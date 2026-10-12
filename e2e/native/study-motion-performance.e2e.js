// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { assertNativeVideoBounds, inspectNativeWindow, resizeNativeWindow, sampleNativeVideoBounds } from '../support/native-window.mjs';

// Opt in on the same foreground Windows desktop for both binaries. Timing is
// reported, never asserted in CI; the ordinary native suite owns correctness.
const phase = process.env.SURTITLE_MOTION_PERFORMANCE;
const visualOnly = process.env.SURTITLE_MOTION_VISUAL === '1';
const enabled = process.platform === 'win32' && (visualOnly || ['before', 'after'].includes(phase));
const fixture = JSON.parse(readFileSync(resolve(process.env.SURTITLE_E2E_DATA_DIR, 'fixture.json'), 'utf8'));
const invoke = (command, args = {}) => browser.execute(async (name, parameters) => window.__TAURI_INTERNALS__.invoke(name, parameters), command, args);
const control = request => invoke('player_control', { request });
const player = () => invoke('get_player_state');
const navigate = path => browser.execute(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);

async function measure(cycles, warmupCycles) {
  return browser.executeAsync((count, warmups, done) => {
    const internals = window.__TAURI_INTERNALS__;
    const originalFetch = window.fetch;
    const callbacks = internals.callbacks;
    const callbackRestorations = [];
    const invokeDescriptor = Object.getOwnPropertyDescriptor(internals, 'invoke');
    const instrumentation = { method: 'tauri-ipc-fetch-and-callback', invokeWritable: !!invokeDescriptor?.writable,
      invokeConfigurable: !!invokeDescriptor?.configurable, callbacksAvailable: callbacks instanceof Map };
    const requests = [];
    const transitions = [];
    const warmupTransitions = [];
    const idleFrames = [];
    let incompleteTransition = null;
    let lastSample = null;
    let context = null;
    let sequence = 0;
    const viewport = document.querySelector('.native-player-viewport');
    const dock = document.querySelector('.study-companion-dock');
    const panel = document.querySelector('.study-companion');
    const rail = document.querySelector('.study-transcript-rail');
    const toggle = document.querySelector('.study-transcript-toggle');
    const rect = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const frame = () => new Promise(requestAnimationFrame);
    const sample = at => {
      lastSample = {
        at, moving: dock.dataset.moving === 'true', pending: viewport.dataset.nativePlacement === 'pending',
        expanded: toggle.getAttribute('aria-expanded') === 'true', panelHidden: panel.hidden,
        panelVisibility: getComputedStyle(panel).visibility, video: rect(viewport), rail: rect(rail),
        documentHidden: document.hidden, documentHasFocus: document.hasFocus(),
        attributes: { moving: dock.dataset.moving ?? null, nativePlacement: viewport.dataset.nativePlacement ?? null,
          expanded: toggle.getAttribute('aria-expanded'), panelHidden: panel.getAttribute('hidden'),
          panelTransform: getComputedStyle(panel).transform, toggleDisabled: toggle.disabled },
        connected: { viewport: viewport.isConnected, dock: dock.isConnected, panel: panel.isConnected, toggle: toggle.isConnected },
      };
      return lastSample;
    };
    // Tauri's injected invoke/runCallback properties are immutable. Its Windows
    // IPC transport calls global fetch and exposes the callback Map for debugging.
    // Observe that boundary without replacing production modules or IPC payloads.
    const observedFetch = function (input, init) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (context === null || url.hostname !== 'ipc.localhost' || decodeURIComponent(url.pathname) !== '/player_control') {
        return originalFetch.call(this, input, init);
      }
      let payload;
      try { payload = JSON.parse(typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body)); }
      catch { return originalFetch.call(this, input, init); }
      const request = payload?.request;
      if (!['bounds', 'hide'].includes(request?.action)) return originalFetch.call(this, input, init);
      const observation = { sequence: ++sequence, ...context, requestedAt: performance.now(), action: request.action, bounds: request.bounds };
      requests.push(observation);
      const headers = new Headers(init.headers);
      for (const [header, rejected] of [['Tauri-Callback', false], ['Tauri-Error', true]]) {
        const id = Number(headers.get(header));
        const original = callbacks.get(id);
        if (typeof original !== 'function') { observation.problem = 'The native completion callback was unavailable'; continue; }
        const wrapped = data => {
          observation.acknowledgedAt = performance.now();
          if (rejected) observation.problem = String(data);
          return original(data);
        };
        callbacks.set(id, wrapped);
        callbackRestorations.push({ id, original, wrapped });
      }
      return originalFetch.call(this, input, init);
    };
    window.fetch = observedFetch;
    const restoreInstrumentation = () => {
      context = null;
      window.fetch = originalFetch;
      for (const { id, original, wrapped } of callbackRestorations) {
        if (callbacks.get(id) === wrapped) callbacks.set(id, original);
      }
    };
    async function transition(open, cycle, record) {
      const frames = [];
      const startedAt = performance.now();
      context = { cycle, direction: open ? 'open' : 'close', recorded: record };
      const before = sample(startedAt);
      incompleteTransition = { cycle, direction: context.direction, recorded: record, startedAt, before, frames };
      toggle.click();
      let settledFrames = 0;
      while (performance.now() - startedAt < 10000) {
        const current = sample(await frame());
        frames.push(current);
        const lastBounds = requests.filter(request => request.action === 'bounds' && request.acknowledgedAt !== undefined).at(-1);
        const acknowledged = !record || (lastBounds && ['x', 'y', 'width', 'height'].every(key =>
          Math.abs(Math.round(lastBounds.bounds[key] * devicePixelRatio) - Math.round(current.video[key] * devicePixelRatio)) <= 1));
        const settled = current.expanded === open && current.panelHidden === !open && !current.moving && !current.pending && acknowledged;
        settledFrames = settled ? settledFrames + 1 : 0;
        if (settledFrames >= 3) {
          const completed = { cycle, direction: open ? 'open' : 'close', startedAt, endedAt: current.at, before, frames, endpoint: current };
          incompleteTransition = null;
          return completed;
        }
      }
      throw new Error(`Study panel ${open ? 'open' : 'close'} did not settle`);
    }
    void (async () => {
      if (!viewport || !dock || !panel || !rail || !toggle) throw new Error('Study controls are unavailable');
      if (!(callbacks instanceof Map) || window.fetch !== observedFetch) throw new Error('The native IPC transport cannot be observed');
      if (document.hidden) throw new Error('Performance recording requires the foreground app');
      if (document.documentElement.dataset.motion !== 'full') throw new Error('Enable Windows animation effects for the hardware performance run');
      if (toggle.getAttribute('aria-expanded') === 'true') warmupTransitions.push(await transition(false, -1, false));
      for (let cycle = 0; cycle < warmups; cycle++) {
        warmupTransitions.push(await transition(true, cycle, false));
        warmupTransitions.push(await transition(false, cycle, false));
      }
      if (warmups && !requests.some(request => request.acknowledgedAt !== undefined)) {
        throw new Error('No native request/acknowledgement was observed during warmup; the IPC transport differs from this harness');
      }
      context = null;
      for (let index = 0; index < 30; index++) idleFrames.push(await frame());
      for (let cycle = 0; cycle < count; cycle++) {
        transitions.push(await transition(true, cycle, true));
        transitions.push(await transition(false, cycle, true));
      }
      return { timeOrigin: performance.timeOrigin, userAgent: navigator.userAgent,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        cycles: count, warmupCycles: warmups, instrumentation, idleFrames, warmupTransitions, transitions, requests };
    })().then(result => {
      restoreInstrumentation(); done({ result });
    }, error => {
      restoreInstrumentation();
      done({ problem: String(error), instrumentation, lastSample, incompleteTransition, transitions, warmupTransitions, requests });
    });
  }, cycles, warmupCycles);
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { count: sorted.length, medianMs: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? null,
    over25ms: sorted.filter(value => value > 25).length, over50ms: sorted.filter(value => value > 50).length };
}

