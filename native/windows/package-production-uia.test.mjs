// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.skipIf(process.platform !== 'win32')('owned Windows PowerShell worker resolves builtin modules across a PowerShell 7 parent', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle worker modules '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'worker');
  const script = String.raw`
$ErrorActionPreference='Stop'
. ./native/windows/production-uia-launch.ps1
# Reproduce a PS7-only inherited module path. The child only hashes repository
# bytes and probes builtin commands; it never loads UIAutomation or a product.
$env:PSModulePath=Join-Path $PSHOME 'Modules'
$command='$ErrorActionPreference="Stop"; Get-Command Get-FileHash, ConvertTo-Json, Get-Content, Add-Type, Start-Sleep | Out-Null; @{hash=(Get-FileHash -LiteralPath package.json -Algorithm SHA256).Hash;major=$PSVersionTable.PSVersion.Major} | ConvertTo-Json -Compress'
Invoke-OwnedUiaWorker (Get-Location).ProviderPath @('-NoProfile','-NonInteractive','-Command',$command) $env:SURTITLE_WORKER_OUTPUT 20
$result=[IO.File]::ReadAllText($env:SURTITLE_WORKER_OUTPUT+'.stdout.log') | ConvertFrom-Json
if($result.major -ne 5 -or $result.hash -ne (Get-FileHash -LiteralPath package.json -Algorithm SHA256).Hash){throw 'Worker hash/JSON roundtrip failed'}
# Also call the real wrapper in this process to verify its finally restores the
# inherited value and its normal nonzero child status contract remains intact.
$arguments=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('["-NoProfile","-NonInteractive","-Command","exit 17"]'))
foreach($value in @($env:PSModulePath, '', $null)) {
    $env:PSModulePath=$value
    $present=Test-Path Env:PSModulePath
    & ./e2e/support/run-windows-standard-user.ps1 -Application (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentsBase64 $arguments
    if($LASTEXITCODE -ne 17 -or $env:PSModulePath -cne $value -or (Test-Path Env:PSModulePath) -ne $present){throw 'Worker status or module path restoration changed'}
}
'builtin module boundary passed'
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, SURTITLE_WORKER_OUTPUT: output },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}, 35_000);

test.skipIf(process.platform !== 'win32')('production UIA context refuses a substituted profile or untrusted CI assertion', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle UIA guards 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const script = String.raw`
$ErrorActionPreference='Stop'
. ./native/windows/production-uia-common.ps1
$local=Join-Path $env:SURTITLE_GUARD_ROOT 'local'
$data=Join-Path $local 'app.surtitle.desktop'
$hosted=@{CI='true';GITHUB_ACTIONS='true';RUNNER_ENVIRONMENT='github-hosted';RUNNER_OS='Windows'}
Assert-ProbeContext $true $hosted $false $local $data 'app.surtitle.desktop'
Assert-ProbeContext $true @{} $true $local $data 'app.surtitle.desktop'
foreach($case in @(
  @{windows=$false;environment=$hosted;disposable=$true;root=$data},
  @{windows=$true;environment=@{CI='true'};disposable=$false;root=$data},
  @{windows=$true;environment=@{};disposable=$false;root=$data},
  @{windows=$true;environment=$hosted;disposable=$true;root=(Join-Path $local 'other')}
)) {
  $rejected=$false
  try { Assert-ProbeContext $case.windows $case.environment $case.disposable $local $case.root 'app.surtitle.desktop' } catch { $rejected=$true }
  if(-not $rejected){throw 'Unsafe execution context was accepted'}
}
'context guards passed'
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, SURTITLE_GUARD_ROOT: root } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test.skipIf(process.platform !== 'win32')('offline production profile audit rejects an AI attempt and detects learning content mutation', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle UIA offline audit 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const script = String.raw`
import json, os, runpy, sqlite3
from pathlib import Path
from unittest.mock import patch
root = Path(os.environ['SURTITLE_GUARD_ROOT'])
fixture = root / '日本語 & sample.mp4'
fixture.write_bytes(b'synthetic media; never decoded')
(root / 'fixture.json').write_text(json.dumps(dict(mediaId='fixture-media',cardId='fixture-card',segmentCount=20000,mediaPath=str(fixture))),encoding='utf-8')
with sqlite3.connect(root / 'learning.sqlite') as db:
    db.executescript('CREATE TABLE media(id,data); CREATE TABLE cards(id,data); CREATE TABLE segments(id,media_id,start_ms,data); CREATE TABLE reviews(id);')
    db.execute('INSERT INTO media VALUES (?,?)',('fixture-media',json.dumps(dict(path=str(fixture)))))
    db.execute('INSERT INTO cards VALUES (?,?)',('fixture-card','original card'))
    db.executemany('INSERT INTO segments VALUES (?,?,?,?)',((str(i),'fixture-media',i,'cue') for i in range(20000)))
with sqlite3.connect(root / 'charges.sqlite') as db:
    db.executescript('CREATE TABLE ai_jobs(id); CREATE TABLE ai_requests(id); CREATE TABLE ai_attempts(id); CREATE TABLE ai_provider_settings(provider,limits_json);')
    db.executemany('INSERT INTO ai_provider_settings VALUES (?,?)',((p,json.dumps(dict(per_job_microusd=0,daily_microusd=0,monthly_microusd=0))) for p in ('vertex','openai')))
(root / 'preferences.json').write_text(json.dumps(dict(settings=dict(aiModels={},credentialConfigured=False,openai=dict(aiModels={},credentialConfigured=False)),tools=dict(ffmpeg=dict(source='managed')))),encoding='utf-8')
audit = runpy.run_path('native/windows/production-profile.py')['audit']
before = audit(root,fixture,False)
assert audit(root,fixture,True) == before
# Rust canonicalize emits a Windows verbatim path; PowerShell resolves the same
# fixture to a normal DOS path. Both metadata and database must identify it.
extended='\\\\?\\'+str(fixture)
identity=json.loads((root/'fixture.json').read_text(encoding='utf-8'))
identity['mediaPath']=extended
(root/'fixture.json').write_text(json.dumps(identity),encoding='utf-8')
with sqlite3.connect(root/'learning.sqlite') as db:
    db.execute('UPDATE media SET data=?',(json.dumps(dict(path=extended)),))
assert audit(root,fixture,False) == before
wrong=root/'different.mp4'; wrong.write_bytes(fixture.read_bytes())
for field in ('metadata','database'):
    for invalid in (str(wrong),str(root/'missing.mp4'),fixture.name,None,17,'bad\0path'):
        if field=='metadata':
            identity['mediaPath']=invalid
            (root/'fixture.json').write_text(json.dumps(identity),encoding='utf-8')
        else:
            with sqlite3.connect(root/'learning.sqlite') as db: db.execute('UPDATE media SET data=?',(json.dumps(dict(path=invalid)),))
        try: audit(root,fixture,False)
        except ValueError: pass
        else: raise AssertionError('An invalid media source was accepted: '+field+repr(invalid))
        identity['mediaPath']=extended
        (root/'fixture.json').write_text(json.dumps(identity),encoding='utf-8')
        with sqlite3.connect(root/'learning.sqlite') as db: db.execute('UPDATE media SET data=?',(json.dumps(dict(path=extended)),))
assert audit(root,fixture,True) == before
with patch.object(type(fixture),'samefile',side_effect=PermissionError('synthetic inaccessible source')):
    try: audit(root,fixture,False)
    except ValueError: pass
    else: raise AssertionError('An inaccessible media source was accepted')
with sqlite3.connect(root / 'charges.sqlite') as db: db.execute('INSERT INTO ai_attempts VALUES (1)')
try: audit(root,fixture,True)
except ValueError: pass
else: raise AssertionError('AI attempt was accepted')
with sqlite3.connect(root / 'charges.sqlite') as db: db.execute('DELETE FROM ai_attempts')
with sqlite3.connect(root / 'learning.sqlite') as db: db.execute("UPDATE cards SET data='changed card'")
assert audit(root,fixture,True)['learningSha256'] != before['learningSha256']
print('offline audit guards passed; no application or UIAutomation invoked')
`;
  const result = spawnSync('python', ['-B', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, SURTITLE_GUARD_ROOT: root } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test.skipIf(process.platform !== 'win32')('production UIA rejects inherited profile state, escaped application paths and overwritten evidence before loading UIAutomation', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle UIA profile 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['profile', 'work/installed', 'work/artifacts']) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, 'profile/learning.sqlite'), 'synthetic file; not opened as a database by path guards');
  writeFileSync(join(root, 'profile/fixture.json'), '{}');
  writeFileSync(join(root, 'work/installed/surtitle.exe'), 'synthetic executable; never executed');
  const script = String.raw`
$ErrorActionPreference='Stop'
. ./native/windows/production-uia-common.ps1
$root=$env:SURTITLE_GUARD_ROOT
$profile=Join-Path $root 'profile'
$app=Join-Path $root 'work/installed/surtitle.exe'
$output=Join-Path $root 'work/artifacts/result.json'
Assert-ProbePaths $root $app $output 'surtitle.exe'
Assert-SeededProfileSkeleton $profile
[IO.File]::WriteAllText((Join-Path $profile 'preferences.json'),'existing user preferences must be protected')
$rejected=$false; try{Assert-SeededProfileSkeleton $profile}catch{$rejected=$true}
if(-not $rejected){throw 'Inherited user state was accepted'}
[IO.File]::WriteAllText($output,'existing evidence must be retained')
$rejected=$false; try{Assert-ProbePaths $root $app $output 'surtitle.exe'}catch{$rejected=$true}
if(-not $rejected){throw 'Existing evidence was accepted'}
if([IO.File]::ReadAllText($output)-ne 'existing evidence must be retained'){throw 'Existing evidence was modified'}
$rejected=$false; try{Assert-ProbePaths $root (Join-Path $root 'outside.exe') (Join-Path $root 'work/artifacts/new.json') 'surtitle.exe'}catch{$rejected=$true}
if(-not $rejected){throw 'Application outside the install workspace was accepted'}
'file guards passed'
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, SURTITLE_GUARD_ROOT: root } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
