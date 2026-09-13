import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { regular, validateInstallerExtraction, validateBundledResources, validateTemplate, writableDestination, assertSourcePackageBinding, assertInstallerNoticeBinding, verifyNsisApplication } from './native-installer-audit.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const windowsPrepareTest = { skip: process.platform !== 'win32', timeout: 20_000 };
function prepareFixture(t, { sourceResponse, contentType = 'application/octet-stream', cachedSource } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-installer-download 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const downloads = join(root, 'work/native-installer-downloads');
  for (const path of ['scripts', 'native', 'mock', 'target/.tauri/NSIS', 'work/native-installer-downloads']) {
    mkdirSync(join(root, path), { recursive: true });
  }
  cpSync(new URL('./native-installer-prepare.ps1', import.meta.url), join(root, 'scripts/native-installer-prepare.ps1'));
  const items = [
    { field: 'toolArchive', file: 'nsis.zip', url: 'https://github.com/example/nsis.zip' },
    { field: 'sourceArchive', file: 'nsis-src.tar.bz2', url: 'https://downloads.sourceforge.net/project/nsis/NSIS%203/nsis-src.tar.bz2' },
    { field: 'cacheOnlyPlugin', file: 'plugin.dll', url: 'https://github.com/example/plugin.dll' },
  ].map(item => ({ ...item, bytes: Buffer.from([0x50, 0x4b, 0, 0xff, ...Buffer.from(item.file)]) }));
  writeFileSync(join(root, 'native/installer-inputs.json'), JSON.stringify(Object.fromEntries(items.map(item =>
    [item.field, { file: item.file, url: item.url, sha256: digest(item.bytes) }]))));
  for (const item of items) writeFileSync(join(root, 'mock', item.file), item.field === 'sourceArchive' && sourceResponse !== undefined ? sourceResponse : item.bytes);
  if (cachedSource !== undefined) writeFileSync(join(downloads, items[1].file), cachedSource);
  writeFileSync(join(root, 'mock/responses.json'), JSON.stringify(items.map(item => ({
    url: item.url, file: item.file, contentType: item.field === 'sourceArchive' ? contentType : 'application/octet-stream',
  }))));
  const harness = join(root, 'mock-download.ps1');
  writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'
$global:downloadMockRoot = $PSScriptRoot
$global:downloadMockItems = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'mock/responses.json') -Raw | ConvertFrom-Json
function Invoke-WebRequest {
  param([string]$Uri, [string]$UserAgent, [string]$OutFile, [switch]$PassThru, [int]$TimeoutSec)
  $item = @($global:downloadMockItems | Where-Object { $_.url -eq $Uri })
  if ($item.Count -ne 1) { throw 'Unexpected mocked request.' }
  @{ uri = $Uri; userAgent = $UserAgent; outFile = $OutFile; passThru = [bool]$PassThru; timeoutSec = $TimeoutSec } |
    ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $global:downloadMockRoot 'requests.jsonl') -Encoding utf8
  [IO.File]::WriteAllBytes($OutFile, [IO.File]::ReadAllBytes((Join-Path $global:downloadMockRoot ('mock/' + $item[0].file))))
  return [pscustomobject]@{
    StatusCode = 200
    Headers = @{ 'Content-Type' = $item[0].contentType }
    BaseResponse = [pscustomobject]@{ RequestMessage = [pscustomobject]@{
      RequestUri = [Uri]'https://mirror.example.invalid/installer/source.tar.bz2?signature=must-not-be-logged'
    } }
  }
}
try {
  & (Join-Path $PSScriptRoot 'scripts/native-installer-prepare.ps1')
} catch {
  Write-Output ('SURTITLE_PREPARE_ERROR:' + $_.Exception.Message)
  exit 37
}
exit 0
`);
  const run = () => {
    const child = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', harness],
      { cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.ifError(child.error);
    const output = child.stdout + child.stderr;
    assert.equal(child.status, 37, output);
    const errors = child.stdout.split(/\r?\n/).filter(line => line.startsWith('SURTITLE_PREPARE_ERROR:'));
    assert.equal(errors.length, 1, output);
    const requests = existsSync(join(root, 'requests.jsonl'))
      ? readFileSync(join(root, 'requests.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, ''))) : [];
    for (const request of requests) {
      assert.equal(request.userAgent, 'Surtitle-installer-source-audit');
      assert.equal(request.passThru, true);
      assert.ok(request.timeoutSec > 0);
    }
    assert.ok(!output.includes('signature=must-not-be-logged'), output);
    return { output, error: errors[0].slice('SURTITLE_PREPARE_ERROR:'.length), requests };
  };
  return { root, downloads, items, run };
}

test('installer preparation downloads with a CLI User-Agent and promotes only all three pinned payloads', windowsPrepareTest, t => {
  const f = prepareFixture(t);
  const result = f.run();
  // This existing guard is after download validation and before archive extraction or other tools.
  assert.equal(result.error, 'Private NSIS tools already exist; audit the prepared receipt or use a fresh checkout.');
  assert.deepEqual(result.requests.map(request => request.uri), f.items.map(item => item.url));
  for (const item of f.items) {
    assert.deepEqual(readFileSync(join(f.downloads, item.file)), item.bytes);
    assert.equal(existsSync(join(f.downloads, item.file + '.partial')), false);
    assert.ok(result.output.includes(`Verified installer input ${item.file} against its pinned SHA-256.`));
  }
  assert.ok(result.output.includes('final-url=https://mirror.example.invalid/installer/source.tar.bz2'));
});

for (const [name, bytes, contentType] of [
  ['HTTP 200 HTML landing page', Buffer.from('<!doctype html><title>SourceForge download</title>'), 'text/html'],
  ['modified binary download', Buffer.from([0x50, 0x4b, 0, 0xfe, 1, 2, 3]), 'application/octet-stream'],
]) {
  test(`installer preparation rejects a ${name} without promoting the unverified input`, windowsPrepareTest, t => {
    const f = prepareFixture(t, { sourceResponse: bytes, contentType });
    const result = f.run();
    assert.match(result.error, /^Installer download checksum mismatch for nsis-src\.tar\.bz2:/);
    assert.ok(result.error.includes(`expected ${digest(f.items[1].bytes)}, received ${digest(bytes)}`));
    assert.equal(result.requests.length, 2);
    assert.deepEqual(readFileSync(join(f.downloads, f.items[0].file)), f.items[0].bytes);
    assert.equal(existsSync(join(f.downloads, f.items[1].file)), false);
    assert.deepEqual(readFileSync(join(f.downloads, f.items[1].file + '.partial')), bytes);
    assert.equal(existsSync(join(f.downloads, f.items[2].file)), false);
    assert.ok(result.output.includes(`status=200; content-type=${contentType}`));
  });
}

test('installer preparation rejects a modified cached input without treating it as verified', windowsPrepareTest, t => {
  const cachedSource = Buffer.from('unverified cached source archive');
  const f = prepareFixture(t, { cachedSource });
  const result = f.run();
  assert.equal(result.error, 'Installer input checksum mismatch for nsis-src.tar.bz2.');
  assert.deepEqual(result.requests.map(request => request.uri), [f.items[0].url]);
  assert.deepEqual(readFileSync(join(f.downloads, f.items[1].file)), cachedSource);
  assert.equal(existsSync(join(f.downloads, f.items[2].file)), false);
  assert.ok(!result.output.includes('Verified installer input nsis-src.tar.bz2'));
});

test('accepts only the complete-file-equivalent single Tauri UNK to NSS marker transformation', () => {
  const original = Buffer.from('MZ-prefix\0__TAURI_BUNDLE_TYPE_VAR_UNK\0unchanged executable and resources');
  const embedded = Buffer.from(original.toString().replace('_VAR_UNK', '_VAR_NSS'));
  const evidence = verifyNsisApplication(original, embedded);
  assert.equal(evidence.originalSha256, digest(original));
  assert.equal(evidence.embeddedSha256, digest(embedded));
  assert.equal(evidence.markerOffset, 10);
  assert.deepEqual(evidence.changedOffsets, [34, 35, 36]);
  assert.equal(evidence.byteLength, original.length);
});
test('rejects arbitrary PE/resource/signature changes despite a valid marker', () => {
  const original = Buffer.from('MZ-header__TAURI_BUNDLE_TYPE_VAR_UNK-executable');
  const embedded = Buffer.from(original.toString().replace('_VAR_UNK', '_VAR_NSS'));
  const altered = Buffer.from(embedded);
  altered[0] ^= 1;
  assert.throws(() => verifyNsisApplication(original, altered), /outside the exact/);
  assert.throws(() => verifyNsisApplication(original, Buffer.concat([embedded, Buffer.from('signature')])), /byte lengths/);
  assert.throws(() => verifyNsisApplication(original, original), /corresponding NSIS marker/);
});
test('rejects duplicate, missing, shifted or already patched bundle markers', () => {
  const original = Buffer.from('prefix__TAURI_BUNDLE_TYPE_VAR_UNK-suffix');
  const embedded = Buffer.from(original.toString().replace('_VAR_UNK', '_VAR_NSS'));
  assert.throws(() => verifyNsisApplication(Buffer.concat([original, original]), Buffer.concat([embedded, embedded])), /one unpatched/);
  assert.throws(() => verifyNsisApplication(embedded, embedded), /one unpatched/);
  assert.throws(() => verifyNsisApplication(original, Buffer.from('prefixx__TAURI_BUNDLE_TYPE_VAR_NSSsuffix')), /corresponding NSIS marker/);
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-installer-audit-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const extracted = join(root, 'extracted');
  const put = (name, bytes) => { const path = join(extracted, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes); };
  mkdirSync(join(root, 'native'));
  writeFileSync(join(root, 'native/vc-prerequisite.ps1'), 'prerequisite');
  for (const [name, bytes] of [
    ['$PLUGINSDIR/System.dll', 'system'], ['$PLUGINSDIR/surtitle_nsis_utils.dll', 'reviewed plugin'],
    ['$PLUGINSDIR/surtitle-vc-prerequisite.ps1', 'prerequisite'], ['notices/installer/COPYING', 'source notice'],
  ]) put(name, bytes);
  const inputs = { embeddedFiles: [{ file: '$PLUGINSDIR/System.dll', sha256: digest('system') }] };
  const receipt = { plugin: { file: 'surtitle_nsis_utils.dll', sha256: digest('reviewed plugin') }, notices: [{ file: 'notices/installer/COPYING', sha256: digest('source notice') }] };
  return { root, extracted, put, inputs, receipt };
}
test('binds the actual embedded plugin and notices rather than accepting the cache input', t => {
  const f = fixture(t);
  assert.equal(validateInstallerExtraction(f.extracted, f.inputs, f.receipt, f.root).length, 4);
  f.put('$PLUGINSDIR/surtitle_nsis_utils.dll', 'different plugin');
  assert.throws(() => validateInstallerExtraction(f.extracted, f.inputs, f.receipt, f.root), /Changed installer evidence/);
});
test('rejects the upstream prebuilt plugin even when the reviewed alias is also present', t => {
  const f = fixture(t);
  f.put('$PLUGINSDIR/nsis_tauri_utils.dll', 'upstream cache-only plugin');
  assert.throws(() => validateInstallerExtraction(f.extracted, f.inputs, f.receipt, f.root), /prebuilt utility/);
});
test('rejects omitted notices and unreviewed transient installer components', t => {
  const f = fixture(t);
  f.put('$PLUGINSDIR/extra.dll', 'extra');
  assert.throws(() => validateInstallerExtraction(f.extracted, f.inputs, f.receipt, f.root), /Unexpected transient/);
  rmSync(join(f.extracted, '$PLUGINSDIR/extra.dll'));
  rmSync(join(f.extracted, 'notices/installer/COPYING'));
  assert.throws(() => validateInstallerExtraction(f.extracted, f.inputs, f.receipt, f.root), /ENOENT/);
});
test('rejects traversal and directory junctions in extracted evidence', t => {
  const f = fixture(t);
  assert.throws(() => regular(f.extracted, '../native/vc-prerequisite.ps1'), /Unsafe/);
  symlinkSync(join(f.extracted, 'notices'), join(f.extracted, 'linked'), 'junction');
  assert.throws(() => regular(f.extracted, 'linked/installer/COPYING'), /regular ancestry/);
  assert.throws(() => writableDestination(join(f.extracted, 'linked/new-directory/notice')), /regular ancestry/);
});

function resourceFixture(t) {
  const f = fixture(t);
  const staged = join(f.root, 'src-tauri/resources');
  mkdirSync(join(staged, 'native'), { recursive: true });
  mkdirSync(join(staged, 'notices'), { recursive: true });
  writeFileSync(join(staged, 'native/runtime.dll'), 'reviewed runtime');
  writeFileSync(join(staged, 'native/LICENSE'), 'runtime notice');
  for (const name of ['javascript.txt', 'rust.html', 'README.txt']) writeFileSync(join(staged, 'notices', name), name + ' complete source notice');
  writeFileSync(join(f.root, 'src-tauri/tauri.conf.json'), JSON.stringify({ bundle: { resources: { 'resources/native/': 'native/', 'resources/notices/': 'notices/' } } }));
  writeFileSync(join(f.root, 'native/runtime-windows-x64.json'), JSON.stringify({ components: [{
    runtimeFiles: [{ target: 'runtime.dll', sha256: digest('reviewed runtime') }],
    noticeFiles: [{ path: 'native/LICENSE', sha256: digest('runtime notice') }],
  }] }));
  cpSync(join(f.extracted, 'notices/installer'), join(staged, 'notices/installer'), { recursive: true });
  cpSync(staged, f.extracted, { recursive: true });
  f.put('surtitle.exe', 'application fixture');
  f.put('uninstall.exe', 'uninstaller fixture');
  return { ...f, staged, validate: () => validateBundledResources(f.extracted, f.root, f.receipt.notices) };
}

test('checks complete bundled application notices and resources against reviewed staged files', t => {
  const f = resourceFixture(t);
  assert.equal(f.validate().length, 6);
  f.put('notices/rust.html', 'truncated');
  assert.throws(f.validate, /complete staged notices/);
});

test('rejects missing JavaScript notices and unplanned tools even when staged and packaged together', t => {
  const f = resourceFixture(t);
  rmSync(join(f.staged, 'notices/javascript.txt'));
  rmSync(join(f.extracted, 'notices/javascript.txt'));
  assert.throws(f.validate, /ENOENT/);
  writeFileSync(join(f.staged, 'notices/javascript.txt'), 'complete notice');
  writeFileSync(join(f.staged, 'native/ffmpeg.exe'), 'unexpected download');
  f.put('native/ffmpeg.exe', 'unexpected download');
  assert.throws(f.validate, /Unmanifested native resource/);
});

test('rejects extra extracted payloads and linked notice directories', t => {
  const f = resourceFixture(t);
  f.put('native/unreviewed.dll', 'extra runtime');
  assert.throws(f.validate, /complete staged notices/);
  rmSync(join(f.extracted, 'native/unreviewed.dll'));
  symlinkSync(join(f.staged, 'notices'), join(f.extracted, 'notices/linked'), 'junction');
  assert.throws(f.validate, /must not traverse links/);
});

test('rejects executable or model payloads hidden alongside notices or at the extraction root', t => {
  const f = resourceFixture(t);
  for (const name of ['model.onnx', 'deno.exe']) {
    writeFileSync(join(f.staged, 'notices', name), 'unexpected payload');
    f.put('notices/' + name, 'unexpected payload');
    assert.throws(f.validate, /Unmanifested staged notice resource/);
    rmSync(join(f.staged, 'notices', name));
    rmSync(join(f.extracted, 'notices', name));
  }
  writeFileSync(join(f.staged, 'native/.gitkeep'), 'hidden executable');
  assert.throws(f.validate, /placeholder must be empty/);
  rmSync(join(f.staged, 'native/.gitkeep'));
  f.put('ffmpeg.exe', 'unexpected executable');
  assert.throws(f.validate, /top-level installer payload/);
});

test('staged source hashes must match the validated build, even after refreshing their own receipt', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'build-evidence.json'), 'build evidence');
  writeFileSync(join(f.root, 'rust-runtime-evidence.json'), 'runtime evidence');
  const inputs = { sourceArchive: { file: 'nsis.tar.bz2', sha256: digest('nsis') } };
  const evidence = { sourcePackage: { file: 'plugin.tar.gz', sha256: digest('plugin source') }, rustRuntimeSourcePackage: { file: 'rust.tar.gz', sha256: digest('rust source') } };
  const receipt = { sourcePackages: [inputs.sourceArchive, evidence.sourcePackage, evidence.rustRuntimeSourcePackage,
    { file: 'plugin-build-evidence.json', sha256: digest('build evidence') }, { file: 'rust-runtime-evidence.json', sha256: digest('runtime evidence') }] };
  assertSourcePackageBinding(receipt, inputs, evidence, f.root);
  receipt.sourcePackages[1] = { file: 'plugin.tar.gz', sha256: digest('stale plugin source') };
  assert.throws(() => assertSourcePackageBinding(receipt, inputs, evidence, f.root), /Staged source packages/);
});

test('rejects self-consistent omission or replacement of a notice required by original source evidence', () => {
  const inputs = { notices: [{ file: 'COPYING', sha256: digest('NSIS notice') }] };
  const evidence = { notices: [{ file: 'MIT.txt', sha256: digest('plugin copyright') }],
    runtimeNotices: [{ file: 'LICENSE', sha256: digest('Rust copyright') }] };
  const receipt = { notices: [
    { file: 'notices/installer/COPYING', sha256: digest('NSIS notice') },
    { file: 'notices/installer/plugin/MIT.txt', sha256: digest('plugin copyright') },
    { file: 'notices/installer/rust-runtime/LICENSE', sha256: digest('Rust copyright') },
  ] };
  assertInstallerNoticeBinding(receipt, inputs, evidence);
  const omitted = structuredClone(receipt); omitted.notices.pop();
  assert.throws(() => assertInstallerNoticeBinding(omitted, inputs, evidence), /required source-backed notices/);
  const replaced = structuredClone(receipt); replaced.notices[1].sha256 = digest('replacement notice');
  assert.throws(() => assertInstallerNoticeBinding(replaced, inputs, evidence), /required source-backed notices/);
});

test('validates helper includes and alias-only macro changes as well as the outer template', t => {
  const f = fixture(t);
  const template = '!include "utils.nsh"\n!include "{{installer_hooks}}"\n{{/if}}\n!addplugindir "${ADDITIONALPLUGINSPATH}"\nnsis_tauri_utils::RunAsUser\n';
  const helper = 'nsis_tauri_utils::FindProcessCurrentUser\n';
  writeFileSync(join(f.root, 'native/upstream.nsi'), template);
  writeFileSync(join(f.root, 'native/upstream.nsh'), helper);
  const transformed = template.replaceAll('nsis_tauri_utils::', 'surtitle_nsis_utils::')
    .replace('!include "utils.nsh"\n', '')
    .replace('!include "{{installer_hooks}}"\n{{/if}}', '!include "{{installer_hooks}}"\n{{/if}}\n!include "${SURTITLE_NATIVE_DIR}\\installer-utils.nsh"')
    .replace('!addplugindir "${ADDITIONALPLUGINSPATH}"', '!addplugindir "${ADDITIONALPLUGINSPATH}"\n!addplugindir "${SURTITLE_PLUGIN_DIR}"');
  writeFileSync(join(f.root, 'native/installer.nsi'), transformed);
  writeFileSync(join(f.root, 'native/installer-utils.nsh'), helper.replaceAll('nsis_tauri_utils::', 'surtitle_nsis_utils::'));
  mkdirSync(join(f.root, 'src-tauri'));
  writeFileSync(join(f.root, 'src-tauri/tauri.conf.json'), JSON.stringify({ bundle: { useLocalToolsDir: true, windows: { nsis: { template: '../native/installer.nsi', installerHooks: '../native/windows-prerequisite.nsh' } } } }));
  const inputs = { upstreamTemplate: { path: 'native/upstream.nsi', sha256: digest(template) }, upstreamHelpers: { path: 'native/upstream.nsh', sha256: digest(helper) } };
  validateTemplate(f.root, inputs);
  writeFileSync(join(f.root, 'native/installer-utils.nsh'), helper);
  assert.throws(() => validateTemplate(f.root, inputs), /helper macros/);
});
