// SPDX-License-Identifier: GPL-3.0-or-later
import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const checker = fileURLToPath(new URL('./native-source-archive-check.py', import.meta.url));
const childTimeoutMs = 15_000;
// Each sequential checker run retains its own deadline; allow five seconds for
// fixture setup and assertions. onTestFinished cleanup has a separate hook budget.
const testBudget = childRuns => childRuns * childTimeoutMs + 5_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const member = (path, contents, options = {}) => ({ path, contents: Buffer.from(contents), ...options });
const expected = entries => entries.map(entry => ({ path: entry.path, sha256: hash(entry.contents), bytes: entry.contents.length }));

// Keep fixtures independent of the checker and never extract untrusted archives.
function tar(entries, { tail = Buffer.alloc(1024) } = {}) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write((entry.size ?? entry.contents.length).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, entry.contents, Buffer.alloc((512 - entry.contents.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, tail]));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'surtitle source 日本語 & '));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'source.tar.gz');
  const entries = [member('recipe/scripts/native-build.sh', 'reviewed build recipe'),
    member('archives/mpv-fixed.tar.gz', 'unchanged upstream archive'),
    member('notices/mpv/LICENSE', 'required retained notice')];
  const document = { schemaVersion: 1, kind: 'libmpv', files: expected(entries) };
  const run = (content = tar(entries), request = document) => {
    writeFileSync(path, content);
    // A new gzip and outer digest for each mutation simulates resealed transport.
    const outerSha256 = hash(content);
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [checker, path], {
      input: typeof request === 'string' ? request : JSON.stringify(request), encoding: 'utf8', timeout: childTimeoutMs,
      windowsHide: true,
    });
    assert.ifError(result.error);
    return { ...result, outerSha256 };
  };
  return { entries, document, run };
}

function rejected(result, pattern) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, '');
}

test('streams required libmpv recipes, source archives and notices while allowing bounded build evidence', t => {
  const f = fixture(t);
  const result = f.run(tar([...f.entries, member('evidence/logs/build.log', 'observed compiler output')]));
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.requiredMembers, 3);
  assert.equal(report.verifiedMembers, 4);
  assert.equal(report.extraEvidenceBytes, Buffer.byteLength('observed compiler output'));
}, testBudget(1));

test.each(['recipe/', 'archives/', 'notices/'])('resealing cannot omit a required %s file', (prefix, t) => {
  const f = fixture(t);
  rejected(f.run(tar(f.entries.filter(entry => !entry.path.startsWith(prefix)))), /missing required members/);
}, testBudget(1));

test.each(['recipe/', 'archives/', 'notices/'])('resealing cannot change required %s bytes', (prefix, t) => {
  const f = fixture(t);
  const changed = f.entries.map(entry => entry.path.startsWith(prefix)
    ? { ...entry, contents: Buffer.alloc(entry.contents.length, 65) } : entry);
  const result = f.run(tar(changed));
  assert.notEqual(result.outerSha256, hash(tar(f.entries)));
  rejected(result, /checksum mismatch/);
}, testBudget(1));

test.each(['archives/extra.tar.gz', 'notices/extra/LICENSE', 'recipe/other.sh', 'runtime/mpv-2.dll'])(
  'rejects unlisted libmpv payload %s', (path, t) => {
    const f = fixture(t);
    rejected(f.run(tar([...f.entries, member(path, 'unreviewed')])), /Unexpected source archive member/);
  }, testBudget(1));

test.each(['../escape', '/absolute', 'C:/drive', 'evidence/../escape', 'evidence//alias', 'evidence/./alias',
  'evidence\\alias', 'evidence/trailing.', 'evidence/trailing ', 'evidence/file:stream', 'evidence/NUL', 'evidence/control\n'])(
  'rejects unsafe tar member path %j', (path, t) => {
    const f = fixture(t);
    rejected(f.run(tar([...f.entries, member(path, '')])), /Unsafe archive path/);
  }, testBudget(1));

test.each(['notices/mpv/LICENSE', 'NOTICES/MPV/license'])(
  'rejects duplicate or Windows-aliased path %s', (path, t) => {
    const f = fixture(t);
    rejected(f.run(tar([...f.entries, member(path, 'duplicate')])), /Duplicate or aliased archive path/);
  }, testBudget(1));

test.each(['1', '2', '3', '4', '5', '6', 'x', 'g', 'L', 'K', 'S'])(
  'rejects link, special or extended tar type %s before reading its contents', (type, t) => {
    const f = fixture(t);
    rejected(f.run(tar([...f.entries, member('evidence/unsupported', '', { type, size: 1024 ** 3 })])),
      /Non-regular or extended archive member/);
  }, testBudget(1));

