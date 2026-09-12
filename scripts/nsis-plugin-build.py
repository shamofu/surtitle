#!/usr/bin/env python3
"""Acquire and package a locked NSIS plugin build without global installation."""
import argparse
import gzip
import hashlib
import json
import shutil
import subprocess
import tarfile
import tomllib
import urllib.request
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent
POLICY = WORKSPACE / 'native/nsis-plugin/inputs.json'
LOCK = WORKSPACE / 'native/nsis-plugin/Cargo.lock'
RECIPE = ['scripts/nsis-plugin-build.py', 'scripts/nsis-plugin-build.ps1',
          'scripts/nsis-plugin-smoke.ps1', 'native/nsis-plugin/inputs.json', 'native/nsis-plugin/Cargo.lock',
          'native/nsis-plugin/README.md']

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')

def regular(path):
    for ancestor in [path, *path.parents]:
        if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
            raise RuntimeError('Symlink or junction path is not allowed: ' + str(path))
    return path

def bounded_work(value):
    path = Path(value).absolute()
    regular(path)
    path = path.resolve()
    if not path.is_relative_to((WORKSPACE / 'work').resolve()) or path == (WORKSPACE / 'work').resolve():
        raise RuntimeError('Build directory must be a child of this repository work directory')
    return path

def unpack(archive_path, destination):
    if destination.exists():
        raise RuntimeError('Extraction directory must be fresh')
    with tarfile.open(archive_path) as archive:
        archive.extractall(destination, filter='data')
    roots = list(destination.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise RuntimeError('Unexpected archive root')
    return roots[0]

def acquire(item, destination):
    path = destination / item['file']
    if path.exists():
        raise RuntimeError('Acquisition destination must be fresh')
    request = urllib.request.Request(item['url'], headers={'User-Agent': 'Surtitle-installer-source-build'})
    with urllib.request.urlopen(request, timeout=120) as response, path.open('xb') as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > 512 * 1024 * 1024:
                raise RuntimeError('Oversized pinned upstream archive')
            output.write(chunk)
    if digest(path) != item['sha256']:
        raise RuntimeError('Pinned archive checksum mismatch: ' + item['file'])
    return path

def inventory(directory):
    return [{'file': path.relative_to(directory).as_posix(), 'sha256': digest(regular(path)), 'bytes': path.stat().st_size}
            for path in sorted(directory.rglob('*')) if path.is_file()]

def validate_source(root, receipt):
    current = inventory(root / 'source')
    if current != receipt['sourceFiles']:
        raise RuntimeError('Prepared source tree changed during the build')

def prepare(root, toolchain, policy):
    root.mkdir(parents=True, exist_ok=False)
    archives = root / 'archives'
    archives.mkdir()
    version = subprocess.check_output([str(toolchain / 'bin/rustc.exe'), '-vV'], text=True)
    if f'release: {policy["rustVersion"]}\n' not in version or f'commit-hash: {policy["rustCommit"]}\n' not in version or f'host: {policy["host"]}\n' not in version:
        raise RuntimeError('The installed compiler differs from the pinned Rust toolchain')
    if digest(LOCK) != policy['cargoLockSha256']:
        raise RuntimeError('Cargo.lock differs from reviewed inputs')
    extracted = {}
    for key in ['source', 'rustStd', 'rustHostStd', 'rustSource']:
        extracted[key] = unpack(acquire(policy[key], archives), root / ('source-unpacked' if key == 'source' else key))
    shutil.copytree(extracted['source'], root / 'source')
    shutil.copyfile(LOCK, root / 'source/Cargo.lock')
    shutil.copytree(extracted['rustStd'] / ('rust-std-' + policy['target']) / 'lib', root / 'sysroot/lib')
    host_root = extracted['rustHostStd'] / ('rust-std-' + policy['host'])
    host_files = [item for item in inventory(host_root) if item['file'].startswith('lib/')]
    for item in host_files:
        if digest(regular(toolchain / item['file'])) != item['sha256']:
            raise RuntimeError('Host standard library differs from the exact official component: ' + item['file'])
    runtime_notices = root / 'runtime-notices'
    runtime_notices.mkdir()
    for item in policy['rustRuntimeNotices']:
        original = regular(toolchain / 'share/doc/rust' / item['file'])
        if digest(original) != item['sha256']:
            raise RuntimeError('Installed runtime notice differs from reviewed Rust release')
        target = runtime_notices / item['file']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, target)
    for name in ['COPYRIGHT', 'LICENSE-MIT', 'LICENSE-APACHE']:
        shutil.copyfile(extracted['rustStd'] / name, runtime_notices / name)
    rust_library = extracted['rustSource'] / 'rust-src/lib/rustlib/src/rust/library'
    shutil.copyfile(rust_library / 'compiler-builtins/LICENSE.txt', runtime_notices / 'compiler-builtins-LICENSE.txt')
    (root / 'cargo-home').mkdir()
    (root / 'logs').mkdir()
    receipt = {'schemaVersion': 1, 'inputsSha256': digest(POLICY), 'cargoLockSha256': digest(LOCK),
               'rustcVersion': version, 'rustcSha256': digest(toolchain / 'bin/rustc.exe'),
               'cargoVersion': subprocess.check_output([str(toolchain / 'bin/cargo.exe'), '-V'], text=True).strip(),
               'cargoSha256': digest(toolchain / 'bin/cargo.exe'), 'sourceFiles': inventory(root / 'source'),
               'verifiedHostStandardLibraryFiles': host_files,
               'i686StandardLibraryFiles': inventory(root / 'sysroot'),
               'runtimeNotices': inventory(runtime_notices)}
    write_json(root / 'preparation.json', receipt)
    print('Pinned sources, local i686 sysroot and exact host runtime notices are prepared.', flush=True)

