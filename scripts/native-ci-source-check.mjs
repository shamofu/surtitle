import { assertEffectiveManifestInSource } from './native-ci-contract.mjs';

const [sourceRoot, artifactDirectory, sha] = process.argv.slice(2);
if (!sourceRoot || !artifactDirectory || !sha) throw new Error('Usage: native-ci-source-check.mjs SOURCE_ROOT ARTIFACT_DIRECTORY SHA');
assertEffectiveManifestInSource(sourceRoot, artifactDirectory, sha);
console.log('The corresponding-source package contains the exact tested native manifest and build receipt.');
