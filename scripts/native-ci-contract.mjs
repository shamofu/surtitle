import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, parse, relative, resolve } from 'node:path';

export const nativeArtifactFiles = Object.freeze([
  'mpv-2.dll', 'libmpv-source.tar.gz', 'onnxruntime-source.tar.gz',
  'libmpv-build-evidence.json', 'onnxruntime-source-inventory.json',
  'toolchain-packages.tsv', 'container-image.json', 'effective-native-manifest.json',
]);
const receiptName = 'native-build-artifact.json';
const policyName = 'native/build/reviewed-inputs.json';
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const recipePaths = [
  'native/build/Dockerfile', 'native/build/sources.json', 'native/build/cross-win64.ini',
  'native/build/toolchain-win64.cmake', 'scripts/native-build.sh',
  'scripts/native-source-inputs.py', 'scripts/native-build-evidence.py',
];

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
  requireCondition(left.size === right.size && [...right].every(([name, digest]) => left.get(name) === digest), `${label} differs from reviewed inputs`);
}
function exactKeys(actual, expected, label) {
  requireCondition(isDeepStrictEqual([...actual].sort(), [...expected].sort()), `Unexpected or missing ${label}`);
}

function artifactEnvelope(directory, expectedSha) {
  requireCondition(typeof expectedSha === 'string' && shaPattern.test(expectedSha), 'An exact lowercase Git commit SHA is required');
  const root = directoryRoot(directory);
  exactKeys(readdirSync(root), [...nativeArtifactFiles, receiptName], 'native artifact files');
  const receipt = object(jsonFile(root, receiptName), 'native artifact receipt');
  requireCondition(receipt.schemaVersion === 1 && receipt.sha === expectedSha, 'Native artifact commit/schema mismatch');
  requireCondition(digestPattern.test(receipt.inputPolicySha256), 'Invalid reviewed input policy hash');
  exactKeys(Object.keys(object(receipt.files, 'native artifact hashes')), nativeArtifactFiles, 'native artifact hash entries');
  const files = nativeArtifactFiles.map(name => {
    const path = regularFile(root, name), size = lstatSync(path).size;
    requireCondition(size > 0 && digestPattern.test(receipt.files[name]) && hash(path) === receipt.files[name], `Native artifact checksum/size mismatch: ${name}`);
    return { name, path, sha256: receipt.files[name], size };
  });
  return { root, receipt, files };
}

