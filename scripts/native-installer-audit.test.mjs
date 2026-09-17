import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { auditInstaller, verifyInstallerSources } from './native-installer-audit.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-installer-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), value); };
  put('native/installer-inputs.json', JSON.stringify({ plugin: { binary: { file: 'nsis_tauri_utils.dll', sha256: digest('plugin') } },
    notices: [{ file: 'NSIS.txt', sha256: digest('NSIS') }],
    rust: { notices: [{ file: 'COPYRIGHT-library.html', sha256: digest('Rust runtime') }] } }));
  put('native/runtime-windows-x64.json', JSON.stringify({ components: [{ runtimeFiles: [{ target: 'mpv-2.dll', sha256: digest('mpv') }], noticeFiles: [{ path: 'native/COPYING', sha256: digest('notice') }] }] }));
  put('native/vc-prerequisite.ps1', 'helper');
  for (const [file, bytes] of [['native/mpv-2.dll', 'mpv'], ['native/COPYING', 'notice'], ['notices/javascript.txt', 'javascript'], ['notices/rust.html', 'rust'], ['notices/installer/NSIS.txt', 'NSIS'],
    ['notices/installer/rust-runtime/COPYRIGHT-library.html', 'Rust runtime'],
    ['notices/installer/rust-runtime/compiler-builtins-LICENSE.txt', 'compiler-builtins']]) put('src-tauri/resources/' + file, bytes);
  cpSync(join(root, 'src-tauri/resources'), join(root, 'extracted'), { recursive: true });
  put('installer.exe', 'installer');
  put('extracted/surtitle.exe', 'actual embedded production executable');
  put('extracted/uninstall.exe', 'uninstaller');
  put('extracted/$PLUGINSDIR/nsis_tauri_utils.dll', 'plugin');
  put('extracted/$PLUGINSDIR/surtitle-vc-prerequisite.ps1', 'helper');
  return { root, put, audit: () => auditInstaller(join(root, 'installer.exe'), join(root, 'extracted'), root) };
}

test('records the extracted executable and verifies standard plugin, native DLLs and notices', t => {
  const f = fixture(t), report = f.audit();
  assert.equal(report.passed, true);
  assert.equal(report.applicationSha256, digest('actual embedded production executable'));
  assert.equal(report.installerSha256, digest('installer'));
  assert.equal(report.files.length, 7);
});

test('rejects missing or changed DLLs/notices and an altered standard utility', t => {
  const f = fixture(t);
  for (const file of ['native/mpv-2.dll', 'notices/installer/NSIS.txt', '$PLUGINSDIR/nsis_tauri_utils.dll']) {
    const path = join(f.root, 'extracted', file), original = readFileSync(path);
    rmSync(path); assert.throws(f.audit);
    writeFileSync(path, 'changed'); assert.throws(f.audit);
    writeFileSync(path, original);
  }
  f.put('src-tauri/resources/native/unrequested.dll', 'extra');
  f.put('extracted/native/unrequested.dll', 'extra');
  assert.throws(f.audit, /Unmanifested/);
});

test('the published source tree must contain every pinned installer and Rust source archive', t => {
  const f = fixture(t);
  const item = name => ({ file: name, sha256: digest(name) });
  const sources = ['nsis.tar.bz2', 'plugin.tar.gz', 'crate.crate', 'rust.tar.xz'].map(item);
  f.put('native/installer-inputs.json', JSON.stringify({ sourceArchive: sources[0], plugin: { sourceArchive: sources[1], sourceCrates: [sources[2]] }, rust: { sourceArchive: sources[3] } }));
  f.put('native-installer-sources/sources.json', JSON.stringify({ sources }));
  for (const source of sources) f.put('native-installer-sources/' + source.file, source.file);
  assert.equal(verifyInstallerSources(f.root), true);
  f.put('native-installer-sources/rust.tar.xz', 'changed');
  assert.throws(() => verifyInstallerSources(f.root), /checksum mismatch/);
  rmSync(join(f.root, 'native-installer-sources/plugin.tar.gz'));
  assert.throws(() => verifyInstallerSources(f.root));
});

test('rejects missing or corrupted required notices even when staging and installer agree', t => {
  const f = fixture(t);
  for (const name of ['NSIS.txt', 'rust-runtime/COPYRIGHT-library.html', 'rust-runtime/compiler-builtins-LICENSE.txt']) {
    const file = 'notices/installer/' + name;
    const staged = join(f.root, 'src-tauri/resources', file), extracted = join(f.root, 'extracted', file);
    const original = readFileSync(staged);
    rmSync(staged); rmSync(extracted); assert.throws(f.audit);
    const corrupted = name.endsWith('compiler-builtins-LICENSE.txt') ? '' : 'changed';
    writeFileSync(staged, corrupted); writeFileSync(extracted, corrupted); assert.throws(f.audit);
    writeFileSync(staged, original); writeFileSync(extracted, original);
  }
  assert.equal(f.audit().passed, true);
});
