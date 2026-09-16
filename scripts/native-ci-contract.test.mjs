import { test as registerTest } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, copyFileSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { nativeArtifactFiles, validateNativeArtifact, assertEffectiveManifestInSource } from './native-ci-contract.mjs';
import { nativeCheckoutInputs } from './native-ci-git.mjs';
import { consumeNativeArtifact, sealNativeArtifact } from './native-ci-artifact.mjs';
import { fixture, digest, fileHash, write, read, tarGzip } from './native-ci-fixture.mjs';

// These integration checks inspect real source archives with Python.
const test = (name, run) => registerTest(name, run, 20_000);

test('validates runtime and source evidence without Git or workflow identity expectations', t => {
  const f = fixture(t), result = f.validate();
  assert.equal(result.files.length, 8);
  assert.notEqual(result.manifest.components[0].runtimeFiles[0].sha256, f.originalManifest.components[0].runtimeFiles[0].sha256);
  assert.equal(result.receipt.schemaVersion, 3);
  assert.deepEqual(result.manifest.buildBinding, { artifactManifestPath: 'work/native-ci-artifact/native-build-artifact.json' });
  assert.equal(read(join(f.directory, 'libmpv-build-evidence.json')).releaseEligible, false);
  f.mutate('native-build-artifact.json', receipt => { receipt.sha = null; receipt.files = {}; });
  f.validate();
});

test('rejects missing, extra or empty native payloads', t => {
  const f = fixture(t);
  for (const name of nativeArtifactFiles) {
    const bytes = readFileSync(join(f.directory, name));
    rmSync(join(f.directory, name)); assert.throws(f.validate, /missing native artifact files/);
    write(join(f.directory, name), ''); assert.throws(f.validate, /Empty native artifact file/);
    write(join(f.directory, name), bytes);
  }
  write(join(f.directory, 'extra.dll'), 'unexpected'); assert.throws(f.validate, /native artifact files/);
});

test('uses checkout recipe bytes while ignoring unrelated files and directories', t => {
  const f = fixture(t);
  for (const path of ['native/build/extra.cmake', 'native/upstream-evidence/extra.json', 'scripts/native-ort-untracked.py']) {
    write(join(f.workspace, path), 'unrelated file');
  }
  mkdirSync(join(f.workspace, 'native/upstream-evidence/untracked-directory'));
  f.validate();
  write(join(f.workspace, 'native/build/Dockerfile'), 'updated checkout recipe');
  assert.equal(nativeCheckoutInputs(f.workspace).recipe[0].sha256, digest('updated checkout recipe'));
  assert.throws(f.validate, /Build recipe evidence differs from checkout inputs/);
});

test('rejects source metadata and recipe evidence inconsistent with the checkout', t => {
  const f = fixture(t), original = readFileSync(join(f.directory, 'libmpv-build-evidence.json'));
  for (const change of [
    value => { value.recipe[0].sha256 = digest('changed recipe'); },
    value => { value.sources[0].sha256 = digest('changed source'); },
    value => { delete value.sources[0].license; },
    value => { value.sources[0].retainedNotices = []; },
  ]) {
    f.mutate('libmpv-build-evidence.json', change); f.reseal();
    assert.throws(f.validate, /checkout inputs|retained notices/);
    write(join(f.directory, 'libmpv-build-evidence.json'), original);
  }
});

test('rejects changed DLL and source archives when the build evidence does not match', t => {
  const f = fixture(t);
  for (const name of ['mpv-2.dll', 'libmpv-source.tar.gz']) {
    const original = readFileSync(join(f.directory, name));
    write(join(f.directory, name), 'replacement'); f.reseal();
    assert.throws(f.validate, /evidence does not match/);
    write(join(f.directory, name), original);
  }
});

