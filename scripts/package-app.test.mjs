// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageInputs, validateCompilerVersion } from './package-app.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'package 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['native', 'packaging', 'work/resources/native', 'work/resources/notices', 'work/target/release']) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, 'packaging/app.json'), JSON.stringify({productName:'Surtitle',identifier:'app.surtitle.desktop',executable:'surtitle.exe',publisher:'surtitle'}));
  writeFileSync(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "1.2.3"\n');
  writeFileSync(join(root, 'native/runtime-windows-x64.json'), JSON.stringify({ components: [{ runtimeFiles: [{ target: 'mpv-2.dll' }], noticeFiles: [{ path: 'native/NOTICE.txt' }] }] }));
  for (const file of ['work/target/release/surtitle.exe', 'work/resources/native/mpv-2.dll', 'work/resources/native/NOTICE.txt', 'work/resources/notices/rust.html']) writeFileSync(join(root, file), 'fixture bytes');
  return root;
}

test('packages the explicit workspace version and selected staged native payload', t => {
  const root = fixture(t);
  const inputs = packageInputs(root, {});
  assert.equal(inputs.version, '1.2.3');
  assert.equal(inputs.binary, join(root, 'work/target/release/surtitle.exe'));
  assert.equal(inputs.output, join(root, 'work/target/release/bundle/nsis/Surtitle_1.2.3_x64-setup.exe'));
  rmSync(join(root, 'work/resources/native/NOTICE.txt'));
  assert.throws(() => packageInputs(root, {}), /NOTICE.txt/);
});

test('honors a caller Cargo target directory without changing installer identity', t => {
  const root = fixture(t), target = join(root, 'custom target');
  mkdirSync(join(target, 'release'), { recursive: true });
  writeFileSync(join(target, 'release/surtitle.exe'), 'alternate binary');
  assert.equal(packageInputs(root, { CARGO_TARGET_DIR: target }).binary, join(target, 'release/surtitle.exe'));
  assert.equal(packageInputs(root, { CARGO_BUILD_TARGET_DIR: target }).version, '1.2.3');
});

test('refuses incomplete or path-escaping package inputs before invoking NSIS', t => {
  const root = fixture(t);
  rmSync(join(root, 'work/target/release/surtitle.exe'));
  assert.throws(() => packageInputs(root, {}), /surtitle.exe/);
  writeFileSync(join(root, 'work/target/release/surtitle.exe'), 'binary');
  writeFileSync(join(root, 'native/runtime-windows-x64.json'), JSON.stringify({ components: [{ runtimeFiles: [{ target: '../escape.dll' }], noticeFiles: [] }] }));
  assert.throws(() => packageInputs(root, {}), /plain filename/);
});

test('requires the pinned NSIS compiler version rather than accepting a nearby version', () => {
  assert.doesNotThrow(() => validateCompilerVersion('v3.11\r\n', '3.11'));
  assert.throws(() => validateCompilerVersion('v3.10', '3.11'), /NSIS.*3.11/);
  assert.throws(() => validateCompilerVersion('', '3.11'), /NSIS/);
});

test('rejects linked resource subdirectories instead of bundling files outside the staging tree', t => {
  const root = fixture(t), outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'unrelated.txt'), 'not part of the selected payload');
  symlinkSync(outside, join(root, 'work/resources/notices/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => packageInputs(root, {}), /must not traverse links/);
});
