// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

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

/** Resize the owned top-level native client, rather than a nested child HWND. */
export async function requestNativeWindowSize(width, height) {
  validateNativeSize(width, height);
  assert.equal(process.platform, 'win32', 'Native window resizing requires Windows');
  return nativeWindow('resize', ['-Width', String(width), '-Height', String(height)]);
}

/** Predict a supported client size before resizing, using the current monitor. */
export async function nativeWindowSizeWithinWorkArea(width, height) {
  validateNativeSize(width, height);
  if (process.platform !== 'win32') return { width, height };
  const [native, display] = await Promise.all([inspectNativeWindow(), inspectNativeMonitor()]);
  const root = native?.[0];
  assert(root && Number.isSafeInteger(root.handle) && root.handle > 0 && root.parent === 0 &&
    root.visible === true && root.maximized === false, 'Work-area sizing requires a visible normal top-level window');
  assert(Number.isInteger(root.dpi) && root.dpi >= 48 && root.dpi <= 768, 'Invalid native window DPI');
  const monitor = display?.monitors?.find(item => item.handle === display.current);
  assert(monitor, 'The current native monitor is missing');
  const size = (rectangle, name) => {
    assert(rectangle && ['Left', 'Top', 'Right', 'Bottom'].every(edge => Number.isSafeInteger(rectangle[edge])) &&
      rectangle.Right > rectangle.Left && rectangle.Bottom > rectangle.Top, `Invalid ${name} rectangle`);
    return { width: rectangle.Right - rectangle.Left, height: rectangle.Bottom - rectangle.Top };
  };
  const client = size(root.client, 'client');
  const frame = size(root.visibleFrame, 'visible frame');
  const work = size(monitor.workArea, 'monitor work area');
  const decoration = { width: frame.width - client.width, height: frame.height - client.height };
  assert(decoration.width >= 0 && decoration.height >= 0, 'Invalid native window decoration dimensions');
  const scale = root.dpi / 96;
  const fitted = {
    width: Math.min(width, Math.floor((work.width - decoration.width) / scale)),
    height: Math.min(height, Math.floor((work.height - decoration.height) / scale)),
  };
  validateNativeSize(fitted.width, fitted.height);
  return fitted;
}

export async function inspectNativeMonitor() {
  return nativeWindow('monitor');
}

export const inspectNativeWindow = () => nativeWindow('inspect');
export function snapNativeWindow(edge) {
  assert(['left', 'right', 'top', 'bottom', 'top-left', 'bottom-right'].includes(edge), 'Invalid snap edge');
  return nativeWindow('snap-edge', ['-Edge', edge]);
}
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
  const deadline = Date.now() + 15000;
  while ((await inspectNativeMonitor()).current !== monitor) {
    assert(Date.now() < deadline, 'The owned application did not reach the selected monitor');
    await delay(50);
  }
}

/** Captures the owned app window including native child surfaces, not just HTML. */
export async function saveNativeScreenshot(path) {
  assert.equal(process.platform, 'win32', 'Native window capture requires Windows');
  await nativeWindow('capture', ['-Screenshot', resolve(path)]);
}

/** Records actual HWND composition while an action runs; no child-only fallback. */
export async function captureNativeScreenshotSequence(path, action) {
  assert.equal(process.platform, 'win32', 'Motion composition evidence requires Windows HWND capture');
  const screenshot = resolve(path);
  const outputRoot = resolve(dirname(script), '../../work/test-results/native');
  assert(screenshot.toLowerCase().startsWith(`${outputRoot.toLowerCase()}${sep}`) && extname(screenshot).toLowerCase() === '.png',
    'Native sequence must be a PNG within work/test-results/native');
  const ready = `${screenshot}.ready`;
  rmSync(ready, { force: true });
  let result;
  const recording = nativeWindow('capture-sequence', ['-Screenshot', screenshot])
    .then(value => { result = { value }; }, error => { result = { error }; });
  try {
    const deadline = Date.now() + 12000;
    while (!existsSync(ready)) {
      if (result?.error) throw result.error;
      assert(!result && Date.now() < deadline, 'Native sequence did not become ready to capture the action');
      await delay(10);
    }
    await action();
  } finally {
    await recording;
    rmSync(ready, { force: true });
  }
  if (result.error) throw result.error;
  return result.value;
}
