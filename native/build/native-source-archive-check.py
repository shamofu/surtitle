#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify generated native source tar contents against reviewed source inputs.

Usage: python native-source-archive-check.py ARCHIVE.tar.gz < expectations.json
Run during dependency generation, before exporting the source archive.
Nothing is extracted, downloaded, or written. Only regular tar members emitted
by the native package generators are supported; extended headers fail closed.
"""
import gzip
import hashlib
import json
import re
import sys
import tarfile
import unicodedata
from pathlib import Path

MIB = 1024 * 1024
MAX_JSON = 16 * MIB
MAX_COMPRESSED = 2 * 1024 * MIB
MAX_MEMBER = 1024 * MIB
MAX_TOTAL = 8 * 1024 * MIB
MAX_MEMBERS = 10_000
MAX_EVIDENCE_MEMBER = 64 * MIB
MAX_EXTRA_EVIDENCE = 256 * MIB
MAX_PADDING = MIB
INVENTORY_PATH = 'source-package-inventory.json'
DIGEST = re.compile(r'^[0-9a-f]{64}$')
WINDOWS_RESERVED = re.compile(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', re.I)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def parse_json(data):
    def invalid_constant(value):
        raise ValueError('Invalid JSON constant: ' + value)
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique_object,
                      parse_constant=invalid_constant)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def safe_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 1024,
            'Invalid archive path')
    require(not any(ord(char) < 32 or ord(char) == 127 for char in value)
            and '\\' not in value and ':' not in value,
            'Unsafe archive path: ' + repr(value))
    parts = value.split('/')
    require(all(part not in ('', '.', '..') and not part.endswith((' ', '.'))
                and not WINDOWS_RESERVED.match(part) for part in parts),
            'Unsafe archive path: ' + repr(value))
    return value


def path_identity(value):
    return unicodedata.normalize('NFC', value).casefold()


def expected_files(items, path_key):
    require(isinstance(items, list) and 0 < len(items) <= MAX_MEMBERS,
            'Invalid expected file inventory')
    result, identities = {}, set()
    for item in items:
        require(isinstance(item, dict), 'Invalid expected file entry')
        path = safe_path(item.get(path_key))
        identity = path_identity(path)
        require(identity not in identities, 'Duplicate expected path: ' + path)
        identities.add(identity)
        digest = item.get('sha256')
        require(isinstance(digest, str) and DIGEST.fullmatch(digest),
                'Invalid expected SHA-256: ' + path)
        size = item.get('bytes')
        require(size is None or type(size) is int and 0 <= size <= MAX_MEMBER,
                'Invalid expected file size: ' + path)
        result[path] = {'sha256': digest, 'bytes': size}
    return result


def expectations(document):
    require(isinstance(document, dict) and document.get('schemaVersion') == 1,
            'Unsupported source archive expectations')
    kind = document.get('kind')
    require(kind in ('libmpv', 'onnxruntime'), 'Unknown native source archive kind')
    required = expected_files(document.get('files'), 'path')
    inventory = document.get('inventory')
    if kind == 'onnxruntime':
        require(isinstance(inventory, dict) and inventory.get('schemaVersion') == 1
                and inventory.get('componentId') == 'onnxruntime',
                'Missing ONNX Runtime inventory')
        listed = expected_files(inventory.get('files'), 'file')
        require(INVENTORY_PATH not in listed, 'Inventory cannot list itself')
        for path, expected in required.items():
            require(path in listed, 'Inventory omits required source: ' + path)
            require(listed[path]['sha256'] == expected['sha256']
                    and (expected['bytes'] is None or listed[path]['bytes'] == expected['bytes']),
                    'Inventory differs from reviewed expectations: ' + path)
        required = listed
    else:
        require(inventory is None, 'Unexpected libmpv inventory')
        require(all(path.startswith(('recipe/', 'archives/', 'notices/', 'evidence/'))
                    for path in required), 'Unexpected libmpv expected path')
    return kind, required, inventory


def exact_read(stream, size):
    data = stream.read(size)
    require(len(data) == size, 'Truncated source archive')
    return data


def verify_archive(archive_path, document):
    kind, required, inventory = expectations(document)
    path = Path(archive_path)
    require(path.is_file() and not path.is_symlink(), 'Source archive must be a regular file')
    require(0 < path.stat().st_size <= MAX_COMPRESSED, 'Source archive compressed size exceeds limit')
    seen, identities = set(), set()
    total, extra_evidence = 0, 0
    with gzip.open(path, 'rb') as stream:
        while True:
            header = exact_read(stream, tarfile.BLOCKSIZE)
            if header == bytes(tarfile.BLOCKSIZE):
                require(exact_read(stream, tarfile.BLOCKSIZE) == bytes(tarfile.BLOCKSIZE),
                        'Invalid source archive end marker')
                padding = 0
                while block := stream.read(64 * 1024):
                    padding += len(block)
                    require(padding <= MAX_PADDING and not any(block),
                            'Unexpected data after source archive end marker')
                break
            info = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
            # Inspect the raw header before any PAX/longname/sparse processing.
            require(info.type in (tarfile.REGTYPE, tarfile.AREGTYPE),
                    'Non-regular or extended archive member: ' + repr(info.name))
            require(not info.linkname, 'Unexpected archive link target')
            name = safe_path(info.name)
            identity = path_identity(name)
            require(identity not in identities, 'Duplicate or aliased archive path: ' + name)
            identities.add(identity)
            seen.add(name)
            require(len(seen) <= MAX_MEMBERS, 'Source archive member count exceeds limit')
            require(0 <= info.size <= MAX_MEMBER, 'Source archive member size exceeds limit: ' + name)
            total += info.size
            require(total <= MAX_TOTAL, 'Source archive total size exceeds limit')
            internal_inventory = kind == 'onnxruntime' and name == INVENTORY_PATH
            expected = required.get(name)
            if expected is None and not internal_inventory:
                require(kind == 'libmpv' and name.startswith('evidence/'),
                        'Unexpected source archive member: ' + name)
                extra_evidence += info.size
                require(info.size <= MAX_EVIDENCE_MEMBER and extra_evidence <= MAX_EXTRA_EVIDENCE,
                        'Source archive evidence size exceeds limit')
            if expected is not None and expected['bytes'] is not None:
                require(info.size == expected['bytes'], 'Source archive size mismatch: ' + name)
            if internal_inventory:
                require(info.size <= MAX_JSON, 'Internal source inventory exceeds size limit')
            remaining, digest, inventory_bytes = info.size, hashlib.sha256(), bytearray()
            while remaining:
                block = exact_read(stream, min(remaining, MIB))
                digest.update(block)
                if internal_inventory:
                    inventory_bytes.extend(block)
                remaining -= len(block)
            if expected is not None:
                require(digest.hexdigest() == expected['sha256'], 'Source archive checksum mismatch: ' + name)
            if internal_inventory:
                require(canonical_json(parse_json(inventory_bytes)) == canonical_json(inventory),
                        'Internal ONNX Runtime inventory differs from authenticated external inventory')
            padding = (-info.size) % tarfile.BLOCKSIZE
            require(not any(exact_read(stream, padding)), 'Nonzero source archive member padding: ' + name)
    missing = set(required) - seen
    if kind == 'onnxruntime' and INVENTORY_PATH not in seen:
        missing.add(INVENTORY_PATH)
    require(not missing, 'Source archive missing required members: ' + ', '.join(sorted(missing)))
    return {'schemaVersion': 1, 'kind': kind, 'verifiedMembers': len(seen),
            'requiredMembers': len(required), 'uncompressedFileBytes': total,
            'extraEvidenceBytes': extra_evidence}


def main():
    require(len(sys.argv) == 2, 'Usage: native-source-archive-check.py ARCHIVE.tar.gz < expectations.json')
    data = sys.stdin.buffer.read(MAX_JSON + 1)
    require(len(data) <= MAX_JSON, 'Source archive expectations exceed size limit')
    print(json.dumps(verify_archive(sys.argv[1], parse_json(data)), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, EOFError, tarfile.TarError) as error:
        print('Native source archive check failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
