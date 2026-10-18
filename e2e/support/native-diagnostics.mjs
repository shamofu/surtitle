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

async function capturePage(failureMessage) {
  // Keep this function self-contained: WebDriver executes its serialized source.
  const limits = { animations: 16, targets: 8, surfaces: 16, properties: 16 };
  const text = value => value == null ? null : String(value).slice(0, 160);
  const scalar = value => typeof value === 'number' && Number.isFinite(value) ? value : text(value);
  const identify = element => element && {
    tag: element.tagName, id: text(element.id), classes: text(element.getAttribute('class')),
    role: text(element.getAttribute('role')), label: text(element.getAttribute('aria-label')),
    testId: text(element.getAttribute('data-testid')),
    text: element.matches('button, a, summary, label') ? text(element.textContent?.trim()) : null,
  };
  const rectangle = element => {
    if (!element) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const active = document.activeElement;
  const page = {
    pathname: location.pathname, innerWidth, innerHeight, devicePixelRatio,
    hidden: document.hidden, documentHasFocus: document.hasFocus(),
    activeElement: active && { tag: active.tagName, role: active.getAttribute('role'), label: active.getAttribute('aria-label') },
    dialog: rectangle(document.querySelector('[role="dialog"], dialog[open], [aria-modal="true"]')),
    nativePlayerViewport: rectangle(document.querySelector('[data-testid="native-player-viewport"]')),
    playbackRatePopup: rectangle(document.querySelector('.playback-rate-popover')),
  };
  // The error sometimes includes WDIO's selector, which need not be valid CSS.
  const failedSelector = failureMessage?.match(/element \("([^"]+)"\)/)?.[1]?.slice(0, 240) ?? null;
  let failedTarget;
  if (failedSelector) {
    const exactText = failedSelector.match(/^([a-z][a-z0-9-]*)=(.*)$/i);
    try {
      failedTarget = exactText
        ? [...document.querySelectorAll(exactText[1])].find(element => element.textContent?.trim() === exactText[2])
        : document.querySelector(failedSelector);
    } catch { /* An unsupported selector must not discard the page receipt. */ }
  }
  const targets = [];
  const addTarget = element => {
    if (!element?.getBoundingClientRect) return null;
    let index = targets.indexOf(element);
    if (index < 0 && targets.length < limits.targets) index = targets.push(element) - 1;
    return index < 0 ? null : index;
  };
  addTarget(failedTarget);
  addTarget(active);
  const animations = [];
  const animationList = document.getAnimations?.() ?? [];
  let finiteActive = 0, infiniteActive = 0;
  for (const animation of animationList) {
    if (!animation.pending && animation.playState !== 'running') continue;
    try {
      if (animation.effect?.getTiming().iterations === Infinity) { infiniteActive++; continue; }
      finiteActive++;
      if (animations.length < limits.animations) {
        animations.push({ animation, targetIndex: addTarget(animation.effect?.target) });
      }
    } catch { /* A disposed animation has no useful timing to sample. */ }
  }
  for (const hovered of [...document.querySelectorAll(':hover')].reverse()) addTarget(hovered);
  const surfaces = [...document.querySelectorAll('.study-companion-dock, details[data-motion-state], .motion-region, .study-motion-region')]
    .filter(element => element.dataset.moving === 'true' || element.dataset.motionState === 'exiting' ||
      element.style.height || element.style.overflow === 'hidden' || element.style.transform);
  const inspectTarget = element => {
    const style = getComputedStyle(element);
    const before = element.getBoundingClientRect(), after = element.getBoundingClientRect();
    // WDIO isStable compares every enumerable DOMRect property, including any
    // inherited non-numeric properties. Record their types and identity too.
    const rectProperties = [];
    for (const name in before) {
      if (rectProperties.length === limits.properties) break;
      rectProperties.push({ name: text(name), type: typeof before[name],
        equalAcrossReads: before[name] === after[name], value: scalar(before[name]) });
    }
    return {
      element: identify(element), connected: element.isConnected, rectangle: rectangle(element),
      hovered: element.matches(':hover'), hiddenAncestor: identify(element.closest('[hidden], [inert], [aria-hidden="true"]')),
      style: Object.fromEntries(['display', 'visibility', 'opacity', 'transform', 'scale', 'translate', 'height', 'overflow', 'pointerEvents']
        .map(name => [name, text(style[name])])),
      rectProperties,
    };
  };
  const inspectAnimation = ({ animation, targetIndex }) => {
    try {
      const timing = animation.effect?.getTiming() ?? {};
      const computed = animation.effect?.getComputedTiming?.() ?? {};
      const properties = new Set();
      for (const frame of (animation.effect?.getKeyframes?.() ?? []).slice(0, 32)) {
        for (const name of Object.keys(frame)) {
          if (!['offset', 'computedOffset', 'easing', 'composite'].includes(name) && properties.size < limits.properties) properties.add(text(name));
        }
      }
      return { targetIndex, target: identify(animation.effect?.target),
        kind: text(animation.constructor?.name), id: text(animation.id),
        animationName: text(animation.animationName), transitionProperty: text(animation.transitionProperty),
        currentTime: scalar(animation.currentTime), startTime: scalar(animation.startTime),
        playState: animation.playState, pending: animation.pending, playbackRate: scalar(animation.playbackRate),
        timing: Object.fromEntries(['duration', 'delay', 'endDelay', 'iterations', 'fill', 'direction', 'easing'].map(name => [name, scalar(timing[name])])),
        progress: scalar(computed.progress), currentIteration: scalar(computed.currentIteration),
        properties: [...properties] };
    } catch (error) { return { targetIndex, diagnosticProblem: text(error?.message ?? error) }; }
  };
  const startedAt = performance.now();
  const sample = () => ({ elapsedMs: Math.round(performance.now() - startedAt),
    targets: targets.map(inspectTarget), animations: animations.map(inspectAnimation) });
  const first = sample();
  await new Promise(resolve => setTimeout(resolve, 120));
  page.motion = { failedSelector, limits, totalAnimations: animationList.length,
    finiteActive, infiniteActive, omittedAnimations: finiteActive - animations.length,
    surfaces: surfaces.slice(0, limits.surfaces).map(element => ({ element: identify(element), rectangle: rectangle(element),
      moving: text(element.dataset.moving), state: text(element.dataset.motionState),
      hidden: element.hidden, inert: element.hasAttribute('inert'),
      height: text(element.style.height), overflow: text(element.style.overflow), transform: text(element.style.transform) })),
    omittedSurfaces: Math.max(0, surfaces.length - limits.surfaces), samples: [first, sample()] };
  return page;
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
      ['page', { method: 'POST', command: 'execute/sync', body: { script: `return (${capturePage.toString()})(arguments[0])`, args: [String(error?.message ?? '')] } }],
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
