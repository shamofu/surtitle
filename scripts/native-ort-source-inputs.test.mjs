// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('ORT acquisition authenticates only the exact vcpkg API and never forwards credentials across redirects', () => {
  const child = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', String.raw`
import importlib.util, io, os, sys, urllib.request, urllib.response
from email.message import Message
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('ort_inputs', sys.argv[1])
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)
token = 'ghs_fixture_secret_do_not_log'
api = 'https://api.github.com/repos/microsoft/vcpkg/git/trees/' + 'a' * 40
blob = 'https://api.github.com/repos/microsoft/vcpkg/git/blobs/' + 'b' * 40
codeload = 'https://codeload.github.com/microsoft/vcpkg/tar.gz/main'
gitlab = 'https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen.tar.gz'
real_build_opener = urllib.request.build_opener
seen = []
redirects = {}
class NetworkFixture(urllib.request.BaseHandler):
    handler_order = 100
    def https_open(self, req):
        seen.append((req.full_url, req.get_header('Authorization'), dict(req.unredirected_hdrs)))
        headers = Message()
        code = 200
        if req.full_url in redirects:
            headers['Location'] = redirects[req.full_url]
            code = 302
        response = urllib.response.addinfourl(io.BytesIO(b'fixture source'), headers, req.full_url, code)
        response.msg = 'Found' if code == 302 else 'OK'
        return response
def opener(*handlers):
    return real_build_opener(*handlers, NetworkFixture())
with patch.dict(os.environ, {'SURTITLE_NATIVE_GITHUB_TOKEN': token}), patch.object(urllib.request, 'build_opener', side_effect=opener):
    for url in [api, blob, codeload, gitlab]:
        seen.clear()
        assert inputs.request(url) == b'fixture source'
        assert len(seen) == 1
        expected = 'Bearer ' + token if url in [api, blob] else None
        assert seen[0][1] == expected
        if expected:
            assert seen[0][2].get('Authorization') == expected
    for invalid in ['http://api.github.com/repos/microsoft/vcpkg/git/trees/' + 'a' * 40,
                    api.replace('api.github.com', 'api.github.com.evil.invalid'),
                    api.replace('api.github.com', 'api.github.com@evil.invalid'),
                    api.replace('api.github.com', 'api.github.com:443'),
                    api.replace('/microsoft/vcpkg/', '/another/project/'),
                    api.replace('/git/trees/', '/../other/git/trees/'),
                    api + '?redirect=somewhere',
                    gitlab.replace('/libeigen/eigen/', '/another/project/')]:
        seen.clear()
        try:
            inputs.request(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('Accepted an untrusted upstream URL')
        assert not seen
    for destination in [blob, codeload, gitlab]:
        seen.clear()
        redirects.clear()
        redirects[api] = destination
        assert inputs.request(api) == b'fixture source'
        assert [item[0] for item in seen] == [api, destination]
        assert seen[0][1] == 'Bearer ' + token and seen[1][1] is None
    seen.clear()
    redirects.clear()
    redirects.update({api: codeload, codeload: blob})
    assert inputs.request(api) == b'fixture source'
    assert all(item[1] is None for item in seen[1:])
    for destination in ['https://evil.invalid/archive', api.replace('/vcpkg/', '/another/')]:
        seen.clear()
        redirects.clear()
        redirects[api] = destination
        try:
            inputs.request(api)
        except ValueError:
            pass
        else:
            raise AssertionError('Followed an untrusted redirect')
        assert len(seen) == 1
    redirects.clear()
    seen.clear()
    del os.environ['SURTITLE_NATIVE_GITHUB_TOKEN']
    assert inputs.request(api) == b'fixture source'
    assert seen[0][1] is None
print('Scoped API authentication and redirect checks passed')
`, fileURLToPath(new URL('./native-ort-source-inputs.py', import.meta.url))], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.doesNotMatch(child.stdout + child.stderr, /ghs_fixture_secret/);
});

test('ORT source acquisition follows changed manifest pins and still verifies cached archives', () => {
  const child = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', String.raw`
import base64, hashlib, importlib.util, io, json, sys, tarfile, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('ort_inputs', sys.argv[1])
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)

