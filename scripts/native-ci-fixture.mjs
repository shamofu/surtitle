import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { nativeDigest, nativeRecipePaths, ortRecipePaths } from './native-ci-git.mjs';
import { nativeArtifactFiles, effectiveNativeManifest, validateNativeArtifact, assertEffectiveManifestInSource } from './native-ci-contract.mjs';

export const digest = nativeDigest;
export const fileHash = path => digest(readFileSync(path));
export function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n');
}
export const read = path => JSON.parse(readFileSync(path, 'utf8'));
export function tarGzip(entries) {
  const blocks = [];
  for (const [name, value] of entries) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(name) <= 100);
    header.write(name, 0);
    const octal = (offset, size, number) => header.write(number.toString(8).padStart(size - 1, '0') + '\0', offset, size);
    octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, bytes.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle native 日本語 & '));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'artifact'), workspace = join(root, 'workspace'), source = join(root, 'source');
  for (const path of [directory, workspace, source]) mkdirSync(path);
  const ortCommit = 'b'.repeat(40), sha = 'a'.repeat(40);
  const sources = [
    { id: 'mpv', file: 'mpv.tar.gz', sha256: digest('original mpv source'), license: 'GPL-2.0-or-later' },
    { id: 'ffmpeg', file: 'ffmpeg.tar.gz', sha256: digest('original FFmpeg source'), license: 'GPL-3.0-or-later' },
  ];
  for (const path of [...nativeRecipePaths, ...ortRecipePaths]) write(join(workspace, path), `checkout recipe ${path}`);
  for (const path of ['scripts/native-ci-build.sh', 'scripts/native-ci-inputs.py', 'scripts/native-ci-build-inside.sh', 'native/onnxruntime-LICENSE', 'native/onnxruntime-ThirdPartyNotices.txt']) {
    write(join(workspace, path), `checkout build input ${path}`);
  }
  write(join(workspace, '.gitattributes'), '* -text\n');
  write(join(workspace, 'native/build/sources.json'), { schemaVersion: 1, sources });
  const mpvSources = sources.map(item => ({ ...item, retainedNotices: [{ file: 'LICENSE', sha256: digest(`${item.id} notice`) }] }));
  write(join(workspace, 'native/reviews/libmpv-dependencies.json'), { schemaVersion: 1, sources: mpvSources });
  write(join(workspace, 'native/reviews/libmpv.json'), { sourceComplete: true, noticesComplete: true });
  write(join(workspace, 'native/reviews/onnxruntime.json'), { sourceComplete: true, noticesComplete: true });
  const ortEntries = [
    [`sources/onnxruntime-${ortCommit}.tar.gz`, 'original ORT source'],
    ['sources/abseil.tar.gz', 'original abseil source'], ['ports/abseil/fix.patch', 'committed patch'], ['notices/abseil/LICENSE', 'committed notice'],
    ...ortRecipePaths.map(path => [path, readFileSync(join(workspace, path))]),
  ];
  const ort = { schemaVersion: 1, componentId: 'onnxruntime', binarySha256: digest('official ORT DLL'), pdbSha256: digest('official ORT PDB'),
    observedChecksumRecords: 1181, unresolvedChecksumRecords: 0,
    components: [{ id: 'abseil', version: '1', license: 'Apache-2.0', sourceArchiveSha256: digest('original abseil source'),
      notices: [{ file: 'notices/abseil/LICENSE', sha256: digest('committed notice') }] }],
    files: ortEntries.map(([file, bytes]) => ({ file, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) })),
  };
  const ortIdentity = { sourceCommit: ortCommit, binarySha256: ort.binarySha256, pdbSha256: ort.pdbSha256, dllPdbIdentityMatches: true };
  write(join(workspace, 'native/reviews/onnxruntime-dependencies.json'), ort);
  write(join(workspace, 'native/upstream-evidence/onnxruntime-dependency-inventory.json'), ortIdentity);
  const originalManifest = { schemaVersion: 1, platform: 'windows-x64', components: [
    { id: 'libmpv', version: '0.41.0-local-candidate', format: 'source-build',
      runtimeFiles: [{ source: 'mpv-2.dll', target: 'mpv-2.dll', sha256: digest('distinct local candidate DLL') }],
      redistribution: { status: 'complete', reviewEvidence: { path: 'native/reviews/libmpv.json', sha256: fileHash(join(workspace, 'native/reviews/libmpv.json')) } } },
    { id: 'onnxruntime', version: '1.29.0', format: 'zip',
      runtimeFiles: [{ source: 'official/onnxruntime.dll', target: 'onnxruntime.dll', sha256: ort.binarySha256 }],
      redistribution: { status: 'complete', reviewEvidence: { path: 'native/reviews/onnxruntime.json', sha256: fileHash(join(workspace, 'native/reviews/onnxruntime.json')) } } },
  ], prerequisites: [{ id: 'microsoft-vc-runtime-x64', bundled: false }] };
  write(join(workspace, 'native/runtime-windows-x64.json'), originalManifest);
  const recipe = nativeRecipePaths.map(path => ({ path, sha256: fileHash(join(workspace, path)) }));
  const mpvEntries = [
    ...nativeRecipePaths.map(path => [`recipe/${path}`, readFileSync(join(workspace, path))]),
    ['archives/mpv.tar.gz', 'original mpv source'], ['archives/ffmpeg.tar.gz', 'original FFmpeg source'],
    ['notices/mpv/LICENSE', 'mpv notice'], ['notices/ffmpeg/LICENSE', 'ffmpeg notice'],
    ['evidence/logs/build.log', 'observed build log'],
  ];
  write(join(directory, 'mpv-2.dll'), 'new CI runtime DLL');
  write(join(directory, 'libmpv-source.tar.gz'), tarGzip(mpvEntries));
  write(join(directory, 'onnxruntime-source-inventory.json'), ort);
  write(join(directory, 'onnxruntime-source.tar.gz'), tarGzip([...ortEntries, ['source-package-inventory.json', readFileSync(join(directory, 'onnxruntime-source-inventory.json'))]]));
  const evidence = { schemaVersion: 1, status: 'candidate-needs-review', releaseEligible: false, recipe, sources: mpvSources,
    runtime: { file: 'mpv-2.dll', sha256: fileHash(join(directory, 'mpv-2.dll')), bytes: Buffer.byteLength('new CI runtime DLL') },
    correspondingSourceCandidate: { file: 'libmpv-candidate-source.tar.gz', sha256: fileHash(join(directory, 'libmpv-source.tar.gz')), bytes: readFileSync(join(directory, 'libmpv-source.tar.gz')).length },
  };
  write(join(directory, 'libmpv-build-evidence.json'), evidence);
  write(join(directory, 'toolchain-packages.tsv'), 'gcc-mingw-w64-x86-64\t13.2.0\tamd64\ncmake\t3.28.3\tamd64\n');
  write(join(directory, 'container-image.json'), [{ Id: `sha256:${digest('actual image')}`, Os: 'linux', Architecture: 'amd64' }]);
  const receipt = { schemaVersion: 3, sha, files: {} };
  for (const name of nativeArtifactFiles.filter(name => name !== 'effective-native-manifest.json')) receipt.files[name] = fileHash(join(directory, name));
  const inputs = { originalManifest, ortIdentity };
  const manifest = effectiveNativeManifest(inputs, receipt);
  write(join(directory, 'effective-native-manifest.json'), manifest);
  receipt.files['effective-native-manifest.json'] = fileHash(join(directory, 'effective-native-manifest.json'));
  write(join(directory, 'native-build-artifact.json'), receipt);
  const sourceOptions = { referenceWorkspace: workspace };
  const context = { root, directory, workspace, source, sha, originalManifest, ort, receipt, manifest, sourceOptions, mpvEntries, ortEntries };
  context.validate = () => validateNativeArtifact(directory, workspace);
  context.validateSource = () => assertEffectiveManifestInSource(source, directory, sourceOptions);
  context.mutate = (name, change) => { const value = read(join(directory, name)); change(value); write(join(directory, name), value); };
  context.reseal = ({ rebuildManifest = false } = {}) => {
    const receipt = read(join(directory, 'native-build-artifact.json'));
    receipt.files = Object.fromEntries(nativeArtifactFiles.map(name => [name, fileHash(join(directory, name))]));
    if (rebuildManifest) {
      write(join(directory, 'effective-native-manifest.json'), effectiveNativeManifest(inputs, receipt));
      receipt.files['effective-native-manifest.json'] = fileHash(join(directory, 'effective-native-manifest.json'));
    }
    write(join(directory, 'native-build-artifact.json'), receipt);
  };
  context.copySource = () => {
    for (const path of nativeRecipePaths) { mkdirSync(dirname(join(source, path)), { recursive: true }); copyFileSync(join(workspace, path), join(source, path)); }
    mkdirSync(join(source, 'native'), { recursive: true });
    copyFileSync(join(directory, 'effective-native-manifest.json'), join(source, 'native/runtime-windows-x64.json'));
    copyFileSync(join(directory, 'native-build-artifact.json'), join(source, 'native/native-build-artifact.json'));
    const effective = read(join(directory, 'effective-native-manifest.json'));
    for (const component of effective.components) for (const field of ['correspondingSource', 'dependencyInventory', 'reviewEvidence']) {
      const evidence = component.redistribution[field], name = `${field}-${evidence.path.split('/').at(-1)}`;
      const origin = evidence.path.startsWith('work/native-ci-artifact/') ? join(directory, evidence.path.split('/').at(-1)) : join(workspace, evidence.path);
      write(join(source, 'native-sources', component.id, name), readFileSync(origin));
    }
  };
  return context;
}
