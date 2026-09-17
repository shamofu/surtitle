// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnWebDriver } from './webdriver-process.mjs';

const marker = 'SURTITLE_TEST_CHILD_JSON:';
const directTimeoutMs = 10_000;
const identityTimeoutMs = 5_000;
const tokenProbeTimeoutMs = 10_000;
const launcherTimeoutMs = process.platform === 'win32' ? 30_000 : directTimeoutMs;
const nestedLauncherTimeoutMs = process.platform === 'win32' ? 2 * launcherTimeoutMs : directTimeoutMs;
const argumentTimeoutMs = launcherTimeoutMs + (process.platform === 'win32' ? 2 * identityTimeoutMs + tokenProbeTimeoutMs : 0);
const cleanupMarginMs = 5_000;
const treeStepTimeoutMs = 5_000;
const treeWatchdogTimeoutMs = launcherTimeoutMs + 3 * treeStepTimeoutMs + cleanupMarginMs;
const treeSelfExitTimeoutMs = treeWatchdogTimeoutMs + 2 * cleanupMarginMs;
// This is the sum of separately bounded phases, not one unbounded WAL wait.
// Every failed or timed-out phase is checked before starting the next phase.
const walTestTimeoutMs = 3 * launcherTimeoutMs + 2 * nestedLauncherTimeoutMs
  + (process.platform === 'win32' ? launcherTimeoutMs + directTimeoutMs + nestedLauncherTimeoutMs + directTimeoutMs : 0)
  + 2 * cleanupMarginMs;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function processDiagnostic(result) {
  return JSON.stringify({ ...result, error: result.error ? {
    name: result.error.name, code: result.error.code, message: result.error.message,
  } : null });
}
function assertCompleted(result) {
  const diagnostic = processDiagnostic(result);
  assert.equal(result.timedOut, false, `Test child exceeded its phase budget: ${diagnostic}`);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.signal, null, diagnostic);
}
function assertExit(result, expectedCode) {
  assertCompleted(result);
  assert.equal(result.code, expectedCode, processDiagnostic(result));
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function until(condition, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}
function fixture(t, parent = tmpdir()) {
  const root = mkdtempSync(join(parent, 'surtitle-webdriver 日本語 & '));
  const processes = [], ownedPids = new Set();
  t.onTestFinished(async () => {
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const pid of ownedPids) if (alive(pid)) process.kill(pid);
    await Promise.all(processes.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => child.once('close', resolve))));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const write = (name, source) => { const path = join(root, name); writeFileSync(path, source); return path; };
  const record = (child, phase, timeoutMs = directTimeoutMs) => {
    processes.push(child);
    const startedAt = performance.now();
    const result = { phase, pid: child.pid ?? null, timeoutMs, timedOut: false, elapsedMs: 0,
      stdout: '', stderr: '', code: null, signal: null, error: undefined, closed: false };
    child.stdout?.setEncoding('utf8').on('data', chunk => { result.stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', chunk => { result.stderr += chunk; });
    const completed = new Promise(resolve => {
      child.once('error', error => { result.error = error; });
      child.once('close', (code, signal) => {
        Object.assign(result, { code, signal, elapsedMs: Math.round(performance.now() - startedAt), closed: true });
        resolve(result);
      });
    });
    const watchdog = setTimeout(() => {
      result.timedOut = true;
      result.elapsedMs = Math.round(performance.now() - startedAt);
      child.kill();
    }, timeoutMs);
    void completed.then(() => clearTimeout(watchdog));
    return { child, result, completed };
  };
  const launch = (args, phase, { env = {}, timeoutMs = launcherTimeoutMs } = {}) => record(spawnWebDriver(process.execPath, args,
    { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }), phase, timeoutMs);
  return { root, write, record, launch, ownedPids };
}
function childJson(stdout) {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
  assert.equal(lines.length, 1, `Expected exactly one marked child result:\n${stdout}`);
  return JSON.parse(lines[0].slice(marker.length));
}

test('WebDriver launcher preserves literal arguments, cwd, environment, user, stderr and nonzero child status', async t => {
  const f = fixture(t);
  const args = ['plain', '日本語', 'spaces and & punctuation', 'a"b', '""', '', '\\',
    'C:\\spaces & 日本語\\', 'before\\\\"after', 'trailing\\\\'];
  // Request access only: opening this protected key must fail before any write.
  const windowsAccessProbe = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$denied = $false
$machine = $null
$read = $null
$key = $null
try {
  $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64)
  $path = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  $read = $machine.OpenSubKey($path, $false)
  if ($null -eq $read) { throw 'The protected machine key must exist and be readable.' }
  $read.Dispose()
  $read = $null
  try {
    $key = $machine.OpenSubKey($path, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
      [System.Security.AccessControl.RegistryRights]::SetValue)
  } catch {
    $exception = $_.Exception
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    if ($exception.GetType().FullName -cne 'System.Security.SecurityException') {
      throw "$($exception.GetType().FullName): $($exception.Message)"
    }
    $denied = $true
  }
  [pscustomobject]@{ administrator = $administrator; protectedMachineKeyReadable = $true; protectedMachineWriteAccessDenied = $denied } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $read) { $read.Dispose() }
  if ($null -ne $key) { $key.Dispose() }
  if ($null -ne $machine) { $machine.Dispose() }
  $identity.Dispose()
}
`;
  const script = f.write('child arguments & 日本語.cjs', `
const os = require('node:os');
const { spawnSync } = require('node:child_process');
let groups = null, userSid = null, access = null;
if (process.platform === 'win32') {
  const whoami = spawnSync('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: ${identityTimeoutMs} });
  if (whoami.status !== 0) throw new Error('Cannot inspect actual child token groups: ' + (whoami.error?.message ?? whoami.stderr));
  groups = whoami.stdout;
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: ${identityTimeoutMs} });
  if (identity.status !== 0) throw new Error('Cannot inspect actual child user: ' + (identity.error?.message ?? identity.stderr));
  userSid = identity.stdout.match(/S-1-5-\\d+(?:-\\d+)*/)?.[0];
  const probe = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(windowsAccessProbe)}],
    { encoding: 'utf8', windowsHide: true, timeout: ${tokenProbeTimeoutMs} });
  if (probe.status !== 0) throw new Error('Cannot inspect actual child access: ' + (probe.error?.message ?? probe.stderr));
  access = JSON.parse(probe.stdout);
}
console.log(${JSON.stringify(marker)} + JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(),
  environment: process.env.SURTITLE_TEST_VALUE, username: os.userInfo().username, groups, userSid, access }));