/** Verify transport integrity and reviewed inputs, not bit-for-bit reproducibility or license approval. */
export function validateNativeArtifact(directory, workspaceRoot, expectedSha) {
  const result = artifactEnvelope(directory, expectedSha);
  const { root, receipt, files } = result;
  const workspace = directoryRoot(workspaceRoot);
  const policy = object(jsonFile(workspace, policyName), 'reviewed input policy');
  requireCondition(policy.schemaVersion === 1 && hash(regularFile(workspace, policyName)) === receipt.inputPolicySha256, 'Reviewed input policy hash/schema mismatch');
  const reviewedInputs = pairs(policy.inputs, 'path', 'reviewed');
  requireCondition(reviewedInputs.has('native/reviews/onnxruntime-dependencies.json'), 'Reviewed input policy omits the ONNX Runtime review inventory');
  samePairs(receipt.reviewedInputs, policy.inputs, 'path', 'Reviewed input inventory');
  const recipe = pairs(policy.recipe, 'path', 'recipe');
  exactKeys(recipe.keys(), recipePaths, 'reviewed recipe inputs');
  for (const item of [...policy.inputs, ...policy.recipe]) {
    requireCondition(hash(regularFile(workspace, item.path)) === item.sha256, `Reviewed native input changed: ${item.path}`);
  }
  const sourceCatalog = jsonFile(workspace, 'native/build/sources.json');
  samePairs(sourceCatalog.sources, policy.sources, 'id', 'Source archive policy');
  const evidence = object(jsonFile(root, 'libmpv-build-evidence.json'), 'libmpv evidence');
  requireCondition(evidence.schemaVersion === 1, 'Invalid libmpv evidence schema');
  samePairs(evidence.recipe, policy.recipe, 'path', 'Build recipe evidence');
  samePairs(evidence.sources, policy.sources, 'id', 'Build source evidence');
  for (const reviewedSource of sourceCatalog.sources) {
    const observed = evidence.sources.find(item => item.id === reviewedSource.id);
    requireCondition(Object.entries(reviewedSource).every(([key, value]) => isDeepStrictEqual(observed[key], value)),
      `Build source metadata differs from reviewed inputs: ${reviewedSource.id}`);
  }
  const byName = new Map(files.map(file => [file.name, file]));
  const runtime = object(evidence.runtime, 'libmpv runtime evidence');
  requireCondition(runtime.file === 'mpv-2.dll' && runtime.sha256 === receipt.files['mpv-2.dll']
    && runtime.bytes === byName.get('mpv-2.dll').size, 'libmpv runtime evidence does not match the DLL');
  const source = object(evidence.correspondingSourceCandidate, 'libmpv source evidence');
  requireCondition(source.file === 'libmpv-candidate-source.tar.gz' && source.sha256 === receipt.files['libmpv-source.tar.gz']
    && source.bytes === byName.get('libmpv-source.tar.gz').size, 'libmpv source evidence does not match the source archive');

  const ort = object(jsonFile(root, 'onnxruntime-source-inventory.json'), 'ONNX Runtime inventory');
  requireCondition(digestPattern.test(policy.ortBinarySha256) && shaPattern.test(policy.ortSourceCommit), 'Invalid reviewed ONNX Runtime identity');
  requireCondition(ort.schemaVersion === 1 && ort.componentId === 'onnxruntime' && ort.binarySha256 === policy.ortBinarySha256
    && Number.isSafeInteger(ort.observedChecksumRecords) && ort.observedChecksumRecords > 0 && ort.unresolvedChecksumRecords === 0, 'ONNX Runtime source inventory is incomplete or for a different binary');
  const ortFiles = pairs(ort.files?.map(file => ({ path: file.file, sha256: file.sha256 })), 'path', 'ONNX Runtime source files');
  requireCondition(ortFiles.has(`sources/onnxruntime-${policy.ortSourceCommit}.tar.gz`), 'ONNX Runtime source commit is missing from the inventory');
  const ortReviewed = jsonFile(workspace, 'native/reviews/onnxruntime-dependencies.json');
  requireCondition(ort.binarySha256 === ortReviewed.binarySha256 && ort.pdbSha256 === ortReviewed.pdbSha256
    && ort.observedChecksumRecords === ortReviewed.observedChecksumRecords, 'ONNX Runtime observed binary/PDB evidence differs from review');
  samePairs(ort.components?.map(item => ({ id: item.id, sha256: item.sourceArchiveSha256 })),
    ortReviewed.components?.map(item => ({ id: item.id, sha256: item.sourceArchiveSha256 })), 'id', 'ONNX Runtime component sources');
  const reviewedOrtFiles = pairs(ortReviewed.files?.map(file => ({ path: file.file, sha256: file.sha256 })), 'path', 'Reviewed ONNX Runtime source files');
  const stable = name => /^(sources|ports|notices)\//.test(name);
  const expectedOrtFiles = pairs(Object.entries(object(policy.ortSourceFiles, 'reviewed ONNX Runtime source file policy'))
    .map(([path, sha256]) => ({ path, sha256 })), 'path', 'ONNX Runtime source file policy');
  exactKeys(expectedOrtFiles.keys(), [...reviewedOrtFiles.keys()].filter(stable), 'reviewed ONNX Runtime stable source files');
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
  const expected = structuredClone(object(policy.originalManifest, 'reviewed original runtime manifest'));
  requireCondition(expected.schemaVersion === 1 && expected.platform === 'windows-x64' && Array.isArray(expected.components), 'Invalid reviewed runtime manifest');
  exactKeys(expected.components.map(item => item.id), ['libmpv', 'onnxruntime'], 'reviewed native components');
  const mpvComponent = expected.components.find(item => item.id === 'libmpv');
  const ortComponent = expected.components.find(item => item.id === 'onnxruntime');
  requireCondition(mpvComponent.runtimeFiles?.length === 1 && mpvComponent.runtimeFiles[0].target === 'mpv-2.dll'
    && ortComponent.runtimeFiles?.find(item => item.target === 'onnxruntime.dll')?.sha256 === policy.ortBinarySha256, 'Reviewed runtime DLL inventory mismatch');
  mpvComponent.version = `0.41.0-surtitle-ci-${expectedSha.slice(0, 12)}`;
  mpvComponent.localRuntimePath = 'work/native-ci-artifact';
  mpvComponent.runtimeFiles[0].sha256 = receipt.files['mpv-2.dll'];
  for (const [component, sourceName, inventoryName] of [
    [mpvComponent, 'libmpv-source.tar.gz', 'libmpv-build-evidence.json'],
    [ortComponent, 'onnxruntime-source.tar.gz', 'onnxruntime-source-inventory.json'],
  ]) {
    component.redistribution.correspondingSource = { path: `work/native-ci-artifact/${sourceName}`, sha256: receipt.files[sourceName] };
    component.redistribution.dependencyInventory = { path: `work/native-ci-artifact/${inventoryName}`, sha256: receipt.files[inventoryName] };
  }
  expected.buildBinding = { sha: expectedSha, inputPolicySha256: receipt.inputPolicySha256, artifactManifestPath: 'work/native-ci-artifact/native-build-artifact.json' };
  requireCondition(isDeepStrictEqual(manifest, expected), 'Effective runtime manifest differs from reviewed configuration or artifact binding');
  return { receipt, manifest, files };
}

/** Check the extracted source package itself; do not substitute the checkout manifest. */
export function assertEffectiveManifestInSource(sourceRoot, artifactDirectory, expectedSha) {
  const { root, receipt } = artifactEnvelope(artifactDirectory, expectedSha);
  const source = directoryRoot(sourceRoot);
  for (const [destination, name] of [
    ['native/runtime-windows-x64.json', 'effective-native-manifest.json'],
    ['native/native-build-artifact.json', receiptName],
  ]) {
    requireCondition(hash(regularFile(source, destination)) === hash(regularFile(root, name)), `Source package omits or changes the effective build evidence: ${destination}`);
  }
  const manifest = jsonFile(source, 'native/runtime-windows-x64.json');
  requireCondition(manifest.buildBinding?.sha === expectedSha && manifest.buildBinding?.inputPolicySha256 === receipt.inputPolicySha256,
    'Source package effective manifest has a different commit/policy binding');
  return true;
}
