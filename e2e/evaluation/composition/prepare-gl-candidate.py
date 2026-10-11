#!/usr/bin/env python3
"""Prepare an isolated GL-enabled candidate from the repository's pinned inputs.

This only writes under work/rendering-evaluation. It does not build, export,
install, or replace the production DLL.
"""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[3]
context = root / 'work/rendering-evaluation/gl-context'
destination = context / 'native/build'
destination.mkdir(parents=True, exist_ok=True)
for source in (root / 'native/build').iterdir():
    if source.is_file():
        shutil.copyfile(source, destination / source.name)
# Freeze this renderer comparison's inputs independently from subsequent
# production FFmpeg adoption. It is mpv 0.41.0 / FFmpeg 8.1.2, as documented.
shutil.copyfile(Path(__file__).with_name('comparison-sources.json'), destination / 'sources.json')

def replace_once(path, before, after):
    text = path.read_text(encoding='utf-8')
    if text.count(before) != 1:
        raise SystemExit(f'Pinned recipe structure changed: {path.name}: {before}')
    path.write_text(text.replace(before, after), encoding='utf-8', newline='\n')

build = destination / 'native-build.sh'
replace_once(build, '-Dgl=disabled', '-Dgl=enabled -Dgl-win32=enabled')
# Cache slow codec/shader dependencies separately from the mpv experiment.
dependencies = build.read_text(encoding='utf-8').split('meson_build mpv ', 1)[0]
(destination / 'native-build-deps.sh').write_text(dependencies, encoding='utf-8', newline='\n')
replace_once(destination / 'Dockerfile',
    'COPY native/build/native-build.sh native/build/native-build-evidence.py native/build/native_source_archive.py /workspace/native/build/',
    'COPY native/build/native-build-deps.sh /workspace/native/build/\n'
    'RUN --network=none bash native/build/native-build-deps.sh /workspace /build\n'
    'COPY native/build/native-build.sh native/build/native-build-evidence.py native/build/native_source_archive.py /workspace/native/build/')
replace_once(destination / 'native-build-evidence.py',
    "'native/build/native-build.sh',",
    "'native/build/native-build.sh', 'native/build/native-build-deps.sh',")
print(context)
