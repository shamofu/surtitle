#!/usr/bin/env python3
"""Package selected, verified ORT source inputs without exporting build caches."""
import gzip
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

workspace, root, destination = map(Path, sys.argv[1:4])
destination.mkdir(parents=True, exist_ok=True)
inputs = json.loads((root / 'source-inputs.json').read_text())
comparison = json.loads((root / 'source-comparison-final.json').read_text())
reviewed = json.loads((workspace / 'native/reviews/onnxruntime-dependencies.json').read_text())
definition = json.loads((workspace / 'native/build/onnxruntime-sources.json').read_text())
runtime = json.loads((workspace / 'native/runtime-windows-x64.json').read_text())
component = next(item for item in runtime['components'] if item['id'] == 'onnxruntime')
runtime_dll = next(item for item in component['runtimeFiles'] if item['target'] == 'onnxruntime.dll')
if not inputs['complete'] or comparison['counts']['mismatch'] or comparison['counts']['missing-or-generated']:
    raise SystemExit('Incomplete input or checksum evidence')
if (component['version'] != reviewed['version']
        or runtime_dll['sha256'] != reviewed['binarySha256']
        or comparison['binarySha256'] != reviewed['binarySha256'] or comparison['pdbSha256'] != reviewed['pdbSha256']
        or sum(comparison['counts'].values()) != reviewed['observedChecksumRecords']):
    raise SystemExit('ORT qualification differs from the reviewed binary and checksum inventory')

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

selected = {}
for name, item in definition['sources'].items():
    archive = root / 'archives' / (name + '-' + item['commit'] + '.tar.gz')
    if sha(archive) != item['sha256']:
        raise SystemExit('Changed source archive: ' + name)
    selected[archive] = 'sources/' + archive.name
notices = destination / 'notices'
notices.mkdir(exist_ok=True)
inventory = []
upstream_notices = workspace / 'native/onnxruntime-ThirdPartyNotices.txt'
boost_text = upstream_notices.read_text().split('Boost Software License - Version 1.0 - August 17th, 2003', 1)[1].split('_____', 1)[0]
(notices / 'Boost-LICENSE_1_0.txt').write_text('Boost Software License - Version 1.0 - August 17th, 2003' + boost_text.rstrip() + '\n')
for item in inputs['sources']:
    archive = root / 'archives' / item['file']
    if sha(archive) != item['sha256']:
        raise SystemExit('Changed dependency archive: ' + item['id'])
    selected[archive] = 'sources/' + archive.name
    source = next((root / 'comparison-sources' / item['id']).iterdir())
    component_notices = []
    for path in sorted(source.iterdir()):
        if not re.match(r'(?i)^(license|copying|notice|thirdpartynotices)', path.name):
            continue
        candidates = [path] if path.is_file() else sorted(p for p in path.rglob('*') if p.is_file())
        for candidate in candidates:
            target = notices / item['id'] / candidate.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(candidate, target)
            component_notices.append({'file': target.relative_to(destination).as_posix(), 'sha256': sha(target)})
    if item['id'].startswith('boost-'):
        component_notices.append({'file': 'notices/Boost-LICENSE_1_0.txt', 'sha256': sha(notices / 'Boost-LICENSE_1_0.txt'),
                                  'origin': 'Verbatim license section from official ONNX Runtime ThirdPartyNotices; copyright remains in source headers'})
    if not component_notices:
        raise SystemExit('Missing selected component notices: ' + item['id'])
    inventory.append({'id': item['id'], 'version': item['version'], 'license': 'MIT' if item['id'] == 'safeint' else item['license'],
                      'sourceArchiveSha256': item['sha256'], 'notices': component_notices})

for name in ['onnxruntime-LICENSE', 'onnxruntime-ThirdPartyNotices.txt']:
    shutil.copyfile(workspace / 'native' / name, notices / name)
for path in sorted(notices.rglob('*')):
    if path.is_file():
        selected[path] = path.relative_to(destination).as_posix()
for directory, prefix in [(root / 'ports', 'ports'), (root / 'generated-header-evidence', 'generated-header-evidence')]:
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            selected[path] = prefix + '/' + path.relative_to(directory).as_posix()
for name in ['source-inputs.json', 'source-comparison-final.json', 'protoc-build.log']:
    selected[root / name] = 'evidence/' + name
for path in sorted((workspace / 'native/upstream-evidence').glob('onnxruntime-*')):
    if path.is_file():
        selected[path] = 'evidence/' + path.name
for name in ['native-ort-evidence.py', 'native-ort-source-inputs.py', 'native-ort-compare.py', 'native-ort-generated.py', 'native-ort-package.py', 'native-source-archive-check.py']:
    selected[workspace / 'scripts' / name] = 'scripts/' + name
