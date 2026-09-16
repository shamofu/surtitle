import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const nativeRecipePaths = Object.freeze([
  'native/build/Dockerfile', 'native/build/sources.json', 'native/build/cross-win64.ini',
  'native/build/toolchain-win64.cmake', 'scripts/native-build.sh',
  'scripts/native-source-inputs.py', 'scripts/native-build-evidence.py',
]);
export const ortRecipePaths = Object.freeze([
  'scripts/native-ort-evidence.py', 'scripts/native-ort-source-inputs.py',
  'scripts/native-ort-compare.py', 'scripts/native-ort-generated.py', 'scripts/native-ort-package.py',
]);
export const baseManifestPath = 'native/runtime-windows-x64.json';
export const nativeDigest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Read the checkout inputs used to build the corresponding-source package. */
export function nativeCheckoutInputs(workspaceRoot) {
  const workspace = resolve(workspaceRoot);
  const bytes = path => {
    let current = workspace;
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !(index === parts.length - 1 ? stat.isFile() : stat.isDirectory())) {
        throw new Error(`Native input has a non-regular or symlink path: ${path}`);
      }
    }
    return readFileSync(current);
  };
  const json = path => JSON.parse(bytes(path).toString('utf8').replace(/^\uFEFF/, ''));
  return {
    originalManifest: json(baseManifestPath),
    recipe: nativeRecipePaths.map(path => ({ path, sha256: nativeDigest(bytes(path)) })),
    ortRecipe: ortRecipePaths.map(path => ({ path, sha256: nativeDigest(bytes(path)) })),
    sourceCatalog: json('native/build/sources.json'),
    mpvReviewed: json('native/reviews/libmpv-dependencies.json'),
    ortReviewed: json('native/reviews/onnxruntime-dependencies.json'),
    ortIdentity: json('native/upstream-evidence/onnxruntime-dependency-inventory.json'),
  };
}
