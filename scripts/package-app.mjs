// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkVersion } from './check-release.mjs';
import { readJson, sha256File } from './file-content.mjs';

function regularFile(path) {
  const item = lstatSync(path);
  if (!item.isFile() || item.isSymbolicLink() || item.size === 0) throw new Error(`Package input must be a nonempty regular file: ${path}`);
  return path;
}

function resourceTree(path) {
  const item = lstatSync(path);
  if (item.isSymbolicLink()) throw new Error(`Package resources must not traverse links: ${path}`);
  if (item.isDirectory()) for (const name of readdirSync(path)) resourceTree(join(path, name));
  else regularFile(path);
}

export function packageInputs(workspace, env = process.env) {
  workspace = resolve(workspace);
  const version = checkVersion(workspace);
  const target = resolve(workspace, env.CARGO_TARGET_DIR || env.CARGO_BUILD_TARGET_DIR || 'work/target');
  const resources = join(workspace, 'work/resources');
  const identity = readJson(join(workspace, 'packaging/app.json'));
  if (!/^[A-Za-z0-9 ._-]+$/.test(identity.productName) || !/^[A-Za-z0-9 ._-]+$/.test(identity.publisher)
      || !/^[a-zA-Z0-9.-]+$/.test(identity.identifier) || identity.executable !== 'surtitle.exe') throw new Error('Invalid application packaging identity');
  const native = join(resources, 'native');
  const binary = regularFile(join(target, 'release/surtitle.exe'));
  const manifest = readJson(join(workspace, 'native/runtime-windows-x64.json'));
  for (const component of manifest.components) {
    const names = [...component.runtimeFiles.map(file => file.target), ...component.noticeFiles.map(notice => basename(notice.path))];
    for (const name of names) {
      if (!name || /[\\/]/.test(name) || name === '..') throw new Error('Native target must be a plain filename');
      regularFile(join(native, name));
    }
  }
  regularFile(join(resources, 'notices/rust.html'));
  resourceTree(resources);
  return { workspace, version, target, binary, resources, identity,
    output: join(workspace, `work/target/release/bundle/nsis/${identity.productName}_${version}_x64-setup.exe`) };
}

export function validateCompilerVersion(output, expected) {
  if (output.trim() !== `v${expected}`) throw new Error(`NSIS ${expected} is required; got ${output.trim() || 'no version'}`);
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { shell: false, windowsHide: true, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${program} exited with ${result.status}`);
  return result.stdout;
}

async function compiler(workspace, env, acquire = true) {
  const inputs = readJson(join(workspace, 'native/installer-inputs.json'));
  const local = join(workspace, 'work/tools/nsis');
  const candidates = env.SURTITLE_NSIS_COMPILER ? [resolve(env.SURTITLE_NSIS_COMPILER)] : [
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'tauri/NSIS/Bin/makensis.exe'), join(env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe')] : []),
    join(local, `nsis-${inputs.nsisVersion}/makensis.exe`), join(local, 'makensis.exe'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    regularFile(candidate);
    const version = command(candidate, ['/VERSION']);
    if (!env.SURTITLE_NSIS_COMPILER && version.trim() !== `v${inputs.nsisVersion}`) continue;
    validateCompilerVersion(version, inputs.nsisVersion);
    return candidate;
  }
  if (env.SURTITLE_NSIS_COMPILER) throw new Error('SURTITLE_NSIS_COMPILER does not identify a compiler');
  if (!acquire) throw new Error('The verified NSIS archive did not provide the expected compiler');
  const archive = inputs.binaryArchive;
  if (!archive || basename(archive.file) !== archive.file || !/^[a-f0-9]{64}$/.test(archive.sha256)) throw new Error('Pinned NSIS archive is missing');
  mkdirSync(local, { recursive: true });
  const zip = join(local, archive.file);
  if (!existsSync(zip)) {
    const response = await fetch(archive.url);
    if (!response.ok) throw new Error(`NSIS download failed: HTTP ${response.status}`);
    writeFileSync(zip, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
  }
  regularFile(zip);
  if (sha256File(zip) !== archive.sha256) throw new Error('NSIS archive checksum mismatch');
  command('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:SURTITLE_NSIS_ARCHIVE -DestinationPath $env:SURTITLE_NSIS_EXTRACT -Force'],
    { env: { ...env, SURTITLE_NSIS_ARCHIVE: zip, SURTITLE_NSIS_EXTRACT: local } });
  return compiler(workspace, env, false);
}

function nsisValue(value) {
  if (/[\r\n"]/.test(value)) throw new Error('Unsafe NSIS argument');
  return value.replaceAll('$', '$$');
}

export async function buildPackage({ workspace = fileURLToPath(new URL('..', import.meta.url)), env = process.env, build = true } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The Windows x64 package requires a Windows x64 host');
  workspace = resolve(workspace);
  const target = resolve(workspace, env.CARGO_TARGET_DIR || env.CARGO_BUILD_TARGET_DIR || 'work/target');
  const cargoEnv = { ...env, CARGO_TARGET_DIR: target };
  const sourceRevision = build ? command('git', ['rev-parse', 'HEAD'], {cwd:workspace,env:cargoEnv}).trim() : null;
  const sourceCleanBefore = build && command('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd:workspace,env:cargoEnv}).trim() === '';
  command(process.execPath, [join(workspace, 'scripts/check-production-features.mjs')], { cwd: workspace, env: cargoEnv });
  if (build) command('cargo', ['build', '--release', '--locked', '--package', 'surtitle', '--no-default-features'], { cwd: workspace, env: cargoEnv, stdio: 'inherit' });
  const inputs = packageInputs(workspace, cargoEnv);
  const executable = await compiler(workspace, env);
  mkdirSync(dirname(inputs.output), { recursive: true });
  const receipt = `${inputs.output}.build.json`;
  rmSync(receipt, { force: true });
  command(executable, ['/INPUTCHARSET', 'UTF8', '/V3', `/DAPP_VERSION=${inputs.version}`, `/DAPP_PRODUCT=${inputs.identity.productName}`, `/DAPP_PUBLISHER=${inputs.identity.publisher}`, `/DAPP_BINARY=${nsisValue(inputs.binary)}`,
    `/DAPP_RESOURCES=${nsisValue(inputs.resources)}`, `/DAPP_OUTPUT=${nsisValue(inputs.output)}`, join(workspace, 'packaging/windows.nsi')],
  { cwd: workspace, env: cargoEnv, stdio: 'inherit' });
  regularFile(inputs.output);
  if (build) writeFileSync(receipt, JSON.stringify({ schema: 1, productionBuild: true,
    command: 'cargo build --release --locked --package surtitle --no-default-features',
    version: inputs.version, sourceRevision,
    sourceTreeClean: sourceCleanBefore && command('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd:workspace,env:cargoEnv}).trim() === '',
    executableSha256: sha256File(inputs.binary), installerSha256: sha256File(inputs.output) }, null, 2) + '\n', { flag: 'wx' });
  return inputs.output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await buildPackage({ build: !process.argv.includes('--no-build') }));
}
