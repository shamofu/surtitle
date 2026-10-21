// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), mkdir: vi.fn(), write: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execute }),
}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal(), mkdirSync: mocks.mkdir, writeFileSync: mocks.write,
}));

import { nativeWindowSizeWithinWorkArea, resizeNativeWindow } from './native-window.mjs';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const timeout = new Error('The top-level native resize did not reach the WebView viewport');
const dom = { innerWidth: 1008, innerHeight: 681, devicePixelRatio: 1 };
const root = {
  handle: 1, parent: 0, className: 'Tauri Window', visible: true, dpi: 96,
  origin: { X: 8, Y: 31 }, client: { Left: 0, Top: 0, Right: 1008, Bottom: 681 },
  screen: { Left: 0, Top: 0, Right: 1024, Bottom: 720 },
};
const monitor = {
  current: 2,
  monitors: [{ handle: 2, workArea: { Left: 0, Top: 0, Right: 1024, Bottom: 720 } }],
};
const actionOf = args => args[args.indexOf('-Action') + 1];

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('SURTITLE_E2E_BINARY', resolve('surtitle-test.exe'));
  vi.stubGlobal('browser', {
    execute: vi.fn(async () => dom),
    waitUntil: vi.fn(async condition => { if (!await condition()) throw timeout; }),
  });
  mocks.execute.mockImplementation(async (_command, args) => ({
    stdout: JSON.stringify(actionOf(args) === 'monitor' ? monitor : [root]),
  }));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('keeps the requested size strict and records the observed work-area clamp', async () => {
  await assert.rejects(resizeNativeWindow(1440, 900), error => {
    assert.equal(error.cause, timeout);
    assert.match(error.message, /1440/);
    assert.match(error.message, /1008/);
    assert.match(error.message, /native-window-resize-1440x900\.json/);
    return true;
  });
  const [path, contents] = mocks.write.mock.calls[0];
  assert.equal(path, resolve('work/test-results/native/session/native-window-resize-1440x900.json'));
  const evidence = JSON.parse(contents);
  assert.deepEqual(evidence.requested, { width: 1440, height: 900 });
  assert.deepEqual(evidence.dom, dom);
  assert.deepEqual(evidence.native[0], root);
  assert.deepEqual(evidence.monitor, monitor);
  assert.equal(evidence.error.message, timeout.message);
});

test('preserves the original failure and available dimensions if native inspection and artifact writing fail', async () => {
  mocks.execute.mockImplementation(async (_command, args) => {
    if (actionOf(args) === 'inspect') throw new Error('Native window is no longer available');
    return { stdout: JSON.stringify(actionOf(args) === 'monitor' ? monitor : [root]) };
  });
  mocks.write.mockImplementation(() => { throw new Error('Evidence directory is read-only'); });
  await assert.rejects(resizeNativeWindow(1024, 700), error => {
    assert.equal(error.cause, timeout);
    assert.match(error.message, /1008/);
    assert.match(error.message, /workArea/);
    assert.match(error.message, /Native window is no longer available/);
    assert.match(error.message, /Evidence directory is read-only/);
    return true;
  });
});

test('requires exact client dimensions even for a one-pixel resize mismatch', async () => {
  browser.execute.mockResolvedValue({ ...dom, innerWidth: 1439, innerHeight: 900 });
  await assert.rejects(resizeNativeWindow(1440, 900), error => error.cause === timeout);
});

test('continues validating native geometry after an exact resize without collecting failure diagnostics', async () => {
  const fitted = { ...root, client: { ...root.client, Right: 1440, Bottom: 900 } };
  const renderer = { ...fitted, handle: 3, parent: 1, className: 'Chrome_RenderWidgetHostHWND' };
  browser.execute.mockResolvedValue({ ...dom, innerWidth: 1440, innerHeight: 900 });
  mocks.execute.mockResolvedValue({ stdout: JSON.stringify([fitted, renderer]) });
  await resizeNativeWindow(1440, 900);
  assert.equal(mocks.write.mock.calls.length, 1);
  assert.equal(mocks.write.mock.calls[0][0], resolve('work/test-results/native/session/native-window-bounds-passed.json'));
  assert(!mocks.execute.mock.calls.some(([, args]) => actionOf(args) === 'monitor'));
});