def tar_bytes(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return stream.getvalue()

packages = ['abseil', 'cpuinfo', 'onnx', 'protobuf', 're2', 'eigen3', 'nlohmann-json',
            'boost-config', 'boost-mp11', 'flatbuffers', 'ms-gsl', 'wil', 'safeint']
overlay_names = ['abseil', 'cpuinfo', 'onnx', 'protobuf', 'eigen3']
source = tar_bytes({'fixture-source/LICENSE': b'fixture license'})
checksum = hashlib.sha512(source).hexdigest()
recipe = ('vcpkg_from_github(\n REPO example/dependency\n REF 77.88.99\n SHA512 ' + checksum + '\n)').encode()
metadata = json.dumps({'version': '77.88.99', 'license': 'MIT'}).encode()
tree_id, old_tree_id = 'c' * 40, 'd' * 40
with tempfile.TemporaryDirectory() as temporary:
    workspace = Path(temporary) / 'workspace'
    build = workspace / 'native/build'
    build.mkdir(parents=True)
    baseline_commit, ort_commit = 'a' * 40, 'b' * 40
    registry_files = {}
    for name in packages:
        for filename, data in [('portfile.cmake', recipe), ('vcpkg.json', metadata)]:
            registry_files['vcpkg-' + baseline_commit + '/ports/' + name + '/' + filename] = data
            if name in overlay_names:
                path = workspace / 'native/upstream-evidence/onnxruntime-overlay-ports' / name / filename
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
    registry_files['vcpkg-' + baseline_commit + '/versions/f-/flatbuffers.json'] = json.dumps({'versions': [
        {'version': '77.88.99', 'port-version': 0, 'git-tree': old_tree_id},
        {'version': '77.88.99', 'port-version': 2, 'git-tree': tree_id},
    ]}).encode()
    registry = tar_bytes(registry_files)
    definition = {'schemaVersion': 1, 'sources': {
        'onnxruntime': {'repository': 'microsoft/onnxruntime', 'commit': ort_commit, 'sha256': hashlib.sha256(source).hexdigest()},
        'vcpkg': {'repository': 'microsoft/vcpkg', 'commit': baseline_commit, 'sha256': hashlib.sha256(registry).hexdigest()},
    }, 'historicalPorts': {'flatbuffers': {'version': '77.88.99', 'portVersion': 2}}}
    (build / 'onnxruntime-sources.json').write_text(json.dumps(definition))
    blobs = {'e' * 40: recipe, 'f' * 40: metadata}
    responses = {
        'https://codeload.github.com/microsoft/onnxruntime/tar.gz/' + ort_commit: source,
        'https://codeload.github.com/microsoft/vcpkg/tar.gz/' + baseline_commit: registry,
        'https://codeload.github.com/example/dependency/tar.gz/77.88.99': source,
        'https://api.github.com/repos/microsoft/vcpkg/git/trees/' + tree_id: json.dumps({'tree': [
            {'type': 'blob', 'path': 'portfile.cmake', 'sha': 'e' * 40},
            {'type': 'blob', 'path': 'vcpkg.json', 'sha': 'f' * 40},
        ]}).encode(),
    }
    responses.update({'https://api.github.com/repos/microsoft/vcpkg/git/blobs/' + key:
                      json.dumps({'content': base64.b64encode(data).decode()}).encode() for key, data in blobs.items()})
    root = Path(temporary) / 'output'
    with patch.object(inputs, 'request', side_effect=lambda url: responses[url]) as request:
        inputs.main(workspace, root)
        assert request.call_count == 18
    result = json.loads((root / 'source-inputs.json').read_text())
    assert result['complete'] and len(result['sources']) == len(packages)
    flatbuffers = next(item for item in result['sources'] if item['id'] == 'flatbuffers')
    assert flatbuffers['recipeOrigin'] == 'vcpkg-history-' + tree_id
    assert all(item['version'] == '77.88.99' and item['sha512'] == checksum for item in result['sources'])
    for name, pin in definition['sources'].items():
        archive = root / 'archives' / (name + '-' + pin['commit'] + '.tar.gz')
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == pin['sha256']
    (root / 'archives' / ('onnxruntime-' + ort_commit + '.tar.gz')).write_bytes(b'changed cache')
    with patch.object(inputs, 'request', side_effect=AssertionError('Cached archive must be checked without network')):
        try:
            inputs.main(workspace, root)
        except ValueError as error:
            assert str(error) == 'Changed source archive: onnxruntime'
        else:
            raise AssertionError('Changed archive was accepted')
print('Manifest-driven source pins, historical port selection and checksum checks passed')
`, fileURLToPath(new URL('./native-ort-source-inputs.py', import.meta.url))], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test('ORT comparison uses a stable extracted root and rejects changed dependency source bytes', () => {
  const child = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', String.raw`
import hashlib, io, json, subprocess, sys, tarfile, tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as temporary:
    workspace = Path(temporary) / 'workspace'
    evidence = workspace / 'native/upstream-evidence'
    evidence.mkdir(parents=True)
    (evidence / 'onnxruntime-dependency-inventory.json').write_text(json.dumps({
        'dllPdbIdentityMatches': True, 'binarySha256': 'a' * 64, 'pdbSha256': 'b' * 64,
        'vcpkgHeaderChecksums': {}, 'compiledSourceChecksums': {},
    }))
    root = Path(temporary) / 'output'
    (root / 'archives').mkdir(parents=True)
    (root / 'ports/protobuf').mkdir(parents=True)
    (root / 'ports/protobuf/portfile.cmake').write_text('')
    archive = root / 'archives/protobuf-fixture.tar.gz'
    data = b'fixture CMake rules'
    with tarfile.open(archive, 'w:gz') as stream:
        info = tarfile.TarInfo('protobuf-77.88.99/cmake/CMakeLists.txt')
        info.size = len(data)
        stream.addfile(info, io.BytesIO(data))
    (root / 'source-inputs.json').write_text(json.dumps({'complete': True, 'sources': [{
        'id': 'protobuf', 'file': archive.name, 'sha512': hashlib.sha512(archive.read_bytes()).hexdigest(),
    }]}))
    command = [sys.executable, '-B', sys.argv[1], str(workspace), str(root)]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    stable = root / 'comparison-sources/protobuf/source/cmake/CMakeLists.txt'
    assert stable.read_bytes() == data
    assert not (root / 'comparison-sources/protobuf/protobuf-77.88.99').exists()
    archive.write_bytes(b'changed source archive')
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode != 0 and 'Changed source archive' in result.stderr
    assert stable.read_bytes() == data
print('Stable extracted root and source checksum checks passed')
`, fileURLToPath(new URL('./native-ort-compare.py', import.meta.url))], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test('ORT packaging derives version and source pins, preserves notices, and refuses stale review or changed archives', () => {
  const child = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', String.raw`
import hashlib, json, os, shutil, subprocess, sys, tarfile, tempfile
from pathlib import Path
script = Path(sys.argv[1])
sha = lambda data: hashlib.sha256(data).hexdigest()
with tempfile.TemporaryDirectory() as temporary:
    workspace = Path(temporary) / 'workspace'
    root, destination = Path(temporary) / 'root', Path(temporary) / 'package'
    for path in ['native/build', 'native/reviews', 'native/upstream-evidence', 'scripts']:
        (workspace / path).mkdir(parents=True, exist_ok=True)
    for path in ['archives', 'comparison-sources/protobuf/source', 'ports/protobuf', 'generated-header-evidence']:
        (root / path).mkdir(parents=True, exist_ok=True)
    definition = {'schemaVersion': 1, 'sources': {}}
    required = {}
    for name, character in [('onnxruntime', 'a'), ('vcpkg', 'b')]:
        data = (name + ' source fixture').encode()
        commit = character * 40
        definition['sources'][name] = {'repository': 'microsoft/' + name, 'commit': commit, 'sha256': sha(data)}
        filename = name + '-' + commit + '.tar.gz'
        (root / 'archives' / filename).write_bytes(data)
        required['sources/' + filename] = sha(data)
    (workspace / 'native/build/onnxruntime-sources.json').write_text(json.dumps(definition))
    runtime = {'components': [{'id': 'onnxruntime', 'version': '77.88.99', 'runtimeFiles': [
        {'target': 'onnxruntime.dll', 'sha256': 'c' * 64},
    ]}]}
    runtime_path = workspace / 'native/runtime-windows-x64.json'
    runtime_path.write_text(json.dumps(runtime))
    protobuf_source, protobuf_notice = b'protobuf source fixture', b'fixture protobuf license'
    (root / 'archives/protobuf-fixture.tar.gz').write_bytes(protobuf_source)
    (root / 'comparison-sources/protobuf/source/LICENSE').write_bytes(protobuf_notice)
    (root / 'ports/protobuf/portfile.cmake').write_bytes(b'fixture port')
    (root / 'protoc-build.log').write_text('fixture build log')
    (root / 'source-inputs.json').write_text(json.dumps({'complete': True, 'sources': [
        {'id': 'protobuf', 'version': '66.77.88', 'license': 'MIT', 'file': 'protobuf-fixture.tar.gz', 'sha256': sha(protobuf_source)},
    ]}))
    (root / 'source-comparison-final.json').write_text(json.dumps({
        'binarySha256': 'c' * 64, 'pdbSha256': 'd' * 64,
        'counts': {'exact-bytes': 1, 'exact-after-checkout-crlf': 0, 'exact-reconstructed-installed-header': 0, 'mismatch': 0, 'missing-or-generated': 0},
    }))
    boost_title = 'Boost Software License - Version 1.0 - August 17th, 2003'
    upstream_notices = boost_title + '\nfixture boost license\n_____'
    (workspace / 'native/onnxruntime-ThirdPartyNotices.txt').write_text(upstream_notices)
    (workspace / 'native/onnxruntime-LICENSE').write_bytes(b'fixture ort license')
    required.update({
        'sources/protobuf-fixture.tar.gz': sha(protobuf_source),
        'ports/protobuf/portfile.cmake': sha(b'fixture port'),
        'notices/protobuf/LICENSE': sha(protobuf_notice),
        'notices/Boost-LICENSE_1_0.txt': sha((boost_title + '\nfixture boost license\n').replace('\n', os.linesep).encode()),
        'notices/onnxruntime-LICENSE': sha(b'fixture ort license'),
        'notices/onnxruntime-ThirdPartyNotices.txt': sha((workspace / 'native/onnxruntime-ThirdPartyNotices.txt').read_bytes()),
    })
    review = {'version': '77.88.99', 'binarySha256': 'c' * 64, 'pdbSha256': 'd' * 64, 'observedChecksumRecords': 1,
        'components': [{'id': 'protobuf', 'version': '66.77.88', 'license': 'MIT', 'sourceArchiveSha256': sha(protobuf_source),
                        'notices': [{'file': 'notices/protobuf/LICENSE', 'sha256': sha(protobuf_notice)}]}],
        'files': [{'file': name, 'sha256': checksum} for name, checksum in required.items()]}
    (workspace / 'native/reviews/onnxruntime-dependencies.json').write_text(json.dumps(review))
    for name in ['native-ort-evidence.py', 'native-ort-source-inputs.py', 'native-ort-compare.py',
                 'native-ort-generated.py', 'native-ort-package.py', 'native-source-archive-check.py']:
        shutil.copyfile(script.parent / name, workspace / 'scripts' / name)
    command = [sys.executable, '-B', str(script), str(workspace), str(root), str(destination)]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    archive = destination / 'onnxruntime-source.tar.gz'
    assert archive.is_file()
    manifest = json.loads((destination / 'source-package-inventory.json').read_text())
    assert manifest['version'] == '77.88.99'
    with tarfile.open(archive) as package:
        for name, checksum in required.items():
            assert sha(package.extractfile(name).read()) == checksum, name
        readme = package.extractfile('README.md').read().decode()
        assert 'ONNX Runtime 77.88.99' in readme and 'protobuf 66.77.88' in readme
        assert 'ROOT/comparison-sources/protobuf/source/cmake' in readme
        assert json.loads(package.extractfile('native/build/onnxruntime-sources.json').read()) == definition
    for field, replacement in [('version', '99.99.99'), ('runtimeFiles', [{'target': 'onnxruntime.dll', 'sha256': 'e' * 64}])]:
        original = runtime['components'][0][field]
        runtime['components'][0][field] = replacement
        runtime_path.write_text(json.dumps(runtime))
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode != 0 and 'differs from the reviewed binary' in result.stderr
        runtime['components'][0][field] = original
    runtime_path.write_text(json.dumps(runtime))
    (root / 'archives' / ('onnxruntime-' + 'a' * 40 + '.tar.gz')).write_bytes(b'changed ort source')
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode != 0 and 'Changed source archive: onnxruntime' in result.stderr
print('Manifest-driven packaging, source/notices verification and stale-review refusal passed')
`, fileURLToPath(new URL('./native-ort-package.py', import.meta.url))], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