console.error('SURTITLE_TEST_CHILD_STDERR: retained');
process.exitCode = 37;
`);
  const run = f.launch([script, ...args], 'arguments-and-token-probe', {
    env: { SURTITLE_TEST_VALUE: '環境 & "literal" \\ value' }, timeoutMs: argumentTimeoutMs,
  });
  const result = await run.completed;
  assertExit(result, 37);
  const actual = childJson(result.stdout);
  assert.deepEqual(actual.args, args);
  // Hosted Windows TEMP can contain an 8.3 alias (RUNNER~1); PowerShell expands
  // it before launching the child. Compare the actual filesystem locations.
  assert.equal(realpathSync.native(actual.cwd), realpathSync.native(f.root));
  assert.equal(actual.environment, '環境 & "literal" \\ value');
  assert.equal(actual.username, userInfo().username);
  assert.match(result.stderr, /SURTITLE_TEST_CHILD_STDERR: retained/);
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: identityTimeoutMs });
    assert.equal(identity.status, 0, processDiagnostic({ phase: 'calling-user-identity', ...identity }));
    const expectedSid = identity.stdout.match(/S-1-5-\d+(?:-\d+)*/)?.[0];
    assert.ok(expectedSid, 'The calling process must have an inspectable user SID');
    assert.equal(actual.userSid, expectedSid, 'Lowering privileges must preserve the calling user identity');
    const diagnostics = [...result.stderr.matchAll(/\[restricted-medium\] pid=(\d+) elevated=(?:true|false) integrity=8192 admin=false elevationType=\d+ privileges=[^\r\n]*/g)];
    assert.deepEqual(diagnostics.map(match => Number(match[1])), [actual.pid], 'The launcher must verify the actual child token before resuming it');
    // Inspect the actual child's inherited token, independently of launcher logs.
    assert.match(actual.groups, /S-1-16-8192\b/, 'The launched process must have medium integrity');
    assert.doesNotMatch(actual.groups, /S-1-16-(?:12288|16384)\b/, 'The launched process must not retain high or system integrity');
    assert.deepEqual(actual.access, { administrator: false, protectedMachineKeyReadable: true, protectedMachineWriteAccessDenied: true },
      'The actual child must lack administrator membership and protected-machine write access regardless of UAC elevation metadata');
  }
}, argumentTimeoutMs + (process.platform === 'win32' ? identityTimeoutMs : 0) + cleanupMarginMs);

for (const location of ['temp', 'workspace']) {
test(`standard-user observers preserve WAL writes across nested app restarts in ${location}`, async t => {
  const parent = location === 'temp' ? tmpdir() : join(process.cwd(), 'work');
  mkdirSync(parent, { recursive: true });
  const f = fixture(t, parent), profile = join(f.root, 'fresh profile 日本語 & SQLite');
  const script = f.write('profile writer.cjs', `
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [profile, phase] = process.argv.slice(2);
if (phase === 'seed') mkdirSync(profile);
const db = new DatabaseSync(join(profile, 'learning.sqlite'), { readOnly: phase === 'observe' });
try {
  if (phase !== 'observe') {
    assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode, 'wal');
    if (phase === 'seed') {
      db.exec('CREATE TABLE saved_state (value INTEGER NOT NULL); INSERT INTO saved_state VALUES (1);');
    } else {
      db.exec('BEGIN IMMEDIATE; UPDATE saved_state SET value=value+1; COMMIT;');
    }
    assert.equal(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
    writeFileSync(join(profile, 'last-writer.txt'), phase);
  }
  console.log(${JSON.stringify(marker)} + JSON.stringify(db.prepare('SELECT value FROM saved_state').get()));
} finally { db.close(); }
`);
  const nested = f.write('nested app launcher.mjs', `