const fullHdRoot = {
  ...root, maximized: false,
  client: { Left: 0, Top: 0, Right: 1918, Bottom: 1000 },
  visibleFrame: { Left: 0, Top: 0, Right: 1920, Bottom: 1032 },
};
const fullHdMonitor = {
  current: 2,
  monitors: [{ handle: 2, workArea: { Left: 0, Top: 0, Right: 1920, Bottom: 1032 } }],
};
function inspectGeometry(window = fullHdRoot, display = fullHdMonitor) {
  mocks.execute.mockImplementation(async (_command, args) => ({
    stdout: JSON.stringify(actionOf(args) === 'monitor' ? display : [window]),
  }));
}

test('predicts the recorded CI client capacity from the current monitor work area and visible decoration', async () => {
  inspectGeometry();
  assert.deepEqual(await nativeWindowSizeWithinWorkArea(1920, 1080), { width: 1918, height: 1000 });
  assert.deepEqual(mocks.execute.mock.calls.map(([, args]) => actionOf(args)).sort(), ['inspect', 'monitor']);
  assert.equal(browser.execute.mock.calls.length, 0);
  assert.equal(mocks.write.mock.calls.length, 0);
});

test('keeps the requested size when a larger monitor has capacity, independently of the current client size', async () => {
  inspectGeometry({ ...fullHdRoot,
    client: { Left: 0, Top: 0, Right: 1280, Bottom: 720 },
    visibleFrame: { Left: 50, Top: 20, Right: 1332, Bottom: 772 },
  }, { current: 3, monitors: [fullHdMonitor.monitors[0],
    { handle: 3, workArea: { Left: 1920, Top: -100, Right: 4480, Bottom: 1300 } }] });
  assert.deepEqual(await nativeWindowSizeWithinWorkArea(1920, 1080), { width: 1920, height: 1080 });
});

test('uses physical decoration and floors logical capacity at fractional DPI with an offset work area', async () => {
  inspectGeometry({ ...fullHdRoot, dpi: 144,
    client: { Left: 0, Top: 0, Right: 1800, Bottom: 1050 },
    visibleFrame: { Left: -1800, Top: -200, Right: 3, Bottom: 898 },
  }, { current: 2, monitors: [{ handle: 2,
    workArea: { Left: -2400, Top: -200, Right: -2, Bottom: 1331 } }] });
  assert.deepEqual(await nativeWindowSizeWithinWorkArea(1920, 1080), { width: 1596, height: 988 });
});

test('rejects non-normal windows and malformed DPI, native rectangles or monitor geometry', async () => {
  for (const window of [
    { ...fullHdRoot, parent: 5 }, { ...fullHdRoot, visible: false }, { ...fullHdRoot, maximized: true },
    { ...fullHdRoot, dpi: 0 }, { ...fullHdRoot, dpi: null },
    { ...fullHdRoot, client: { Left: 0, Top: 0, Right: 0, Bottom: 1000 } },
    { ...fullHdRoot, visibleFrame: { Left: 0, Top: 0, Right: 1917, Bottom: 1032 } },
    { ...fullHdRoot, visibleFrame: { Left: 0, Top: 0, Right: 1920 } },
  ]) {
    inspectGeometry(window);
    await assert.rejects(nativeWindowSizeWithinWorkArea(1920, 1080), /normal|DPI|rectangle|decoration/i);
  }
  for (const display of [
    { ...fullHdMonitor, current: 3 },
    { current: 2, monitors: [{ handle: 2, workArea: { Left: 0, Top: 0, Right: 1920, Bottom: 0 } }] },
  ]) {
    inspectGeometry(fullHdRoot, display);
    await assert.rejects(nativeWindowSizeWithinWorkArea(1920, 1080), /monitor|rectangle/i);
  }
});

test('returns the requested dimensions outside Windows without inspecting or resizing a window', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  assert.deepEqual(await nativeWindowSizeWithinWorkArea(1920, 1080), { width: 1920, height: 1080 });
  assert.equal(mocks.execute.mock.calls.length, 0);
  assert.equal(browser.execute.mock.calls.length, 0);
});
