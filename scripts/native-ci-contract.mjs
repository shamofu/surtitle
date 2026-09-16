import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nativeCommitInputs, nativeRecipePaths } from './native-ci-git.mjs';

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
  requireCondition(left.size === right.size && [...right].every(([name, digest]) => left.get(name) === digest), `${label} differs from committed inputs`);
}
function exactKeys(actual, expected, label) {
  requireCondition(isDeepStrictEqual([...actual].sort(), [...expected].sort()), `Unexpected or missing ${label}`);
}

function artifactEnvelope(directory, expectedSha, { expectedReceiptSha256, expectedRunId } = {}) {
  requireCondition(typeof expectedSha === 'string' && shaPattern.test(expectedSha), 'An exact lowercase Git commit SHA is required');
  requireCondition(digestPattern.test(expectedReceiptSha256 ?? ''), 'An independently supplied receipt SHA-256 is required');
  requireCondition(/^[1-9][0-9]*$/.test(expectedRunId ?? ''), 'An expected workflow run ID is required');
  const root = directoryRoot(directory);
  exactKeys(readdirSync(root), [...nativeArtifactFiles, receiptName], 'native artifact files');
  requireCondition(hash(regularFile(root, receiptName)) === expectedReceiptSha256, 'Native artifact receipt differs from the producer job output');
  const receipt = object(jsonFile(root, receiptName), 'native artifact receipt');
  exactKeys(Object.keys(receipt), ['schemaVersion', 'sha', 'runId', 'runAttempt', 'baseManifestSha256', 'files'], 'native receipt fields');
  requireCondition(receipt.schemaVersion === 2 && receipt.sha === expectedSha, 'Native artifact commit/schema mismatch');
  requireCondition(receipt.runId === expectedRunId && /^[1-9][0-9]*$/.test(receipt.runAttempt ?? ''), 'Native artifact workflow run identity mismatch');
  requireCondition(digestPattern.test(receipt.baseManifestSha256), 'Invalid committed base manifest hash');
  exactKeys(Object.keys(object(receipt.files, 'native artifact hashes')), nativeArtifactFiles, 'native artifact hash entries');
  const files = nativeArtifactFiles.map(name => {
    const path = regularFile(root, name), size = lstatSync(path).size;
    requireCondition(size > 0 && digestPattern.test(receipt.files[name]) && hash(path) === receipt.files[name], `Native artifact checksum/size mismatch: ${name}`);
    return { name, path, sha256: receipt.files[name], size };
  });
  return { root, receipt, files };
}

/** Verify transport, committed inputs and retained source bytes; this is not independent approval of the producer. */
export function validateNativeArtifact(directory, workspaceRoot, expectedSha, expectations) {
  const result = artifactEnvelope(directory, expectedSha, expectations);
  const { root, receipt, files } = result;
  const workspace = directoryRoot(workspaceRoot);
  const committed = nativeCommitInputs(workspace, expectedSha);
  requireCondition(committed.baseManifestSha256 === receipt.baseManifestSha256, 'Committed base manifest hash mismatch');
  const workingManifestHash = hash(regularFile(workspace, 'native/runtime-windows-x64.json'));
  requireCondition(workingManifestHash === committed.baseManifestSha256 || workingManifestHash === receipt.files['effective-native-manifest.json'],
    'Working native manifest is neither the committed base nor this artifact effective manifest');
  const { sourceCatalog, ortReviewed, ortIdentity, mpvReviewed } = committed;
  requireCondition(sourceCatalog.schemaVersion === 1, 'Invalid committed native source catalog');
  const evidence = object(jsonFile(root, 'libmpv-build-evidence.json'), 'libmpv evidence');
  requireCondition(evidence.schemaVersion === 1, 'Invalid libmpv evidence schema');
  samePairs(evidence.recipe, committed.recipe, 'path', 'Build recipe evidence');
  samePairs(evidence.sources, sourceCatalog.sources, 'id', 'Build source evidence');
  samePairs(mpvReviewed.sources, sourceCatalog.sources, 'id', 'libmpv reviewed source inventory');
  for (const reviewedSource of sourceCatalog.sources) {
    const observed = evidence.sources.find(item => item.id === reviewedSource.id);
    requireCondition(Object.entries(reviewedSource).every(([key, value]) => isDeepStrictEqual(observed[key], value)),
      `Build source metadata differs from committed inputs: ${reviewedSource.id}`);
    requireCondition(typeof reviewedSource.license === 'string' && reviewedSource.license.length > 0, 'Missing source license metadata');
    const notices = mpvReviewed.sources.find(item => item.id === reviewedSource.id).retainedNotices;
    samePairs(observed.retainedNotices, notices, 'file', `libmpv ${reviewedSource.id} retained notices`);
  }
  const byName = new Map(files.map(file => [file.name, file]));
  const runtime = object(evidence.runtime, 'libmpv runtime evidence');
  requireCondition(runtime.file === 'mpv-2.dll' && runtime.sha256 === receipt.files['mpv-2.dll']
    && runtime.bytes === byName.get('mpv-2.dll').size, 'libmpv runtime evidence does not match the DLL');
  const source = object(evidence.correspondingSourceCandidate, 'libmpv source evidence');
  requireCondition(source.file === 'libmpv-candidate-source.tar.gz' && source.sha256 === receipt.files['libmpv-source.tar.gz']
    && source.bytes === byName.get('libmpv-source.tar.gz').size, 'libmpv source evidence does not match the source archive');

  const ort = object(jsonFile(root, 'onnxruntime-source-inventory.json'), 'ONNX Runtime inventory');
  requireCondition(digestPattern.test(ortIdentity.binarySha256) && shaPattern.test(ortIdentity.sourceCommit)
    && ortIdentity.dllPdbIdentityMatches === true, 'Invalid committed ONNX Runtime identity');
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
  const expected = effectiveNativeManifest(committed, receipt);
  requireCondition(isDeepStrictEqual(manifest, expected), 'Effective runtime manifest differs from committed configuration or artifact binding');
  const mpvArchiveFiles = [
    ...committed.recipe.map(item => ({ path: `recipe/${item.path}`, sha256: item.sha256 })),
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
      .concat(committed.ortRecipe.map(item => ({ path: item.path, sha256: item.sha256 }))),
  });
  return { receipt, manifest, files, recipe: committed.recipe };
}

