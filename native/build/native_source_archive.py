# SPDX-License-Identifier: GPL-3.0-or-later
"""Deterministic source archives shared by the native artifact producers."""
import gzip
import hashlib
import tarfile
from pathlib import Path


def sha256_file(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_source_archive(destination, entries):
    """Write sorted regular files with fixed metadata and portable member paths."""
    entries = sorted(entries, key=lambda entry: entry[1])
    names = set()
    for path, name in entries:
        if (not isinstance(name, str) or not name or any(char in name for char in '\\:\x00')
                or any(part in ('', '.', '..') for part in name.split('/')) or name in names):
            raise ValueError('Unsafe or duplicate source archive path: ' + str(name))
        names.add(name)
        if Path(path).is_symlink() or not Path(path).is_file():
            raise ValueError('Source archive input must be a regular file: ' + str(path))
    with Path(destination).open('wb') as raw:
        with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                for path, name in entries:
                    path = Path(path)
                    if path.is_symlink() or not path.is_file():
                        raise ValueError('Source archive input must be a regular file: ' + str(path))
                    info = tarfile.TarInfo(name)
                    info.size = path.stat().st_size
                    info.mode = 0o644
                    with path.open('rb') as stream:
                        archive.addfile(info, stream)
