// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPassedTest, execute, runRequiredSuite, selectSuite } from './run-required-rust-tests.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-required-rust 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return { root };
}
const pass = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out; finished in 0.01s\n';

test('requires an available suite and exactly one passed test', () => {
  assert.throws(() => selectSuite('unknown', 'linux'), /Unknown/);
  assert.throws(() => selectSuite('windows-native', 'linux'), /requires win32/);
  assert.throws(() => selectSuite('windows-native', 'win32', 'arm64'), /x64/);
  assertPassedTest(pass, 'required');
  for (const output of ['', pass.replace('1 passed', '0 passed'), pass.replace('0 ignored', '1 ignored'), pass + pass]) {
    assert.throws(() => assertPassedTest(output, 'required'), /exactly one pass/);
  }
});

test('runs exact ignored Cargo tests and stops on failed or empty runs', async t => {
  const f = fixture(t), calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: pass };
  };
  await runRequiredSuite('linux-ffmpeg', { root: f.root, platform: 'linux', run });
  assert(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.command, 'cargo');
    assert.equal(call.args[0], 'test');
    assert.deepEqual(call.args.slice(call.args.indexOf('--')), ['--', '--ignored', '--exact', '--test-threads=1', '--nocapture', '--color=never']);
    assert(call.args[call.args.indexOf('--') - 1].includes('::'));
    assert(call.options.logPrefix.startsWith(f.root));
  }
  for (const result of [{ code: 7, stdout: pass }, { code: 0, stdout: pass.replace('1 passed', '0 passed') }]) {
    let count = 0;
    await assert.rejects(runRequiredSuite('linux-ffmpeg', { root: f.root, platform: 'linux', run: async () => { count++; return result; } }));
    assert.equal(count, 1);
  }
});

test('real process evidence preserves stdout, stderr and a nonzero status', async t => {
  const f = fixture(t), logPrefix = join(f.root, 'child');
  const result = await execute(process.execPath, ['-e', 'console.log("child stdout"); console.error("child stderr"); process.exitCode=7'],
    { cwd: f.root, env: process.env, timeoutMs: 5000, logPrefix, showStdout: false });
  assert.equal(result.code, 7);
  assert.match(readFileSync(logPrefix + '.stdout.log', 'utf8'), /child stdout/);
  assert.match(readFileSync(logPrefix + '.stderr.log', 'utf8'), /child stderr/);
});

test('watchdog terminates its own child tree while an unrelated process continues', async t => {
  const f = fixture(t), ownedBeat = join(f.root, 'owned-beat'), unrelatedBeat = join(f.root, 'unrelated-beat');
  const until = async (condition, message) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, message);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const running = pid => {
    try {
      process.kill(pid, 0);
      // A container's PID 1 may not reap an orphan immediately. Zombies have
      // exited and cannot write heartbeats, even though kill(pid, 0) succeeds.
      return process.platform !== 'linux' || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch (error) {
      if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
      throw error;
    }
  };
  // Overwriting briefly truncates a heartbeat to zero bytes. Append sequences
  // so a concurrent reader can only see the same length or forward progress.
  const heartbeat = path => `const fs=require('node:fs');let sequence=0;const beat=()=>fs.appendFileSync(${JSON.stringify(path)},String(sequence++)+'\\n');beat();setInterval(beat,25)`;
  const unrelated = spawn(process.execPath, ['-e', heartbeat(unrelatedBeat)], { windowsHide: true, stdio: 'ignore' });
  const unrelatedClosed = new Promise(resolve => unrelated.once('close', resolve));
  const ownedPids = [];
  t.onTestFinished(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
    for (const pid of ownedPids) if (running(pid)) process.kill(pid, 'SIGKILL');
    await unrelatedClosed;
    await until(() => ownedPids.every(pid => !running(pid)), 'Test cleanup must finish before removing heartbeat files');
  });
  const source = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(heartbeat(ownedBeat))}],{windowsHide:true,stdio:'ignore'});console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`;
  await assert.rejects(execute(process.execPath, ['-e', source], { cwd: f.root, env: process.env, timeoutMs: 1500, logPrefix: join(f.root, 'timeout'), showStdout: false }), error => {
    assert.match(error.message, /timed out/);
    const pids = JSON.parse(error.result.stdout);
    assert.equal(pids.length, 2);
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    ownedPids.push(...pids);
    return true;
  });
  assert.ok(readFileSync(ownedBeat).length > 0, 'The owned grandchild must run before the watchdog fires');
  assert.ok(readFileSync(unrelatedBeat).length > 0, 'The unrelated process must run before the watchdog fires');
  await until(() => ownedPids.every(pid => !running(pid)), 'The watchdog must terminate both its child and grandchild');
  const lastOwned = readFileSync(ownedBeat, 'utf8');
  let lastUnrelated = readFileSync(unrelatedBeat).length;
  for (let observation = 0; observation < 3; observation++) {
    await until(() => {
      assert.equal(readFileSync(ownedBeat, 'utf8'), lastOwned);
      assert.ok(running(unrelated.pid), 'The watchdog must leave the unrelated process alive');
      return readFileSync(unrelatedBeat).length > lastUnrelated;
    }, 'The unrelated process must keep appending heartbeats after the owned tree exits');
    lastUnrelated = readFileSync(unrelatedBeat).length;
  }
  assert.equal(readFileSync(ownedBeat, 'utf8'), lastOwned);
}, 20_000);
