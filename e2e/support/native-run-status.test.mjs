// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLValidator } from 'fast-xml-parser';
import { test } from 'vitest';
import { spawnWebDriver } from './webdriver-process.mjs';
import { stopNativeProcess } from './native-session.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const cli = resolve(dirname(fileURLToPath(import.meta.resolve('@wdio/cli'))), '../bin/wdio.js');
const configUrl = new URL('../../wdio.conf.js', import.meta.url).href;
const workerUrl = new URL('./native-session.mjs', import.meta.url).href;

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

// Exercise the installed WDIO runner and the real configuration. A hook that
// merely logs an error must not turn this into a successful native CI run.
for (const stage of ['success', 'testfailure', 'startup', 'readiness', 'cleanup']) {
  test(`native WDIO ${stage} propagates through the real runner and reports`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'surtitle-wdio-status-'));
    const run = join(directory, 'run');
    const template = join(directory, 'template');
    mkdirSync(template);
    const media = join(directory, 'video.mp4');
    writeFileSync(media, 'offline fixture');
    writeFileSync(join(template, 'fixture.json'), JSON.stringify({ mediaPath: media }));
    const bodyMarker = join(directory, 'body-ran');
    const settledMarker = join(directory, 'test-settled');
    const spec = join(directory, 'native.e2e.mjs');
    writeFileSync(spec, `import { writeFileSync } from 'node:fs';
describe('native runner contract', () => {
  afterEach(() => writeFileSync(${JSON.stringify(settledMarker)}, 'settled'));
  it('runs the test body only after readiness', async () => {
    writeFileSync(${JSON.stringify(bodyMarker)}, 'started');
    if (${JSON.stringify(stage)} === 'success') {
      const response = await fetch(process.env.SURTITLE_E2E_CONTRACT_GATE_URL);
      if (!response.ok) throw new Error('contract gate failed');
    }
    if (${JSON.stringify(stage)} === 'testfailure') throw new Error('injected testfailure failure');
  });
  if (${JSON.stringify(stage)} === 'success') {
    it.skip('reports a skipped test without running it', () => { throw new Error('skipped body ran'); });
  }
});\n`);
    const config = join(directory, 'wdio.conf.mjs');
    writeFileSync(config, `import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config as nativeConfig } from ${JSON.stringify(configUrl)};
import { NativeWorker } from ${JSON.stringify(workerUrl)};
NativeWorker.prototype.start = async function() {
  this.directory = join(process.env.SURTITLE_E2E_RUN_ARTIFACT_DIR, 'worker');
  mkdirSync(this.directory, {recursive: true});
  process.env.SURTITLE_E2E_ARTIFACT_DIR = this.directory;
  if (${JSON.stringify(stage)} === 'startup') throw new Error('injected startup failure');
};
NativeWorker.prototype.stop = async function() {
  if (${JSON.stringify(stage)} === 'cleanup') throw new Error('injected cleanup failure');
};
export const config = {
  ...nativeConfig,
  specs: [${JSON.stringify(spec)}],
  waitforTimeout: 1000,
  connectionRetryTimeout: 3000,
  mochaOpts: {...nativeConfig.mochaOpts, timeout: 10000},
};\n`);
    let gateResponse;
    let signalGateReached;
    const gateReached = new Promise(resolveGate => { signalGateReached = resolveGate; });
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === '/contract/gate') {
        gateResponse = response;
        signalGateReached();
        return;
      }
      let status = 200;
      let value = null;
      if (request.method === 'POST' && request.url === '/session') {
        value = { sessionId: 'offline-session', capabilities: {
          platformName: process.platform === 'win32' ? 'windows' : 'linux',
          browserName: 'offline-webview', browserVersion: '123.4',
        } };
      } else if (request.url.endsWith('/timeouts') && stage === 'readiness') {
        status = 500;
        value = { error: 'unknown error', message: 'injected readiness failure', stacktrace: '' };
      } else if (request.url.endsWith('/element')) {
        value = { 'element-6066-11e4-a52e-4f735466cecf': 'heading' };
      } else if (request.url.endsWith('/elements')) {
        value = [{ 'element-6066-11e4-a52e-4f735466cecf': 'heading' }];
      } else if (request.url.endsWith('/execute/sync') || request.url.endsWith('/displayed')) {
        value = true;
      } else if (request.url.endsWith('/screenshot')) {
        value = '';
      } else if (request.url.includes('/css/')) {
        value = 'block';
      }
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ value }));
    });
    let child;
    let deadline;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      child = spawnWebDriver(process.execPath, [cli, 'run', config], {
        cwd: repository, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SURTITLE_E2E_BINARY: process.execPath, SURTITLE_E2E_SEED_BINARY: process.execPath,
          SURTITLE_E2E_DATA_DIR: template, SURTITLE_E2E_RUN_ID: 'hook-contract', SURTITLE_E2E_RUN_ARTIFACT_DIR: run,
          SURTITLE_E2E_CONTRACT_GATE_URL: `http://127.0.0.1:${server.address().port}/contract/gate`,
          SURTITLE_WEBDRIVER_PORT: String(server.address().port), FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      let output = '';
      let stdout = '';
      let signalProgress;
      const progressSeen = new Promise(resolveProgress => { signalProgress = resolveProgress; });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
        output += chunk;
        if (stream === child.stdout) stdout += chunk;
        if (/RUN TEST\s+.*native runner contract.*runs the test body only after readiness/.test(output)) signalProgress();
      });
      const exited = once(child, 'close');
      const timedOut = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Native runner did not exit: ${output}`)), 60000);
      });
      if (stage === 'success') {
        // The test body cannot finish until this process has observed RUN TEST.
        // This checks streaming directly, without assuming a runner speed.
        await Promise.race([
          Promise.all([gateReached, progressSeen]),
          exited.then(() => { throw new Error(`Native runner exited before live progress: ${output}`); }),
          timedOut,
        ]);
        assert.equal(existsSync(settledMarker), false, output);
        gateResponse.writeHead(200).end('continue');
      }
      const [code] = await Promise.race([exited, timedOut]);
      clearTimeout(deadline);
      assert.equal(code, stage === 'success' ? 0 : 1, output);
      assert.equal(existsSync(bodyMarker), ['success', 'testfailure', 'cleanup'].includes(stage), output);
      const reportFiles = files(run).filter(path => path.endsWith('.xml'));
      assert(reportFiles.length > 0, output);
      const reports = reportFiles.map(path => {
        const xml = readFileSync(path, 'utf8');
        assert.equal(XMLValidator.validate(xml), true, output);
        return xml;
      }).join('\n');
      if (['success', 'testfailure', 'cleanup'].includes(stage)) {
        assert.match(reports, /native runner contract/, output);
      }
      const failures = files(join(run, 'failures')).map(path => JSON.parse(readFileSync(path, 'utf8')));
      if (['startup', 'readiness', 'cleanup'].includes(stage)) {
        // Root hooks run before any test suite. Their lifecycle failure is
        // reported separately instead of inventing executed JUnit test cases.
        assert(failures.some(item => item.stage === stage && item.failure?.message.includes(`injected ${stage} failure`)), output);
      } else {
        assert.equal(failures.length, 0, output);
        if (stage === 'success') {
          assert.doesNotMatch(reports, /<failure\b/, output);
          assert.match(reports, /<skipped\b/, output);
          assert.match(output, /PASS TEST\s+.*native runner contract.*runs the test body only after readiness \(\d+(?:\.\d+)?s\)/, output);
          assert.equal(output.match(/runs the test body only after readiness/g)?.length, 2, output);
          assert.match(output, /(?:SKIP|PENDING) TEST\s+.*reports a skipped test without running it/, output);
          assert.equal(output.match(/reports a skipped test without running it/g)?.length, 1, output);
          assert.doesNotMatch(output, /(?:RUN|PASS) TEST[^\r\n]*reports a skipped test without running it/, output);
          assert.match(output, /ENV[^\r\n]*offline-webview[^\r\n]*123\.4/, output);
          assert.match(output, /SUMMARY\s+1 passed, 0 failed, (?:1 skipped|0 skipped, 1 pending) \(/, output);
        } else {
          assert.match(reports, /<failure\b/, output);
          assert.match(reports, /injected testfailure failure/, output);
          assert.match(output, /FAIL TEST\s+.*native runner contract.*runs the test body only after readiness/, output);
          assert.match(output, /SUMMARY\s+0 passed, 1 failed, 0 skipped \(/, output);
          assert.match(stdout, /Error: injected testfailure failure/, output);
          assert.match(stdout, /at [^\r\n]*native\.e2e\.mjs:\d+:\d+/, output);
        }
      }
      if (stage === 'readiness' || stage === 'testfailure') {
        const observations = files(run).filter(path => path.endsWith('.json')).map(path => JSON.parse(readFileSync(path, 'utf8')));
        const diagnostic = observations.find(item => item.kind === (stage === 'readiness' ? 'startup' : 'test') &&
          item.failure?.message.includes(`injected ${stage} failure`));
        assert(diagnostic?.diagnostics?.page && diagnostic?.diagnostics?.player, output);
        assert(existsSync(diagnostic.diagnostics.screenshot.path), output);
      }
    } finally {
      clearTimeout(deadline);
      gateResponse?.destroy();
      try {
        // The WDIO worker can retain stdout after its launcher exits. Reap the
        // owned Job Object/process group without waiting forever for pipe close.
        await stopNativeProcess(child);
      } finally {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        server.closeAllConnections();
        await new Promise(resolveDone => server.close(resolveDone));
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 70000);
}
