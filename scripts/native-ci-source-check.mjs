import { assertEffectiveManifestInSource } from './native-ci-contract.mjs';

const [sourceRoot, artifactDirectory, option, referenceWorkspace, ...extra] = process.argv.slice(2);
if (!sourceRoot || !artifactDirectory || option !== '--reference-workspace' || !referenceWorkspace || extra.length) {
  throw new Error('Usage: native-ci-source-check.mjs SOURCE_ROOT ARTIFACT_DIRECTORY --reference-workspace CHECKOUT');
}
assertEffectiveManifestInSource(sourceRoot, artifactDirectory, { referenceWorkspace });
console.log('The corresponding-source package contains the native manifest, build evidence and source files.');
