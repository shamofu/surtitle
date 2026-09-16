import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
const metadataPaths = Object.freeze([
  'native/reviews/libmpv-dependencies.json', 'native/reviews/onnxruntime-dependencies.json',
  'native/upstream-evidence/onnxruntime-dependency-inventory.json',
]);
const nativeBuildPaths = Object.freeze([
  'scripts/native-ci-build.sh', 'scripts/native-ci-inputs.py', 'scripts/native-ci-build-inside.sh',
  'native/onnxruntime-LICENSE', 'native/onnxruntime-ThirdPartyNotices.txt',
]);
export const nativeDigest = bytes => createHash('sha256').update(bytes).digest('hex');

function requireCondition(value, message) { if (!value) throw new Error(message); }

/** Read immutable inputs from the requested commit, never from a consumed manifest. */
export function nativeCommitInputs(workspaceRoot, sha, { requireOriginalManifest = false } = {}) {
  requireCondition(/^[a-f0-9]{40}$/.test(sha ?? ''), 'An exact lowercase Git commit SHA is required');
  const workspace = resolve(workspaceRoot);
  const git = (args, input) => {
    const result = spawnSync('git', args, {
      cwd: workspace, encoding: null, input, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    });
    requireCondition(!result.error && result.status === 0, `Cannot read native input commit: ${result.error?.message ?? result.stderr?.toString().trim()}`);
    return result.stdout;
  };
  requireCondition(git(['rev-parse', '--verify', 'HEAD']).toString().trim() === sha, 'Checkout differs from the native artifact commit');
  const treeFiles = prefix => git(['ls-tree', '-r', '-z', '--name-only', sha, '--', prefix]).toString().split('\0').filter(Boolean);
  const copiedTrees = ['native/build', 'native/upstream-evidence'];
  const copiedTreeFiles = copiedTrees.flatMap(prefix => {
    const expected = treeFiles(prefix);
    requireCondition(expected.length > 0, `Missing committed native input tree: ${prefix}`);
    const expectedDirectories = new Set([prefix]);
    for (const path of expected) {
      const parts = path.split('/');
      for (let length = prefix.split('/').length + 1; length < parts.length; length++) expectedDirectories.add(parts.slice(0, length).join('/'));
    }
    const actual = [];
    const walk = path => {
      requireCondition(lstatSync(join(workspace, path)).isDirectory() && !lstatSync(join(workspace, path)).isSymbolicLink(), `Native input tree has a symlink or non-directory: ${path}`);
      for (const entry of readdirSync(join(workspace, path), { withFileTypes: true })) {
        const name = `${path}/${entry.name}`;
        requireCondition(!entry.isSymbolicLink(), `Native input tree has a symlink: ${name}`);
        if (entry.isDirectory()) {
          requireCondition(expectedDirectories.has(name), `Untracked native input directory: ${name}`);
          walk(name);
        } else {
          requireCondition(entry.isFile(), `Non-regular native input: ${name}`);
          actual.push(name);
        }
      }
    };
    walk(prefix);
    requireCondition(JSON.stringify(actual.sort()) === JSON.stringify(expected.sort()), `Native input tree differs from the selected commit: ${prefix}`);
    return expected;
  });
  const ortPattern = /^scripts\/native-ort-[^/]+\.py$/;
  const copiedOrtScripts = treeFiles('scripts').filter(path => ortPattern.test(path)).sort();
  const scriptDirectory = lstatSync(join(workspace, 'scripts'));
  requireCondition(scriptDirectory.isDirectory() && !scriptDirectory.isSymbolicLink(), 'Native scripts directory is a symlink or non-directory');
  const actualOrtScripts = readdirSync(join(workspace, 'scripts')).map(name => `scripts/${name}`).filter(path => ortPattern.test(path)).sort();
  requireCondition(JSON.stringify(actualOrtScripts) === JSON.stringify(copiedOrtScripts), 'Copied ONNX Runtime scripts differ from the selected commit');
  const checkedInputs = [...new Set([...nativeRecipePaths, ...ortRecipePaths, ...metadataPaths, ...nativeBuildPaths, ...copiedTreeFiles, ...copiedOrtScripts])];
  const blobs = new Map();
  const loadBlobs = paths => {
    const entries = git(['ls-tree', '-z', sha, '--', ...paths]).toString().split('\0').filter(Boolean);
    const identities = new Map(entries.map(entry => {
      const match = entry.match(/^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/);
      requireCondition(match, 'Native commit input is not a regular blob');
      return [match[2], match[1]];
    }));
    requireCondition(identities.size === paths.length && paths.every(path => identities.has(path)), 'Native commit input is missing or not a regular blob');
    const output = git(['cat-file', '--batch'], paths.map(path => `${sha}:${path}\n`).join(''));
    let offset = 0;
    for (const path of paths) {
      const end = output.indexOf(10, offset);
      requireCondition(end !== -1, 'Incomplete Git blob response');
      const header = output.subarray(offset, end).toString().match(/^([a-f0-9]{40}) blob ([0-9]+)$/);
      requireCondition(header && header[1] === identities.get(path), 'Git blob identity differs from the selected tree');
      const size = Number(header[2]);
      requireCondition(Number.isSafeInteger(size) && size <= 16 * 1024 * 1024 && end + size + 1 < output.length, 'Invalid Git blob size');
      blobs.set(path, output.subarray(end + 1, end + 1 + size));
      offset = end + size + 2;
      requireCondition(output[offset - 1] === 10, 'Incomplete Git blob bytes');
    }
    requireCondition(offset === output.length, 'Unexpected Git blob response');
  };
  loadBlobs([...new Set([...checkedInputs, baseManifestPath])]);
  const blob = path => {
    requireCondition(typeof path === 'string' && !/[\\:\x00-\x1f]/.test(path)
      && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe native commit path');
    if (!blobs.has(path)) loadBlobs([path]);
    return blobs.get(path);
  };
  const json = path => JSON.parse(blob(path).toString('utf8').replace(/^\uFEFF/, ''));
  const checked = [...checkedInputs, ...(requireOriginalManifest ? [baseManifestPath] : [])];
  for (const path of checked) {
    let current = workspace;
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      requireCondition(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), `Native input has a non-regular or symlink path: ${path}`);
    }
    requireCondition(nativeDigest(readFileSync(current)) === nativeDigest(blob(path)), `Native input differs from the selected commit: ${path}`);
  }
  const manifestBytes = blob(baseManifestPath);
  const originalManifest = json(baseManifestPath);
  requireCondition(!Object.hasOwn(originalManifest, 'buildBinding'), 'Committed base manifest must not contain an effective build binding');
  return {
    sha, blob, originalManifest, baseManifestSha256: nativeDigest(manifestBytes),
    recipe: nativeRecipePaths.map(path => ({ path, sha256: nativeDigest(blob(path)) })),
    ortRecipe: ortRecipePaths.map(path => ({ path, sha256: nativeDigest(blob(path)) })),
    sourceCatalog: json('native/build/sources.json'),
    mpvReviewed: json('native/reviews/libmpv-dependencies.json'),
    ortReviewed: json('native/reviews/onnxruntime-dependencies.json'),
    ortIdentity: json('native/upstream-evidence/onnxruntime-dependency-inventory.json'),
  };
}
