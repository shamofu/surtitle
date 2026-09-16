#!/usr/bin/env python3
"""Collect exact vcpkg archives/patches inside the audit container only."""
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path

def digest(path, algorithm='sha256'):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()

def is_vcpkg_api(url):
    parsed = urlsplit(url)
    return (parsed.scheme == 'https' and parsed.netloc == 'api.github.com'
            and not parsed.query and not parsed.fragment
            and re.fullmatch(r'/repos/microsoft/vcpkg/git/(?:trees|blobs)/[a-f0-9]{40}', parsed.path) is not None)


def validate_url(url):
    parsed = urlsplit(url)
    if not (is_vcpkg_api(url) or (parsed.scheme == 'https' and (
            parsed.netloc == 'codeload.github.com'
            or (parsed.netloc == 'gitlab.com' and parsed.path.startswith('/libeigen/eigen/'))))):
        raise ValueError('Unexpected upstream URL')


class SourceRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            redirected.remove_header('Authorization')
        return redirected


def request(url):
    validate_url(url)
    req = urllib.request.Request(url, headers={'User-Agent': 'Surtitle-corresponding-source-audit'})
    token = os.environ.get('SURTITLE_NATIVE_GITHUB_TOKEN') if is_vcpkg_api(url) else None
    if token:
        if '\r' in token or '\n' in token:
            raise ValueError('Invalid GitHub API token')
        # urllib does not copy unredirected headers to any redirected request.
        req.add_unredirected_header('Authorization', 'Bearer ' + token)
    opener = urllib.request.build_opener(SourceRedirectHandler())
    with opener.open(req, timeout=120) as response:
        return response.read()


def main(workspace, root):
    root.mkdir(parents=True, exist_ok=True)
    cache = root / 'archives'
    cache.mkdir(exist_ok=True)
    baseline = '18a4723aeb7adbbae84bcff0edf510883800f32f'
    baseline_archive = cache / ('vcpkg-' + baseline + '.tar.gz')
    if digest(baseline_archive) != 'a0414f2f0b75673b7e7872e392e3f0598c9c5d117348d4ca3fcec8562f6b6c38':
        raise SystemExit('Changed vcpkg baseline archive')
    with tarfile.open(baseline_archive) as archive:
        archive.extractall(root / 'registry', filter='data')
    registry = root / 'registry' / ('vcpkg-' + baseline)
    overlays = workspace / 'native/upstream-evidence/onnxruntime-overlay-ports'
    for required in ['abseil', 'cpuinfo', 'onnx', 'protobuf', 'eigen3']:
        if not (overlays / required / 'portfile.cmake').is_file():
            raise SystemExit('Required ONNX Runtime overlay is absent: ' + required)
    ports_root = root / 'ports'
    if ports_root.exists():
        raise SystemExit('ORT port staging must be fresh; reused overlays can retain unrelated baseline patches')
    ports_root.mkdir()
    packages = ['abseil', 'cpuinfo', 'onnx', 'protobuf', 're2', 'eigen3', 'nlohmann-json',
                'boost-config', 'boost-mp11', 'flatbuffers', 'ms-gsl', 'wil', 'safeint']
    result = []
    (root / 'source-inputs.json').write_text(json.dumps({'schemaVersion': 1, 'sources': [], 'complete': False, 'releaseEligible': False}) + '\n')
    for package in packages:
        port = ports_root / package
        if (overlays / package).is_dir():
            shutil.copytree(overlays / package, port, dirs_exist_ok=True)
            origin = 'onnxruntime-overlay'
        elif package == 'flatbuffers':
            versions = json.loads((registry / 'versions/f-/flatbuffers.json').read_text())['versions']
            selected = next(item for item in versions if '23.5.26' in item.values() and item.get('port-version', 0) == 0)
            tree_id = selected['git-tree']
            tree = json.loads(request('https://api.github.com/repos/microsoft/vcpkg/git/trees/' + tree_id))
            port.mkdir(exist_ok=True)
            for entry in tree['tree']:
                if entry['type'] != 'blob' or '/' in entry['path'] or entry.get('size', 0) > 1024 * 1024:
                    raise ValueError('Unexpected historical port entry')
                blob = json.loads(request('https://api.github.com/repos/microsoft/vcpkg/git/blobs/' + entry['sha']))
                (port / entry['path']).write_bytes(base64.b64decode(blob['content']))
            origin = 'vcpkg-history-' + tree_id
        else:
            shutil.copytree(registry / 'ports' / package, port, dirs_exist_ok=True)
            origin = 'vcpkg-baseline-' + baseline
        metadata = json.loads((port / 'vcpkg.json').read_text())
        version = next(metadata[key] for key in ['version', 'version-semver', 'version-string', 'version-date'] if key in metadata)
        recipe = (port / 'portfile.cmake').read_text()
        repository = re.search(r'\bREPO\s+([\w./-]+)', recipe).group(1)
        reference = re.search(r'\bREF\s+"?([^"\s)]+)', recipe).group(1).replace('${VERSION}', version)
        checksum = re.search(r'\bSHA512\s+([a-fA-F0-9]{128})', recipe).group(1).lower()
        if 'vcpkg_from_gitlab(' in recipe:
            url = 'https://gitlab.com/' + repository + '/-/archive/' + reference + '/' + repository.split('/')[-1] + '-' + reference + '.tar.gz'
        else:
            url = 'https://codeload.github.com/' + repository + '/tar.gz/' + reference
        filename = package + '-' + re.sub(r'[^a-zA-Z0-9_.-]', '_', reference) + '.tar.gz'
        archive_path = cache / filename
        if not archive_path.exists():
            temporary = archive_path.with_suffix('.partial')
            temporary.write_bytes(request(url))
            if digest(temporary, 'sha512') != checksum:
                raise ValueError('Upstream archive SHA512 differs from exact recipe: ' + package)
            temporary.rename(archive_path)
        if digest(archive_path, 'sha512') != checksum:
            raise ValueError('Changed source archive: ' + package)
        item = {'id': package, 'version': version, 'repository': repository, 'reference': reference,
                'url': url, 'file': filename, 'sha512': checksum, 'sha256': digest(archive_path),
                'bytes': archive_path.stat().st_size, 'license': metadata.get('license'), 'recipeOrigin': origin,
                'recipeFiles': [{'file': path.name, 'sha256': digest(path)} for path in sorted(port.iterdir()) if path.is_file()]}
        result.append(item)
        (root / 'source-inputs.json').write_text(json.dumps({'schemaVersion': 1, 'sources': result, 'complete': False, 'releaseEligible': False}, indent=2) + '\n')
        print(package + ': verified ' + checksum, flush=True)
    (root / 'source-inputs.json').write_text(json.dumps({'schemaVersion': 1, 'sources': result, 'complete': True, 'releaseEligible': False,
        'remainingChecks': ['Apply conditional patches and compare PDB source/header checksums', 'Per-component redistribution review and source packaging', 'Microsoft runtime entitlement']}, indent=2) + '\n')


if __name__ == '__main__':
    main(*map(Path, sys.argv[1:3]))
