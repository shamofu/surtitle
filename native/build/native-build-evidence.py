#!/usr/bin/env python3
"""Package source recipes/notices and describe the native build output."""
import json
import re
import subprocess
import sys
from pathlib import Path
from native_source_manifest import read_sources
from native_source_archive import sha256_file as digest, write_source_archive

workspace, build_root, output = map(Path, sys.argv[1:4])
sources = read_sources(workspace)
runtime = output / 'runtime/mpv-2.dll'
if not runtime.is_file():
    raise SystemExit('A completed candidate DLL is required')

recipe_paths = ['native/build/Dockerfile', 'native/build/sources.json', 'native/build/cross-win64.ini',
                'native/build/toolchain-win64.cmake', 'native/build/native-build.sh',
                'native/build/native-source-inputs.py', 'native/build/native_source_manifest.py', 'native/build/native-build-evidence.py',
                'native/build/native_source_archive.py']
bundle_inputs = [(workspace / path, 'recipe/' + path) for path in recipe_paths]
inventory = []
for source in sources['sources']:
    archive = build_root / 'source-cache' / source['file']
    if digest(archive) != source['sha256']:
        raise SystemExit('Changed source archive: ' + source['id'])
    bundle_inputs.append((archive, 'archives/' + source['file']))
    directory = build_root / 'sources' / source.get('parent', source['id'])
    if source.get('parent'):
        directory /= source['destination']
    notices = [path for path in directory.iterdir() if path.is_file() and path.suffix != '.cfg' and re.match(r'(?i)^(license|copying|copyright|notice)([._-]|$)', path.name)]
    if source['id'] == 'freetype':
        notices.append(directory / 'docs/FTL.TXT')
    if (directory / 'LICENSES').is_dir():
        notices.extend(path for path in (directory / 'LICENSES').iterdir() if path.is_file())
    for notice in sorted(notices):
        bundle_inputs.append((notice, 'notices/' + source['id'] + '/' + notice.name))
    retained = [{'file': path.name} for path in sorted(notices)]
    inventory.append({**source, 'archiveBytes': archive.stat().st_size, 'retainedNotices': retained})

for directory in ['logs', 'toolchain-notices']:
    for path in sorted((output / directory).rglob('*')):
        if path.is_file() and not path.is_symlink():
            bundle_inputs.append((path, 'evidence/' + str(path.relative_to(output))))
bundle_inputs.append((output / 'toolchain-packages.tsv', 'evidence/toolchain-packages.tsv'))
pe = subprocess.run(['x86_64-w64-mingw32-objdump', '-p', str(runtime)], check=True, text=True, capture_output=True).stdout
(output / 'mpv-pe.txt').write_text(pe)
imports = re.findall(r'DLL Name:\s*(\S+)', pe)

source_bundle = output / 'libmpv-candidate-source.tar.gz'
write_source_archive(source_bundle, bundle_inputs)

report = {
    'schemaVersion': 1,
    'runtime': {'file': runtime.name, 'bytes': runtime.stat().st_size, 'imports': imports},
    'recipe': [{'path': path} for path in recipe_paths],
    'sources': inventory,
    'correspondingSource': {'file': source_bundle.name, 'bytes': source_bundle.stat().st_size},
}
(output / 'build-evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'runtime': report['runtime'], 'sourceBundle': report['correspondingSource']}, indent=2))