test('rejects unapproved effective manifest changes including the ORT archive format', t => {
  const f = fixture(t), original = readFileSync(join(f.directory, 'effective-native-manifest.json'));
  for (const change of [
    value => { value.components[0].redistribution.status = 'unreviewed'; },
    value => { value.components[0].redistribution.correspondingSource.path = '../other.tar.gz'; },
    value => { value.components[1].runtimeFiles[0].sha256 = digest('other DLL'); },
    value => { delete value.components[1].format; },
    value => { value.prerequisites[0].bundled = true; },
  ]) {
    f.mutate('effective-native-manifest.json', change); f.reseal();
    assert.throws(f.validate, /Effective runtime manifest/);
    write(join(f.directory, 'effective-native-manifest.json'), original);
  }
});

test('requires the ORT source identity, stable sources and complete license metadata', t => {
  const f = fixture(t), original = readFileSync(join(f.directory, 'onnxruntime-source-inventory.json'));
  for (const change of [
    value => { value.binarySha256 = digest('other DLL'); },
    value => { value.unresolvedChecksumRecords = 1; },
    value => { value.files.shift(); },
    value => { value.files[2].sha256 = digest('changed patch'); },
    value => { value.files[3].sha256 = digest('changed notice'); },
    value => { value.files.push({ file: 'ports/new.patch', sha256: digest('new patch') }); },
    value => { delete value.components[0].license; },
    value => { value.components[0].notices = []; },
  ]) {
    f.mutate('onnxruntime-source-inventory.json', change); f.reseal();
    assert.throws(f.validate, /ONNX Runtime/);
    write(join(f.directory, 'onnxruntime-source-inventory.json'), original);
  }
});

test('checks actual libmpv archive members even when archive, evidence and receipt are resealed', t => {
  const f = fixture(t);
  const entries = f.mpvEntries.map(([name, value]) => [name, name === 'notices/mpv/LICENSE' ? 'wrong license bytes' : value]);
  write(join(f.directory, 'libmpv-source.tar.gz'), tarGzip(entries));
  f.mutate('libmpv-build-evidence.json', value => {
    value.correspondingSourceCandidate.sha256 = fileHash(join(f.directory, 'libmpv-source.tar.gz'));
    value.correspondingSourceCandidate.bytes = readFileSync(join(f.directory, 'libmpv-source.tar.gz')).length;
  });
  f.reseal({ rebuildManifest: true });
  assert.throws(f.validate, /source archive verification failed/);
});

test('checks ORT archive contents and its embedded inventory against the external inventory', t => {
  const f = fixture(t);
  const entries = [...f.ortEntries, ['source-package-inventory.json', '{}']];
  write(join(f.directory, 'onnxruntime-source.tar.gz'), tarGzip(entries));
  f.reseal({ rebuildManifest: true });
  assert.throws(f.validate, /source archive verification failed/);
});

test('requires populated observed image and toolchain package evidence', t => {
  const f = fixture(t);
  f.mutate('container-image.json', value => { value[0].Id = `sha256:${digest('another image')}`; });
  f.reseal(); f.validate();
  write(join(f.directory, 'container-image.json'), []); f.reseal(); assert.throws(f.validate, /container image identity/);
  write(join(f.directory, 'container-image.json'), [{ Id: `sha256:${digest('image')}`, Os: 'linux', Architecture: 'amd64' }]);
  write(join(f.directory, 'toolchain-packages.tsv'), '\n'); f.reseal(); assert.throws(f.validate, /toolchain package/);
});

test('sealing generates the manifest and supports consume then revalidation', t => {
  const f = fixture(t);
  const sealed = sealNativeArtifact(f.directory, f.workspace, { sha: f.sha });
  assert.equal(sealed.receipt.sha, f.sha);
  assert.equal(sealed.receipt.files['mpv-2.dll'], fileHash(join(f.directory, 'mpv-2.dll')));
  consumeNativeArtifact(f.directory, f.workspace);
  f.validate();
  assert.deepEqual(nativeCheckoutInputs(f.workspace).originalManifest, sealed.manifest);
  assert.deepEqual(sealNativeArtifact(f.directory, f.workspace).manifest, sealed.manifest);
});