def package_tar(destination, entries):
    if destination.exists():
        raise RuntimeError('Source package destination must be fresh')
    with destination.open('xb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w|') as archive:
        for path, name in sorted(entries, key=lambda pair: pair[1]):
            regular(path)
            info = tarfile.TarInfo(name)
            info.size = path.stat().st_size
            info.mode = 0o644
            with path.open('rb') as stream:
                archive.addfile(info, stream)
    return {'file': destination.name, 'sha256': digest(destination), 'bytes': destination.stat().st_size}

def package(root, policy):
    receipt = json.loads((root / 'preparation.json').read_text())
    if receipt['inputsSha256'] != digest(POLICY) or receipt['cargoLockSha256'] != digest(LOCK):
        raise RuntimeError('Reviewed preparation inputs changed')
    validate_source(root, receipt)
    output = root / 'output'
    output.mkdir(exist_ok=False)
    dll = root / 'target' / policy['target'] / 'release/nsis_tauri_utils.dll'
    if not dll.is_file():
        raise RuntimeError('The actual release plugin was not built')
    smoke = json.loads((root / 'logs/plugin-smoke.json').read_text(encoding='utf-8-sig'))
    if smoke.get('sha256', '').lower() != digest(dll) or smoke.get('passed') is not True:
        raise RuntimeError('Plugin functional smoke is missing or for a different DLL')
    shutil.copyfile(dll, output / dll.name)
    shutil.copytree(root / 'runtime-notices', output / 'rust-runtime-notices')
    notices = output / 'notices'
    notices.mkdir()
    for name in ['LICENSE_MIT', 'LICENSE_APACHE-2.0']:
        shutil.copyfile(root / 'source' / name, notices / ('nsis-tauri-utils-' + name))
    lock = tomllib.loads(LOCK.read_text())
    dependencies = []
    for dependency in lock['package']:
        if 'source' not in dependency:
            continue
        name = dependency['name'] + '-' + dependency['version']
        vendor = root / 'vendor' / name
        checksum = json.loads((vendor / '.cargo-checksum.json').read_text())
        if checksum['package'] != dependency['checksum']:
            raise RuntimeError('Vendored package does not match Cargo.lock: ' + name)
        for relative, expected in checksum['files'].items():
            if digest(regular(vendor / relative)) != expected:
                raise RuntimeError('Vendored source file changed: ' + name + '/' + relative)
        license_files = [path for path in vendor.rglob('*') if path.is_file() and path.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'COPYRIGHT', 'NOTICE', 'UNLICENSE'))]
        if not license_files:
            raise RuntimeError('No dependency license files: ' + name)
        for path in license_files:
            target = notices / name / path.relative_to(vendor)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        metadata = tomllib.loads((vendor / 'Cargo.toml').read_text())
        dependencies.append({'name': dependency['name'], 'version': dependency['version'], 'source': dependency['source'],
                             'checksum': dependency['checksum'], 'license': metadata['package'].get('license'),
                             'notices': [path.relative_to(vendor).as_posix() for path in license_files]})
    source_entries = [(root / 'archives' / policy['source']['file'], 'archives/' + policy['source']['file'])]
    for directory in ['source', 'vendor', 'logs']:
        source_entries.extend((path, directory + '/' + path.relative_to(root / directory).as_posix()) for path in sorted((root / directory).rglob('*')) if path.is_file())
    source_entries.extend((WORKSPACE / name, 'recipe/' + name) for name in RECIPE)
    source_entries.append((root / 'vendor-config.toml', 'vendor-config.toml'))
    runtime_evidence = {'schemaVersion': 1, 'rustVersion': policy['rustVersion'], 'rustCommit': policy['rustCommit'],
                        'target': policy['target'], 'host': policy['host'],
                        'source': policy['rustSource'], 'targetComponent': policy['rustStd'], 'hostComponent': policy['rustHostStd'],
                        'verifiedHostStandardLibraryFiles': receipt['verifiedHostStandardLibraryFiles'],
                        'targetStandardLibraryFiles': receipt['i686StandardLibraryFiles'],
                        'notices': inventory(output / 'rust-runtime-notices'),
                        'scope': 'Exact Rust release runtime sources and notices for plugin i686 and main application x86_64; not compiler binary reproducibility.'}
    write_json(output / 'rust-runtime-evidence.json', runtime_evidence)
    runtime_entries = [(root / 'archives' / policy['rustSource']['file'], 'archives/' + policy['rustSource']['file']),
                       (output / 'rust-runtime-evidence.json', 'rust-runtime-evidence.json'), (POLICY, 'inputs.json')]
    runtime_entries.extend((path, 'notices/' + path.relative_to(output / 'rust-runtime-notices').as_posix()) for path in sorted((output / 'rust-runtime-notices').rglob('*')) if path.is_file())
    runtime_package = package_tar(output / 'rust-runtime-source.tar.gz', runtime_entries)
    source_entries.extend((path, 'notices/' + path.relative_to(notices).as_posix()) for path in sorted(notices.rglob('*')) if path.is_file())
    source_entries.append((output / 'rust-runtime-source.tar.gz', 'rust-runtime-source.tar.gz'))
    source_package = package_tar(output / 'nsis-plugin-source.tar.gz', source_entries)
    evidence = {'schemaVersion': 1, 'component': 'nsis-tauri-utils', 'version': policy['pluginVersion'],
                'sourceCommit': policy['sourceCommit'], 'runtime': {'file': dll.name, 'sha256': digest(dll), 'bytes': dll.stat().st_size},
                'cargoLockSha256': digest(LOCK), 'inputs': policy, 'recipe': [{'path': name, 'sha256': digest(WORKSPACE / name)} for name in RECIPE],
                'toolchain': {key: value for key, value in receipt.items() if key not in ['sourceFiles', 'schemaVersion', 'inputsSha256', 'cargoLockSha256']},
                'dependencies': dependencies, 'sourcePackage': source_package, 'rustRuntimeSourcePackage': runtime_package,
                'notices': inventory(notices), 'runtimeNotices': inventory(output / 'rust-runtime-notices'),
                'smoke': smoke, 'buildMode': 'cargo build --release --frozen; repository-local target sysroot; no global target installation',
                'buildLogSha256': digest(root / 'logs/build.log'), 'cargoMetadataSha256': digest(root / 'logs/cargo-metadata.json'), 'releaseApproval': False,
                'remainingChecks': ['Stage this exact plugin into a verified private NSIS tool cache, rebuild the actual installer, and verify extracted plugin/notices/source bindings.']}
    write_json(output / 'build-evidence.json', evidence)
    print(json.dumps({'runtime': evidence['runtime'], 'sourcePackage': source_package, 'rustRuntimeSourcePackage': runtime_package}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'package'])
    parser.add_argument('work_directory')
    parser.add_argument('--toolchain')
    arguments = parser.parse_args()
    build_root = bounded_work(arguments.work_directory)
    settings = json.loads(POLICY.read_text())
    if arguments.command == 'prepare':
        if not arguments.toolchain:
            parser.error('--toolchain is required for preparation')
        prepare(build_root, Path(arguments.toolchain).resolve(), settings)
    else:
        package(build_root, settings)
