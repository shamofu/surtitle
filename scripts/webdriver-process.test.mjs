// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnWebDriver } from './webdriver-process.mjs';

const marker = 'SURTITLE_TEST_CHILD_JSON:';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-webdriver 日本語 & '));
  const processes = [], ownedPids = new Set();
  t.onTestFinished(async () => {
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const pid of ownedPids) if (alive(pid)) process.kill(pid);
    await Promise.all(processes.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => child.once('close', resolve))));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const write = (name, source) => { const path = join(root, name); writeFileSync(path, source); return path; };
  const record = child => {
    processes.push(child);
    const result = { stdout: '', stderr: '', code: null, signal: null, error: undefined, closed: false };
    child.stdout?.setEncoding('utf8').on('data', chunk => { result.stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', chunk => { result.stderr += chunk; });
    const completed = new Promise(resolve => {
      child.once('error', error => { result.error = error; });
      child.once('close', (code, signal) => { Object.assign(result, { code, signal, closed: true }); resolve(result); });
    });
    const watchdog = setTimeout(() => child.kill(), 20_000);
    void completed.then(() => clearTimeout(watchdog));
    return { child, result, completed };
  };
  const launch = (args, env = {}) => record(spawnWebDriver(process.execPath, args,
    { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }));
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
  const script = f.write('child arguments & 日本語.cjs', `
const os = require('node:os');
const { spawnSync } = require('node:child_process');
let groups = null, userSid = null;
if (process.platform === 'win32') {
  const whoami = spawnSync('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  if (whoami.status !== 0) throw new Error('Cannot inspect actual child token groups: ' + whoami.stderr);
  groups = whoami.stdout;
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  if (identity.status !== 0) throw new Error('Cannot inspect actual child user: ' + identity.stderr);
  userSid = identity.stdout.match(/S-1-5-\\d+(?:-\\d+)*/)?.[0];
}
console.log(${JSON.stringify(marker)} + JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(),
  environment: process.env.SURTITLE_TEST_VALUE, username: os.userInfo().username, groups, userSid }));
console.error('SURTITLE_TEST_CHILD_STDERR: retained');
process.exitCode = 37;
`);
  const run = f.launch([script, ...args], { SURTITLE_TEST_VALUE: '環境 & "literal" \\ value' });
  const result = await run.completed;
  assert.equal(result.error, undefined);
  assert.equal(result.code, 37, result.stderr);
  assert.equal(result.signal, null);
  const actual = childJson(result.stdout);
  assert.deepEqual(actual.args, args);
  assert.equal(actual.cwd, f.root);
  assert.equal(actual.environment, '環境 & "literal" \\ value');
  assert.equal(actual.username, userInfo().username);
  assert.match(result.stderr, /SURTITLE_TEST_CHILD_STDERR: retained/);
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    assert.equal(identity.status, 0, identity.stderr);
    const expectedSid = identity.stdout.match(/S-1-5-\d+(?:-\d+)*/)?.[0];
    assert.ok(expectedSid, 'The calling process must have an inspectable user SID');
    assert.equal(actual.userSid, expectedSid, 'Lowering privileges must preserve the calling user identity');
    const diagnostics = [...result.stderr.matchAll(/\[standard-user\] pid=(\d+) elevated=false integrity=8192 admin=false/g)];
    assert.deepEqual(diagnostics.map(match => Number(match[1])), [actual.pid], 'The launcher must verify the actual child token before resuming it');
    // Inspect the actual child's inherited token, independently of launcher logs.
    assert.match(actual.groups, /S-1-16-8192\b/, 'The launched process must have medium integrity');
    assert.doesNotMatch(actual.groups, /S-1-16-(?:12288|16384)\b/, 'The launched process must not retain high or system integrity');
  }
}, 30_000);

test.skipIf(process.platform !== 'win32')('terminating the Windows launcher ends its child and grandchild while an unrelated process continues', async t => {
  const f = fixture(t), ownedBeat = join(f.root, 'owned-beat'), unrelatedBeat = join(f.root, 'unrelated-beat');
  const worker = f.write('watchdog worker.cjs', `
const fs = require('node:fs');
const path = process.argv[2];
let sequence = 0;
const beat = () => fs.appendFileSync(path, String(sequence++) + '\\n');
beat();
const heartbeat = setInterval(beat, 25);
setTimeout(() => { clearInterval(heartbeat); process.exit(0); }, 30_000);
`);
  const leader = f.write('owned leader.cjs', `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { windowsHide: true, stdio: 'ignore' });
child.once('error', error => { throw error; });
console.log(${JSON.stringify(marker)} + JSON.stringify({ pid: process.pid, grandchildPid: child.pid }));
setTimeout(() => { child.kill(); process.exit(0); }, 30_000);
`);
  const unrelated = f.record(spawn(process.execPath, [worker, unrelatedBeat], { windowsHide: true, stdio: 'ignore' }));
  const run = f.launch([leader, worker, ownedBeat]);
  await until(() => /SURTITLE_TEST_CHILD_JSON:[^\r\n]+\r?\n/.test(run.result.stdout) || run.result.closed, 'Launcher did not start its child');
  assert.equal(run.result.closed, false, run.result.stderr);
  const child = childJson(run.result.stdout);
  f.ownedPids.add(child.pid); f.ownedPids.add(child.grandchildPid);
  await until(() => existsSync(ownedBeat) && existsSync(unrelatedBeat)
    && readFileSync(ownedBeat).length > 0 && readFileSync(unrelatedBeat).length > 0, 'Both watchdog children must run before testing termination');
  assert.ok(alive(child.pid)); assert.ok(alive(child.grandchildPid));
  assert.equal(run.child.kill(), true);
  await until(() => !alive(child.pid) && !alive(child.grandchildPid), 'Closing the launcher must kill its complete owned process tree', 5000);
  await run.completed;
  const ownedAfterExit = readFileSync(ownedBeat, 'utf8'), unrelatedBefore = readFileSync(unrelatedBeat).length;
  await until(() => {
    assert.equal(readFileSync(ownedBeat, 'utf8'), ownedAfterExit);
    assert.ok(alive(unrelated.child.pid));
    return readFileSync(unrelatedBeat).length > unrelatedBefore;
  }, 'The unrelated process must continue appending heartbeats after the owned tree exits', 5000);
  assert.equal(readFileSync(ownedBeat, 'utf8'), ownedAfterExit);
  assert.ok(alive(unrelated.child.pid));
}, 30_000);
