// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { readNativeVideoClickTarget } from './native-video-click.mjs';

let surface, covered;
beforeEach(() => {
  surface = {
    disabled: false, closest: () => null, contains: node => node?.parent === surface,
    getBoundingClientRect: () => ({ left: 100, top: 120, right: 900, bottom: 600 }),
  };
  covered = () => false;
  vi.stubGlobal('document', {
    querySelector: () => surface,
    elementFromPoint: (x, y) => covered(x, y) ? { tagName: 'BUTTON' } : surface,
  });
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block', pointerEvents: 'auto' }));
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 720);
  vi.stubGlobal('devicePixelRatio', 1.5);
});
afterEach(() => { vi.unstubAllGlobals(); });

test('selects the visible video surface in physical client coordinates at fractional DPI', () => {
  assert.deepEqual(readNativeVideoClickTarget(), { clientX: 750, clientY: 540, clientWidth: 1920, clientHeight: 1080, dpi: 144 });
});

test('avoids a popup covering the center instead of clicking another DOM control', () => {
  covered = (x, y) => x >= 400 && x <= 600 && y >= 200 && y <= 500;
  assert.deepEqual(readNativeVideoClickTarget(), { clientX: 450, clientY: 540, clientWidth: 1920, clientHeight: 1080, dpi: 144 });
  covered = () => true;
  assert.throws(readNativeVideoClickTarget, /covered by another DOM control/);
});

test('rejects disabled, inert, hidden and offscreen surfaces before native pointer input', () => {
  surface.disabled = true;
  assert.throws(readNativeVideoClickTarget, /enabled visible/);
  surface.disabled = false; surface.closest = () => ({ inert: true });
  assert.throws(readNativeVideoClickTarget, /enabled visible/);
  surface.closest = () => null;
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'hidden', display: 'block', pointerEvents: 'auto' }));
  assert.throws(readNativeVideoClickTarget, /not interactive/);
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block', pointerEvents: 'auto' }));
  surface.getBoundingClientRect = () => ({ left: 100, top: 800, right: 900, bottom: 1200 });
  assert.throws(readNativeVideoClickTarget, /outside the WebView/);
});

test('uses only the visible intersection when the video extends past the client edge', () => {
  surface.getBoundingClientRect = () => ({ left: -400, top: -300, right: 800, bottom: 600 });
  assert.deepEqual(readNativeVideoClickTarget(), { clientX: 600, clientY: 450, clientWidth: 1920, clientHeight: 1080, dpi: 144 });
  vi.stubGlobal('devicePixelRatio', Number.NaN);
  assert.throws(readNativeVideoClickTarget, /Invalid video input DPI/);
});
