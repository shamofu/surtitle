import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nativeCheckoutInputs, nativeRecipePaths } from './native-ci-git.mjs';

export const nativeArtifactFiles = Object.freeze([
  'mpv-2.dll', 'libmpv-source.tar.gz', 'onnxruntime-source.tar.gz',
  'libmpv-build-evidence.json', 'onnxruntime-source-inventory.json',
  'toolchain-packages.tsv', 'container-image.json', 'effective-native-manifest.json',
]);
const receiptName = 'native-build-artifact.json';
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}
function object(value, label) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  return value;
}
function pathName(value) {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length < 1024
    && !/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/')
    && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe artifact or reviewed input path');
  return value;
}
function directoryRoot(value) {
  const absolute = resolve(value);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'Directory is not a regular directory or has a symlink ancestor');
  }
  return realpathSync(absolute);
}
export function assertNativeDirectory(value) { return directoryRoot(value); }

/** Check every input/output path before sealing can replace either JSON output. */
export function assertNativeArtifactStaging(value) {
  const root = directoryRoot(value);
  const allowed = new Set([...nativeArtifactFiles, receiptName]);
  for (const name of readdirSync(root)) {
    requireCondition(allowed.has(name), `Unexpected native artifact staging file: ${name}`);
    const file = regularFile(root, name);
    if (name === receiptName || name === 'effective-native-manifest.json') {
      requireCondition(lstatSync(file).nlink === 1, `Native artifact output must not be hard-linked: ${name}`);
    }
  }
  for (const name of nativeArtifactFiles.filter(name => name !== 'effective-native-manifest.json')) regularFile(root, name);
  return root;
}
function regularFile(root, name) {
  pathName(name);
  let current = root;
  const parts = name.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = lstatSync(current);
    requireCondition(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), `Non-regular or symlink path: ${name}`);
  }
  const actual = realpathSync(current);
  requireCondition(relative(root, actual) === relative(root, current), `Path escapes its root: ${name}`);
  return current;
}
function hash(path) {
  const digest = createHash('sha256');
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
}
function jsonFile(root, name) {
  const path = regularFile(root, name);
  requireCondition(lstatSync(path).size <= 16 * 1024 * 1024, `Oversized JSON evidence: ${name}`);
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
function pairs(items, key, label) {
  requireCondition(Array.isArray(items) && items.length > 0 && items.length <= 10000, `Invalid ${label} inventory`);
  const result = new Map();
  for (const item of items) {
    object(item, label);
    const name = key === 'path' ? pathName(item[key]) : item[key];
    requireCondition(typeof name === 'string' && name.length > 0 && !result.has(name) && digestPattern.test(item.sha256), `Invalid or duplicate ${label} entry`);
    result.set(name, item.sha256);
  }
  return result;
}
function samePairs(actual, expected, key, label) {
  const left = pairs(actual, key, label), right = pairs(expected, key, label);
  requireCondition(left.size === right.size && [...right].every(([name, digest]) => left.get(name) === digest), `${label} differs from checkout inputs`);
}
function exactKeys(actual, expected, label) {
  requireCondition(isDeepStrictEqual([...actual].sort(), [...expected].sort()), `Unexpected or missing ${label}`);
}

function artifactEnvelope(directory) {
  const root = directoryRoot(directory);
  exactKeys(readdirSync(root), [...nativeArtifactFiles, receiptName], 'native artifact files');
  const receipt = object(jsonFile(root, receiptName), 'native artifact receipt');
  requireCondition(receipt.schemaVersion === 3, 'Invalid native artifact receipt schema');
  const files = nativeArtifactFiles.map(name => {
    const path = regularFile(root, name), size = lstatSync(path).size;
    requireCondition(size > 0, `Empty native artifact file: ${name}`);
    return { name, path, sha256: hash(path), size };
  });
  return { root, receipt, files };
}

/** Validate the runtime, corresponding sources and retained license evidence. */
export function validateNativeArtifact(directory, workspaceRoot) {
  const { root, receipt, files } = artifactEnvelope(directory);
  const workspace = directoryRoot(workspaceRoot);
  const inputs = nativeCheckoutInputs(workspace);
  const { sourceCatalog, ortReviewed, ortIdentity, mpvReviewed } = inputs;
  requireCondition(sourceCatalog.schemaVersion === 1, 'Invalid native source catalog');
  const evidence = object(jsonFile(root, 'libmpv-build-evidence.json'), 'libmpv evidence');
  requireCondition(evidence.schemaVersion === 1, 'Invalid libmpv evidence schema');
  samePairs(evidence.recipe, inputs.recipe, 'path', 'Build recipe evidence');
  samePairs(evidence.sources, sourceCatalog.sources, 'id', 'Build source evidence');
  samePairs(mpvReviewed.sources, sourceCatalog.sources, 'id', 'libmpv reviewed source inventory');
  for (const reviewedSource of sourceCatalog.sources) {
    const observed = evidence.sources.find(item => item.id === reviewedSource.id);
    requireCondition(Object.entries(reviewedSource).every(([key, value]) => isDeepStrictEqual(observed[key], value)),
      `Build source metadata differs from checkout inputs: ${reviewedSource.id}`);
    requireCondition(typeof reviewedSource.license === 'string' && reviewedSource.license.length > 0, 'Missing source license metadata');
    const notices = mpvReviewed.sources.find(item => item.id === reviewedSource.id).retainedNotices;
    samePairs(observed.retainedNotices, notices, 'file', `libmpv ${reviewedSource.id} retained notices`);
  }
  const byName = new Map(files.map(file => [file.name, file]));
  const runtime = object(evidence.runtime, 'libmpv runtime evidence');
  requireCondition(runtime.file === 'mpv-2.dll' && runtime.sha256 === byName.get('mpv-2.dll').sha256
    && runtime.bytes === byName.get('mpv-2.dll').size, 'libmpv runtime evidence does not match the DLL');
  const source = object(evidence.correspondingSourceCandidate, 'libmpv source evidence');
  requireCondition(source.file === 'libmpv-candidate-source.tar.gz' && source.sha256 === byName.get('libmpv-source.tar.gz').sha256
    && source.bytes === byName.get('libmpv-source.tar.gz').size, 'libmpv source evidence does not match the source archive');

  const ort = object(jsonFile(root, 'onnxruntime-source-inventory.json'), 'ONNX Runtime inventory');
  requireCondition(digestPattern.test(ortIdentity.binarySha256) && shaPattern.test(ortIdentity.sourceCommit)
    && ortIdentity.dllPdbIdentityMatches === true, 'Invalid reviewed ONNX Runtime identity');
  requireCondition(ort.schemaVersion === 1 && ort.componentId === 'onnxruntime' && ort.binarySha256 === ortIdentity.binarySha256
    && Number.isSafeInteger(ort.observedChecksumRecords) && ort.observedChecksumRecords > 0 && ort.unresolvedChecksumRecords === 0, 'ONNX Runtime source inventory is incomplete or for a different binary');
  const ortFiles = pairs(ort.files?.map(file => ({ path: file.file, sha256: file.sha256 })), 'path', 'ONNX Runtime source files');
  requireCondition(ortFiles.has(`sources/onnxruntime-${ortIdentity.sourceCommit}.tar.gz`), 'ONNX Runtime source commit is missing from the inventory');
  requireCondition(ort.binarySha256 === ortReviewed.binarySha256 && ort.pdbSha256 === ortReviewed.pdbSha256
    && ort.pdbSha256 === ortIdentity.pdbSha256
    && ort.observedChecksumRecords === ortReviewed.observedChecksumRecords, 'ONNX Runtime observed binary/PDB evidence differs from review');
  samePairs(ort.components?.map(item => ({ id: item.id, sha256: item.sourceArchiveSha256 })),
    ortReviewed.components?.map(item => ({ id: item.id, sha256: item.sourceArchiveSha256 })), 'id', 'ONNX Runtime component sources');
  for (const component of ortReviewed.components) {
    const observed = ort.components.find(item => item.id === component.id);
    requireCondition(typeof component.license === 'string' && component.license.length > 0
      && isDeepStrictEqual(observed, component), `ONNX Runtime component license/source/notice metadata differs: ${component.id}`);
    pairs(component.notices, 'file', 'ONNX Runtime component notices');
  }
  const reviewedOrtFiles = pairs(ortReviewed.files?.map(file => ({ path: file.file, sha256: file.sha256 })), 'path', 'Reviewed ONNX Runtime source files');
  const stable = name => /^(sources|ports|notices)\//.test(name);
  const expectedOrtFiles = new Map([...reviewedOrtFiles].filter(([name]) => stable(name)));
  exactKeys([...ortFiles.keys()].filter(stable), expectedOrtFiles.keys(), 'ONNX Runtime stable source files');
  for (const [name, digest] of expectedOrtFiles) {
    requireCondition(stable(name) && reviewedOrtFiles.get(name) === digest && ortFiles.get(name) === digest, `ONNX Runtime source, patch or notice changed: ${name}`);
  }

  const image = jsonFile(root, 'container-image.json');
  requireCondition(Array.isArray(image) && image.length === 1 && /^sha256:[a-f0-9]{64}$/.test(image[0]?.Id)
    && image[0]?.Os === 'linux' && image[0]?.Architecture === 'amd64', 'Missing or invalid container image identity');
  const packages = readFileSync(regularFile(root, 'toolchain-packages.tsv'), 'utf8').trim().split(/\r?\n/);
  requireCondition(packages.length > 0 && packages.every(line => /^[^\s\t]+\t[^\s\t]+(?:\t[^\s\t]+)*$/.test(line)), 'Missing or malformed toolchain package evidence');

  const manifest = object(jsonFile(root, 'effective-native-manifest.json'), 'effective runtime manifest');
  const expected = effectiveNativeManifest(inputs, { files: Object.fromEntries(files.map(file => [file.name, file.sha256])) });
  requireCondition(isDeepStrictEqual(manifest, expected), 'Effective runtime manifest differs from the runtime configuration or source files');
  const mpvArchiveFiles = [
    ...inputs.recipe.map(item => ({ path: `recipe/${item.path}`, sha256: item.sha256 })),
    ...sourceCatalog.sources.flatMap(item => [
      { path: `archives/${pathName(item.file)}`, sha256: item.sha256 },
      ...mpvReviewed.sources.find(source => source.id === item.id).retainedNotices.map(notice => ({
        path: `notices/${pathName(item.id)}/${pathName(notice.file)}`, sha256: notice.sha256,
      })),
    ]),
  ];
  checkSourceArchive(join(root, 'libmpv-source.tar.gz'), { schemaVersion: 1, kind: 'libmpv', files: mpvArchiveFiles });
  checkSourceArchive(join(root, 'onnxruntime-source.tar.gz'), {
    schemaVersion: 1, kind: 'onnxruntime', inventory: ort,
    files: [...expectedOrtFiles].map(([path, sha256]) => ({ path, sha256 }))
      .concat(inputs.ortRecipe.map(item => ({ path: item.path, sha256: item.sha256 }))),
  });
  return { receipt, manifest, files, recipe: inputs.recipe };
}

function checkSourceArchive(path, specification) {
  const script = fileURLToPath(new URL('./native-source-archive-check.py', import.meta.url));
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [script, path], {
    input: JSON.stringify(specification), encoding: 'utf8', windowsHide: true,
    maxBuffer: 1024 * 1024, timeout: 300_000,
  });
  requireCondition(!result.error && result.status === 0, `Native source archive verification failed: ${result.error?.message ?? result.stderr?.trim()}`);
}

