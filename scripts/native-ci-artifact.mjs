import { readFileSync, writeFileSync, mkdirSync, copyFileSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNativeArtifact, nativeArtifactFiles, effectiveNativeManifest, assertNativeDirectory, assertNativeArtifactStaging } from './native-ci-contract.mjs';
import { nativeCheckoutInputs, nativeDigest } from './native-ci-git.mjs';

const hash = path => nativeDigest(readFileSync(path));
const receiptName = 'native-build-artifact.json';

export function sealNativeArtifact(directory, workspace, { sha = process.env.GITHUB_SHA ?? null } = {}) {
  directory = assertNativeArtifactStaging(directory);
  const inputs = nativeCheckoutInputs(workspace);
  const receipt = { schemaVersion: 3, sha,
    files: Object.fromEntries(nativeArtifactFiles.filter(name => name !== 'effective-native-manifest.json')
      .map(name => [name, hash(join(directory, name))])) };
  const manifest = effectiveNativeManifest(inputs, receipt);
  writeFileSync(join(directory, 'effective-native-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  receipt.files['effective-native-manifest.json'] = hash(join(directory, 'effective-native-manifest.json'));
  writeFileSync(join(directory, receiptName), `${JSON.stringify(receipt, null, 2)}\n`);
  validateNativeArtifact(directory, workspace);
  return { receipt, manifest };
}

export function consumeNativeArtifact(directory, workspace) {
  const result = validateNativeArtifact(directory, workspace);
  const manifestPath = join(workspace, 'native/runtime-windows-x64.json');
  if (lstatSync(manifestPath).nlink !== 1) throw new Error('Native manifest output must not be hard-linked');
  const destination = join(workspace, 'work/native-ci-artifact');
  if (resolve(directory) !== resolve(destination)) {
    const work = join(workspace, 'work');
    if (lstatSync(work, { throwIfNoEntry: false })) assertNativeDirectory(work);
    else mkdirSync(work);
    if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error('Native artifact destination must be fresh');
    mkdirSync(destination);
    for (const name of [...nativeArtifactFiles, receiptName]) copyFileSync(join(directory, name), join(destination, name));
  }
  copyFileSync(join(destination, 'effective-native-manifest.json'), manifestPath);
  return result;
}

function main(args) {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [command, directory, ...extra] = args;
  if (!directory || extra.length || !['seal', 'consume'].includes(command)) {
    throw new Error('Usage: native-ci-artifact.mjs seal DIRECTORY | consume DIRECTORY');
  }
  if (command === 'seal') {
    sealNativeArtifact(resolve(directory), workspace);
    console.log('Prepared the native runtime/source artifact and effective manifest. Windows execution tests remain required.');
  } else {
    consumeNativeArtifact(resolve(directory), workspace);
    console.log('Applied the effective native manifest.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
