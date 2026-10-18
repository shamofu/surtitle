#!/usr/bin/env python3
"""Verify and unpack the exact native source closure without implicit downloads."""
import hashlib
from native_source_manifest import read_sources
from pathlib import Path
import tarfile
import sys
import urllib.request

workspace = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
archive_root = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else destination.parent / 'source-cache'
archive_root.mkdir(parents=True, exist_ok=True)
manifest = read_sources(workspace)
destination.mkdir(parents=True, exist_ok=True)
for source in manifest['sources']:
    archive = archive_root / source['file']
    expected = source.get('sha256', '')
    if not archive.exists():
        if '--download' not in sys.argv or not source['url'].startswith('https://codeload.github.com/'):
            raise SystemExit(f"Source archive absent; explicitly fetch inputs first: {source['id']}")
        partial = archive.with_suffix(archive.suffix + '.partial')
        with urllib.request.urlopen(source['url'], timeout=90) as response, partial.open('wb') as out:
            while block := response.read(1024 * 1024):
                out.write(block)
        if hashlib.file_digest(partial.open('rb'), 'sha256').hexdigest() != expected:
            raise SystemExit(f"Downloaded source checksum mismatch: {source['id']}")
        partial.rename(archive)
    if len(expected) != 64 or hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() != expected:
        raise SystemExit(f"Source checksum mismatch: {source['id']}")
    if '--download-only' in sys.argv:
        continue
    target = destination / source['id'] if 'parent' not in source else destination / source['parent'] / source['destination']
    if not target.resolve().is_relative_to(destination):
        raise SystemExit('Source destination escapes the build directory')
    receipt = target / '.surtitle-source-sha256'
    if receipt.exists():
        if receipt.read_text() != expected:
            raise SystemExit(f"Source changed; use a fresh build volume: {source['id']}")
        continue
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        top = members[0].name.split('/')[0]
        for member in members:
            parts = member.name.split('/', 1)
            if parts[0] != top:
                raise SystemExit('Unexpected source archive root')
            if len(parts) == 1 or not parts[1]:
                continue
            member.name = parts[1]
            bundle.extract(member, target, filter='data')
    receipt.write_text(expected)
    print(f"Verified {source['id']} {source['commit']}", flush=True)
