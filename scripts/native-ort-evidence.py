#!/usr/bin/env python3
"""Bind the official DLL/PDB and inventory actual link inputs; no review waiver."""
import collections
import hashlib
import json
import math
import mmap
import re
import struct
import sys
import uuid
from pathlib import Path

dll, pdb, listing, destination = map(Path, sys.argv[1:5])
def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
def u32(data, offset):
    return struct.unpack_from('<I', data, offset)[0]

data = dll.read_bytes()
pe = u32(data, 0x3c)
if data[pe:pe+4] != b'PE\0\0':
    raise SystemExit('Invalid PE')
optional = pe + 24
count = struct.unpack_from('<H', data, pe + 6)[0]
table = optional + struct.unpack_from('<H', data, pe + 20)[0]
def offset(rva):
    for i in range(count):
        section = table + i * 40
        start, raw_size, raw = struct.unpack_from('<III', data, section + 12)
        size = max(u32(data, section + 8), raw_size)
        if start <= rva < start + size:
            return raw + rva - start
    raise ValueError('RVA outside PE sections')
debug_rva, debug_size = struct.unpack_from('<II', data, optional + 112 + 6 * 8)
codeviews = []
for at in range(offset(debug_rva), offset(debug_rva) + debug_size, 28):
    if u32(data, at + 12) != 2:
        continue
    record = u32(data, at + 24)
    if data[record:record+4] == b'RSDS':
        codeviews.append((str(uuid.UUID(bytes_le=data[record+4:record+20])), u32(data, record+20)))
if len(codeviews) != 1:
    raise SystemExit('Expected one RSDS record')

with pdb.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as msf:
    if not msf[:32].startswith(b'Microsoft C/C++ MSF 7.00'):
        raise SystemExit('Unsupported PDB format')
    block_size, directory_size, block_map = u32(msf, 32), u32(msf, 44), u32(msf, 52)
    directory_blocks = math.ceil(directory_size / block_size)
    block_numbers = struct.unpack_from('<' + 'I' * directory_blocks, msf, block_map * block_size)
    directory = b''.join(msf[n*block_size:(n+1)*block_size] for n in block_numbers)[:directory_size]
    stream_count = u32(directory, 0)
    sizes = struct.unpack_from('<' + 'I' * stream_count, directory, 4)
    cursor = 4 + 4 * stream_count
    info = None
    for index, size in enumerate(sizes):
        blocks = 0 if size == 0xffffffff else math.ceil(size / block_size)
        numbers = struct.unpack_from('<' + 'I' * blocks, directory, cursor)
        cursor += 4 * blocks
        if index == 1:
            info = b''.join(msf[n*block_size:(n+1)*block_size] for n in numbers)[:size]
            break
    pdb_identity = (str(uuid.UUID(bytes_le=info[12:28])), u32(info, 8))
if codeviews[0] != pdb_identity:
    raise SystemExit('Official PDB does not match the DLL CodeView GUID/age')

text = listing.read_text(encoding='utf-8-sig')
libraries = collections.Counter(re.findall(r'Obj: `([^`]+\.lib)`', text))
file_records = re.findall(r'- \(SHA-256: ([A-Fa-f0-9]{64})\) ([^\r\n]+)', text)
headers = {}
compiled_sources = {}
for digest, name in file_records:
    if '\\vcpkg_installed\\' in name and '\\include\\' in name:
        headers[name.split('\\include\\', 1)[1]] = digest.lower()
    if '.clean\\' in name:
        compiled_sources[name] = digest.lower()
source_roots = sorted(set(re.findall(r'([^\s`]+\.clean)', text)))
report = {
    'schemaVersion': 1, 'componentId': 'onnxruntime', 'version': '1.29.0',
    'sourceCommit': '2e2543fbe9fae542f921d47a72d21d5a4ef0b710',
    'binarySha256': sha(dll), 'pdbSha256': sha(pdb),
    'codeViewGuid': pdb_identity[0], 'pdbAge': pdb_identity[1], 'dllPdbIdentityMatches': True,
    'moduleListing': {'sha256': sha(listing), 'producer': 'llvm-pdbutil-18 dump -modules -files'},
    'linkInputLibraries': [{'path': path, 'moduleCount': count} for path, count in sorted(libraries.items())],
    'observedSourceRoots': source_roots,
    'vcpkgHeaderChecksums': headers,
    'compiledSourceChecksums': compiled_sources,
    'vcpkgBaseline': '18a4723aeb7adbbae84bcff0edf510883800f32f',
    'releaseEligible': False,
    'remainingChecks': ['Collect matching vcpkg archives and overlay patches',
                        'Reconcile each compiled/header-only component with redistribution notices',
                        'Confirm applicable Microsoft runtime redistribution entitlement'],
}
destination.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'dllPdbIdentityMatches': True, 'linkInputLibraries': len(libraries),
                  'vcpkgHeaders': len(headers), 'releaseEligible': False}))
