// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./native-video-click.ps1', import.meta.url));

async function nativePointer(args = [], timeout = 15000) {
  assert.equal(process.platform, 'win32', 'Native video pointer input requires Windows');
  const application = process.env.SURTITLE_E2E_BINARY;
  assert(application && isAbsolute(application), 'Set an absolute test binary for native video input');
  const { stdout } = await execute('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-Application', application, ...args], { windowsHide: true, timeout });
  return JSON.parse(stdout);
}
/** Activate the uniquely identified test window, using its verified caption when needed. */
export const activateNativeApplication = () => nativePointer(['-ActivateOnly']);

// This function runs inside the tested WebView. A native region alone cannot
// identify an interactive point once HTML is composed above the video HWND.
export function readNativeVideoClickTarget() {
  const surface = document.querySelector('.player-surface-toggle');
  if (!surface || surface.disabled || surface.closest('[inert], [hidden]')) throw new Error('No enabled visible video input surface');
  const style = getComputedStyle(surface);
  if (style.visibility !== 'visible' || style.display === 'none' || style.pointerEvents === 'none' || Number(style.opacity) === 0) throw new Error('Video input surface is not interactive');
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio < .5 || devicePixelRatio > 8) throw new Error('Invalid video input DPI');
  const box = surface.getBoundingClientRect();
  const left = Math.max(0, box.left), top = Math.max(0, box.top);
  const right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
  if (right - left < 4 || bottom - top < 4) throw new Error('Video input surface is outside the WebView');
  for (const [horizontal, vertical] of [[.5, .5], [.25, .5], [.75, .5], [.5, .25], [.5, .75], [.25, .25], [.75, .25], [.25, .75], [.75, .75]]) {
    const clientX = Math.floor((left + (right - left) * horizontal) * devicePixelRatio);
    const clientY = Math.floor((top + (bottom - top) * vertical) * devicePixelRatio);
    const hit = document.elementFromPoint(clientX / devicePixelRatio, clientY / devicePixelRatio);
    if (hit !== surface && !surface.contains(hit)) continue;
    return { clientX, clientY,
      clientWidth: Math.round(innerWidth * devicePixelRatio), clientHeight: Math.round(innerHeight * devicePixelRatio),
      dpi: Math.round(devicePixelRatio * 96) };
  }
  throw new Error('Every tested video input point is covered by another DOM control');
}

/** Click DOM-verified video through the owned WebView after native geometry checks. */
export async function clickNativeVideo() {
  const point = await browser.execute(readNativeVideoClickTarget);
  return nativePointer(['-ClientX', String(point.clientX), '-ClientY', String(point.clientY),
    '-ClientWidth', String(point.clientWidth), '-ClientHeight', String(point.clientHeight), '-Dpi', String(point.dpi)]);
}

/** Hold the verified native titlebar through a slow outward/return/outward drag. */
export function dragNativeWindowSnap(axis) {
  assert.equal(process.env.SURTITLE_E2E_NATIVE_INPUT, '1', 'Native caption drag requires SURTITLE_E2E_NATIVE_INPUT=1');
  assert(['x', 'y'].includes(axis), 'Invalid caption drag axis');
  return nativePointer(['-SnapDragAxis', axis], 45000);
}

export function verifyNativeSnapDrag(receipt) {
  const { axis, dpi, rootHandle, workArea, samples } = receipt;
  assert(['x', 'y'].includes(axis) && Number.isFinite(dpi) && dpi >= 48 && dpi <= 768, 'Invalid native snap receipt');
  assert.equal(receipt.released, true, 'Native caption drag did not release the mouse button');
  assert(samples.length > 1 && samples[0].phase === 'start', 'Missing initial native drag sample');
  const boundary = Math.round(32 * dpi / 96);
  const coordinate = axis === 'x' ? 'X' : 'Y', side = axis === 'x' ? 'Left' : 'Top';
  const otherSide = axis === 'x' ? 'Top' : 'Left';
  const first = samples[0], gap = sample => sample.visibleFrame[side] - workArea[side];
  assert.equal(gap(first), 0, 'The native drag must start visibly aligned');
  for (const sample of samples) {
    assert.equal(sample.moveSize, rootHandle, 'Every sample must come from the owned Win32 move loop');
    assert.equal(sample.cursor[coordinate] - first.cursor[coordinate], sample.offset, 'Native cursor offset was not acknowledged');
    const expected = sample.offset <= boundary ? 0 : sample.offset;
    assert.equal(gap(sample), expected, 'Visible frame must snap within 32 logical pixels and otherwise follow the intended cursor position');
    assert.equal(sample.screen[side] - first.screen[side], expected, 'Outer window must follow the same intended drag position');
    assert.equal(sample.visibleFrame[otherSide], first.visibleFrame[otherSide], 'Dragging one axis moved the other axis');
    for (const kind of ['screen', 'visibleFrame', 'client']) {
      assert.equal(sample[kind].Right - sample[kind].Left, first[kind].Right - first[kind].Left, `${kind} width changed size while dragging`);
      assert.equal(sample[kind].Bottom - sample[kind].Top, first[kind].Bottom - first[kind].Top, `${kind} height changed size while dragging`);
    }
  }
  const approach = samples.filter(sample => sample.phase === 'approach');
  assert(approach.length > 1, 'Missing reapproach from outside the snap boundary');
  assert.equal(approach.at(-1).offset, boundary, 'Reapproach must turn outward at the snap boundary');
  for (const phase of ['outward', 'outward-again']) {
    const path = samples.filter(sample => sample.phase === phase);
    const origin = phase === 'outward' ? 0 : approach.at(-1).offset;
    assert(path.length > boundary, 'Native drag did not leave the snap boundary');
    for (const [index, sample] of path.entries()) {
      assert.equal(sample.offset - origin, index + 1, 'Outward drag must advance one physical pixel per sample');
    }
  }
  const outward = samples.filter(sample => sample.phase === 'outward');
  for (const [index, sample] of approach.entries()) assert.equal(sample.offset, outward.at(-1).offset - index - 1,
    'Reapproach must advance one physical pixel per sample');
}
