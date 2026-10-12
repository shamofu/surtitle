// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./native-window.ps1', import.meta.url));
export function validateNativeSize(width, height) {
  assert(Number.isInteger(width) && width >= 1024 && width <= 8192, 'Invalid native client width');
  assert(Number.isInteger(height) && height >= 700 && height <= 8192, 'Invalid native client height');
}
async function nativeWindow(action, args = []) {
  const application = process.env.SURTITLE_E2E_BINARY;
  assert(application && isAbsolute(application), 'Set an absolute SURTITLE_E2E_BINARY for native window operations');
  const { stdout } = await execute('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-Action', action, '-Application', application, ...args], { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout);
}

/** EdgeDriver's window rect command moves a nested Chromium HWND, not Tauri. */
export async function requestNativeWindowSize(width, height) {
  validateNativeSize(width, height);
  if (process.platform !== 'win32') return browser.setWindowSize(width, height);
  return nativeWindow('resize', ['-Width', String(width), '-Height', String(height)]);
}

export async function resizeNativeWindow(width, height) {
  await requestNativeWindowSize(width, height);
  let dom;
  try {
    await browser.waitUntil(async () => {
      dom = await readDomGeometry();
      return dom.innerWidth === width && dom.innerHeight === height;
    }, { timeoutMsg: 'The top-level native resize did not reach the WebView viewport' });
  } catch (cause) {
    const observation = {
      capturedAt: new Date().toISOString(), requested: { width, height }, dom,
      error: { name: cause?.name, message: String(cause?.message ?? cause), stack: cause?.stack },
      diagnosticErrors: {},
    };
    if (process.platform === 'win32') {
      const results = await Promise.allSettled([nativeWindow('inspect'), inspectNativeMonitor()]);
      for (const [index, key] of ['native', 'monitor'].entries()) {
        const result = results[index];
        if (result.status === 'fulfilled') observation[key] = result.value;
        else observation.diagnosticErrors[key] = String(result.reason?.message ?? result.reason);
      }
    }
    const path = resolve(`test-results/native/native-window-resize-${width}x${height}.json`);
    let artifact;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(observation, null, 2));
      artifact = `See ${path}`;
    } catch (error) {
      artifact = `Could not write resize diagnostics: ${error.message}`;
    }
    const root = observation.native?.[0];
    const monitor = observation.monitor?.monitors.find(item => item.handle === observation.monitor.current);
    const details = {
      requested: observation.requested, dom,
      native: root && { dpi: root.dpi, client: root.client, screen: root.screen },
      monitor, diagnosticErrors: observation.diagnosticErrors,
    };
    throw new Error(`${observation.error.message}. Resize diagnostics: ${JSON.stringify(details)}. ${artifact}`, { cause });
  }
  await assertNativeVideoBounds(false);
}

export async function inspectNativeMonitor() {
  return nativeWindow('monitor');
}

export const inspectNativeWindow = () => nativeWindow('inspect');
export function resizeThenMaximizeNativeWindow(width, height) {
  validateNativeSize(width, height);
  return nativeWindow('resize-maximize', ['-Width', String(width), '-Height', String(height)]);
}
export function requestNativeWindowCommand(action) {
  assert(['close', 'maximize', 'restore'].includes(action), 'Invalid native window command');
  return nativeWindow(action);
}

export async function moveNativeWindowToMonitor(monitor) {
  assert(Number.isSafeInteger(monitor) && monitor > 0, 'Invalid native monitor identity');
  await nativeWindow('move-monitor', ['-Monitor', String(monitor)]);
  await browser.waitUntil(async () => (await inspectNativeMonitor()).current === monitor,
    { timeoutMsg: 'The owned application did not reach the selected monitor' });
}