function summarize(recording) {
  const activeIntervals = [];
  const resizeIntervals = [];
  for (const transition of recording.transitions) {
    for (let index = 1; index < transition.frames.length; index++) {
      const previous = transition.frames[index - 1], current = transition.frames[index];
      if (previous.moving && current.moving) activeIntervals.push(current.at - previous.at);
      if (Math.abs(current.video.width - previous.video.width) > .01) resizeIntervals.push(current.at - previous.at);
    }
  }
  const bounds = recording.requests.filter(request => request.action === 'bounds' && request.recorded);
  return {
    idleFrameIntervals: distribution(recording.idleFrames.slice(1).map((at, index) => at - recording.idleFrames[index])),
    activeFrameIntervals: distribution(activeIntervals), changingVideoFrameIntervals: distribution(resizeIntervals),
    boundsRoundTrip: distribution(bounds.map(request => request.acknowledgedAt - request.requestedAt)),
    boundsRequestIntervals: distribution(bounds.slice(1).filter((request, index) => {
      const previous = bounds[index]; return previous.cycle === request.cycle && previous.direction === request.direction;
    }).map(request => request.requestedAt - bounds[bounds.indexOf(request) - 1].requestedAt)),
    transitions: recording.transitions.map(transition => ({ cycle: transition.cycle, direction: transition.direction,
      durationMs: transition.endedAt - transition.startedAt, frames: transition.frames.length,
      distinctVideoWidths: new Set(transition.frames.map(frame => Math.round(frame.video.width * recording.viewport.devicePixelRatio))).size,
      boundsRequests: bounds.filter(request => request.cycle === transition.cycle && request.direction === transition.direction).length })),
  };
}

