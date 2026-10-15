// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { NativeWorker, stopNativeProcess } from './native-session.mjs';
import { nativeSpecs, nativeSpecsForPlatform, nativePlatformName } from './native-suite.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-native-session-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, 'template');
  mkdirSync(template);
  const media = join(root, 'video.mp4');
  writeFileSync(media, 'generated fixture');
  writeFileSync(join(template, 'fixture.json'), JSON.stringify({ mediaPath: media }));
  writeFileSync(join(template, 'learning.sqlite'), 'do not copy an existing database');
  const environment = { SURTITLE_E2E_BINARY: process.execPath, SURTITLE_E2E_SEED_BINARY: process.execPath,
    SURTITLE_E2E_DATA_DIR: template, SURTITLE_E2E_RUN_ARTIFACT_DIR: join(root, 'artifacts'),
    SURTITLE_NATIVE_DRIVER: join(root, 'verified driver.exe') };
  return { root, template, environment };
}

test('each spec seeds a new profile before driver launch and keeps the original template untouched', async t => {
  const f = fixture(t);
  const calls = [];
  const dependencies = {
    spawn: (_binary, args, _directory, label, environment) => {
      calls.push({ label, args, profile: environment.SURTITLE_E2E_DATA_DIR });
      const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null });
      if (label === 'seed') {
        writeFileSync(join(args[0], 'fixture.json'), JSON.stringify({ mediaPath: args[1] }));
        writeFileSync(join(args[0], 'learning.sqlite'), 'fresh database');
        queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); });
      }
      return child;
    },
    waitForDriver: async () => {},
  };
  const first = new NativeWorker({ ...f.environment }, dependencies);
  const second = new NativeWorker({ ...f.environment }, dependencies);
  t.onTestFinished(() => Promise.all([first.stop(), second.stop()]));
  await first.start(['e2e/native/study.e2e.js'], '0-1');
  await second.start(['e2e/native/transcript-review.e2e.js'], '0-2');
  assert.notEqual(first.profile, second.profile);
  assert.notEqual(first.profile, f.template);
  assert.deepEqual(calls.map(item => item.label), ['seed', 'driver', 'seed', 'driver']);
  assert.equal(calls[0].profile, calls[1].profile);
  assert(calls[1].args.includes(f.environment.SURTITLE_NATIVE_DRIVER));
  assert.equal(readFileSync(join(f.template, 'learning.sqlite'), 'utf8'), 'do not copy an existing database');
  assert.equal(first.environment.SURTITLE_E2E_AI_RECOVERY, 'translation');
  assert.equal(first.environment.SURTITLE_E2E_TRANSCRIPT_REVIEW, 'boundary');
});

test('owned child termination is awaited before the next native session can start', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await stopNativeProcess(child, { processGroup: false, timeoutMs: 1000 });
  assert(child.exitCode != null || child.signalCode != null);
  await stopNativeProcess(child, { processGroup: false });
});

if (process.platform === 'linux') {
  test.each([false, true])('owned group terminates a SIGTERM-resistant descendant when its leader already exited: %s', async alreadyExited => {
    const descendantCode = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
    const leaderCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio: ['ignore', 'inherit', 'inherit']}); setInterval(() => {}, 1000);`;
    const leader = spawn(process.execPath, ['-e', leaderCode], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    let readyTimer;
    try {
      const [output] = await Promise.race([
        once(leader.stdout, 'data'),
        new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Descendant did not become ready')), 3000); }),
      ]);
      clearTimeout(readyTimer);
      const descendant = Number(String(output).trim());
      assert(Number.isSafeInteger(descendant) && descendant > 0);
      if (alreadyExited) {
        const exited = once(leader, 'exit');
        leader.kill('SIGTERM');
        await exited;
      }
      await stopNativeProcess(leader, { timeoutMs: 100, killTimeoutMs: 1000 });
      // A container PID 1 may retain a terminated orphan as a zombie.
      try {
        const stat = readFileSync(`/proc/${descendant}/stat`, 'utf8');
        assert(['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]), 'Owned descendant remains running');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.equal(unrelated.exitCode, null);
      assert.equal(unrelated.signalCode, null);
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
      await stopNativeProcess(leader, { timeoutMs: 100, killTimeoutMs: 1000 });
    } finally {
      clearTimeout(readyTimer);
      try { process.kill(-leader.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      leader.stdout.destroy();
      await stopNativeProcess(unrelated, { processGroup: false, timeoutMs: 1000 });
    }
  });
}

test('driver startup failure preserves its cause and stage and removes its exit cleanup listener', async t => {
  const f = fixture(t);
  const cause = new Error('The exact native driver refused its status request');
  const listeners = process.listenerCount('exit');
  const worker = new NativeWorker({ ...f.environment }, {
    spawn: (_binary, args, _directory, label) => {
      const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null });
      if (label === 'seed') {
        writeFileSync(join(args[0], 'fixture.json'), JSON.stringify({ mediaPath: args[1] }));
        queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); });
      }
      return child;
    },
    waitForDriver: async () => { throw cause; },
  });
  await assert.rejects(worker.start(['e2e/native/study.e2e.js'], '0-3'), error => error === cause);
  assert.equal(process.listenerCount('exit'), listeners);
  const metadata = JSON.parse(readFileSync(join(worker.directory, 'session.json'), 'utf8'));
  assert.equal(metadata.phase, 'startup-failed');
  assert.equal(metadata.failure.message, cause.message);
  assert(metadata.stoppedAt);
});

test('the native registry covers every authored spec and selects only applicable OS cases', () => {
  const actual = readdirSync(new URL('../native/', import.meta.url)).filter(name => name.endsWith('.e2e.js')).sort();
  assert.deepEqual(actual, nativeSpecs.map(item => `${item.name}.e2e.js`).sort());
  assert.equal(nativeSpecsForPlatform('win32').length, 14);
  assert.equal(nativeSpecsForPlatform('linux').length, 5);
  assert.equal(nativePlatformName('win32'), 'windows');
  assert.equal(nativePlatformName('linux'), 'linux');
  assert.throws(() => nativeSpecsForPlatform('darwin'), /Unsupported/);
});