function checkSourceArchive(path, specification) {
  const script = fileURLToPath(new URL('./native-source-archive-check.py', import.meta.url));
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [script, path], {
    input: JSON.stringify(specification), encoding: 'utf8', windowsHide: true,
    maxBuffer: 1024 * 1024, timeout: 300_000,
  });
  requireCondition(!result.error && result.status === 0, `Native source archive verification failed: ${result.error?.message ?? result.stderr?.trim()}`);
}

export function effectiveNativeManifest(committed, receipt) {
  const expected = structuredClone(object(committed.originalManifest, 'committed original runtime manifest'));
  requireCondition(expected.schemaVersion === 1 && expected.platform === 'windows-x64' && Array.isArray(expected.components), 'Invalid reviewed runtime manifest');
  exactKeys(expected.components.map(item => item.id), ['libmpv', 'onnxruntime'], 'reviewed native components');
  const mpvComponent = expected.components.find(item => item.id === 'libmpv');
  const ortComponent = expected.components.find(item => item.id === 'onnxruntime');
  requireCondition(mpvComponent.runtimeFiles?.length === 1 && mpvComponent.runtimeFiles[0].target === 'mpv-2.dll'
    && mpvComponent.format === 'source-build' && ortComponent.format === 'zip'
    && ortComponent.runtimeFiles?.find(item => item.target === 'onnxruntime.dll')?.sha256 === committed.ortIdentity.binarySha256, 'Committed runtime DLL inventory/format mismatch');
  mpvComponent.version = `0.41.0-surtitle-ci-${receipt.sha.slice(0, 12)}`;
  mpvComponent.localRuntimePath = 'work/native-ci-artifact';
  mpvComponent.runtimeFiles[0].sha256 = receipt.files['mpv-2.dll'];
  for (const [component, sourceName, inventoryName] of [
    [mpvComponent, 'libmpv-source.tar.gz', 'libmpv-build-evidence.json'],
    [ortComponent, 'onnxruntime-source.tar.gz', 'onnxruntime-source-inventory.json'],
  ]) {
    component.redistribution.correspondingSource = { path: `work/native-ci-artifact/${sourceName}`, sha256: receipt.files[sourceName] };
    component.redistribution.dependencyInventory = { path: `work/native-ci-artifact/${inventoryName}`, sha256: receipt.files[inventoryName] };
  }
  expected.buildBinding = { sha: receipt.sha, runId: receipt.runId, baseManifestSha256: receipt.baseManifestSha256,
    artifactManifestPath: 'work/native-ci-artifact/native-build-artifact.json' };
  return expected;
}

/** Check the extracted source package itself; do not substitute the checkout manifest. */
export function assertEffectiveManifestInSource(sourceRoot, artifactDirectory, expectedSha, expectations = {}) {
  requireCondition(typeof expectations.referenceWorkspace === 'string', 'The reference checkout is required for native source verification');
  const { receipt, manifest, recipe } = validateNativeArtifact(artifactDirectory, expectations.referenceWorkspace, expectedSha, expectations);
  const root = directoryRoot(artifactDirectory);
  const source = directoryRoot(sourceRoot);
  for (const [destination, name] of [
    ['native/runtime-windows-x64.json', 'effective-native-manifest.json'],
    ['native/native-build-artifact.json', receiptName],
  ]) {
    requireCondition(hash(regularFile(source, destination)) === hash(regularFile(root, name)), `Source package omits or changes the effective build evidence: ${destination}`);
  }
  const sourceManifest = jsonFile(source, 'native/runtime-windows-x64.json');
  requireCondition(sourceManifest.buildBinding?.sha === expectedSha && sourceManifest.buildBinding?.baseManifestSha256 === receipt.baseManifestSha256
    && sourceManifest.buildBinding?.runId === receipt.runId, 'Source package effective manifest has a different commit/run binding');
  for (const path of nativeRecipePaths) {
    requireCondition(hash(regularFile(source, path)) === recipe.find(item => item.path === path).sha256,
      `Source package recipe differs from the tested commit: ${path}`);
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
