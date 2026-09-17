#!/usr/bin/env python3
"""Reconstruct installed headers using the verified upstream build rules."""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
report = json.loads((root / 'source-comparison.json').read_text())
inputs = json.loads((root / 'source-inputs.json').read_text())
sources = {p.name: next(p.iterdir()) for p in (root / 'comparison-sources').iterdir()}
out = root / 'generated-header-evidence'
out.mkdir(exist_ok=True)
records = []

def record(name, path, method):
    item = next(i for i in report['comparisons'] if i['path'] == name)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    matched = actual == item['expectedSha256']
    records.append({'path': name, 'file': str(path.relative_to(root)), 'sha256': actual,
                    'expectedSha256': item['expectedSha256'], 'matched': matched, 'method': method})
    if matched:
        item['result'] = 'exact-reconstructed-installed-header'

# The reviewed official build uses C++20 with Windows checkout line endings.
pinned = (sources['abseil'] / 'absl/base/options.h').read_text()
for feature in ['ANY', 'OPTIONAL', 'STRING_VIEW', 'VARIANT', 'ORDERING']:
    pinned = pinned.replace(f'#define ABSL_OPTION_USE_STD_{feature} 2', f'#define ABSL_OPTION_USE_STD_{feature} 1')
pinned = re.sub(r'#define ABSL_OPTION_USE_STD_([^ ]*) 2', r'#define ABSL_OPTION_USE_STD_\1 0', pinned)
path = out / 'abseil-cxx20-options-crlf.h'
path.write_bytes(pinned.replace('\n', '\r\n').encode())
record('absl\\base\\options.h', path, 'Abseil C++20 ABI pinning, Windows CRLF output')

record('wil\\Resource.h', sources['wil'] / 'include/wil/resource.h', 'Windows case-insensitive filename lookup; bytes unchanged')
protoc = root / 'protoc-build/protoc'
version = subprocess.check_output([str(protoc), '--version'], text=True).strip()
protobuf_version = next(item['version'] for item in inputs['sources'] if item['id'] == 'protobuf')
if version != 'libprotoc ' + protobuf_version:
    raise SystemExit('Unexpected protobuf compiler version')
# The matching ONNX build enables ML and protobuf lite.
destination = out / 'onnx-lite'
(destination / 'onnx').mkdir(parents=True, exist_ok=True)
for stem in ['onnx', 'onnx-operators', 'onnx-data']:
    command = [sys.executable, str(sources['onnx'] / 'onnx/gen_proto.py'), '-p', 'onnx',
               '-o', str(destination / 'onnx'), stem, '-m', '-l']
    subprocess.run(command, cwd=sources['onnx'], check=True, stdout=subprocess.DEVNULL)
for proto in sorted((destination / 'onnx').glob('*.proto')):
    subprocess.run([str(protoc), str(proto), '-I', str(destination), '--cpp_out', str(destination)], check=True)
for stem in ['onnx-ml', 'onnx-operators-ml', 'onnx-data']:
    record('onnx\\' + stem + '.pb.h', destination / 'onnx' / (stem + '.pb.h'),
           f'ONNX gen_proto.py namespace onnx, ML enabled, lite=True; {version}')

report['counts'] = {kind: sum(i['result'] == kind for i in report['comparisons']) for kind in
                    ['exact-bytes', 'exact-after-checkout-crlf', 'exact-reconstructed-installed-header', 'mismatch', 'missing-or-generated']}
report['generatedHeaderEvidence'] = records
report['remainingChecks'] = ['Redistribution notices and Microsoft runtime entitlement',
                             'PDB coverage does not prove that every build input is listed; preserve complete upstream sources and recipes']
(root / 'source-comparison-final.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'counts': report['counts'], 'matchedReconstructions': [r for r in records if r['matched']]}))
if report['counts']['mismatch'] or report['counts']['missing-or-generated']:
    raise SystemExit('Unresolved official PDB checksums remain')