selected[workspace / 'native/reviews/onnxruntime-dependencies.json'] = 'evidence/reviewed-dependencies.json'
for name in ['native/build/onnxruntime-sources.json', 'native/runtime-windows-x64.json']:
    selected[workspace / name] = name

stable = lambda name: name.startswith(('sources/', 'ports/', 'notices/'))
expected_files = {item['file']: item['sha256'] for item in reviewed['files'] if stable(item['file'])}
observed_files = {name: sha(path) for path, name in selected.items() if stable(name)}
if observed_files != expected_files or inventory != reviewed['components']:
    raise SystemExit('ORT sources, patches or component notices differ from the review')

readme = destination / 'README.md'
protobuf = next(item for item in inputs['sources'] if item['id'] == 'protobuf')
protobuf_source = next((root / 'comparison-sources/protobuf').iterdir()).relative_to(root).as_posix()
counts = comparison['counts']
observed_records = sum(counts.values())
reconstructed_records = counts.get('exact-reconstructed-installed-header', 0)
readme.write_text(f'''# ONNX Runtime candidate source and notice package

This package binds official CPU ONNX Runtime {component['version']} to its exact source commit,
selected vcpkg baseline/overlay ports, source archives, patches and notices.
The matching DLL/PDB GUID and age are checked before source comparison.
All {observed_records} observed dependency source/header SHA-256 records match: {observed_records - reconstructed_records} original
source bytes and {reconstructed_records} installed/generated-header reconstructions. This is
strong observed-input evidence, not a claim that PDBs list every build input
or that final application/installer redistribution checks have passed.

The complete original ORT archive includes its build.py/CMake/CI recipes and
MIT license. Each selected dependency archive is retained unchanged; ports/
contains the exact overlay or historical vcpkg recipes and patches. The archive
contains no DLL, executable, object tree, compiler cache or Microsoft runtime.
Eigen MPL-2.0 source and notices are included for its source-availability duties.
All source-file copyright/license notices remain in their original archives.

To repeat the comparison in an isolated Linux build environment, arrange the
selected source archives in a fresh root/archives directory, copy the recorded
ports and source-inputs.json to root, then run native-ort-compare.py with the
workspace evidence directory. Build the patched protobuf {protobuf['version']} host protoc:

```sh
cmake -S ROOT/{protobuf_source}/cmake -B ROOT/protoc-build -G Ninja -DCMAKE_BUILD_TYPE=Release -Dprotobuf_BUILD_TESTS=OFF -Dprotobuf_BUILD_SHARED_LIBS=OFF -Dprotobuf_WITH_ZLIB=OFF
cmake --build ROOT/protoc-build --target protoc --parallel 4
python3 scripts/native-ort-generated.py ROOT
```

The generated-header script applies upstream Abseil CMake ABI pinning rules
and ONNX gen_proto.py/protoc rules. Only exact official-PDB matches count.
The matching choices are Abseil C++20 with Windows CRLF and ONNX ML/lite mode.
The WIL Resource.h spelling is resolved by Windows case-insensitive lookup.

This source-evidence package does not by itself approve the final application
or installer. Microsoft VC runtimes are a separately installed prerequisite;
they must not be added to this package or the application's native payload.
''')
selected[readme] = 'README.md'
manifest = {'schemaVersion': 1, 'componentId': 'onnxruntime', 'version': component['version'],
            'binarySha256': comparison['binarySha256'], 'pdbSha256': comparison['pdbSha256'],
            'observedChecksumRecords': sum(comparison['counts'].values()), 'unresolvedChecksumRecords': 0,
            'components': inventory, 'files': [{'file': name, 'sha256': sha(path), 'bytes': path.stat().st_size}
                                              for path, name in sorted(selected.items(), key=lambda pair: pair[1])],
            'releaseEligible': False, 'remainingChecks': ['Final effective application/installer payload, notices and corresponding-source audit']}
manifest_path = destination / 'source-package-inventory.json'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
selected[manifest_path] = manifest_path.name
package = destination / 'onnxruntime-source.tar.gz'
with package.open('wb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w') as archive:
        for path, name in sorted(selected.items(), key=lambda pair: pair[1]):
            info = archive.gettarinfo(str(path), arcname=name)
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            info.mode = 0o644
            with path.open('rb') as file:
                archive.addfile(info, file)
subprocess.run([sys.executable, str(workspace / 'scripts/native-source-archive-check.py'), str(package)],
               input=json.dumps({'schemaVersion': 1, 'kind': 'onnxruntime', 'inventory': manifest,
                                 'files': [{'path': name, 'sha256': checksum} for name, checksum in expected_files.items()]}),
               text=True, check=True)
result = {'file': package.name, 'sha256': sha(package), 'bytes': package.stat().st_size,
          'inventorySha256': sha(manifest_path), 'releaseEligible': False}
(destination / 'package-result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
