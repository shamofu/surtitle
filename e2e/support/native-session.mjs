// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnWebDriver, waitForWebDriver } from './webdriver-process.mjs';
import { artifactIdentity } from './native-artifacts.mjs';
import { nativeSpecs } from './native-suite.mjs';

export function validateNativeEnvironment(environment = process.env) {
  const binary = environment.SURTITLE_E2E_BINARY;
  const template = environment.SURTITLE_E2E_DATA_DIR;
  assert(binary && isAbsolute(binary) && existsSync(binary), 'Set SURTITLE_E2E_BINARY to an existing absolute native binary path');
  assert(template && isAbsolute(template) && existsSync(join(template, 'fixture.json')), 'Set SURTITLE_E2E_DATA_DIR to a disposable directory populated by seed_fixture');
  const fixture = JSON.parse(readFileSync(join(template, 'fixture.json'), 'utf8'));
  assert(isAbsolute(fixture.mediaPath) && existsSync(fixture.mediaPath), 'The template fixture needs an existing absolute media path');
  const seedBinary = environment.SURTITLE_E2E_SEED_BINARY || join(dirname(binary), 'examples', `seed_fixture${process.platform === 'win32' ? '.exe' : ''}`);
  assert(isAbsolute(seedBinary) && existsSync(seedBinary), 'Build seed_fixture or set SURTITLE_E2E_SEED_BINARY to its absolute path');
  return { binary, template, fixture, seedBinary };
}

export function initializeNativeRun(environment = process.env) {
  validateNativeEnvironment(environment);
  environment.SURTITLE_E2E_RUN_ID ||= `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  environment.SURTITLE_E2E_RUN_ARTIFACT_DIR ||= resolve('test-results/native', environment.SURTITLE_E2E_RUN_ID);
  mkdirSync(environment.SURTITLE_E2E_RUN_ARTIFACT_DIR, { recursive: true });
}

function spawnLogged(application, args, directory, label, environment) {
  const out = openSync(join(directory, `${label}.stdout.log`), 'a');
  const err = openSync(join(directory, `${label}.stderr.log`), 'a');
  try {
    return spawnWebDriver(application, args, { stdio: ['ignore', out, err], env: environment,
      windowsHide: true, detached: process.platform !== 'win32' });
  } finally { closeSync(out); closeSync(err); }
}

function processGroupRunning(pid) {
  try { process.kill(-pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform !== 'linux') return true;
  // An orphan can remain a zombie when a container's PID 1 does not reap it.
  // It is already terminated; kill(group, 0) alone would wait forever for it.
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try { stat = readFileSync(`/proc/${entry}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(group) === pid && state !== 'Z' && state !== 'X') return true;
  }
  return false;
}

