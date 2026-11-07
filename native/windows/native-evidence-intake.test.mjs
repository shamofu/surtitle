// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('intake verifies ZIP bytes and rejects escaping, linked, ambiguous and oversized payloads without extraction', t => {
  const root=mkdtempSync(join(tmpdir(),'surtitle intake ZIP 日本語 & '));
  t.onTestFinished(()=>rmSync(root,{recursive:true,force:true}));
  const script=String.raw`
import hashlib, os, runpy, stat, zipfile
from pathlib import Path
m=runpy.run_path('native/windows/native-evidence-intake.py')
root=Path(os.environ['SURTITLE_INTAKE_TEST_ROOT'])
extract=m['extract_archive']; verify=m['verify_archive']; url=m['validate_url']
url('https://example.invalid/measurement.zip')  # Validation only, no network call.
for unsafe in ('http://example.invalid/a.zip','file:///tmp/a.zip','https://user:password@example.invalid/a.zip'):
    try: url(unsafe)
    except ValueError: pass
    else: raise AssertionError('Unsafe archive URL accepted')
archive=root/'input.zip'
with zipfile.ZipFile(archive,'w') as z:
    z.writestr('report.json','{}'); z.writestr('日本語/measurement.txt','actual fixture bytes')
verify(archive,hashlib.sha256(archive.read_bytes()).hexdigest())
try: verify(archive,'0'*64)
except ValueError: pass
else: raise AssertionError('Wrong archive digest accepted')
extract(archive,root/'valid')
assert (root/'valid/日本語/measurement.txt').read_text()=='actual fixture bytes'
try: extract(archive,root/'valid')
except ValueError: pass
else: raise AssertionError('Existing evidence directory overwritten')
for index,names in enumerate((('../escape.txt',),('/absolute.txt',),('C:/escape.txt',),('Case.txt','case.txt'),('folder/escape.txt',),('.hidden.txt',),('NUL.txt',))):
    bad=root/('bad-%s.zip'%index)
    with zipfile.ZipFile(bad,'w') as z:
        z.writestr('report.json','{}')
        for name in names: z.writestr(name,'untrusted bytes')
    if index==4:
        # Windows ZipInfo normalizes separators when writing. Preserve a raw
        # backslash in both actual ZIP headers so this exercises the reader.
        bad.write_bytes(bad.read_bytes().replace(b'folder/escape.txt',b'folder\\escape.txt'))
    target=root/('rejected-%s'%index)
    try: extract(bad,target)
    except ValueError: pass
    else: raise AssertionError('Unsafe ZIP path accepted')
    assert not target.exists(), 'Rejected archive wrote evidence'
link=root/'link.zip'
with zipfile.ZipFile(link,'w') as z:
    z.writestr('report.json','{}')
    info=zipfile.ZipInfo('linked'); info.create_system=3; info.external_attr=(stat.S_IFLNK|0o777)<<16
    z.writestr(info,'../outside')
try: extract(link,root/'rejected-link')
except ValueError: pass
else: raise AssertionError('ZIP symlink accepted')
try: extract(archive,root/'rejected-size',max_expanded_bytes=3)
except ValueError: pass
else: raise AssertionError('Oversized expansion accepted')
assert not (root/'rejected-size').exists()
print('Pure ZIP/URL/hash guards passed; no download, installer or application executed')
`;
  const result=spawnSync('python',['-B','-c',script],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,SURTITLE_INTAKE_TEST_ROOT:root}});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stdout+result.stderr);
});
