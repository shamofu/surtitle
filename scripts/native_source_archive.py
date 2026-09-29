# SPDX-License-Identifier: GPL-3.0-or-later
"""Deterministic source archives shared by the native artifact producers.

Producers select and authenticate their inputs. The existing independent checker
then verifies the generated archive against the producer's expected inventory.
"""
import gzip
import hashlib
import json
import subprocess
import sys
import tarfile
from pathlib import Path


def sha256_file(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_source_archive(destination, entries, expectations):
    """Write sorted regular files with fixed metadata, then verify their contents."""
    with Path(destination).open('wb') as raw:
        with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                for path, name in sorted(entries, key=lambda entry: entry[1]):
                    path = Path(path)
                    if path.is_symlink() or not path.is_file():
                        raise ValueError('Source archive input must be a regular file: ' + str(path))
                    info = tarfile.TarInfo(name)
                    info.size = path.stat().st_size
                    info.mode = 0o644
                    with path.open('rb') as stream:
                        archive.addfile(info, stream)
    subprocess.run(
        [sys.executable, str(Path(__file__).with_name('native-source-archive-check.py')), str(destination)],
        input=json.dumps(expectations), text=True, check=True,
    )