test('rejects oversized source and evidence member headers without allocating their declared contents', t => {
  const f = fixture(t);
  rejected(f.run(tar([member('archives/mpv-fixed.tar.gz', '', { size: 1024 ** 3 + 1 })])), /member size exceeds limit/);
  rejected(f.run(tar([...f.entries, member('evidence/large.log', '', { size: 64 * 1024 ** 2 + 1 })])),
    /evidence size exceeds limit/);
}, testBudget(2));

test('requires complete tar end markers and a valid gzip checksum', t => {
  const f = fixture(t);
  rejected(f.run(tar(f.entries, { tail: Buffer.alloc(0) })), /Truncated source archive/);
  rejected(f.run(tar(f.entries, { tail: Buffer.alloc(512) })), /Truncated source archive/);
  const corrupted = tar(f.entries);
  corrupted[corrupted.length - 8] ^= 1;
  rejected(f.run(corrupted), /CRC check failed/);
}, testBudget(3));

test('rejects a second tar payload and excessive padding after the end marker', t => {
  const f = fixture(t);
  rejected(f.run(Buffer.concat([tar(f.entries), tar([member('evidence/hidden', 'hidden')])])), /after source archive end marker/);
  rejected(f.run(tar(f.entries, { tail: Buffer.alloc(1024 + 1024 ** 2 + 1) })), /after source archive end marker/);
}, testBudget(2));

test('validates expected inventory structure before reading the archive', t => {
  const f = fixture(t);
  const duplicate = { ...f.document, files: [...f.document.files, f.document.files[0]] };
  rejected(f.run(tar(f.entries), duplicate), /Duplicate expected path/);
  rejected(f.run(tar(f.entries), { ...f.document, files: [] }), /Invalid expected file inventory/);
  rejected(f.run(tar(f.entries), '{"schemaVersion":1,"schemaVersion":1}'), /Duplicate JSON key/);
}, testBudget(3));

function ortFixture(t) {
  const f = fixture(t);
  const entries = [member('sources/onnxruntime-fixed.tar.gz', 'original ORT source'),
    member('ports/abseil/fix.patch', 'reviewed patch'), member('notices/onnxruntime-LICENSE', 'retained MIT license'),
    member('scripts/native-ort-package.py', 'source packaging recipe'),
    member('evidence/generated-run.json', '{"observed":true}')];
  const inventory = { schemaVersion: 1, componentId: 'onnxruntime', binarySha256: hash('fixed DLL'),
    files: expected(entries).map(({ path, ...rest }) => ({ file: path, ...rest })) };
  const document = { schemaVersion: 1, kind: 'onnxruntime', files: expected(entries.slice(0, 4)), inventory };
  const pack = (files = entries, inner = inventory) => tar([...files,
    member('source-package-inventory.json', JSON.stringify(inner, null, 2) + '\n')]);
  return { ...f, entries, inventory, document, pack };
}

test('checks every ORT inventory member and the internal copy without requiring identical JSON formatting', t => {
  const f = ortFixture(t);
  const result = f.run(f.pack(), f.document);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verifiedMembers, f.entries.length + 1);
}, testBudget(1));

test('rejects ORT internal inventory omission or replacement even after transport resealing', t => {
  const f = ortFixture(t);
  rejected(f.run(tar(f.entries), f.document), /missing required members: source-package-inventory.json/);
  rejected(f.run(f.pack(f.entries, { ...f.inventory, binarySha256: hash('different DLL') }), f.document),
    /Internal ONNX Runtime inventory differs/);
}, testBudget(2));

test('rejects resealed ORT patch changes even when both claimed inventories are changed together', t => {
  const f = ortFixture(t);
  const changed = f.entries.map(entry => entry.path.startsWith('ports/') ? member(entry.path, 'changed patch') : entry);
  const inventory = { ...f.inventory, files: expected(changed).map(({ path, ...rest }) => ({ file: path, ...rest })) };
  rejected(f.run(f.pack(changed, inventory), { ...f.document, inventory }), /differs from reviewed expectations/);
}, testBudget(1));

test('rejects missing ORT licenses, unlisted patches and altered dynamic evidence bytes', t => {
  const f = ortFixture(t);
  rejected(f.run(f.pack(f.entries.filter(entry => !entry.path.startsWith('notices/'))), f.document), /missing required members/);
  rejected(f.run(f.pack([...f.entries, member('ports/extra.patch', 'unexpected')]), f.document), /Unexpected source archive member/);
  const changed = f.entries.map(entry => entry.path.startsWith('evidence/')
    ? { ...entry, contents: Buffer.alloc(entry.contents.length, 65) } : entry);
  rejected(f.run(f.pack(changed), f.document), /checksum mismatch: evidence\//);
}, testBudget(3));