test('sealing rejects runtime bytes inconsistent with build evidence', t => {
  const f = fixture(t);
  write(join(f.directory, 'mpv-2.dll'), 'changed');
  assert.throws(() => sealNativeArtifact(f.directory, f.workspace), /evidence does not match/);
});

test('sealing rejects linked output leaves before writing and preserves external bytes', t => {
  const f = fixture(t);
  for (const name of ['effective-native-manifest.json', 'native-build-artifact.json']) {
    const output = join(f.directory, name), original = readFileSync(output), external = join(f.root, `outside-${name}`);
    write(external, 'external sentinel'); rmSync(output);
    try { symlinkSync(external, output); } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      linkSync(external, output);
    }
    assert.throws(() => sealNativeArtifact(f.directory, f.workspace), /symlink|hard-linked/);
    assert.equal(readFileSync(external, 'utf8'), 'external sentinel');
    rmSync(output); write(output, original);
  }
});

test('consume rejects a linked destination ancestor before copying outside the workspace', t => {
  const f = fixture(t), outside = join(f.root, 'outside-work'); mkdirSync(outside);
  symlinkSync(outside, join(f.workspace, 'work'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => consumeNativeArtifact(f.directory, f.workspace), /symlink ancestor/);
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(read(join(f.workspace, 'native/runtime-windows-x64.json')), f.originalManifest);
});

test('consume refuses a hard-linked original manifest even when its bytes are correct', t => {
  const f = fixture(t), manifest = join(f.workspace, 'native/runtime-windows-x64.json'), external = join(f.root, 'outside-manifest.json');
  copyFileSync(manifest, external); rmSync(manifest); linkSync(external, manifest);
  assert.throws(() => consumeNativeArtifact(f.directory, f.workspace), /must not be hard-linked/);
  assert.deepEqual(read(external), f.originalManifest);
});

test('checks extracted source recipes and every native evidence copy using a separate reference checkout', t => {
  const f = fixture(t); f.copySource(); assert.equal(f.validateSource(), true);
  write(join(f.source, 'native/runtime-windows-x64.json'), f.originalManifest);
  assert.throws(f.validateSource, /Source package omits or changes/);
  f.copySource(); write(join(f.source, 'scripts/native-build.sh'), 'changed recipe');
  assert.throws(f.validateSource, /recipe differs/);
  f.copySource(); write(join(f.source, 'native-sources/libmpv/correspondingSource-libmpv-source.tar.gz'), 'changed source');
  assert.throws(f.validateSource, /evidence changed/);
  f.copySource(); write(join(f.source, 'native-sources/onnxruntime/extra.dll'), 'unexpected');
  assert.throws(f.validateSource, /source evidence files/);
  assert.throws(() => assertEffectiveManifestInSource(f.source, f.directory), /reference checkout/);
});

test('rejects symlinked artifact roots, source ancestry and native input ancestry', t => {
  const f = fixture(t), linked = join(f.root, 'linked-artifact');
  symlinkSync(f.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateNativeArtifact(linked, f.workspace), /symlink ancestor/);
  f.copySource();
  const extracted = join(f.root, 'extracted'); mkdirSync(extracted);
  symlinkSync(join(f.source, 'native'), join(extracted, 'native'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertEffectiveManifestInSource(extracted, f.directory, f.sourceOptions), /symlink/);
  const scripts = join(f.workspace, 'scripts'), outside = join(f.root, 'outside-scripts'); mkdirSync(outside);
  for (const name of ['native-build.sh', 'native-source-inputs.py', 'native-build-evidence.py']) copyFileSync(join(scripts, name), join(outside, name));
  rmSync(scripts, { recursive: true }); symlinkSync(outside, scripts, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(f.validate, /symlink/);
});
