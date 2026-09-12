#!/usr/bin/env python3
"""Verify private NSIS tools against the authenticated archive before/after use."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

workspace = Path(__file__).resolve().parent.parent
inputs = json.loads((workspace / 'native/installer-inputs.json').read_text(encoding='utf-8-sig'))
archive = workspace / 'work/native-installer-downloads' / inputs['toolArchive']['file']
tools = workspace / 'target/.tauri/NSIS'

def digest(path):
    for ancestor in [path, *path.parents]:
        if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
            raise RuntimeError('NSIS tool paths must not traverse links')
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

if digest(archive) != inputs['toolArchive']['sha256']:
    raise RuntimeError('NSIS tool archive changed')
expected = {}
with zipfile.ZipFile(archive) as bundle:
    for item in bundle.infolist():
        if item.is_dir():
            continue
        parts = item.filename.split('/')
        if parts[0] != 'nsis-3.11' or '..' in parts or len(parts) < 2:
            raise RuntimeError('Unexpected NSIS archive path')
        name = '/'.join(parts[1:])
        with bundle.open(item) as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest(tools / name) != checksum:
            raise RuntimeError('NSIS private tool changed: ' + name)
        expected[name] = checksum
extra = 'Plugins/x86-unicode/additional/nsis_tauri_utils.dll'
expected[extra] = inputs['cacheOnlyPlugin']['sha256']
if digest(tools / extra) != expected[extra]:
    raise RuntimeError('Tauri cache-only plugin changed')
observed = {path.relative_to(tools).as_posix() for path in tools.rglob('*') if path.is_file()}
if observed != set(expected):
    raise RuntimeError('Unexpected or missing private NSIS tool files')
print(json.dumps({'verifiedFiles': len(expected), 'toolArchiveSha256': inputs['toolArchive']['sha256']}))
