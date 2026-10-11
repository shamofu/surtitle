// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32' ? test : test.skip;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native prepare 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['native/windows', 'native/build', 'work/native-ci-artifact']) mkdirSync(join(root, path), { recursive: true });
  const script = join(root, 'native/windows/native-prepare.ps1');
  copyFileSync(fileURLToPath(new URL('./native-prepare.ps1', import.meta.url)), script);
  writeFileSync(join(root, 'native/build/sources.json'), JSON.stringify({ sources: [{ id: 'mpv', repo: 'mpv-player/mpv', commit: 'a'.repeat(40) }] }));
  writeFileSync(join(root, 'native/NOTICE'), 'Current license notice');
  writeFileSync(join(root, 'work/native-ci-artifact/mpv-2.dll'), 'Alternate locally built DLL');
  const manifest = {
    components: [{ id: 'libmpv', version: 'test', format: 'source-build', sourceId: 'mpv', localRuntimePath: 'work/native-ci-artifact',
      runtimeFiles: [{ source: 'mpv-2.dll', target: 'mpv-2.dll' }], noticeFiles: [{ path: 'native/NOTICE' }] }],
    models: [{ id: 'model', bundled: false, developmentPath: 'work/model.onnx', url: 'https://raw.githubusercontent.com/example/model', sha256: '0'.repeat(64) }],
  };
  const manifestPath = join(root, 'native/runtime-windows-x64.json');
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  save();
  const run = (...args) => spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return { root, manifest, manifestPath, save, run };
}

windows('preparation stages alternate DLLs and notices without source/evidence files or manifest changes', t => {
  const f = fixture(t);
  const manifest = readFileSync(f.manifestPath);
  const first = f.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(readFileSync(join(f.root, 'src-tauri/resources/native/mpv-2.dll'), 'utf8'), 'Alternate locally built DLL');
  assert.equal(readFileSync(join(f.root, 'src-tauri/resources/native/NOTICE'), 'utf8'), 'Current license notice');
  const target = join(f.root, 'src-tauri/resources/native/mpv-2.dll');
  utimesSync(target, new Date('2020-01-01'), new Date('2020-01-01'));
  const before = statSync(target).mtimeMs;
  const unchanged = f.run();
  assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
  assert.equal(statSync(target).mtimeMs, before, 'An identical DLL should not be replaced');
  writeFileSync(join(f.root, 'work/native-ci-artifact/mpv-2.dll'), 'New alternate DLL bytes');
  const second = f.run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(readFileSync(join(f.root, 'src-tauri/resources/native/mpv-2.dll'), 'utf8'), 'New alternate DLL bytes');
  assert.deepEqual(readFileSync(f.manifestPath), manifest);
}, 45_000);

windows('runtime archives are cached by component version without requiring binary archive digests', t => {
  const f = fixture(t);
  const prepareZip = join(f.root, 'make-zip.ps1');
  writeFileSync(prepareZip, 'param([string]$Source, [string]$Destination)\nCompress-Archive -LiteralPath $Source -DestinationPath $Destination\n');
  for (const version of ['1.0', '2.0']) {
    const directory = join(f.root, 'work/native-cache/onnxruntime-' + version);
    mkdirSync(directory, { recursive: true });
    const dll = join(directory, 'onnxruntime.dll');
    writeFileSync(dll, 'ORT build ' + version);
    const zip = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', prepareZip, '-Source', dll, '-Destination', join(directory, 'ort.zip')],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.equal(zip.status, 0, zip.stdout + zip.stderr);
  }
  f.manifest.components = [{ id: 'onnxruntime', version: '1.0', format: 'zip', archiveFile: 'ort.zip', archiveUrl: 'https://github.com/example/runtime.zip',
    runtimeFiles: [{ source: 'onnxruntime.dll', target: 'onnxruntime.dll' }], noticeFiles: [] }];
  for (const version of ['1.0', '2.0']) {
    f.manifest.components[0].version = version;
    f.save();
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.root, 'src-tauri/resources/native/onnxruntime.dll'), 'utf8'), 'ORT build ' + version);
  }
}, 90_000);

windows('preparation preserves the development model digest check', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'work/model.onnx'), 'unexpected model bytes');
  const result = f.run('-WithDevModel');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /SHA-256 mismatch/);
}, 25_000);

windows('preparation rejects a runtime target outside the staging directory', t => {
  const f = fixture(t);
  f.manifest.components[0].runtimeFiles[0].target = '../escaped.dll';
  f.save();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /plain filename/);
}, 25_000);
