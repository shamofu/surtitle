#!/usr/bin/env python3
"""Package pinned ORT source archives, port recipes and license notices."""
import json
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path
from native_source_archive import sha256_file as sha, write_source_archive

workspace, root, destination = map(Path, sys.argv[1:4])
destination.mkdir(parents=True, exist_ok=True)
inputs = json.loads((root / 'source-inputs.json').read_text())
definition = json.loads((workspace / 'native/build/onnxruntime-sources.json').read_text())
runtime = json.loads((workspace / 'native/runtime-windows-x64.json').read_text())
component = next(item for item in runtime['components'] if item['id'] == 'onnxruntime')
if not inputs['complete']:
    raise SystemExit('Source acquisition is incomplete')

selected = {}
for name, item in definition['sources'].items():
    archive = root / 'archives' / (name + '-' + item['commit'] + '.tar.gz')
    if sha(archive) != item['sha256']:
        raise SystemExit('Changed source archive: ' + name)
    selected[archive] = 'sources/' + archive.name

notices = destination / 'notices'
notices.mkdir(exist_ok=True)
inventory = []
for item in inputs['sources']:
    if (not re.fullmatch(r'[A-Za-z0-9_.-]+', item['id']) or item['id'] in ('.', '..')
            or Path(item['file']).name != item['file'] or '\\' in item['file']):
        raise SystemExit('Unsafe dependency source path')
    archive = root / 'archives' / item['file']
    if sha(archive) != item['sha256']:
        raise SystemExit('Changed dependency archive: ' + item['id'])
    selected[archive] = 'sources/' + archive.name
    component_notices = []
    with tempfile.TemporaryDirectory(prefix='ort-notices-', dir=root) as temporary:
        extracted = Path(temporary)
        with tarfile.open(archive) as source_archive:
            source_archive.extractall(extracted, filter='data')
        children = list(extracted.iterdir())
        if len(children) != 1 or not children[0].is_dir():
            raise SystemExit('Expected one dependency source root')
        source = children[0]
        for path in sorted(source.iterdir()):
            if not re.match(r'(?i)^(license|copying|notice|thirdpartynotices)', path.name):
                continue
            candidates = [path] if path.is_file() else sorted(p for p in path.rglob('*') if p.is_file())
            for candidate in candidates:
                target = notices / item['id'] / candidate.relative_to(source)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(candidate, target)
                component_notices.append({'file': target.relative_to(destination).as_posix()})
    # Boost's common license is also retained verbatim in ORT's top-level notices.
    if item['id'].startswith('boost-'):
        component_notices.append({'file': 'notices/onnxruntime-ThirdPartyNotices.txt'})
    inventory.append({'id': item['id'], 'version': item['version'],
                      'license': 'MIT' if item['id'] == 'safeint' else item['license'],
                      'sourceArchiveSha256': item['sha256'], 'notices': component_notices})

for name in ['onnxruntime-LICENSE', 'onnxruntime-ThirdPartyNotices.txt']:
    shutil.copyfile(workspace / 'native' / name, notices / name)
for directory, prefix in [(notices, 'notices'), (root / 'ports', 'ports')]:
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            selected[path] = prefix + '/' + path.relative_to(directory).as_posix()
selected[root / 'source-inputs.json'] = 'source-inputs.json'
for name in ['native-ort-source-inputs.py', 'native-ort-package.py', 'native_source_archive.py']:
    selected[workspace / 'native/build' / name] = 'native/build/' + name
for name in ['native/build/onnxruntime-sources.json', 'native/runtime-windows-x64.json']:
    selected[workspace / name] = name

readme = destination / 'README.md'
readme.write_text(f'''# ONNX Runtime source and notice package

This package contains the source inputs selected for ONNX Runtime {component['version']}:
the pinned ORT and vcpkg commits, dependency source archives, port recipes,
patches and license notices. The original ORT archive includes its build.py,
CMake and CI recipes. Source-file copyright notices remain in their archives.
Eigen MPL-2.0 sources and notices are included.

The source download pins are in native/build/onnxruntime-sources.json. Each
dependency's upstream download pin and selected port are recorded in
source-inputs.json and ports/. Use the retained ORT build instructions and
port recipes to rebuild the selected sources and apply their patches.

This archive contains no DLL, executable, object tree, compiler cache or
Microsoft runtime. Microsoft VC runtimes are a separately installed prerequisite.
''')
selected[readme] = 'README.md'
manifest = {'schemaVersion': 1, 'componentId': 'onnxruntime', 'version': component['version'],
            'components': inventory, 'files': [{'file': name, 'bytes': path.stat().st_size}
                                              for path, name in sorted(selected.items(), key=lambda pair: pair[1])]}
manifest_path = destination / 'source-package-inventory.json'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
selected[manifest_path] = manifest_path.name
package = destination / 'onnxruntime-source.tar.gz'
write_source_archive(package, selected.items())
print(json.dumps({'file': package.name, 'bytes': package.stat().st_size}))
