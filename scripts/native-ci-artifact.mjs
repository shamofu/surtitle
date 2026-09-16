import { appendFileSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNativeArtifact, nativeArtifactFiles, effectiveNativeManifest, assertNativeDirectory, assertNativeArtifactStaging } from './native-ci-contract.mjs';
import { nativeCommitInputs, nativeDigest } from './native-ci-git.mjs';

const hash = path => nativeDigest(readFileSync(path));
const receiptName = 'native-build-artifact.json';

export function sealNativeArtifact(directory, workspace, sha, { runId, runAttempt, githubOutput } = {}) {
  if (!/^[1-9][0-9]*$/.test(runId ?? '') || !/^[1-9][0-9]*$/.test(runAttempt ?? '')) {
    throw new Error('The producer workflow run ID and attempt are required');
  }
  directory = assertNativeArtifactStaging(directory);
  const committed = nativeCommitInputs(workspace, sha, { requireOriginalManifest: true });
  const receipt = { schemaVersion: 2, sha, runId, runAttempt, baseManifestSha256: committed.baseManifestSha256,
    files: Object.fromEntries(nativeArtifactFiles.filter(name => name !== 'effective-native-manifest.json')
      .map(name => [name, hash(join(directory, name))])) };
  const manifest = effectiveNativeManifest(committed, receipt);
  writeFileSync(join(directory, 'effective-native-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  receipt.files['effective-native-manifest.json'] = hash(join(directory, 'effective-native-manifest.json'));
  writeFileSync(join(directory, receiptName), `${JSON.stringify(receipt, null, 2)}\n`);
  const receiptSha256 = hash(join(directory, receiptName));
  validateNativeArtifact(directory, workspace, sha, { expectedReceiptSha256: receiptSha256, expectedRunId: runId });
  // This transport digest is emitted only after validation; it is not a review baseline.
  if (githubOutput) appendFileSync(githubOutput, `receipt-sha256=${receiptSha256}\n`);
  return { receiptSha256, receipt, manifest };
}

export function consumeNativeArtifact(directory, workspace, sha, expectations) {
  const result = validateNativeArtifact(directory, workspace, sha, expectations);
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
    validateNativeArtifact(destination, workspace, sha, expectations);
  }
  copyFileSync(join(destination, 'effective-native-manifest.json'), manifestPath);
  return result;
}

function main(args) {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [command, suppliedDirectory, suppliedSha, ...flags] = args;
  if (command === 'check-inputs') {
    if (suppliedSha || flags.length) throw new Error('Usage: native-ci-artifact.mjs check-inputs [SHA]');
    nativeCommitInputs(workspace, suppliedDirectory ?? process.env.GITHUB_SHA, { requireOriginalManifest: true });
    console.log('Native recipe and dependency inputs match the selected Git commit.');
  } else if (command === 'seal') {
    if (!suppliedDirectory || flags.length) throw new Error('Usage: native-ci-artifact.mjs seal DIRECTORY SHA');
    const sealed = sealNativeArtifact(resolve(suppliedDirectory), workspace, suppliedSha, {
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, githubOutput: process.env.GITHUB_OUTPUT,
    });
    console.log(`Sealed native runtime/source artifact for ${suppliedSha}; receipt SHA-256: ${sealed.receiptSha256}. Windows execution tests remain required.`);
  } else if (command === 'consume') {
    const options = {};
    for (let index = 0; index < flags.length; index += 2) {
      const flag = flags[index], value = flags[index + 1];
      if (!['--expected-receipt-sha256', '--expected-run-id'].includes(flag) || !value || Object.hasOwn(options, flag)) {
        throw new Error('Consume requires --expected-receipt-sha256 HEX and optionally --expected-run-id ID');
      }
      options[flag] = value;
    }
    if (!suppliedDirectory) throw new Error('Usage: native-ci-artifact.mjs consume DIRECTORY SHA --expected-receipt-sha256 HEX');
    consumeNativeArtifact(resolve(suppliedDirectory), workspace, suppliedSha, {
      expectedReceiptSha256: options['--expected-receipt-sha256'],
      expectedRunId: options['--expected-run-id'] ?? process.env.GITHUB_RUN_ID,
    });
    console.log(`Applied only the verified effective native manifest for ${suppliedSha}.`);
  } else {
    throw new Error('Usage: native-ci-artifact.mjs check-inputs [SHA] | seal DIRECTORY SHA | consume DIRECTORY SHA --expected-receipt-sha256 HEX');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
