// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { captureNativeFailure, diagnosticCommand } from './native-diagnostics.mjs';
import { artifactIdentity, nativeArtifact } from './native-artifacts.mjs';

afterEach(() => vi.unstubAllEnvs());
async function serverFixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('read-only diagnostics abort a server which accepts a request but never responds', async t => {
  const port = await serverFixture(t, () => {});
  await assert.rejects(diagnosticCommand({ port, sessionId: 'hung', method: 'GET', command: 'screenshot', timeoutMs: 80 }), /exceeded 80 ms/);
}, 3000);

test('hook diagnostics retain the primary failure when every WebDriver diagnostic times out', async t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-diagnostics-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv('SURTITLE_E2E_ARTIFACT_DIR', root);
  vi.stubEnv('SURTITLE_E2E_TEST_ID', 'before-hook');
  const port = await serverFixture(t, () => {});
  const result = await captureNativeFailure({ kind: 'hook', title: 'before all', error: new Error('fixture absent'), sessionId: 'hung', port, timeoutMs: 80 });
  assert.equal(result.failure.message, 'fixture absent');
  assert.equal(Object.keys(result.diagnostics).length, 3);
  assert(Object.values(result.diagnostics).every(item => item.diagnosticProblem.includes('exceeded')));
  const files = readdirSync(join(root, 'before-hook'));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'before-hook', files[0]), 'utf8')).failure.message, 'fixture absent');
}, 3000);

test('serialized failure diagnostics identify bounded motion and distinguish geometry from DOMRect property differences', async t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-motion-diagnostics-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv('SURTITLE_E2E_ARTIFACT_DIR', root);
  const dom = new JSDOM(`<div class="study-companion">${Array.from({ length: 25 }, (_, index) =>
    `<div class="motion-region" data-motion-state="exiting"><button id="button-${index}">${index === 24 ? 'Review result' : `Button ${index}`}</button></div>`).join('')}</div>`,
  { url: 'http://localhost/study/fixture', runScripts: 'outside-only' });
  t.onTestFinished(() => dom.window.close());
  const { window } = dom;
  const buttons = [...window.document.querySelectorAll('button')];
  const selected = buttons[24];
  let x = 100;
  selected.getBoundingClientRect = () => ({ x, y: 50, width: 200, height: 40,
    // A per-instance enumerable function must not be mistaken for movement.
    toJSON: () => ({ x }) });
  window.__TAURI_INTERNALS__ = { invoke: async () => ({ paused: true }) };
  window.document.getAnimations = () => {
    window.setTimeout(() => { x = 100.125; selected.style.transform = 'translateX(0.125px)'; }, 40);
    const finite = buttons.map(target => ({
      pending: false, playState: 'running', playbackRate: 1,
      get currentTime() { return window.performance.now(); },
      effect: { target,
        getTiming: () => ({ duration: 240, iterations: 1, easing: 'linear' }),
        getComputedTiming: () => ({ progress: 0.5, currentIteration: 0 }),
        getKeyframes: () => [{ transform: 'none', opacity: 1, offset: 0, computedOffset: 0, easing: 'linear', composite: 'auto' }] },
    }));
    const spinner = { pending: false, playState: 'running', effect: { getTiming: () => ({ iterations: Infinity }) } };
    const finished = { pending: false, playState: 'finished' };
    return [...finite, spinner, finished];
  };
  const port = await serverFixture(t, async (request, response) => {
    try {
      let payload = '';
      for await (const chunk of request) payload += chunk;
      const body = payload && JSON.parse(payload);
      const value = request.url.endsWith('/screenshot') ? 'cG5n' : await window.Function(body.script)(...body.args);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ value }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ value: { error: 'diagnostic fixture', message: error.message } }));
    }
  });
  const result = await captureNativeFailure({ kind: 'test', title: 'moving input',
    error: new Error('element ("button=Review result") still not stable after 15000ms'), sessionId: 'motion', port });
  const motion = result.diagnostics.page.motion;
  assert(motion, JSON.stringify(result.diagnostics.page));
  assert.equal(motion.failedSelector, 'button=Review result');
  assert.equal(motion.totalAnimations, 27);
  assert.equal(motion.finiteActive, 25);
  assert.equal(motion.infiniteActive, 1);
  assert.equal(motion.omittedAnimations, 9);
  assert.equal(motion.surfaces.length, 16);
  assert.equal(motion.omittedSurfaces, 9);
  assert.equal(motion.samples.length, 2);
  const [before, after] = motion.samples;
  assert.equal(before.targets.length, 8);
  assert.equal(before.animations.length, 16);
  assert.equal(before.targets[0].element.id, 'button-24');
  assert.equal(before.targets[0].rectangle.x, 100);
  assert.equal(after.targets[0].rectangle.x, 100.125);
  assert.equal(after.targets[0].style.transform, 'translateX(0.125px)');
  assert(before.targets[0].rectProperties.some(property => property.name === 'toJSON' && property.type === 'function' && !property.equalAcrossReads));
  assert(before.targets[0].rectProperties.some(property => property.name === 'x' && property.type === 'number' && property.equalAcrossReads));
  assert(after.animations[0].currentTime > before.animations[0].currentTime);
  assert.deepEqual(before.animations[0].properties, ['transform', 'opacity']);
  assert.equal(before.animations[0].timing.duration, 240);
  assert.equal(before.animations[0].target.id, 'button-0');
  assert(JSON.stringify(result).length < 128000, 'Bounded motion diagnostics grew beyond 128 KiB');
  assert.equal(result.failure.message, 'element ("button=Review result") still not stable after 15000ms');
}, 5000);

test('artifact names distinguish punctuation and spec/test directories and reject traversal', t => {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-artifacts-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  assert.notEqual(artifactIdentity('ja / light'), artifactIdentity('ja - light'));
  vi.stubEnv('SURTITLE_E2E_ARTIFACT_DIR', root);
  vi.stubEnv('SURTITLE_E2E_TEST_ID', 'first');
  const first = nativeArtifact('page.png');
  vi.stubEnv('SURTITLE_E2E_TEST_ID', 'second');
  assert.notEqual(first, nativeArtifact('page.png'));
  assert.throws(() => nativeArtifact('../outside.png'), /plain file/);
});
