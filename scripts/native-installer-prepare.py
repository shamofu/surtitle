#!/usr/bin/env python3
"""Prepare the source archives and notices shipped with the standard Tauri installer."""
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checked(path, expected):
    if not path.is_file() or path.is_symlink() or digest(path) != expected:
        raise ValueError('Installer input checksum mismatch: ' + str(path))
    return path


def download(item, directory):
    path = directory / item['file']
    if path.name != item['file']:
        raise ValueError('Installer download filename must be plain')
    if not path.exists():
        temporary = path.with_suffix(path.suffix + '.partial')
        request = urllib.request.Request(item['url'], headers={'User-Agent': 'Surtitle-installer-sources'})
        with urllib.request.urlopen(request, timeout=300) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        checked(temporary, item['sha256'])
        temporary.replace(path)
    return checked(path, item['sha256'])


def prepare_prerequisite(workspace):
    manifest = json.loads((workspace / 'native/runtime-windows-x64.json').read_text(encoding='utf-8'))
    prerequisite, = [item for item in manifest['prerequisites'] if item['id'] == 'microsoft-vc-runtime-x64']
    version, url = prerequisite['minimumVersion'], prerequisite['downloadUrl']
    if not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', version):
        raise ValueError('Invalid Microsoft runtime minimum version')
    if not url.startswith('https://') or any(character in url for character in '\r\n"$'):
        raise ValueError('Invalid Microsoft runtime download URL')
    # NSIS language strings need compile-time constants. The helper reads the
    # original manifest embedded by the hook; nothing generated is committed.
    output = workspace / 'work/installer-prerequisite.nsh'
    output.parent.mkdir(parents=True, exist_ok=True)
    display_version = version.removesuffix('.0')
    output.write_text('; Generated from native/runtime-windows-x64.json.\n'
                      f'!define SURTITLE_VC_MINIMUM_VERSION "{display_version}"\n'
                      f'!define SURTITLE_VC_DOWNLOAD_URL "{url}"\n', encoding='utf-8')


def prepare(workspace, toolchain, acquire=download):
    prepare_prerequisite(workspace)
    inputs = json.loads((workspace / 'native/installer-inputs.json').read_text(encoding='utf-8'))
    downloads = workspace / 'work/native-installer-downloads'
    output = workspace / 'work/installer-sources'
    downloads.mkdir(parents=True, exist_ok=True)
    sources = [inputs['sourceArchive'], inputs['plugin']['sourceArchive'],
               *inputs['plugin']['sourceCrates'], inputs['rust']['sourceArchive']]
    files = {item['file']: acquire(item, downloads) for item in sources}
    output.mkdir(parents=True, exist_ok=True)
    for item in sources:
        shutil.copyfile(files[item['file']], output / item['file'])
    notices = workspace / 'src-tauri/resources/notices/installer'
    notices.mkdir(parents=True, exist_ok=True)
    for item in inputs['notices']:
        source = checked(workspace / 'native/installer-notices' / item['file'], item['sha256'])
        shutil.copyfile(source, notices / item['file'])
    for item in inputs['rust']['notices']:
        source = checked(toolchain / 'share/doc/rust' / item['file'], item['sha256'])
        destination = notices / 'rust-runtime' / item['file']
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    with tarfile.open(files[inputs['rust']['sourceArchive']['file']]) as archive:
        members = [item for item in archive.getmembers()
                   if item.isfile() and item.name.endswith('/library/compiler-builtins/LICENSE.txt')]
        if len(members) != 1:
            raise ValueError('Rust source must contain the compiler-builtins license')
        (notices / 'rust-runtime/compiler-builtins-LICENSE.txt').write_bytes(archive.extractfile(members[0]).read())
    manifest = {'schemaVersion': 1, 'sources': [{key: item[key] for key in ['file', 'sha256']} for item in sources]}
    (output / 'sources.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print('Prepared installer and Rust source archives and notices.')


def main():
    workspace = Path(__file__).resolve().parent.parent
    inputs = json.loads((workspace / 'native/installer-inputs.json').read_text(encoding='utf-8'))
    version = subprocess.check_output(['rustc', '--version'], text=True).split()[1]
    if version != inputs['rust']['version']:
        raise ValueError('Update the Rust source/notices pin for the application toolchain')
    toolchain = Path(subprocess.check_output(['rustc', '--print', 'sysroot'], text=True).strip())
    prepare(workspace, toolchain)


if __name__ == '__main__':
    main()
