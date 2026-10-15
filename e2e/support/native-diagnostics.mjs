// SPDX-License-Identifier: GPL-3.0-or-later
import { request } from 'node:http';
import { writeFileSync } from 'node:fs';
import { nativeArtifact, artifactIdentity } from './native-artifacts.mjs';
let failureSequence = 0;

// Use read-only requests outside WDIO's command queue. The socket deadline also
// applies when a frozen WebView cannot execute a JavaScript-side timeout.
export function diagnosticCommand({ port, sessionId, method, command, body, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let timer;
    const req = request({ hostname: '127.0.0.1', port, method,
      path: `/session/${encodeURIComponent(sessionId)}/${command}`, agent: false,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 32 * 1024 * 1024) req.destroy(new Error('Native diagnostic response exceeded 32 MiB'));
      });
      response.on('error', error => { clearTimeout(timer); reject(error); });
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(text);
          if (response.statusCode !== 200 || parsed.value?.error) throw new Error(parsed.value?.message || `Diagnostic HTTP ${response.statusCode}`);
          resolve(parsed.value);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', error => { clearTimeout(timer); reject(error); });
    timer = setTimeout(() => req.destroy(new Error(`Native diagnostic ${command} exceeded ${timeoutMs} ms`)), timeoutMs);
    req.end(payload);
  });
}

function capturePage() {
  const rectangle = element => {
    if (!element) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const active = document.activeElement;
  return {
    pathname: location.pathname, innerWidth, innerHeight, devicePixelRatio,
    hidden: document.hidden, documentHasFocus: document.hasFocus(),
    activeElement: active && { tag: active.tagName, role: active.getAttribute('role'), label: active.getAttribute('aria-label') },
    dialog: rectangle(document.querySelector('[role="dialog"], dialog[open], [aria-modal="true"]')),
    nativePlayerViewport: rectangle(document.querySelector('[data-testid="native-player-viewport"]')),
    playbackRatePopup: rectangle(document.querySelector('.playback-rate-popover')),
  };
}

function capturePlayer() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ diagnosticProblem: 'Native player IPC exceeded 2 seconds' }), 2000);
    Promise.resolve().then(() => window.__TAURI_INTERNALS__.invoke('get_player_state')).then(
      state => { clearTimeout(timer); resolve({ state }); },
      error => { clearTimeout(timer); resolve({ diagnosticProblem: String(error?.message ?? error) }); },
    );
  });
}

export async function captureNativeFailure({ title, kind, error, sessionId, port, timeoutMs = 3000 }) {
  const identity = `${++failureSequence}-${artifactIdentity(`${kind}-${title}`)}`;
  const observation = { schemaVersion: 1, kind, title, capturedAt: new Date().toISOString(),
    failure: error && { name: error.name, message: String(error.message ?? error), stack: error.stack },
    profile: process.env.SURTITLE_E2E_DATA_DIR, sessionId, diagnostics: {} };
  if (sessionId) {
    const commands = [
      ['page', { method: 'POST', command: 'execute/sync', body: { script: `return (${capturePage.toString()})()`, args: [] } }],
      ['player', { method: 'POST', command: 'execute/sync', body: { script: `return (${capturePlayer.toString()})()`, args: [] } }],
      ['screenshot', { method: 'GET', command: 'screenshot' }],
    ];
    const results = await Promise.allSettled(commands.map(([, command]) => diagnosticCommand({ port, sessionId, timeoutMs, ...command })));
    results.forEach((result, index) => {
      const name = commands[index][0];
      if (result.status === 'rejected') observation.diagnostics[name] = { diagnosticProblem: result.reason.message };
      else if (name === 'screenshot') {
        try {
          const path = nativeArtifact(`${identity}.png`);
          writeFileSync(path, Buffer.from(result.value, 'base64'));
          observation.diagnostics.screenshot = { path };
        } catch (error) { observation.diagnostics.screenshot = { diagnosticProblem: error.message }; }
      } else observation.diagnostics[name] = result.value;
    });
  }
  const path = nativeArtifact(`${identity}.json`);
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`);
  console.info(`[native] ${kind} failed: ${title}; diagnostics: ${path}`);
  return observation;
}
