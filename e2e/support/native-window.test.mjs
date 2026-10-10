// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { validateNativeSize, verifyNativeGeometry } from './native-window.mjs';

function geometry(ratio = 1) {
  const root = { handle: 1, parent: 0, className: 'Tauri Window', visible: true, origin: { X: 34, Y: 57 }, client: { Left: 0, Top: 0, Right: 1440 * ratio, Bottom: 900 * ratio } };
  const renderer = { ...root, client: { ...root.client }, origin: { ...root.origin }, handle: 2, parent: 3, className: 'Chrome_RenderWidgetHostHWND' };
  const viewport = { x: 24.25, y: 151.5, width: 592.5, height: 249.5 };
  const left = root.origin.X + Math.round(viewport.x * ratio);
  const top = root.origin.Y + Math.round(viewport.y * ratio);
  const surface = { handle: 4, parent: 1, className: 'Static', visible: true, screen: { Left: left, Top: top, Right: left + Math.round(viewport.width * ratio), Bottom: top + Math.round(viewport.height * ratio) } };
  return { native: [root, renderer, surface], dom: { innerWidth: 1440, innerHeight: 900, devicePixelRatio: ratio, viewport } };
}

test('compares real native video pixels at 100%, 150% and 200% DPI', () => {
  for (const ratio of [1, 1.5, 2]) {
    const { native, dom } = geometry(ratio);
    verifyNativeGeometry(native, dom);
  }
});
test('rejects the observed EdgeDriver child offset even when native video matches root-relative DOM bounds', () => {
  const { native, dom } = geometry();
  // Observed HWND origins after browser.setWindowSize: root (34,57), renderer (102,171).
  native[1].origin = { X: 102, Y: 171 };
  assert.throws(() => verifyNativeGeometry(native, dom), /WebView is horizontally displaced/);
});
test('rejects resized Chromium content inside an unchanged outer native window', () => {
  const { native, dom } = geometry();
  native[0].client.Right = 1600;
  assert.throws(() => verifyNativeGeometry(native, dom), /Tauri width disagrees/);
});
test('rejects a displaced or hidden native video surface', () => {
  const { native, dom } = geometry();
  native[2].screen.Top += 80;
  assert.throws(() => verifyNativeGeometry(native, dom), /Native video y disagrees/);
  native[2].visible = false;
  assert.throws(() => verifyNativeGeometry(native, dom), /Expected one visible native video/);
  verifyNativeGeometry(native, dom, false);
});
test('rejects ambiguous renderers and invalid native resize dimensions', () => {
  const { native, dom } = geometry();
  native.push({ ...native[1], handle: 5 });
  assert.throws(() => verifyNativeGeometry(native, dom), /Expected one visible WebView/);
  validateNativeSize(1024, 700);
  for (const size of [[1023,700],[1024,699],[Infinity,900],[1440.5,900],[8193,900]]) assert.throws(() => validateNativeSize(...size), /Invalid native client/);
});