import { spawnWebDriver } from ${JSON.stringify(new URL('./webdriver-process.mjs', import.meta.url).href)};
const child = spawnWebDriver(process.execPath, process.argv.slice(2), { stdio: 'inherit', env: process.env });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
`);
  const launchApp = (root, phase, label) => f.launch([nested, script, root, phase], label,
    { timeoutMs: nestedLauncherTimeoutMs }).completed;
  // SQLite readOnly SELECT still creates WAL/SHM. The observer must share the
  // app's permissions too. Exercise the nested launcher used by WDIO's driver.
  assert.equal(existsSync(profile), false);
  for (const [phase, value] of [['seed', 1], ['observe', 1], ['reopen', 2], ['observe', 2], ['reopen', 3]]) {
    const label = `wal-${location}-${phase}-${value}`;
    const result = phase === 'reopen' ? await launchApp(profile, phase, label)
      : await f.launch([script, profile, phase], label).completed;
    assertExit(result, 0);
    assert.deepEqual(childJson(result.stdout), { value });
    for (const suffix of ['-wal', '-shm']) {
      assert.equal(existsSync(join(profile, `learning.sqlite${suffix}`)), phase === 'observe',
        `Read-only observation must leave ${suffix}; closing the later writer must remove it`);
    }
  }
  if (process.platform === 'win32') {
    // Diagnostic control: reproduce the old elevated-observer boundary when the
    // host ACL/label policy makes it fail. A host that already has medium rights
    // can legitimately share these files; the corrected path above must pass.
    const control = join(f.root, 'host observer control');
    const seeded = await f.launch([script, control, 'seed'], `control-${location}-seed`).completed;
    assertExit(seeded, 0);
    const observed = await f.record(spawn(process.execPath, [script, control, 'observe'],
      { cwd: f.root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), `control-${location}-host-observe`).completed;
    assertExit(observed, 0);
    const acl = spawnSync('icacls.exe', [control, '/T'], { encoding: 'utf8', windowsHide: true, timeout: directTimeoutMs });
    assert.equal(acl.status, 0, processDiagnostic({ phase: `control-${location}-acl`, ...acl }));
    const restarted = await launchApp(control, 'reopen', `control-${location}-reopen`);
    assertCompleted(restarted);
    if (restarted.code !== 0) assert.match(restarted.stderr, /readonly database/i, processDiagnostic(restarted));
    if (process.env.GITHUB_ACTIONS === 'true' || restarted.code !== 0) {
      console.log(JSON.stringify({ location, hostObserverReopenExitCode: restarted.code,
        hostObserverFileAccess: acl.stdout, reopenDiagnostic: restarted.stderr }));
    }
  }
}, walTestTimeoutMs);
}

test.skipIf(process.platform !== 'win32')('terminating the Windows launcher ends its child and grandchild while an unrelated process continues', async t => {
  const f = fixture(t), ownedBeat = join(f.root, 'owned-beat'), unrelatedBeat = join(f.root, 'unrelated-beat');
  const worker = f.write('watchdog worker.cjs', `