async function stopNativeProcessGroup(pid, timeoutMs, killTimeoutMs) {
  for (const [signal, timeout] of [['SIGTERM', timeoutMs], ['SIGKILL', killTimeoutMs]]) {
    if (!processGroupRunning(pid)) return;
    try { process.kill(-pid, signal); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    const deadline = Date.now() + timeout;
    while (processGroupRunning(pid)) {
      if (Date.now() >= deadline) break;
      await delay(Math.min(25, deadline - Date.now()));
    }
  }
  if (processGroupRunning(pid)) throw new Error('Owned native process group did not terminate');
}

export async function stopNativeProcess(child, { timeoutMs = 5000, killTimeoutMs = 2000, processGroup = process.platform !== 'win32' } = {}) {
  // The group can outlive its leader, including a driver that already crashed.
  if (processGroup && child?.pid) return stopNativeProcessGroup(child.pid, timeoutMs, killTimeoutMs);
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  const kill = signal => {
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      // Windows closes the wrapper's KILL_ON_JOB_CLOSE handle.
      child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  await new Promise((resolveDone, reject) => {
    let softTimer, hardTimer;
    const done = error => {
      clearTimeout(softTimer); clearTimeout(hardTimer);
      child.removeListener('exit', exited); child.removeListener('error', failed);
      if (error) reject(error); else resolveDone();
    };
    const exited = () => done();
    const failed = error => done(error);
    child.once('exit', exited); child.once('error', failed);
    try { kill('SIGTERM'); } catch (error) { done(error); return; }
    softTimer = setTimeout(() => {
      try { kill('SIGKILL'); } catch (error) { done(error); return; }
      hardTimer = setTimeout(() => done(new Error('Owned native process did not terminate')), killTimeoutMs);
    }, timeoutMs);
  });
}

async function waitForSeed(child, timeoutMs = 60000) {
  let timer;
  try {
    await new Promise((resolveDone, reject) => {
      const done = error => {
        clearTimeout(timer); child.removeListener('error', failed); child.removeListener('exit', exited);
        if (error) reject(error); else resolveDone();
      };
      const failed = error => done(error);
      const exited = (code, signal) => done(code === 0 ? undefined : new Error(`Native fixture seed failed (${code ?? signal}); see seed.stderr.log`));
      child.once('error', failed); child.once('exit', exited);
      timer = setTimeout(() => done(new Error('Native fixture seed exceeded 60 seconds')), timeoutMs);
    });
  } catch (error) {
    await stopNativeProcess(child).catch(cleanup => { error.cleanupFailure = cleanup.message; });
    throw error;
  }
}

export class NativeWorker {
  constructor(environment = process.env, dependencies = {}) {
    this.environment = environment;
    this.spawn = dependencies.spawn ?? spawnLogged;
    this.waitForDriver = dependencies.waitForDriver ?? waitForWebDriver;
  }

  async start(specs, cid) {
    const environment = this.environment;
    const { binary, template, fixture, seedBinary } = validateNativeEnvironment(environment);
    assert.equal(specs.length, 1, 'Each native worker must own exactly one spec');
    const name = basename(specs[0], '.e2e.js');
    const spec = nativeSpecs.find(item => item.name === name);
    assert(spec?.platforms.includes(process.platform), `Native spec ${name} is not declared for ${process.platform}`);
    const identity = artifactIdentity(`${cid}-${name}`);
    const runDirectory = environment.SURTITLE_E2E_RUN_ARTIFACT_DIR || resolve('test-results/native', randomUUID());
    this.directory = resolve(runDirectory, identity);
    mkdirSync(this.directory, { recursive: true });
    environment.SURTITLE_E2E_ARTIFACT_DIR = this.directory;
    delete environment.SURTITLE_E2E_TEST_ID;
    // Seed a new SQLite database, never copy a live WAL/profile. Restarts within
    // this worker keep this path; other specs cannot alter its settings or jobs.
    const profileParent = join(dirname(template), 'native-profiles');
    mkdirSync(profileParent, { recursive: true });
    this.profile = mkdtempSync(join(profileParent, `${identity}-`));
    const workerEnvironment = { ...environment, SURTITLE_E2E_DATA_DIR: this.profile };
    // These fixed offline presets are part of every main-suite fixture contract.
    // The isolated pointer suite can also use them; no provider calls are made.
    workerEnvironment.SURTITLE_E2E_AI_RECOVERY = 'translation';
    workerEnvironment.SURTITLE_E2E_TRANSCRIPT_REVIEW = 'boundary';
    this.metadata = { schemaVersion: 1, cid, spec: specs[0], platform: process.platform, binary,
      profile: this.profile, fixtureMedia: fixture.mediaPath, startedAt: new Date().toISOString(), phase: 'seeding' };
    const save = () => writeFileSync(join(this.directory, 'session.json'), `${JSON.stringify(this.metadata, null, 2)}\n`);
    this.save = save;
    save();
    this.exitCleanup = () => {
      for (const child of [this.seed, this.driver]) {
        if (child?.pid && (process.platform !== 'win32' || (child.exitCode == null && child.signalCode == null))) {
          try {
            if (process.platform === 'win32') child.kill();
            else process.kill(-child.pid, 'SIGKILL');
          } catch { /* the process may already have exited */ }
        }
      }
    };
    process.once('exit', this.exitCleanup);
    try {
      this.seed = this.spawn(seedBinary, [this.profile, fixture.mediaPath], this.directory, 'seed', workerEnvironment);
      await waitForSeed(this.seed);
      assert(existsSync(join(this.profile, 'fixture.json')), 'The native seed did not produce fixture.json');
      Object.assign(environment, workerEnvironment);
      const port = Number(environment.SURTITLE_WEBDRIVER_PORT || 4444);
      const args = ['--port', String(port)];
      if (environment.SURTITLE_NATIVE_DRIVER) args.push('--native-driver', environment.SURTITLE_NATIVE_DRIVER);
      this.driver = this.spawn(environment.SURTITLE_TAURI_DRIVER || 'tauri-driver', args, this.directory, 'driver', environment);
      this.metadata.driverPid = this.driver.pid;
      this.metadata.phase = 'starting-driver'; save();
      await this.waitForDriver(this.driver, { port, timeoutMs: 15000 });
      this.metadata.phase = 'ready'; save();
      console.info(`[native] ${name}: fresh profile ready (${process.platform}); logs: ${this.directory}`);
    } catch (error) {
      this.metadata.phase = 'startup-failed'; this.metadata.failure = { name: error.name, message: error.message, stack: error.stack };
      try { save(); } catch (diagnostic) { error.diagnosticFailure = diagnostic.message; }
      await this.stop().catch(cleanup => { error.cleanupFailure = cleanup.message; });
      throw error;
    }
  }

  async stop() {
    await stopNativeProcess(this.seed);
    await stopNativeProcess(this.driver);
    if (this.exitCleanup) process.removeListener('exit', this.exitCleanup);
    if (this.metadata) {
      this.metadata.stoppedAt = new Date().toISOString();
      this.metadata.driverExit = this.driver && { code: this.driver.exitCode, signal: this.driver.signalCode };
      this.save();
    }
  }
}
