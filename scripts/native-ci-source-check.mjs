import { assertEffectiveManifestInSource } from './native-ci-contract.mjs';

const [sourceRoot, artifactDirectory, sha, option, referenceWorkspace, ...extra] = process.argv.slice(2);
if (!sourceRoot || !artifactDirectory || !sha || option !== '--reference-workspace' || !referenceWorkspace || extra.length) {
  throw new Error('Usage: native-ci-source-check.mjs SOURCE_ROOT ARTIFACT_DIRECTORY SHA --reference-workspace CHECKOUT');
}
assertEffectiveManifestInSource(sourceRoot, artifactDirectory, sha, {
  referenceWorkspace,
  expectedReceiptSha256: process.env.SURTITLE_EXPECTED_NATIVE_RECEIPT_SHA256,
  expectedRunId: process.env.GITHUB_RUN_ID,
});
console.log('The corresponding-source package contains the exact tested native manifest and build receipt.');