const fs = require('node:fs');
const path = process.argv[2];
let sequence = 0;
const beat = () => fs.appendFileSync(path, String(sequence++) + '\\n');
beat();
const heartbeat = setInterval(beat, 25);
setTimeout(() => { clearInterval(heartbeat); process.exit(0); }, ${treeSelfExitTimeoutMs});
`);
  const leader = f.write('owned leader.cjs', `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { windowsHide: true, stdio: 'ignore' });
child.once('error', error => { throw error; });
console.log(${JSON.stringify(marker)} + JSON.stringify({ pid: process.pid, grandchildPid: child.pid }));
setTimeout(() => { child.kill(); process.exit(0); }, ${treeSelfExitTimeoutMs});
`);
  // Allow the same launch budget while requiring each lifecycle check in 5s.
  // Both independent self-exit timers remain above this test's watchdog.
  const unrelated = f.record(spawn(process.execPath, [worker, unrelatedBeat], { windowsHide: true, stdio: 'ignore' }),
    'tree-unrelated-worker', treeWatchdogTimeoutMs);
  const run = f.launch([leader, worker, ownedBeat], 'tree-owned-launcher', { timeoutMs: treeWatchdogTimeoutMs });
  await until(() => /SURTITLE_TEST_CHILD_JSON:[^\r\n]+\r?\n/.test(run.result.stdout) || run.result.closed,
    'Launcher did not start its child', launcherTimeoutMs);
  assert.equal(run.result.timedOut, false, processDiagnostic(run.result));
  assert.equal(run.result.closed, false, processDiagnostic(run.result));
  const child = childJson(run.result.stdout);
  f.ownedPids.add(child.pid); f.ownedPids.add(child.grandchildPid);
  await until(() => existsSync(ownedBeat) && existsSync(unrelatedBeat)
    && readFileSync(ownedBeat).length > 0 && readFileSync(unrelatedBeat).length > 0,
    'Both watchdog children must run before testing termination', treeStepTimeoutMs);
  assert.ok(alive(child.pid)); assert.ok(alive(child.grandchildPid));
  assert.equal(run.child.kill(), true);
  await until(() => !alive(child.pid) && !alive(child.grandchildPid),
    'Closing the launcher must kill its complete owned process tree', treeStepTimeoutMs);
  await run.completed;
  assert.equal(run.result.timedOut, false, processDiagnostic(run.result));
  const ownedAfterExit = readFileSync(ownedBeat, 'utf8'), unrelatedBefore = readFileSync(unrelatedBeat).length;
  await until(() => {
    assert.equal(readFileSync(ownedBeat, 'utf8'), ownedAfterExit);
    assert.ok(alive(unrelated.child.pid));
    return readFileSync(unrelatedBeat).length > unrelatedBefore;
  }, 'The unrelated process must continue appending heartbeats after the owned tree exits', treeStepTimeoutMs);
  assert.equal(readFileSync(ownedBeat, 'utf8'), ownedAfterExit);
  assert.ok(alive(unrelated.child.pid));
}, treeWatchdogTimeoutMs + cleanupMarginMs);
