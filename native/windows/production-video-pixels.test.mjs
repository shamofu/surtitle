// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('composed fixture verification rejects blank, stale, shifted and clipped video', () => {
  const script = String.raw`
import json, runpy, subprocess, tempfile, time
from pathlib import Path
from unittest.mock import patch
module=runpy.run_path('native/windows/production-video-pixels.py')
verify=module['verify_frame']
# Authored saturated bars plus a moving bright square: static color metadata
# alone cannot pass the stale-frame check. The viewport has real letterboxing.
rw,rh=160,90
def fixture(square):
    colors=[(240,30,30),(30,240,30),(30,30,240),(230,230,30)]
    return bytes(c for y in range(rh) for x in range(rw)
                 for c in ((245,245,245) if square<=x<square+25 and 30<=y<60 else colors[x//40]))
old=fixture(15); current=fixture(115)
def viewport(image,dx=0,cut=0):
    w,h=200,140; out=bytearray(w*h*3)
    for y in range(112):
        for x in range(200-cut):
            dest=x+dx
            if 0<=dest<w:
                src=((y*rh//112)*rw+x*rw//200)*3
                out[((y+14)*w+dest)*3:((y+14)*w+dest)*3+3]=image[src:src+3]
    return bytes(out)
result=verify(viewport(current),200,140,[current],(rw,rh),old)
assert result['imageBounds']==[0,14,200,112],result
for label,pixels in [('blank',bytes(200*140*3)),('stale',viewport(old)),
                     ('shifted',viewport(current,dx=12)),('clipped',viewport(current,cut=16))]:
    try: verify(pixels,200,140,[current],(rw,rh),old)
    except ValueError: pass
    else: raise AssertionError(label+' video was accepted')
# Ordinary codec/color-rounding noise must not turn this into exact byte matching.
noisy=bytes(min(255,v+2) if v else 0 for v in viewport(current))
verify(noisy,200,140,[current],(rw,rh),old)

# Exercise the complete probe routing and unchanged comparison, without a real
# desktop: only the exact unavailable D3D11VA initialization may try GDI pixels.
probe=module['probe']
unavailable='ffmpeg.exe failed: [Parsed_ddagrab_0] Failed to create D3D11VA device.'
with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary); source=root/'fixture.mp4'; source.write_bytes(b'authored fixture')
    geometry=[262,208,200,140,100,50,1920,1080]
    def exercise(dda, gdi, expected_error=None):
        calls=[]; deadlines=[]
        output=root/'capture.png'
        output.unlink(missing_ok=True)
        def command(executable,args,*,data=None,deadline=None):
            deadlines.append(deadline)
            if executable.name=='ffprobe.exe':
                return json.dumps({'streams':[{'width':640,'height':360,'r_frame_rate':'24/1'}],
                                   'format':{'duration':'12'}}).encode()
            if any('ddagrab=' in arg for arg in args):
                calls.append('dda')
                assert 'offset_x=162:offset_y=158' in args[args.index('-i')+1]
                if isinstance(dda,Exception): raise dda
                return dda
            if 'gdigrab' in args:
                calls.append('gdi')
                assert args[args.index('-i')+1]=='desktop'
                assert args[args.index('-offset_x')+1]=='262'
                assert args[args.index('-offset_y')+1]=='208'
                if isinstance(gdi,Exception): raise gdi
                return gdi
            if '-ss' in args:
                count=int(args[args.index('-frames:v')+1])
                return current*count if count==7 else old
            assert data is not None
            output.write_bytes(data)
            return b''
        with patch.dict(probe.__globals__,run=command):
            try: result=probe(Path('ffmpeg.exe'),source,output,geometry,0.1)
            except (ValueError,subprocess.TimeoutExpired) as error:
                assert expected_error and expected_error in str(error),error
                result=None
            else:
                assert expected_error is None,'Invalid capture was accepted'
        assert len(set(deadlines))==1,'Fallback reset the overall deadline'
        assert deadlines[0]<=time.monotonic()+25
        return result,calls
    result,calls=exercise(viewport(current),None)
    assert calls==['dda'] and 'Desktop Duplication' in result['method']
    result,calls=exercise(ValueError(unavailable),viewport(current))
    assert calls==['dda','gdi'] and 'gdigrab' in result['method']
    assert result['captureInitializationError']==unavailable
    for invalid in [bytes(200*140*3),viewport(old),viewport(current,dx=12),viewport(current,cut=16)]:
        _,calls=exercise(ValueError(unavailable),invalid,'Composed' if any(invalid) else 'No visible')
        assert calls==['dda','gdi']
    for error in [ValueError('Desktop duplication access denied'),
                  ValueError('Composed fixture probe exceeded its 25-second deadline'),
                  subprocess.TimeoutExpired('ffmpeg',15)]:
        _,calls=exercise(error,viewport(current),str(error))
        assert calls==['dda'],'Unrelated capture failure used GDI fallback'
    _,calls=exercise(b'short',viewport(current),'incomplete viewport pixels')
    assert calls==['dda'],'Incomplete DDA pixels used GDI fallback'
    _,calls=exercise(viewport(old),viewport(current),'Composed pixels do not match')
    assert calls==['dda'],'Pixel mismatch used GDI fallback'
    _,calls=exercise(ValueError(unavailable),ValueError('GDI unavailable'),'GDI unavailable')
    assert calls==['dda','gdi']
print('Actual pixel/geometry/temporal acceptance guards passed without a desktop capture')
`;
  const result = spawnSync('python', ['-B', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}, 15000);