export function verifyNativeGeometry(native, dom, video = true) {
  const root = native[0];
  const webviews = native.filter(window => window.visible && window.className === 'Chrome_RenderWidgetHostHWND');
  assert.equal(root.parent, 0, 'The inspected application window must be top-level');
  assert.equal(webviews.length, 1, 'Expected one visible WebView renderer');
  const renderer = webviews[0];
  const close = (actual, expected, message) => assert(Math.abs(actual - expected) <= 1, `${message}: ${actual} != ${expected}`);
  close(renderer.origin.X, root.origin.X, 'WebView is horizontally displaced inside Tauri');
  close(renderer.origin.Y, root.origin.Y, 'WebView is vertically displaced inside Tauri');
  const ratio = dom.devicePixelRatio;
  assert(Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 8, 'Invalid WebView device scale');
  close(renderer.client.Right - renderer.client.Left, dom.innerWidth * ratio, 'WebView width disagrees with DOM');
  close(renderer.client.Bottom - renderer.client.Top, dom.innerHeight * ratio, 'WebView height disagrees with DOM');
  close(root.client.Right - root.client.Left, dom.innerWidth * ratio, 'Tauri width disagrees with DOM');
  close(root.client.Bottom - root.client.Top, dom.innerHeight * ratio, 'Tauri height disagrees with DOM');
  if (!video) return;
  assert(dom.viewport, 'The study video viewport is missing');
  const surfaces = native.filter(window => window.visible && window.parent === root.handle && window.className.toLowerCase() === 'static');
  assert.equal(surfaces.length, 1, 'Expected one visible native video surface');
  const surface = surfaces[0];
  const expected = {
    x: renderer.origin.X + Math.round(dom.viewport.x * ratio), y: renderer.origin.Y + Math.round(dom.viewport.y * ratio),
    width: Math.round(dom.viewport.width * ratio), height: Math.round(dom.viewport.height * ratio),
  };
  close(surface.screen.Left, expected.x, 'Native video x disagrees with the actual WebView viewport');
  close(surface.screen.Top, expected.y, 'Native video y disagrees with the actual WebView viewport');
  close(surface.screen.Right - surface.screen.Left, expected.width, 'Native video width disagrees with DOM');
  close(surface.screen.Bottom - surface.screen.Top, expected.height, 'Native video height disagrees with DOM');
}

function readDomGeometry() {
  return browser.execute(() => {
    const rect = document.querySelector('[data-testid="native-player-viewport"]')?.getBoundingClientRect();
    return { innerWidth, innerHeight, devicePixelRatio, viewport: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  });
}

export async function assertNativeVideoBounds(video = true) {
  if (process.platform !== 'win32') return;
  let observation;
  await browser.waitUntil(async () => {
    const dom = await readDomGeometry();
    const native = await nativeWindow('inspect');
    observation = { native, dom };
    try { verifyNativeGeometry(native, dom, video); return true; } catch (error) { observation.error = error.message; return false; }
  }, { timeout: 15000, interval: 100, timeoutMsg: 'Native HWND bounds do not match the WebView/DOM; see native-window-bounds.json' }).catch(error => {
    writeFileSync(resolve('test-results/native/native-window-bounds.json'), JSON.stringify(observation, null, 2));
    throw error;
  });
  writeFileSync(resolve('test-results/native/native-window-bounds-passed.json'), JSON.stringify(observation, null, 2));
  return observation;
}

/** Sample the actual owned HWND across a short operation, after interop startup. */
export async function sampleNativeVideoBounds(action, artifactName) {
  assert(process.platform === 'win32', 'Native video sampling requires Windows');
  assert(/^[a-z0-9-]+\.json$/i.test(artifactName), 'Native sample artifact must be a plain JSON filename');
  const application = process.env.SURTITLE_E2E_BINARY;
  assert(application && isAbsolute(application), 'Set an absolute SURTITLE_E2E_BINARY for native window operations');
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-Action', 'sample', '-Application', application], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let ready = false;
  let resolveReady;
  let rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const stop = () => { if (child.exitCode === null) child.kill(); };
  process.once('exit', stop);
  const timer = setTimeout(stop, 15000);
  const completed = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!ready && stdout.includes('SURTITLE_NATIVE_SAMPLE_READY')) { ready = true; resolveReady(); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { rejectReady(error); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      process.removeListener('exit', stop);
      if (code !== 0 || !ready) {
        const error = new Error(`Native sampling failed (${code}): ${stderr}`);
        rejectReady(error); reject(error); return;
      }
      try { resolve(JSON.parse(stdout.slice(stdout.indexOf('\n') + 1))); }
      catch (error) { reject(error); }
    });
  });
  // Attach a rejection handler before waiting for startup or the browser action.
  const observation = completed.then(value => ({ value }), error => ({ error }));
  try {
    await started;
    let result;
    let actionError;
    try { result = await action(); } catch (error) { actionError = error; }
    const sampled = await observation;
    if (sampled.error) throw sampled.error;
    writeFileSync(resolve('test-results/native', artifactName), JSON.stringify({ ...sampled.value, result }, null, 2));
    if (actionError) throw actionError;
    return { result, ...sampled.value };
  } finally {
    stop();
    await observation;
  }
}

/** Captures the owned app window including native child surfaces, not just HTML. */
export async function saveNativeScreenshot(path) {
  if (process.platform !== 'win32') return browser.saveScreenshot(path);
  await nativeWindow('capture', ['-Screenshot', resolve(path)]);
}
