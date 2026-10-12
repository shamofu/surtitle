// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'vitest';
import { setWebViewReducedMotion } from './webview-media.mjs';

async function driver(t, receive) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    receive(request, JSON.parse(body), response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { sessionId: 'webview-session', options: { hostname: '127.0.0.1', port: server.address().port, path: '/wd/hub' } };
}

test('uses the active EdgeDriver session to emulate both preferences and remove only the WebView override', async t => {
  const requests = [];
  const browser = await driver(t, (request, body, response) => {
    requests.push({ method: request.method, path: request.url, body });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value: {} }));
  });
  for (const preference of ['no-preference', 'reduce', null]) await setWebViewReducedMotion(browser, preference);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/wd/hub/session/webview-session/ms/cdp/execute');
    assert.equal(request.body.cmd, 'Emulation.setEmulatedMedia');
  }
  assert.deepEqual(requests.map(request => request.body.params.features), [
    [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    [],
  ]);
});

test('fails clearly when EdgeDriver cannot emulate media rather than silently skipping motion assertions', async t => {
  const browser = await driver(t, (_request, _body, response) => {
    response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value: { error: 'unknown command', message: 'CDP endpoint unavailable' } }));
  });
  await assert.rejects(setWebViewReducedMotion(browser, 'no-preference'), /WebView media emulation failed \(404\): CDP endpoint unavailable/);
});
