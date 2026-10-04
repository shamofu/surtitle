import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('./', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const childTimeoutMs = 15_000;
const testBudget = childRuns => childRuns * childTimeoutMs + 5_000;

function runPython(args, input) {
  const result = spawnSync(python, args, {
    input, encoding: 'utf8', timeout: childTimeoutMs, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  });
  assert.ifError(result.error);
  return result;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle native inputs 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const catalog = {
    schemaVersion: 1, target: 'windows-x64', sources: [
      { id: 'mpv', repo: 'example/mpv', ref: 'v1.2.3', commit: 'a'.repeat(40), license: 'MIT' },
      { id: 'helper', repo: 'example/helper', commit: 'b'.repeat(40), parent: 'mpv', destination: 'vendor/helper', license: 'MIT' },
    ],
  };
  const cache = join(root, 'cache'), destination = join(root, 'sources');
  mkdirSync(cache);
  mkdirSync(join(root, 'native/build'), { recursive: true });
  const archivePaths = catalog.sources.map(source => join(cache, `${source.id}-${source.commit}.tar.gz`));
  const created = runPython(['-c', `
import io, json, tarfile, sys
for path, name, contents in json.loads(sys.stdin.read()):
    data = contents.encode('utf-8')
    with tarfile.open(path, 'w:gz') as archive:
        member = tarfile.TarInfo('upstream-root/' + name)
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
`], JSON.stringify([
    [archivePaths[0], 'LICENSE', 'fixture parent license'],
    [archivePaths[1], 'helper.c', 'fixture child source'],
  ]));
  assert.equal(created.status, 0, created.stderr);
  for (const [index, source] of catalog.sources.entries()) {
    source.sha256 = createHash('sha256').update(readFileSync(archivePaths[index])).digest('hex');
  }
  const writeCatalog = () => writeFileSync(join(root, 'native/build/sources.json'), JSON.stringify(catalog));
  writeCatalog();
  const readCatalog = () => runPython(['-c', `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from native_source_manifest import read_sources
print(json.dumps(read_sources(Path(sys.argv[2]))))
`, scripts, root]);
  const unpack = (...args) => runPython([join(scripts, 'native-source-inputs.py'), root, destination, cache, ...args]);
  return { catalog, writeCatalog, readCatalog, unpack, cache, destination, archivePaths };
}

test('a single submodule commit drives download coordinates and the parent evidence', t => {
  const f = fixture(t);
  const initial = f.readCatalog();
  assert.equal(initial.status, 0, initial.stderr);
  const [parent, child] = JSON.parse(initial.stdout).sources;
  assert.equal(parent.ref, 'v1.2.3');
  assert.equal(child.ref, 'b'.repeat(40));
  assert.equal(child.url, `https://codeload.github.com/example/helper/tar.gz/${'b'.repeat(40)}`);
  assert.equal(child.file, `helper-${'b'.repeat(40)}.tar.gz`);
  assert.deepEqual(parent.submodules, [{ path: 'vendor/helper', sha: child.commit }]);
  assert.deepEqual(child.submodules, []);
  f.catalog.sources[1].commit = 'c'.repeat(40);
  f.writeCatalog();
  const changed = f.readCatalog();
  assert.equal(changed.status, 0, changed.stderr);
  const [updatedParent, updatedChild] = JSON.parse(changed.stdout).sources;
  assert.equal(updatedChild.url, `https://codeload.github.com/example/helper/tar.gz/${'c'.repeat(40)}`);
  assert.equal(updatedChild.file, `helper-${'c'.repeat(40)}.tar.gz`);
  assert.equal(updatedChild.ref, 'c'.repeat(40));
  assert.equal(updatedParent.submodules[0].sha, 'c'.repeat(40));
}, testBudget(3));

test('the source consumer verifies cached archives and installs the child source under its parent', t => {
  const f = fixture(t), result = f.unpack();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.destination, 'mpv/LICENSE'), 'utf8'), 'fixture parent license');
  assert.equal(readFileSync(join(f.destination, 'mpv/vendor/helper/helper.c'), 'utf8'), 'fixture child source');
  assert.equal(readFileSync(join(f.destination, 'mpv/vendor/helper/.surtitle-source-sha256'), 'utf8'), f.catalog.sources[1].sha256);
  const cached = f.unpack();
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(cached.stdout, '');
  // Extraction receipts must not allow corrupted input archives on a later run.
  writeFileSync(f.archivePaths[0], 'corrupt archive after extraction');
  const corrupt = f.unpack();
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /Source checksum mismatch: mpv/);
}, testBudget(4));

test('download-only still verifies hashes and a bad pin cannot produce extracted source', t => {
  const f = fixture(t), checked = f.unpack('--download-only');
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(existsSync(join(f.destination, 'mpv')), false);
  f.catalog.sources[0].sha256 = '0'.repeat(64);
  f.writeCatalog();
  const rejected = f.unpack();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Source checksum mismatch: mpv/);
  assert.equal(existsSync(join(f.destination, 'mpv')), false);
}, testBudget(3));

test('an uncached source requires an explicit download request', t => {
  const f = fixture(t);
  rmSync(f.archivePaths[0]);
  const rejected = f.unpack();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Source archive absent; explicitly fetch inputs first: mpv/);
  assert.equal(existsSync(join(f.destination, 'mpv')), false);
}, testBudget(2));
