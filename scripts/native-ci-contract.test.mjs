import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { nativeArtifactFiles, validateNativeArtifact, assertEffectiveManifestInSource } from './native-ci-contract.mjs';

const sha = 'a'.repeat(40), ortCommit = 'b'.repeat(40);
const digest = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => digest(readFileSync(path));
const recipePaths = [
  'native/build/Dockerfile', 'native/build/sources.json', 'native/build/cross-win64.ini',
  'native/build/toolchain-win64.cmake', 'scripts/native-build.sh',
  'scripts/native-source-inputs.py', 'scripts/native-build-evidence.py',
];
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
function read(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle native 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'artifact'), workspace = join(root, 'workspace'), source = join(root, 'source');
  for (const path of [directory, workspace, source]) mkdirSync(path);
  const policyPath = join(workspace, 'native/build/reviewed-inputs.json');
  const sources = [{ id: 'mpv', sha256: digest('original mpv source'), license: 'GPL-2.0-or-later' },
    { id: 'ffmpeg', sha256: digest('original FFmpeg source'), license: 'GPL-3.0-or-later' }];
  for (const path of recipePaths) write(join(workspace, path), `reviewed recipe ${path}`);
  write(join(workspace, 'native/build/sources.json'), { schemaVersion: 1, sources });
  write(join(workspace, 'scripts/packaging.mjs'), 'reviewed packaging script');
  const ort = {
    schemaVersion: 1, componentId: 'onnxruntime', binarySha256: digest('official ORT DLL'), pdbSha256: digest('official ORT PDB'),
    observedChecksumRecords: 1181, unresolvedChecksumRecords: 0,
    components: [{ id: 'abseil', sourceArchiveSha256: digest('original abseil source') }],
    files: [{ file: `sources/onnxruntime-${ortCommit}.tar.gz`, sha256: digest('original ORT source') },
      { file: 'sources/abseil.tar.gz', sha256: digest('original abseil source') },
      { file: 'ports/abseil/fix.patch', sha256: digest('reviewed patch') },
      { file: 'notices/abseil/LICENSE', sha256: digest('reviewed notice') }],
  };
  write(join(workspace, 'native/reviews/onnxruntime-dependencies.json'), ort);
  const originalManifest = {
    schemaVersion: 1, platform: 'windows-x64',
    components: [
      { id: 'libmpv', version: '0.41.0-local-candidate', runtimeFiles: [{ source: 'mpv-2.dll', target: 'mpv-2.dll', sha256: digest('distinct local candidate DLL') }],
        redistribution: { status: 'complete', reviewEvidence: { path: 'native/reviews/libmpv.json', sha256: digest('review remains unchanged') } } },
      { id: 'onnxruntime', version: '1.29.0', runtimeFiles: [{ source: 'official/onnxruntime.dll', target: 'onnxruntime.dll', sha256: ort.binarySha256 }],
        redistribution: { status: 'complete' } },
    ],
    prerequisites: [{ id: 'microsoft-vc-runtime-x64', bundled: false }],
  };
  const policy = {
    schemaVersion: 1, recipe: recipePaths.map(path => ({ path, sha256: fileHash(join(workspace, path)) })), sources,
    inputs: [...recipePaths, 'scripts/packaging.mjs', 'native/reviews/onnxruntime-dependencies.json'].map(path => ({ path, sha256: fileHash(join(workspace, path)) })),
    ortBinarySha256: ort.binarySha256, ortSourceCommit: ortCommit, originalManifest,
    ortSourceFiles: Object.fromEntries(ort.files.map(item => [item.file, item.sha256])),
  };
  write(policyPath, policy);
  write(join(directory, 'mpv-2.dll'), 'new CI runtime DLL');
  write(join(directory, 'libmpv-source.tar.gz'), 'matching mpv source package');
  write(join(directory, 'onnxruntime-source.tar.gz'), 'matching ORT source package');
  write(join(directory, 'libmpv-build-evidence.json'), {
    schemaVersion: 1, status: 'candidate-needs-review', releaseEligible: false,
    recipe: policy.recipe, sources,
    runtime: { file: 'mpv-2.dll', sha256: fileHash(join(directory, 'mpv-2.dll')), bytes: Buffer.byteLength('new CI runtime DLL') },
    correspondingSourceCandidate: { file: 'libmpv-candidate-source.tar.gz', sha256: fileHash(join(directory, 'libmpv-source.tar.gz')), bytes: Buffer.byteLength('matching mpv source package') },
  });
  write(join(directory, 'onnxruntime-source-inventory.json'), ort);
  write(join(directory, 'toolchain-packages.tsv'), 'gcc-mingw-w64-x86-64\t13.2.0\tamd64\ncmake\t3.28.3\tamd64\n');
  write(join(directory, 'container-image.json'), [{ Id: `sha256:${digest('actual image')}`, Os: 'linux', Architecture: 'amd64' }]);
  const manifest = structuredClone(originalManifest);
  const mpv = manifest.components[0];
  mpv.version = `0.41.0-surtitle-ci-${sha.slice(0, 12)}`;
  mpv.localRuntimePath = 'work/native-ci-artifact';
  mpv.runtimeFiles[0].sha256 = fileHash(join(directory, 'mpv-2.dll'));
  for (const [component, archive, inventory] of [[mpv, 'libmpv-source.tar.gz', 'libmpv-build-evidence.json'],
    [manifest.components[1], 'onnxruntime-source.tar.gz', 'onnxruntime-source-inventory.json']]) {
    component.redistribution.correspondingSource = { path: `work/native-ci-artifact/${archive}`, sha256: fileHash(join(directory, archive)) };
    component.redistribution.dependencyInventory = { path: `work/native-ci-artifact/${inventory}`, sha256: fileHash(join(directory, inventory)) };
  }
  manifest.buildBinding = { sha, inputPolicySha256: fileHash(policyPath), artifactManifestPath: 'work/native-ci-artifact/native-build-artifact.json' };
  write(join(directory, 'effective-native-manifest.json'), manifest);
  const receipt = { schemaVersion: 1, sha, inputPolicySha256: fileHash(policyPath), reviewedInputs: policy.inputs,
    files: Object.fromEntries(nativeArtifactFiles.map(name => [name, fileHash(join(directory, name))])) };
  write(join(directory, 'native-build-artifact.json'), receipt);
  const context = { root, directory, workspace, source, policyPath, policy, manifest, receipt };
  context.validate = () => validateNativeArtifact(directory, workspace, sha);
  context.mutate = (name, change) => { const value = read(join(directory, name)); change(value); write(join(directory, name), value); };
  // Resealing transport hashes must not allow changing reviewed source or recipe identity.
  context.reseal = () => {
    const receipt = read(join(directory, 'native-build-artifact.json'));
    receipt.files = Object.fromEntries(nativeArtifactFiles.map(name => [name, fileHash(join(directory, name))]));
    write(join(directory, 'native-build-artifact.json'), receipt);
  };
  context.copySource = () => {
    mkdirSync(join(source, 'native'), { recursive: true });
    copyFileSync(join(directory, 'effective-native-manifest.json'), join(source, 'native/runtime-windows-x64.json'));
    copyFileSync(join(directory, 'native-build-artifact.json'), join(source, 'native/native-build-artifact.json'));
  };
  return context;
}