test.skipIf(process.platform !== 'win32')('pixel evidence archives verify bytes and preserve existing or escaping files; UIA helper compiles without a window', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle pixels 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const script = String.raw`
$ErrorActionPreference='Stop'
. ./native/windows/production-uia-common.ps1
. ./native/windows/production-video-pixels.ps1
$root=$env:SURTITLE_PIXEL_TEST_ROOT
$source=Join-Path $root 'source';$archive=Join-Path $root 'archive'
$null=New-Item -ItemType Directory -Path $source,$archive
$records=@()
foreach($name in @('baseline.png','seek.png')) {
    $path=Join-Path $source $name
    [IO.File]::WriteAllText($path,'authored synthetic evidence '+$name)
    $records+=@{path=$name;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$report=Join-Path $source 'report.json'
@{pixelEvidence=$records}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $report
Copy-ProductionPixelEvidence $report $archive
foreach($name in @('baseline.png','seek.png')) {
    if((Get-FileHash -LiteralPath (Join-Path $archive $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $source $name)).Hash){throw 'Evidence copy changed bytes'}
}
$rejected=$false;try{Copy-ProductionPixelEvidence $report $archive}catch{$rejected=$true}
if(-not $rejected){throw 'Existing evidence accepted'}
$records[0].path='../outside.png'
@{pixelEvidence=$records}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $report
$rejected=$false;try{Copy-ProductionPixelEvidence $report $archive}catch{$rejected=$true}
if(-not $rejected){throw 'Escaping evidence accepted'}
$records[0].path='baseline.png';$records[0].sha256='0'*64
@{pixelEvidence=$records}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $report
$rejected=$false;try{Copy-ProductionPixelEvidence $report (Join-Path $root 'wrong-hash')}catch{$rejected=$true}
if(-not $rejected){throw 'Changed evidence accepted'}
foreach($file in @('production-video-pixels.ps1','production-uia-worker.ps1','native-acceptance-worker.ps1','package-verify.ps1')) {
    $tokens=$null;$errors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD ('native/windows/'+$file)),[ref]$tokens,[ref]$errors)
    if($errors.Count){throw ($errors|Out-String)}
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -Path ./native/windows/production-uia.cs -ReferencedAssemblies ([System.Windows.Automation.AutomationElement].Assembly.Location),([System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location),([System.Windows.Rect].Assembly.Location)
'Archive guards, script syntax and real OS UIA C# compilation passed; no application or capture invoked'
`;
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...childEnvironment, SURTITLE_PIXEL_TEST_ROOT: root,
      PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}, 20000);