function verifyRecording(recording) {
  assert.equal(recording.transitions.length, recording.cycles * 2);
  assert(!recording.requests.some(request => request.problem), 'A native placement request or its observation failed');
  assert(!recording.requests.some(request => request.action === 'hide'), 'Animation hid the native video');
  for (const transition of recording.transitions) {
    assert(!transition.frames.some(frame => frame.documentHidden), 'The app was backgrounded during measurement');
    const last = recording.requests.filter(request => request.action === 'bounds' && request.acknowledgedAt <= transition.endedAt).at(-1);
    assert(last, 'No native bounds acknowledgement was captured');
    const scale = recording.viewport.devicePixelRatio;
    for (const key of ['x', 'y', 'width', 'height']) {
      assert(Math.abs(Math.round(last.bounds[key] * scale) - Math.round(transition.endpoint.video[key] * scale)) <= 1,
        `Acknowledged ${key} does not match the settled physical viewport`);
    }
  }
}

/** Capture only the owned app client rectangle, including the real D3D child.
 * Keep this separate from cadence runs: desktop capture has measurable cost. */
function captureOwnedClient(root, path) {
  const ffmpeg = process.env.SURTITLE_MOTION_FFMPEG;
  assert(ffmpeg && isAbsolute(ffmpeg), 'Set an absolute SURTITLE_MOTION_FFMPEG for the optional visual recording');
  const width = root.client.Right - root.client.Left, height = root.client.Bottom - root.client.Top;
  assert(root.visible && root.parent === 0 && width > 0 && height > 0, 'The owned app must be visible');
  const args = ['-hide_banner', '-y', '-f', 'gdigrab', '-framerate', '60', '-draw_mouse', '0',
    '-offset_x', String(root.origin.X), '-offset_y', String(root.origin.Y), '-video_size', `${width}x${height}`,
    '-i', 'desktop', '-t', '12', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', path];
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', started = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const stop = () => { if (child.exitCode === null) child.kill(); };
  const timeout = setTimeout(stop, 20000);
  const completed = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!started && /frame=\s*[1-9]\d*/.test(stdout)) { started = true; resolveReady(); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { rejectReady(error); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || !started) {
        const error = new Error(`Owned-app recording failed (${code}): ${stderr}`);
        rejectReady(error); reject(error);
      } else resolve({ args, stdout, stderr });
    });
  });
  // Attach immediately, including before startup can reject.
  const result = completed.then(value => ({ value }), problem => ({ problem }));
  return { ready, result, stop };
}

