# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded data-only intake. Never executes ZIP contents or starts Surtitle."""
import hashlib
import os
import re
import shutil
import stat
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_FILES = 512


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_url(url):
    value = urllib.parse.urlsplit(url)
    require(value.scheme == 'https' and value.hostname and not value.username and not value.password,
            'Evidence archive must use an HTTPS URL without embedded credentials')


def verify_archive(path, expected):
    require(bool(re.fullmatch(r'[a-fA-F0-9]{64}', expected)), 'Expected archive SHA256 is invalid')
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_ARCHIVE_BYTES,
            'Archive is missing, linked or exceeds the 128 MiB limit')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(65536), b''):
            digest.update(block)
    require(digest.hexdigest() == expected.lower(), 'Evidence archive SHA256 differs')


def extract_archive(path, destination, max_expanded_bytes=MAX_EXPANDED_BYTES, max_files=MAX_FILES):
    require(not destination.exists(), 'Existing evidence directory is protected')
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        require(len(entries) <= max_files, 'Evidence archive contains too many entries')
        require(sum(entry.file_size for entry in entries) <= max_expanded_bytes, 'Evidence archive exceeds the expanded-size limit')
        seen, regular = set(), set()
        reserved = {'CON', 'PRN', 'AUX', 'NUL'} | {prefix + str(i) for prefix in ('COM', 'LPT') for i in range(1, 10)}
        for entry in entries:
            # ZipInfo preserves the original header name but can normalize '\\'
            # on Windows or truncate NUL before exposing filename. Inspect both.
            original = entry.orig_filename
            require(original == entry.filename, 'Ambiguous normalized evidence ZIP path')
            name = original.rstrip('/')
            parts = name.split('/')
            require(name and '\\' not in name and all(part not in ('', '.', '..') and not part.startswith('.')
                    and not any(char in part for char in ':*?"<>|') and not any(ord(char) < 32 for char in part)
                    and part.split('.')[0].upper() not in reserved and not part.endswith((' ', '.'))
                    for part in parts), 'Unsafe evidence ZIP path')
            require(name.casefold() not in seen, 'Ambiguous case-insensitive ZIP path')
            seen.add(name.casefold())
            if not entry.is_dir():
                regular.add(name.casefold())
            mode = entry.external_attr >> 16
            require(not stat.S_ISLNK(mode) and (stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)),
                    'Linked or special ZIP entries are forbidden')
            require(not entry.flag_bits & 1, 'Encrypted evidence ZIP is unsupported')
        for entry in entries:
            parts = entry.filename.rstrip('/').casefold().split('/')
            require(not any('/'.join(parts[:i]) in regular for i in range(1, len(parts))),
                    'ZIP file conflicts with an evidence directory')
        require(any(entry.filename == 'report.json' and not entry.is_dir() for entry in entries),
                'ZIP must contain report.json at its root')
        destination.mkdir(parents=True)
        for entry in entries:
            target = destination.joinpath(*entry.filename.rstrip('/').split('/'))
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, target.open('xb') as output:
                    # ZipFile enforces CRC and declared uncompressed length.
                    shutil.copyfileobj(source, output, 65536)


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download_archive(url, expected, path):
    validate_url(url)
    require(bool(re.fullmatch(r'[a-fA-F0-9]{64}', expected)), 'Expected archive SHA256 is invalid')
    require(not path.exists(), 'Existing archive is protected')
    path.parent.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(HttpsRedirects())
    deadline, total = time.monotonic() + 180, 0
    with opener.open(url, timeout=15) as response, path.open('xb') as output:
        validate_url(response.geturl())
        if response.headers.get('Content-Length'):
            require(int(response.headers['Content-Length']) <= MAX_ARCHIVE_BYTES, 'Evidence download exceeds the size limit')
        while True:
            require(time.monotonic() < deadline, 'Evidence download exceeded its deadline')
            block = response.read1(65536)
            if not block:
                break
            total += len(block)
            require(total <= MAX_ARCHIVE_BYTES, 'Evidence download exceeds the size limit')
            output.write(block)
    verify_archive(path, expected)


if __name__ == '__main__':
    try:
        root = Path(__file__).resolve().parents[2] / 'work/evidence-intake'
        archive = root / 'input.zip'
        download_archive(os.environ['SURTITLE_EVIDENCE_URL'], os.environ['SURTITLE_EVIDENCE_SHA256'], archive)
        extract_archive(archive, root / 'payload')
        print('Evidence archive verified and extracted as data; no included files executed')
    except Exception as error:
        # Do not echo a presigned URL or transport exception containing its query.
        print(str(error) if isinstance(error, ValueError) else 'Evidence transport/ZIP validation failed', file=sys.stderr)
        raise SystemExit(1)
