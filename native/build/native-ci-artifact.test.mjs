import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeNativeArtifact } from './native-ci-artifact.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-native 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'download');
  mkdirSync(directory);
  mkdirSync(join(root, 'native'));
  const manifestPath = join(root, 'native/runtime-windows-x64.json');
  const manifest = Buffer.from('{ "components": [], "retainFormatting": true }\r\n');
  writeFileSync(manifestPath, manifest);
  for (const name of ['mpv-2.dll', 'libmpv-source.tar.gz', 'onnxruntime-source.tar.gz']) writeFileSync(join(directory, name), name);
  return { root, directory, manifestPath, manifest };
}

test('stages alternate DLL bytes without checksums or evidence and leaves the manifest byte-for-byte unchanged', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'mpv-2.dll'), 'a different source build');
  const result = consumeNativeArtifact(f.directory, f.root);
  assert.deepEqual(result.files, ['mpv-2.dll', 'libmpv-source.tar.gz', 'onnxruntime-source.tar.gz']);
  assert.equal(readFileSync(join(result.directory, 'mpv-2.dll'), 'utf8'), 'a different source build');
  assert.deepEqual(readFileSync(f.manifestPath), f.manifest);
  assert.equal(consumeNativeArtifact(result.directory, f.root).directory, result.directory);
  assert.deepEqual(readFileSync(f.manifestPath), f.manifest);
});

test('copies optional reports without requiring their contents to match the runtime', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'libmpv-build-evidence.json'), '{"runtime":{"sha256":"old output"}}');
  writeFileSync(join(f.directory, 'onnxruntime-source-inventory.json'), '{"binarySha256":"old DLL"}');
  writeFileSync(join(f.directory, 'SHA256SUMS.txt'), 'obsolete checksums');
  writeFileSync(join(f.directory, 'unrelated.txt'), 'not part of the build output');
  const result = consumeNativeArtifact(f.directory, f.root);
  assert.equal(result.files.length, 5);
  assert.equal(readFileSync(join(result.directory, 'libmpv-build-evidence.json'), 'utf8'), '{"runtime":{"sha256":"old output"}}');
  assert.equal(existsSync(join(result.directory, 'SHA256SUMS.txt')), false);
  assert.equal(existsSync(join(result.directory, 'unrelated.txt')), false);
  assert.deepEqual(readFileSync(f.manifestPath), f.manifest);
});

test('requires nonempty runtime and source archives before creating staging output', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'mpv-2.dll'), '');
  assert.throws(() => consumeNativeArtifact(f.directory, f.root), /Empty native artifact/);
  assert.equal(existsSync(join(f.root, 'work')), false);
  rmSync(join(f.directory, 'mpv-2.dll'));
  assert.throws(() => consumeNativeArtifact(f.directory, f.root), /ENOENT/);
  assert.deepEqual(readFileSync(f.manifestPath), f.manifest);
});

test('does not replace an existing staging directory or follow a redirected artifact directory', t => {
  const f = fixture(t);
  const redirected = join(f.root, 'redirected');
  symlinkSync(f.directory, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => consumeNativeArtifact(redirected, f.root), /only regular files and directories/);
  mkdirSync(join(f.root, 'work/native-ci-artifact'), { recursive: true });
  writeFileSync(join(f.root, 'work/native-ci-artifact/mpv-2.dll'), 'existing build');
  assert.throws(() => consumeNativeArtifact(f.directory, f.root), /destination must be fresh/);
  assert.equal(readFileSync(join(f.root, 'work/native-ci-artifact/mpv-2.dll'), 'utf8'), 'existing build');
});
