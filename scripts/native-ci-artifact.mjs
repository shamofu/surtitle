import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateNativeArtifact } from './native-ci-contract.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const policyPath = join(workspace, 'native/build/reviewed-inputs.json');
const policy = json(policyPath);
function checkInputs() {
  for (const item of policy.inputs) {
    if (hash(join(workspace, item.path)) !== item.sha256) throw new Error(`Reviewed native input changed: ${item.path}`);
  }
  const preservedPaths = [...new Set([...policy.inputs.map(item => item.path), 'native/build/reviewed-inputs.json'])];
  const attributes = spawnSync('git', ['check-attr', '-z', '--stdin', 'text'], {
    cwd: workspace, input: preservedPaths.join('\0') + '\0', encoding: 'utf8',
  });
  if (attributes.status !== 0) throw new Error('Cannot verify byte-preserving Git attributes');
  const records = attributes.stdout.split('\0');
  for (let index = 0; index + 2 < records.length; index += 3) {
    if (records[index + 1] !== 'text' || records[index + 2] !== 'unset') throw new Error(`Reviewed input is subject to Git text normalization: ${records[index]}`);
  }
  if ((records.length - 1) / 3 !== preservedPaths.length) throw new Error('Incomplete Git attribute verification');
}
const [command, suppliedDirectory, sha] = process.argv.slice(2);
checkInputs();
if (command === 'check-inputs') {
  console.log('Reviewed native source, recipe and packaging inputs match.');
} else if (command === 'seal') {
  if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('An explicit commit SHA is required');
  const directory = resolve(suppliedDirectory);
  const manifest = json(join(workspace, 'native/runtime-windows-x64.json'));
  const artifactPath = name => `work/native-ci-artifact/${name}`;
  const mpv = manifest.components.find(item => item.id === 'libmpv');
  const ort = manifest.components.find(item => item.id === 'onnxruntime');
  mpv.version = `0.41.0-surtitle-ci-${sha.slice(0, 12)}`;
  mpv.localRuntimePath = 'work/native-ci-artifact';
  mpv.runtimeFiles[0].sha256 = hash(join(directory, 'mpv-2.dll'));
  for (const [component, source, inventory] of [
    [mpv, 'libmpv-source.tar.gz', 'libmpv-build-evidence.json'],
    [ort, 'onnxruntime-source.tar.gz', 'onnxruntime-source-inventory.json'],
  ]) {
    component.redistribution.correspondingSource = { path: artifactPath(source), sha256: hash(join(directory, source)) };
    component.redistribution.dependencyInventory = { path: artifactPath(inventory), sha256: hash(join(directory, inventory)) };
  }
  manifest.buildBinding = { sha, inputPolicySha256: hash(policyPath), artifactManifestPath: artifactPath('native-build-artifact.json') };
  writeFileSync(join(directory, 'effective-native-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const names = ['mpv-2.dll', 'libmpv-source.tar.gz', 'onnxruntime-source.tar.gz', 'libmpv-build-evidence.json',
    'onnxruntime-source-inventory.json', 'toolchain-packages.tsv', 'container-image.json', 'effective-native-manifest.json'];
  const receipt = { schemaVersion: 1, sha, inputPolicySha256: hash(policyPath), reviewedInputs: policy.inputs,
    files: Object.fromEntries(names.map(name => [name, hash(join(directory, name))])) };
  writeFileSync(join(directory, 'native-build-artifact.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  validateNativeArtifact(directory, workspace, sha);
  console.log(`Sealed native runtime/source artifact for ${sha}; Windows execution tests remain required.`);
} else if (command === 'consume') {
  const directory = resolve(suppliedDirectory);
  validateNativeArtifact(directory, workspace, sha);
  const destination = join(workspace, 'work/native-ci-artifact');
  if (directory !== destination) {
    if (existsSync(destination)) throw new Error('Native artifact destination must be fresh');
    mkdirSync(destination, { recursive: true });
    const receipt = json(join(directory, 'native-build-artifact.json'));
    for (const name of [...Object.keys(receipt.files), 'native-build-artifact.json']) copyFileSync(join(directory, name), join(destination, name));
  }
  copyFileSync(join(destination, 'effective-native-manifest.json'), join(workspace, 'native/runtime-windows-x64.json'));
  console.log(`Applied only the verified effective native manifest for ${sha}.`);
} else {
  throw new Error('Usage: native-ci-artifact.mjs check-inputs | seal DIRECTORY SHA | consume DIRECTORY SHA');
}