test('accepts same-SHA build while retaining a distinct reviewed local candidate hash', t => {
  const f = fixture(t), result = f.validate();
  assert.equal(result.files.length, 8);
  assert.notEqual(result.manifest.components[0].runtimeFiles[0].sha256, f.policy.originalManifest.components[0].runtimeFiles[0].sha256);
  assert.equal(read(join(f.directory, 'libmpv-build-evidence.json')).releaseEligible, false);
});
test('requires the exact expected SHA in both artifact and effective manifest', t => {
  const f = fixture(t);
  assert.throws(() => validateNativeArtifact(f.directory, f.workspace, 'b'.repeat(40)), /commit/);
  f.mutate('effective-native-manifest.json', value => { value.buildBinding.sha = 'b'.repeat(40); });
  f.reseal();
  assert.throws(f.validate, /Effective runtime manifest/);
});
test('rejects every missing payload and the omitted effective manifest hash', t => {
  const f = fixture(t);
  for (const name of nativeArtifactFiles) {
    const bytes = readFileSync(join(f.directory, name));
    rmSync(join(f.directory, name));
    assert.throws(f.validate, /missing native artifact files/);
    writeFileSync(join(f.directory, name), bytes);
  }
  f.mutate('native-build-artifact.json', value => { delete value.files['effective-native-manifest.json']; });
  assert.throws(f.validate, /hash entries/);
});
test('rejects unexpected files and every altered artifact before resealing', t => {
  const f = fixture(t);
  write(join(f.directory, 'unreviewed.dll'), 'unreviewed runtime');
  assert.throws(f.validate, /native artifact files/);
  rmSync(join(f.directory, 'unreviewed.dll'));
  for (const name of nativeArtifactFiles) {
    const bytes = readFileSync(join(f.directory, name));
    writeFileSync(join(f.directory, name), Buffer.concat([bytes, Buffer.from('tamper')]));
    assert.throws(f.validate, /checksum/);
    writeFileSync(join(f.directory, name), bytes);
  }
});
test('changed reviewed scripts, source catalog and recipe files fail on the same SHA', t => {
  const f = fixture(t);
  for (const name of ['scripts/packaging.mjs', 'native/build/sources.json', 'native/build/Dockerfile']) {
    const bytes = readFileSync(join(f.workspace, name));
    write(join(f.workspace, name), 'changed at the same commit');
    assert.throws(f.validate, /Reviewed native input changed/);
    writeFileSync(join(f.workspace, name), bytes);
  }
});
test('resealed changed recipe/source evidence cannot replace reviewed inputs', t => {
  const f = fixture(t), original = readFileSync(join(f.directory, 'libmpv-build-evidence.json'));
  for (const key of ['recipe', 'sources']) {
    f.mutate('libmpv-build-evidence.json', value => { value[key][0].sha256 = digest('unreviewed'); });
    f.reseal();
    assert.throws(f.validate, /differs from reviewed inputs/);
    writeFileSync(join(f.directory, 'libmpv-build-evidence.json'), original);
  }
  f.mutate('libmpv-build-evidence.json', value => { value.sources[0].license = 'MIT'; });
  f.reseal();
  assert.throws(f.validate, /source metadata differs/);
});
test('resealed DLL/source archives must still match build evidence', t => {
  const f = fixture(t);
  for (const name of ['mpv-2.dll', 'libmpv-source.tar.gz']) {
    const bytes = readFileSync(join(f.directory, name));
    write(join(f.directory, name), 'substituted');
    f.reseal();
    assert.throws(f.validate, /evidence does not match/);
    writeFileSync(join(f.directory, name), bytes);
  }
});
test('effective manifest cannot weaken reviewed configuration, redirect sources or substitute ORT DLLs', t => {
  const f = fixture(t), original = readFileSync(join(f.directory, 'effective-native-manifest.json'));
  for (const change of [
    value => { value.components[0].redistribution.status = 'unreviewed'; },
    value => { value.components[0].redistribution.correspondingSource.path = '../other/source.tar.gz'; },
    value => { value.components[1].runtimeFiles[0].sha256 = digest('other ORT DLL'); },
    value => { value.prerequisites[0].bundled = true; },
  ]) {
    f.mutate('effective-native-manifest.json', change); f.reseal();
    assert.throws(f.validate, /Effective runtime manifest/);
    writeFileSync(join(f.directory, 'effective-native-manifest.json'), original);
  }
});
test('rejects unknown, incomplete or altered ORT source evidence even after resealing', t => {
  const f = fixture(t), original = readFileSync(join(f.directory, 'onnxruntime-source-inventory.json'));
  for (const change of [
    value => { value.binarySha256 = digest('other binary'); },
    value => { value.unresolvedChecksumRecords = 1; },
    value => { value.files.shift(); },
    value => { value.files[0].sha256 = digest('changed ORT archive'); },
    value => { value.files[2].sha256 = digest('changed historical patch'); },
    value => { value.files[3].sha256 = digest('changed notice'); },
    value => { value.files.push({ file: 'ports/unreviewed.patch', sha256: digest('new patch') }); },
    value => { value.components[0].sourceArchiveSha256 = digest('changed dependency'); },
  ]) {
    f.mutate('onnxruntime-source-inventory.json', change); f.reseal();
    assert.throws(f.validate, /ONNX Runtime/);
    writeFileSync(join(f.directory, 'onnxruntime-source-inventory.json'), original);
  }
});
test('rejects altered policy, omitted or duplicate reviewed inputs and traversal paths', t => {
  const f = fixture(t), original = readFileSync(join(f.directory, 'native-build-artifact.json'));
  for (const change of [
    value => { value.inputPolicySha256 = digest('another policy'); },
    value => { value.reviewedInputs.pop(); },
    value => { value.reviewedInputs.push(value.reviewedInputs[0]); },
    value => { value.reviewedInputs[0].path = '../escape'; },
    value => { value.files['../escape'] = digest('escape'); },
  ]) {
    f.mutate('native-build-artifact.json', change);
    assert.throws(f.validate, /policy|inventory|duplicate|Unsafe|hash entries/);
    writeFileSync(join(f.directory, 'native-build-artifact.json'), original);
  }
});
test('requires populated image and package evidence, not a predetermined image hash', t => {
  const f = fixture(t);
  f.mutate('container-image.json', value => { value[0].Id = `sha256:${digest('another observed image')}`; });
  f.reseal(); f.validate();
  write(join(f.directory, 'container-image.json'), []); f.reseal();
  assert.throws(f.validate, /container image identity/);
  write(join(f.directory, 'container-image.json'), [{ Id: `sha256:${digest('image')}`, Os: 'linux', Architecture: 'amd64' }]);
  write(join(f.directory, 'toolchain-packages.tsv'), '\n'); f.reseal();
  assert.throws(f.validate, /toolchain package/);
});
test('rejects symlinked artifact files and reviewed input ancestors', t => {
  const f = fixture(t), path = join(f.directory, 'mpv-2.dll'), external = join(f.root, 'outside.dll');
  copyFileSync(path, external); rmSync(path);
  let fileSymlinkCreated = true;
  try { symlinkSync(external, path); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      // Directory junctions exercise the same lstat guard without Windows symlink privilege.
      fileSymlinkCreated = false;
      copyFileSync(external, path);
    } else throw error;
  }
  if (fileSymlinkCreated) {
    assert.throws(f.validate, /symlink/);
    rmSync(path); copyFileSync(external, path);
  }
  const scripts = join(f.workspace, 'scripts'), outside = join(f.root, 'outside-scripts');
  mkdirSync(outside);
  for (const name of ['native-build.sh', 'native-source-inputs.py', 'native-build-evidence.py', 'packaging.mjs']) copyFileSync(join(scripts, name), join(outside, name));
  rmSync(scripts, { recursive: true });
  symlinkSync(outside, scripts, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(f.validate, /symlink/);
});
test('checks effective manifest and receipt in the extracted source tree, rejecting omissions and stale candidate bytes', t => {
  const f = fixture(t);
  assert.throws(() => assertEffectiveManifestInSource(f.source, f.directory, sha), /ENOENT/);
  f.copySource(); assert.equal(assertEffectiveManifestInSource(f.source, f.directory, sha), true);
  write(join(f.source, 'native/runtime-windows-x64.json'), f.policy.originalManifest);
  assert.throws(() => assertEffectiveManifestInSource(f.source, f.directory, sha), /Source package omits or changes/);
  f.copySource(); rmSync(join(f.source, 'native/native-build-artifact.json'));
  assert.throws(() => assertEffectiveManifestInSource(f.source, f.directory, sha), /ENOENT/);
  f.copySource();
  assert.throws(() => assertEffectiveManifestInSource(f.source, f.directory, 'c'.repeat(40)), /commit/);
});
test('rejects source package symlink ancestors even when effective bytes are correct', t => {
  const f = fixture(t); f.copySource();
  const extracted = join(f.root, 'extracted'); mkdirSync(extracted);
  symlinkSync(join(f.source, 'native'), join(extracted, 'native'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertEffectiveManifestInSource(extracted, f.directory, sha), /symlink/);
});
test('rejects symlinked artifact root and a source receipt copied from another build', t => {
  const f = fixture(t), linked = join(f.root, 'linked-artifact');
  symlinkSync(f.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateNativeArtifact(linked, f.workspace, sha), /symlink ancestor/);
  f.copySource();
  const path = join(f.source, 'native/native-build-artifact.json'), receipt = read(path);
  receipt.sha = 'b'.repeat(40); write(path, receipt);
  assert.throws(() => assertEffectiveManifestInSource(f.source, f.directory, sha), /Source package omits or changes/);
});
