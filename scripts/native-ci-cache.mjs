// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const compilerInputPaths = Object.freeze([
  'native/build/Dockerfile', 'native/build/cross-win64.ini', 'native/build/toolchain-win64.cmake',
  'native/build/sources.json', 'scripts/native-build.sh', 'scripts/native-ci-build-inside.sh',
  'scripts/native-source-inputs.py', 'scripts/native-ort-compare.py', 'scripts/native-ort-generated.py',
]);
export const sourceInputPaths = Object.freeze([
  'native/build/sources.json', 'scripts/native-ci-inputs.py',
  'scripts/native-source-inputs.py', 'scripts/native-ort-source-inputs.py',
]);
export const sourceTreePath = 'native/upstream-evidence/onnxruntime-overlay-ports';
const digest = value => createHash('sha256').update(value).digest('hex');

// Run against the prepared image without a network or mounted host files. Paths
// deliberately bypass ccache wrappers so the key binds the actual compiler bytes.
const toolchainProbe = String.raw`
import hashlib, json, pathlib, shutil, subprocess

def command(args):
    return subprocess.check_output(args, text=True).strip()

def file_record(path):
    path = pathlib.Path(path).resolve(strict=True)
    with path.open('rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'sha256': checksum}

tools = ['gcc', 'g++', 'x86_64-w64-mingw32-gcc-posix', 'x86_64-w64-mingw32-g++-posix',
         'as', 'ld', 'ar', 'x86_64-w64-mingw32-as', 'x86_64-w64-mingw32-ld',
         'x86_64-w64-mingw32-ar', 'cmake', 'meson', 'ninja', 'nasm', 'ccache']
files = {}
for name in tools:
    path = shutil.which(name, path='/usr/bin:/bin')
    if not path:
        raise RuntimeError('Required native tool is missing: ' + name)
    files[name] = file_record(path)
for name in ['gcc', 'g++', 'x86_64-w64-mingw32-gcc-posix', 'x86_64-w64-mingw32-g++-posix']:
    frontend = 'cc1plus' if 'g++' in name else 'cc1'
    path = command([files[name]['path'], '-print-prog-name=' + frontend])
    files[name + '/' + frontend] = file_record(path)
package_format = chr(36) + '{binary:Package}\t' + chr(36) + '{Version}\t' + chr(36) + '{Architecture}\n'
packages = command(['dpkg-query', '-W', '-f=' + package_format])
print(json.dumps({
    'schemaVersion': 1,
    'architecture': command(['dpkg', '--print-architecture']),
    'packages': sorted(packages.splitlines()),
    'files': files,
    'ccacheVersion': command(['/usr/bin/ccache', '--version']),
    'ccacheConfig': file_record('/etc/surtitle-ccache.conf'),
}, sort_keys=True))
`;

function inputHashes(root, paths) {
  return [...paths].sort().map(path => {
    const absolute = join(root, path);
    if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error('Cache input must be a regular file: ' + path);
    return [path, digest(readFileSync(absolute))];
  });
}

function treeFiles(root, path) {
  if (!lstatSync(join(root, path)).isDirectory() || lstatSync(join(root, path)).isSymbolicLink()) throw new Error('Cache source recipes must be a regular directory: ' + path);
  return readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const child = path + '/' + entry.name;
    if (entry.isDirectory()) return treeFiles(root, child);
    if (!entry.isFile()) throw new Error('Cache source recipes must not contain links: ' + child);
    return [child];
  });
}

export function cacheKeys(root, toolchain) {
  if (toolchain?.schemaVersion !== 1 || !toolchain.architecture || !toolchain.packages?.length
      || !Object.keys(toolchain.files ?? {}).length || !toolchain.ccacheVersion || !toolchain.ccacheConfig?.sha256) {
    throw new Error('Incomplete native toolchain fingerprint');
  }
  // Neither commit/image identity nor the broad review policy enters these keys.
  // Reused objects and archives still pass their existing content checks later.
  const sourceRecipes = treeFiles(root, sourceTreePath);
  return {
    compilerKey: 'native-compiler-v1-' + digest(JSON.stringify([toolchain, inputHashes(root, [...compilerInputPaths, ...sourceRecipes])])),
    sourceKey: 'native-sources-v1-' + digest(JSON.stringify(inputHashes(root, [...sourceInputPaths, ...sourceRecipes]))),
  };
}

export function prepareCache(image, {
  root = workspace, runnerTemp = process.env.RUNNER_TEMP, outputPath = process.env.GITHUB_OUTPUT, run = spawnSync,
} = {}) {
  if (!/^[a-z0-9][a-z0-9./:@_-]+$/.test(image ?? '')) throw new Error('A prepared native Docker image is required');
  if (!runnerTemp || !outputPath || /[\r\n]/.test(runnerTemp + outputPath)) throw new Error('RUNNER_TEMP and GITHUB_OUTPUT are required');
  if (!lstatSync(runnerTemp).isDirectory() || lstatSync(runnerTemp).isSymbolicLink()) throw new Error('RUNNER_TEMP must be an existing regular directory');
  const result = run('docker', ['run', '--rm', '--network', 'none', '--pull', 'never', image, 'python3', '-c', toolchainProbe], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('Cannot fingerprint the prepared native image: ' + (result.error?.message ?? result.stderr));
  let toolchain;
  try { toolchain = JSON.parse(result.stdout); } catch { throw new Error('Native image returned an invalid toolchain fingerprint'); }
  const keys = cacheKeys(root, toolchain);
  // actions/cache binds its archive/version to the paths. Keep these paths
  // stable across jobs while requiring fresh staging on each ephemeral runner.
  const directory = join(resolve(runnerTemp), 'surtitle-native-cache-v1');
  if (existsSync(directory)) {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || readdirSync(directory).length) {
      throw new Error('Native cache staging must be an absent or empty regular directory');
    }
  } else mkdirSync(directory);
  for (const name of ['compiler', 'source-cache', 'ort-archives']) mkdirSync(join(directory, name));
  appendFileSync(outputPath, `directory=${directory}\ncompiler-key=${keys.compilerKey}\nsource-key=${keys.sourceKey}\n`);
  return { directory, ...keys };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, image, ...extra] = process.argv.slice(2);
  if (command !== 'prepare' || extra.length) throw new Error('Usage: node scripts/native-ci-cache.mjs prepare IMAGE');
  const result = prepareCache(image);
  console.log('Prepared native source/compiler caches at ' + result.directory);
}
