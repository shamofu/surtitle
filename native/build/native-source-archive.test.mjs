// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('source archives retain current file contents with deterministic order and metadata', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', String.raw`
import os
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from native_source_archive import write_source_archive

with tempfile.TemporaryDirectory(prefix='surtitle archive ') as temporary:
    root = Path(temporary)
    recipe, source = root / 'recipe.py', root / 'source.tar.gz'
    recipe.write_bytes(b'reproducible recipe\n')
    source.write_bytes(bytes(range(256)) * 5000)
    entries = [(source, 'archives/source.tar.gz'), (recipe, 'recipe/build.py')]
    first, second = root / 'first.tar.gz', root / 'second.tar.gz'
    write_source_archive(first, entries)
    for path, _ in entries:
        os.utime(path, (1700000000, 1800000000))
    write_source_archive(second, reversed(entries))
    assert first.read_bytes() == second.read_bytes(), 'Archive bytes depend on metadata or input order'
    with tarfile.open(first) as archive:
        members = archive.getmembers()
        assert [member.name for member in members] == sorted(name for _, name in entries)
        for member in members:
            assert member.isreg() and member.mode == 0o644
            assert member.uid == member.gid == member.mtime == 0
            assert member.uname == member.gname == ''
        assert archive.extractfile('archives/source.tar.gz').read() == source.read_bytes()
    source.write_bytes(b'current source contents')
    changed = root / 'changed.tar.gz'
    write_source_archive(changed, entries)
    with tarfile.open(changed) as archive:
        assert archive.extractfile('archives/source.tar.gz').read() == b'current source contents'
    for name in ['../escape', '/absolute', 'a/../escape', 'a\\escape', 'C:/escape']:
        try:
            write_source_archive(root / 'unsafe.tar.gz', [(source, name)])
        except ValueError:
            pass
        else:
            raise AssertionError('Unsafe member path was accepted: ' + name)
print('deterministic archives, current contents and safe paths passed')
`, fileURLToPath(new URL('./', import.meta.url))], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /deterministic archives, current contents and safe paths passed/);
}, 25_000);