export function effectiveNativeManifest(inputs, receipt) {
  const expected = structuredClone(object(inputs.originalManifest, 'runtime manifest'));
  requireCondition(expected.schemaVersion === 1 && expected.platform === 'windows-x64' && Array.isArray(expected.components), 'Invalid reviewed runtime manifest');
  exactKeys(expected.components.map(item => item.id), ['libmpv', 'onnxruntime'], 'reviewed native components');
  const mpvComponent = expected.components.find(item => item.id === 'libmpv');
  const ortComponent = expected.components.find(item => item.id === 'onnxruntime');
  requireCondition(mpvComponent.runtimeFiles?.length === 1 && mpvComponent.runtimeFiles[0].target === 'mpv-2.dll'
    && mpvComponent.format === 'source-build' && ortComponent.format === 'zip'
    && ortComponent.runtimeFiles?.find(item => item.target === 'onnxruntime.dll')?.sha256 === inputs.ortIdentity.binarySha256, 'Runtime DLL inventory/format mismatch');
  mpvComponent.version = '0.41.0-surtitle-ci';
  mpvComponent.localRuntimePath = 'work/native-ci-artifact';
  mpvComponent.runtimeFiles[0].sha256 = receipt.files['mpv-2.dll'];
  for (const [component, sourceName, inventoryName] of [
    [mpvComponent, 'libmpv-source.tar.gz', 'libmpv-build-evidence.json'],
    [ortComponent, 'onnxruntime-source.tar.gz', 'onnxruntime-source-inventory.json'],
  ]) {
    component.redistribution.correspondingSource = { path: `work/native-ci-artifact/${sourceName}`, sha256: receipt.files[sourceName] };
    component.redistribution.dependencyInventory = { path: `work/native-ci-artifact/${inventoryName}`, sha256: receipt.files[inventoryName] };
  }
  expected.buildBinding = { artifactManifestPath: 'work/native-ci-artifact/native-build-artifact.json' };
  return expected;
}

