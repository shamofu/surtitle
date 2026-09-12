#!/usr/bin/env python3
"""Acquire fixed upstream inputs inside the unmounted native CI container."""
import hashlib
import subprocess
import sys
import urllib.request
from pathlib import Path

workspace, build = map(Path, sys.argv[1:3])
archives = build / 'ort-corresponding/archives'
archives.mkdir(parents=True, exist_ok=True)
fixed = [
    ('microsoft/onnxruntime', '2e2543fbe9fae542f921d47a72d21d5a4ef0b710', 'onnxruntime', '00a7483d894037b23e5f2a7d9b18c4026e3585e2636b316cd2870b6e1bc660cb'),
    ('microsoft/vcpkg', '18a4723aeb7adbbae84bcff0edf510883800f32f', 'vcpkg', 'a0414f2f0b75673b7e7872e392e3f0598c9c5d117348d4ca3fcec8562f6b6c38'),
]
for repository, commit, name, expected in fixed:
    path = archives / f'{name}-{commit}.tar.gz'
    if not path.exists():
        temporary = path.with_suffix('.partial')
        with urllib.request.urlopen(f'https://codeload.github.com/{repository}/tar.gz/{commit}', timeout=180) as response, temporary.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        with temporary.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                raise SystemExit('Downloaded source does not match the reviewed SHA-256: ' + name)
        temporary.rename(path)
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
            raise SystemExit('Changed source archive: ' + name)
subprocess.run([sys.executable, str(workspace / 'scripts/native-source-inputs.py'), str(workspace), str(build / 'sources'), str(build / 'source-cache'), '--download'], check=True)
subprocess.run([sys.executable, str(workspace / 'scripts/native-ort-source-inputs.py'), str(workspace), str(build / 'ort-corresponding')], check=True)
