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
