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

import { resizeNativeWindow } from './native-window.mjs';

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
