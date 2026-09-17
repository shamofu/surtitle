// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
function hash(path) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    for (let length; (length = readSync(descriptor, buffer)) > 0;) {
      digest.update(buffer.subarray(0, length));
    }
    return digest.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function regular(root, name) {
  assert(typeof name === 'string' && name.length && !isAbsolute(name)
    && !name.split(/[\\/]/).some(part => !part || part === '..' || part === '.'), 'Unsafe installer file path');
  const path = resolve(root, name);
  assert(!relative(resolve(root), path).startsWith('..'), 'Installer file escapes its root');
  let cursor = resolve(root);
  for (const part of name.split(/[\\/]/)) {
    cursor = join(cursor, part);
    assert(!lstatSync(cursor).isSymbolicLink(), 'Installer files must not traverse links');
  }
  assert(lstatSync(path).isFile(), 'Installer input must be a regular file');
  return path;
}

function checked(root, file, sha256) {
  assert(/^[a-f0-9]{64}$/.test(sha256 ?? ''), 'Invalid installer checksum');
  const path = regular(root, file);
  assert(hash(path) === sha256, 'Installer checksum mismatch: ' + file);
  return path;
}

function inventory(root, folder) {
  const result = [];
  const visit = name => {
    for (const entry of readdirSync(join(root, name), { withFileTypes: true })) {
      const child = name + '/' + entry.name;
      assert(!entry.isSymbolicLink(), 'Installer resources must not contain links');
      if (entry.isDirectory()) visit(child);
      else result.push({ file: child, sha256: hash(regular(root, child)) });
    }
  };
  visit(folder);
  return result.sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

export function auditInstaller(installer, directory, root = workspace) {
  const inputs = json(join(root, 'native/installer-inputs.json'));
  const manifest = json(join(root, 'native/runtime-windows-x64.json'));
  const staged = join(root, 'src-tauri/resources');
  const expectedNative = manifest.components.flatMap(component => [
    ...component.runtimeFiles.map(item => ({ file: 'native/' + item.target, sha256: item.sha256 })),
    ...component.noticeFiles.map(item => ({ file: 'native/' + basename(item.path), sha256: item.sha256 })),
  ]);
  for (const item of expectedNative) checked(staged, item.file, item.sha256);
  const native = inventory(staged, 'native');
  assert(native.every(item => expectedNative.some(expected => expected.file === item.file)
    || (item.file === 'native/.gitkeep' && readFileSync(join(staged, item.file), 'utf8').trim() === '')),
  'Unmanifested native resource');
  const notices = inventory(staged, 'notices');
  for (const file of ['notices/javascript.txt', 'notices/rust.html']) {
    assert(lstatSync(regular(staged, file)).size > 0, 'Required dependency notices are empty');
  }
  assert(inputs.notices?.length > 0 && inputs.rust?.notices?.length > 0,
    'Required installer and Rust notice pins are missing');
  for (const item of inputs.notices) checked(staged, 'notices/installer/' + item.file, item.sha256);
  for (const item of inputs.rust.notices) checked(staged, 'notices/installer/rust-runtime/' + item.file, item.sha256);
  assert(lstatSync(regular(staged, 'notices/installer/rust-runtime/compiler-builtins-LICENSE.txt')).size > 0,
    'Compiler-builtins notice is empty');
  const expected = [...native, ...notices];
  const actual = [...inventory(directory, 'native'), ...inventory(directory, 'notices')];
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'Installer DLLs or notices differ from the prepared files');
  checked(directory, '$PLUGINSDIR/' + inputs.plugin.binary.file, inputs.plugin.binary.sha256);
  checked(directory, '$PLUGINSDIR/surtitle-vc-prerequisite.ps1', hash(join(root, 'native/vc-prerequisite.ps1')));
  checked(directory, '$PLUGINSDIR/runtime-windows-x64.json', hash(join(root, 'native/runtime-windows-x64.json')));
  assert(!existsSync(join(directory, '$PLUGINSDIR/surtitle_nsis_utils.dll')), 'Unexpected custom installer utility');
  const application = regular(directory, 'surtitle.exe');
  assert(lstatSync(application).size > 0, 'Installer application is empty');
  regular(directory, 'uninstall.exe');
  return { schemaVersion: 1, passed: true, installerSha256: hash(installer),
    applicationSha256: hash(application), files: expected };
}

export function verifyInstallerSources(sourceRoot) {
  const inputs = json(regular(sourceRoot, 'native/installer-inputs.json'));
  const directory = join(sourceRoot, 'native-installer-sources');
  const sources = [inputs.sourceArchive, inputs.plugin.sourceArchive, ...inputs.plugin.sourceCrates, inputs.rust.sourceArchive];
  const inventory = json(regular(directory, 'sources.json'));
  assert(JSON.stringify(inventory.sources) === JSON.stringify(sources.map(({ file, sha256 }) => ({ file, sha256 }))),
    'Installer source inventory differs from the pinned sources');
  for (const item of sources) checked(directory, item.file, item.sha256);
  return true;
}

function main([command, first, second, ...extra]) {
  assert(first && !extra.length, 'Usage: native-installer-audit.mjs audit INSTALLER EXTRACTED | source-check SOURCE_ROOT');
  if (command === 'source-check' && !second) {
    verifyInstallerSources(resolve(first));
    console.log('Installer and Rust source archives are present with their pinned checksums.');
  } else {
    assert(command === 'audit' && second, 'Expected installer and extracted directory');
    const report = auditInstaller(resolve(first), resolve(second));
    mkdirSync(join(workspace, 'artifacts'), { recursive: true });
    writeFileSync(join(workspace, 'artifacts/installer-audit.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Verified the extracted production executable, DLLs and notices.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
