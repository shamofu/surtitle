import { test } from 'vitest';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeNativeArtifact, nativeArtifactFiles, nativeFileHash, validateNativeArtifact, verifyNativeSources } from './native-ci-artifact.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-native 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'download');
  mkdirSync(directory);
  mkdirSync(join(root, 'native'));
  const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
  const manifestPath = join(root, 'native/runtime-windows-x64.json');
  const manifest = {
    schemaVersion: 1, platform: 'windows-x64', currentCheckoutSetting: 'retain me',
    prerequisites: [{ id: 'microsoft-vc-runtime-x64', hookSha256: 'new checkout hook' }],
    buildBinding: { artifactManifestPath: 'obsolete receipt' },
    components: [
      { id: 'libmpv', version: 'current dependency', format: 'source-build',
        runtimeFiles: [{ source: 'mpv-2.dll', target: 'mpv-2.dll', sha256: 'old build' }],
        noticeFiles: [], redistribution: { status: 'complete', reason: 'current checkout review' } },
      { id: 'onnxruntime', archiveUrl: 'current official URL',
        runtimeFiles: [{ target: 'onnxruntime.dll', sha256: '1'.repeat(64) }],
        noticeFiles: [], redistribution: { status: 'complete' } },
    ],
  };
  writeJson(manifestPath, manifest);
  for (const name of nativeArtifactFiles) writeFileSync(join(directory, name), name);
  writeJson(join(directory, 'libmpv-build-evidence.json'), { runtime: { sha256: nativeFileHash(join(directory, 'mpv-2.dll')) } });
  writeJson(join(directory, 'onnxruntime-source-inventory.json'), { binarySha256: '1'.repeat(64) });
  const checksums = () => writeFileSync(join(directory, 'SHA256SUMS.txt'),
    nativeArtifactFiles.map(name => nativeFileHash(join(directory, name)) + '  ' + name).join('\n') + '\n');
  checksums();
  return { root, directory, manifest, manifestPath, checksums, writeJson };
}

test('consumes cached dependency files using the current checkout settings and native sources', t => {
  const f = fixture(t);
  assert.equal(validateNativeArtifact(f.directory).files.length, 5);
  const result = consumeNativeArtifact(f.directory, f.root);
  assert.equal(result.currentCheckoutSetting, 'retain me');
  assert.deepEqual(result.prerequisites, f.manifest.prerequisites);
  assert.equal(result.components[0].redistribution.reason, 'current checkout review');
  assert.equal(result.components[1].archiveUrl, 'current official URL');
  assert.equal(result.components[0].runtimeFiles[0].sha256, nativeFileHash(join(f.directory, 'mpv-2.dll')));
  assert.equal(result.components[0].redistribution.correspondingSource.path, 'work/native-ci-artifact/libmpv-source.tar.gz');
  assert.equal(result.buildBinding, undefined);
  assert.equal(validateNativeArtifact(join(f.root, 'work/native-ci-artifact')).files.length, 5);
});

test('rejects corrupt, missing or additional exported files', t => {
  const f = fixture(t), path = join(f.directory, 'mpv-2.dll');
  writeFileSync(path, 'changed DLL');
  assert.throws(() => validateNativeArtifact(f.directory), /checksum mismatch/);
  rmSync(path);
  assert.throws(() => validateNativeArtifact(f.directory), /missing native artifact/);
  writeFileSync(path, 'mpv-2.dll');
  writeFileSync(join(f.directory, 'old-effective-manifest.json'), '{}');
  assert.throws(() => validateNativeArtifact(f.directory), /native artifact files/);
});

test('requires a complete, unambiguous checksum list', t => {
  const f = fixture(t), path = join(f.directory, 'SHA256SUMS.txt');
  const contents = readFileSync(path, 'utf8');
  for (const changed of [contents.split('\n').slice(1).join('\n'), contents + contents.split('\n')[0] + '\n', contents.replace('mpv-2.dll', '../mpv-2.dll')]) {
    writeFileSync(path, changed);
    assert.throws(() => validateNativeArtifact(f.directory), /SHA256SUMS/);
  }
});

test('refuses ORT sources for a different official DLL before modifying the workspace', t => {
  const f = fixture(t);
  f.writeJson(join(f.directory, 'onnxruntime-source-inventory.json'), { binarySha256: '2'.repeat(64) });
  f.checksums();
  assert.throws(() => consumeNativeArtifact(f.directory, f.root), /selected official DLL/);
  assert.deepEqual(JSON.parse(readFileSync(f.manifestPath)), f.manifest);
  assert.equal(existsSync(join(f.root, 'work')), false);
});

test('checks extracted source ZIP bytes through its portable manifest without rebuilding dependencies', t => {
  const f = fixture(t), manifest = consumeNativeArtifact(f.directory, f.root);
  for (const component of manifest.components) {
    const target = join(f.root, 'native-sources', component.id);
    mkdirSync(target, { recursive: true });
    for (const field of ['correspondingSource', 'dependencyInventory']) {
      const item = component.redistribution[field];
      const file = item.path.split('/').at(-1);
      copyFileSync(join(f.root, item.path), join(target, file));
      item.path = 'native-sources/' + component.id + '/' + file;
    }
  }
  f.writeJson(f.manifestPath, manifest);
  assert.equal(verifyNativeSources(f.root).checkedFiles, 4);
  const item = manifest.components[0].redistribution.correspondingSource;
  writeFileSync(join(f.root, item.path), 'changed archive');
  assert.throws(() => verifyNativeSources(f.root), /Native source checksum mismatch/);
  item.path = '../outside.tar.gz';
  f.writeJson(f.manifestPath, manifest);
  assert.throws(() => verifyNativeSources(f.root), /Unsafe native source path/);
});
