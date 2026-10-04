// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('source archives ignore input order and filesystem timestamps and pass independent verification', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', String.raw`
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from native_source_archive import sha256_file, write_source_archive

with tempfile.TemporaryDirectory(prefix='surtitle archive ') as temporary:
    root = Path(temporary)
    recipe, source = root / 'recipe.py', root / 'source.tar.gz'
    recipe.write_bytes(b'reproducible recipe\n')
    source.write_bytes(bytes(range(256)) * 5000)
    entries = [(source, 'archives/source.tar.gz'), (recipe, 'recipe/build.py')]
    expected = {'schemaVersion': 1, 'kind': 'libmpv', 'files': [
        {'path': name, 'sha256': sha256_file(path), 'bytes': path.stat().st_size}
        for path, name in entries
    ]}
    first, second = root / 'first.tar.gz', root / 'second.tar.gz'
    write_source_archive(first, entries, expected)
    for path, _ in entries:
        os.utime(path, (1700000000, 1800000000))
    write_source_archive(second, reversed(entries), expected)
    assert first.read_bytes() == second.read_bytes(), 'Archive bytes depend on metadata or input order'
    with tarfile.open(first) as archive:
        members = archive.getmembers()
        assert [member.name for member in members] == sorted(name for _, name in entries)
        for member in members:
            assert member.isreg() and member.mode == 0o644
            assert member.uid == member.gid == member.mtime == 0
            assert member.uname == member.gname == ''
        assert archive.extractfile('archives/source.tar.gz').read() == source.read_bytes()
    source.write_bytes(b'changed after the expected inventory was prepared')
    try:
        write_source_archive(root / 'changed.tar.gz', entries, expected)
    except subprocess.CalledProcessError:
        pass
    else:
        raise AssertionError('Changed source content was accepted')
print('deterministic archives and independent content verification passed')
`, fileURLToPath(new URL('./', import.meta.url))], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /deterministic archives and independent content verification passed/);
}, 25_000);
