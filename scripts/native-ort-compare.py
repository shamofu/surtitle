#!/usr/bin/env python3
"""Compare exact upstream/patch inputs with the matching official PDB."""
import hashlib
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

workspace, root = map(Path, sys.argv[1:3])
inputs = json.loads((root / 'source-inputs.json').read_text())
evidence = json.loads((workspace / 'native/upstream-evidence/onnxruntime-dependency-inventory.json').read_text())
if inputs['complete'] is not True or evidence['dllPdbIdentityMatches'] is not True:
    raise SystemExit('Verified source inputs and matching DLL/PDB are required')
sources = {}
patch_results = []
for item in inputs['sources']:
    archive_path = root / 'archives' / item['file']
    with archive_path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha512').hexdigest() != item['sha512']:
            raise SystemExit('Changed source archive')
    destination = root / 'comparison-sources' / item['id']
    if destination.exists():
        raise SystemExit('Comparison requires fresh extracted sources: ' + str(destination))
    destination.mkdir(parents=True)
    with tarfile.open(archive_path) as archive:
        archive.extractall(destination, filter='data')
    children = list(destination.iterdir())
    if len(children) != 1 or not children[0].is_dir():
        raise SystemExit('Expected one archive root')
    # Keep build paths independent of the archive's versioned root directory.
    source = destination / 'source'
    if children[0] != source:
        children[0].rename(source)
    sources[item['id']] = source
    recipe = (root / 'ports' / item['id'] / 'portfile.cmake').read_text()
    match = re.search(r'\bPATCHES\s+([\s\S]*?)\)', recipe)
    patches = re.findall(r'[\w.+-]+\.patch', re.sub(r'#[^\n]*', '', match.group(1))) if match else []
    for name in patches:
        patch = root / 'ports' / item['id'] / name
        result = subprocess.run(['git', 'apply', '--ignore-whitespace', str(patch.resolve())], cwd=source, capture_output=True, text=True)
        patch_results.append({'component': item['id'], 'file': name, 'applied': result.returncode == 0, 'stderr': result.stderr[:2000]})

header_roots = {
    'Eigen': [('eigen3', '')], 'unsupported': [('eigen3', '')], 'absl': [('abseil', '')],
    'nlohmann': [('nlohmann-json', 'include')], 'google': [('protobuf', 'src')],
    'boost': [('boost-config', 'include'), ('boost-mp11', 'include')], 'onnx': [('onnx', '')],
    'flatbuffers': [('flatbuffers', 'include')], 'gsl': [('ms-gsl', 'include')],
    'wil': [('wil', 'include')], 're2': [('re2', '')], 'SafeInt.hpp': [('safeint', '')],
    'cpuinfo.h': [('cpuinfo', 'include')],
}
comparisons = []
def compare(name, expected, candidates, kind):
    existing = [path for path in candidates if path.is_file()]
    match_kind = None
    for path in existing:
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() == expected:
            match_kind = 'exact-bytes'
            break
        if hashlib.sha256(data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')).hexdigest() == expected:
            match_kind = 'exact-after-checkout-crlf'
            break
    comparisons.append({'kind': kind, 'path': name, 'expectedSha256': expected, 'result': match_kind or ('mismatch' if existing else 'missing-or-generated')})
for name, expected in evidence['vcpkgHeaderChecksums'].items():
    parts = name.split('\\')
    candidates = [sources[package] / prefix / Path(*parts) for package, prefix in header_roots.get(parts[0], [])]
    compare(name, expected, candidates, 'installed-header')
for name, expected in evidence['compiledSourceChecksums'].items():
    match = re.search(r'\\_temp\\([^\\]+)\\src\\[^\\]+\.clean\\(.+)', name)
    candidates = [sources[match[1]] / Path(*match[2].split('\\'))] if match and match[1] in sources else []
    compare(name, expected, candidates, 'compiled-source')
counts = {kind: sum(item['result'] == kind for item in comparisons) for kind in ['exact-bytes', 'exact-after-checkout-crlf', 'mismatch', 'missing-or-generated']}
report = {'schemaVersion': 1, 'binarySha256': evidence['binarySha256'], 'pdbSha256': evidence['pdbSha256'],
          'counts': counts, 'patches': patch_results, 'comparisons': comparisons, 'releaseEligible': False,
          'remainingChecks': ['Investigate missing/generated and mismatched inputs', 'Redistribution notices and Microsoft runtime entitlement']}
(root / 'source-comparison.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'counts': counts, 'patchFailures': sum(not item['applied'] for item in patch_results), 'releaseEligible': False}))