(enabled ? describe : describe.skip)('opt-in hardware study motion cadence', () => {
  let originalSettings;
  before(async () => {
    assert.equal(process.env.SURTITLE_E2E_HARDWARE_RENDERING, '1', 'Use hardware rendering, not the default WARP native test renderer');
    await browser.waitUntil(async () => browser.execute(() => !!window.__TAURI_INTERNALS__));
    const snapshot = await invoke('get_app_snapshot');
    assert.equal(snapshot.settings.credentialConfigured, false);
    assert.equal(snapshot.budget.spentUsd, 0);
    assert(snapshot.media.some(media => media.id === fixture.mediaId && media.path === fixture.mediaPath));
    originalSettings = snapshot.settings;
    if (process.env.SURTITLE_E2E_FRONTEND_SCRIPT) {
      const scripts = await browser.execute(() => Array.from(document.querySelectorAll('script[src]'), script => new URL(script.src).pathname));
      assert(scripts.includes(process.env.SURTITLE_E2E_FRONTEND_SCRIPT), 'The executable embeds an unexpected frontend');
    }
  });
  after(async () => {
    try { await control({ action: 'pause' }); await control({ action: 'loop' }); }
    finally { if (originalSettings) await invoke('update_settings', { settings: originalSettings }); }
  });
  for (const paused of [true, false]) {
    (visualOnly ? it.skip : it)(`records 20 ${paused ? 'paused' : 'playing'} open/close cycles without screenshot overhead`, async () => {
      const status = paused ? 'paused' : 'playing';
      await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', sentencePause: false, motionPreference: 'system' } });
      await browser.refresh();
      await resizeNativeWindow(1440, 900);
      await navigate(`/study/${fixture.mediaId}`);
      await $('.play-button').waitForEnabled();
      await browser.waitUntil(async () => {
        const state = await player(); return state.ready && state.surfaceVisible && state.videoWidth > 0 && state.videoHeight > 0;
      });
      const loaded = await player();
      await control({ action: 'pause' });
      await control({ action: 'seek', value: 0 });
      // A plain native seek clears A-B repeat. Install it afterwards, with the
      // loop endpoint before EOF so the short fixture stays playing throughout.
      await control({ action: 'loop', startMs: 0, endMs: Math.max(1000, loaded.durationMs - 1000) });
      await control({ action: paused ? 'pause' : 'play' });
      await browser.waitUntil(async () => (await player()).paused === paused);
      const before = await assertNativeVideoBounds();
      const measured = await measure(20, 3);
      if (measured.problem) writeFileSync(resolve(`test-results/native/${phase}-study-motion-${status}.json`),
        `${JSON.stringify({ phase, status, capturedAt: new Date().toISOString(), ...measured }, null, 2)}\n`);
      assert(!measured.problem, measured.problem);
      const after = await assertNativeVideoBounds();
      const stateAfter = await player();
      const report = { phase, status, capturedAt: new Date().toISOString(), hardwareRendering: true,
        binary: process.env.SURTITLE_E2E_BINARY, summary: summarize(measured.result), recording: measured.result,
        endpoints: { before, after }, stateAfter };
      writeFileSync(resolve(`test-results/native/${phase}-study-motion-${status}.json`), `${JSON.stringify(report, null, 2)}\n`);
      verifyRecording(measured.result);
      assert.equal(stateAfter.paused, paused, 'Playback state changed during panel motion');
      assert.deepEqual(after.dom.viewport, before.dom.viewport, 'Closing did not restore the viewport');
      // Separate actual-HWND observation from the main timing run, since the
      // external inspector itself has cost and only samples at about 10ms.
      const native = await sampleNativeVideoBounds(() => measure(1, 0), `${phase}-study-motion-${status}-hwnd.json`);
      assert(!native.result.problem, native.result.problem);
      for (const sample of native.samples) {
        assert(sample.windows.some(window => window.visible && window.parent === sample.windows[0].handle && window.className.toLowerCase() === 'static'),
          'The native video was hidden during the sampled transition');
      }
      await assertNativeVideoBounds();
    });
  }
  (visualOnly ? it : it.skip)('records the owned app visually without collecting cadence measurements', async () => {
    await invoke('update_settings', { settings: { ...originalSettings, locale: 'en', sentencePause: false, motionPreference: 'system' } });
    await browser.refresh();
    await resizeNativeWindow(1440, 900);
    await navigate(`/study/${fixture.mediaId}`);
    await $('.play-button').waitForEnabled();
    await browser.waitUntil(async () => {
      const state = await player(); return state.ready && state.surfaceVisible && state.videoWidth > 0;
    });
    const loaded = await player();
    await control({ action: 'pause' });
    await control({ action: 'seek', value: 0 });
    await control({ action: 'loop', startMs: 0, endMs: Math.max(1000, loaded.durationMs - 1000) });
    const before = await assertNativeVideoBounds();
    assert(await browser.execute(() => !document.hidden && document.hasFocus()), 'Keep the owned app in the foreground for desktop capture');
    const path = resolve('test-results/native/study-motion-visual.mp4');
    const capture = captureOwnedClient(before.native[0], path);
    let observation;
    try {
      await capture.ready;
      observation = await browser.executeAsync(done => {
        const start = performance.now(), events = [];
        const toggle = document.querySelector('.study-transcript-toggle');
        const dock = document.querySelector('.study-companion-dock'), panel = document.querySelector('.study-companion');
        const viewport = document.querySelector('.native-player-viewport');
        const frame = () => new Promise(requestAnimationFrame);
        const foreground = () => { if (document.hidden || !document.hasFocus()) throw new Error('The owned app lost foreground during recording'); };
        const hold = async duration => { const until = performance.now() + duration; while (performance.now() < until) { await frame(); foreground(); } };
        const transition = async open => {
          events.push({ open, atMs: performance.now() - start });
          if ((toggle.getAttribute('aria-expanded') === 'true') !== open) toggle.click();
          const deadline = performance.now() + 5000;
          do {
            await frame(); foreground();
            if (performance.now() > deadline) throw new Error('Visual recording transition did not settle');
          } while (dock.dataset.moving === 'true' || viewport.dataset.nativePlacement === 'pending'
            || (toggle.getAttribute('aria-expanded') === 'true') !== open || panel.hidden !== !open);
          await hold(550);
        };
        void (async () => {
          await transition(false);
          for (const paused of [true, false]) {
            await window.__TAURI_INTERNALS__.invoke('player_control', { request: { action: paused ? 'pause' : 'play' } });
            events.push({ paused, atMs: performance.now() - start });
            for (let index = 0; index < 2; index++) { await transition(true); await transition(false); }
          }
          await hold(Math.max(0, 12000 - (performance.now() - start)));
          return { events, durationMs: performance.now() - start };
        })().then(result => done({ result }), error => done({ problem: String(error), events }));
      });
      assert(!observation.problem, observation.problem);
      const recording = await capture.result;
      assert(!recording.problem, String(recording.problem));
      const after = await inspectNativeWindow();
      assert.deepEqual(after[0].origin, before.native[0].origin, 'The owned app moved during the cropped recording');
      assert.deepEqual(after[0].client, before.native[0].client, 'The owned app resized during the cropped recording');
      await assertNativeVideoBounds();
      writeFileSync(resolve('test-results/native/study-motion-visual.json'), JSON.stringify({
        purpose: 'Visual inspection only; capture overhead excludes this run from cadence conclusions',
        path, binary: process.env.SURTITLE_E2E_BINARY, client: before.native[0], observation, ffmpeg: recording.value,
      }, null, 2));
    } finally { capture.stop(); await capture.result; }
  });
});
