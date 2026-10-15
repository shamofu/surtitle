// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
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
