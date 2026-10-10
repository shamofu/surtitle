// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

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
export async function resizeNativeWindow(width, height) {
  validateNativeSize(width, height);
  if (process.platform !== 'win32') return browser.setWindowSize(width, height);
  await nativeWindow('resize', ['-Width', String(width), '-Height', String(height)]);
  await browser.waitUntil(async () => browser.execute((w, h) => innerWidth === w && innerHeight === h, width, height),
    { timeoutMsg: 'The top-level native resize did not reach the WebView viewport' });
  await assertNativeVideoBounds(false);
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

export async function assertNativeVideoBounds(video = true) {
  if (process.platform !== 'win32') return;
  let observation;
  await browser.waitUntil(async () => {
    const dom = await browser.execute(() => {
      const rect = document.querySelector('[data-testid="native-player-viewport"]')?.getBoundingClientRect();
      return { innerWidth, innerHeight, devicePixelRatio, viewport: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    });
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

/** Captures the owned app window including native child surfaces, not just HTML. */
export async function saveNativeScreenshot(path) {
  if (process.platform !== 'win32') return browser.saveScreenshot(path);
  await nativeWindow('capture', ['-Screenshot', resolve(path)]);
}