/** Check the extracted source package itself; do not substitute the checkout manifest. */
export function assertEffectiveManifestInSource(sourceRoot, artifactDirectory, { referenceWorkspace } = {}) {
  requireCondition(typeof referenceWorkspace === 'string', 'The reference checkout is required for native source verification');
  const { manifest, recipe } = validateNativeArtifact(artifactDirectory, referenceWorkspace);
  const root = directoryRoot(artifactDirectory);
  const source = directoryRoot(sourceRoot);
  for (const [destination, name] of [
    ['native/runtime-windows-x64.json', 'effective-native-manifest.json'],
    ['native/native-build-artifact.json', receiptName],
  ]) {
    requireCondition(hash(regularFile(source, destination)) === hash(regularFile(root, name)), `Source package omits or changes the effective build evidence: ${destination}`);
  }
  for (const path of nativeRecipePaths) {
    requireCondition(hash(regularFile(source, path)) === recipe.find(item => item.path === path).sha256,
      `Source package recipe differs from the reference checkout: ${path}`);
  }
  const nativeSources = directoryRoot(join(source, 'native-sources'));
  exactKeys(readdirSync(nativeSources), manifest.components.map(component => component.id), 'native source component directories');
  for (const component of manifest.components) {
    const componentRoot = directoryRoot(join(nativeSources, pathName(component.id)));
    const required = [];
    for (const field of ['correspondingSource', 'dependencyInventory', 'reviewEvidence']) {
      const evidence = component.redistribution[field];
      requireCondition(evidence, `Native source package is missing ${component.id} ${field}`);
      const name = `${field}-${pathName(evidence.path).split('/').at(-1)}`;
      required.push(name);
      requireCondition(hash(regularFile(componentRoot, name)) === evidence.sha256, `Native source package evidence changed: ${component.id}/${name}`);
    }
    exactKeys(readdirSync(componentRoot), required, `${component.id} source evidence files`);
  }
  return true;
}
