// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('composed fixture verification rejects blank, stale, shifted and clipped video', () => {
  const script = String.raw`
import runpy
verify=runpy.run_path('native/windows/production-video-pixels.py')['verify_frame']
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
print('Actual pixel/geometry/temporal acceptance guards passed without a desktop capture')
`;
  const result = spawnSync('python', ['-B', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

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
