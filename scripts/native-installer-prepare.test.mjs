import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('source preparation preserves pinned sources/notices and rejects tampered downloads', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', String.raw`
import hashlib, importlib.util, io, json, pathlib, tarfile, tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('prepare', 'scripts/native-installer-prepare.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
    root=pathlib.Path(temp); downloads=root/'work/native-installer-downloads'; downloads.mkdir(parents=True)
    toolchain=root/'rust'; notice=toolchain/'share/doc/rust/LICENSE-MIT'; notice.parent.mkdir(parents=True); notice.write_bytes(b'rust notice')
    (root/'native/installer-notices').mkdir(parents=True); (root/'native/installer-notices/NSIS.txt').write_bytes(b'NSIS notice')
    notices=root/'src-tauri/resources/notices/installer'; notices.mkdir(parents=True); (notices/'NSIS.txt').write_bytes(b'previous output')
    (root/'work/installer-sources').mkdir(parents=True)
    payloads={name:name.encode() for name in ['nsis-source.tar.bz2','plugin.tar.gz','dependency.crate']}
    data=io.BytesIO()
    with tarfile.open(fileobj=data,mode='w:xz') as archive:
        item=tarfile.TarInfo('rust-src/rust-src/lib/rustlib/src/rust/library/compiler-builtins/LICENSE.txt'); item.size=8; archive.addfile(item,io.BytesIO(b'builtins'))
    payloads['rust.tar.xz']=data.getvalue()
    digest=lambda data: hashlib.sha256(data).hexdigest()
    item=lambda file:{'file':file,'url':'https://example.invalid/'+file,'sha256':digest(payloads[file])}
    inputs={'sourceArchive':item('nsis-source.tar.bz2'),
      'plugin':{'sourceArchive':item('plugin.tar.gz'),'sourceCrates':[item('dependency.crate')]},
      'rust':{'sourceArchive':item('rust.tar.xz'),'notices':[{'file':'LICENSE-MIT','sha256':digest(b'rust notice')}]},
      'notices':[{'file':'NSIS.txt','sha256':digest(b'NSIS notice')}]}
    (root/'native/installer-inputs.json').write_text(json.dumps(inputs))
    runtime={'prerequisites':[{'id':'microsoft-vc-runtime-x64','minimumVersion':'14.44.35211.0','downloadUrl':'https://example.invalid/vc.exe'}]}
    (root/'native/runtime-windows-x64.json').write_text(json.dumps(runtime))
    requests=[]
    def response(request,timeout): requests.append(request.full_url); return io.BytesIO(payloads[pathlib.PurePosixPath(request.full_url).name])
    with patch.object(m.urllib.request,'urlopen',response): m.prepare(root,toolchain)
    assert len(requests)==4
    generated=(root/'work/installer-prerequisite.nsh').read_text()
    assert '!define SURTITLE_VC_MINIMUM_VERSION "14.44.35211"' in generated
    assert '!define SURTITLE_VC_DOWNLOAD_URL "https://example.invalid/vc.exe"' in generated
    assert (notices/'NSIS.txt').read_bytes()==b'NSIS notice'
    with patch.object(m.urllib.request,'urlopen',response): m.prepare(root,toolchain)
    assert len(requests)==4, 'A retry must reuse verified downloads'
    assert (root/'src-tauri/resources/notices/installer/rust-runtime/compiler-builtins-LICENSE.txt').read_bytes()==b'builtins'
    sources=json.loads((root/'work/installer-sources/sources.json').read_text())['sources']; assert len(sources)==4
    for source in sources: assert m.digest(root/'work/installer-sources'/source['file'])==source['sha256']
    changed=downloads/'dependency.crate'; changed.write_bytes(b'changed')
    try: m.download(inputs['plugin']['sourceCrates'][0],downloads)
    except ValueError: pass
    else: raise AssertionError('changed cached archive accepted')
    missing=downloads/'download.bin'; payloads['download.bin']=b'HTTP 200 HTML body'
    with patch.object(m.urllib.request,'urlopen',response):
        try: m.download({'file':'download.bin','url':'https://example.invalid/download.bin','sha256':digest(b'required bytes')},downloads)
        except ValueError: pass
        else: raise AssertionError('unverified download accepted')
    assert not missing.exists()
    runtime['prerequisites'][0].update(minimumVersion='14.99.12345.1',downloadUrl='https://example.invalid/new-vc.exe')
    (root/'native/runtime-windows-x64.json').write_text(json.dumps(runtime))
    m.prepare_prerequisite(root)
    generated=(root/'work/installer-prerequisite.nsh').read_text()
    assert '14.99.12345.1' in generated and 'https://example.invalid/new-vc.exe' in generated
    assert '14.44.35211' not in generated
    runtime['prerequisites'][0]['downloadUrl']='https://example.invalid/$injected'
    (root/'native/runtime-windows-x64.json').write_text(json.dumps(runtime))
    try: m.prepare_prerequisite(root)
    except ValueError: pass
    else: raise AssertionError('NSIS interpolation in the prerequisite URL accepted')
`], { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
