// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { verifyNativeSnapDrag } from './native-video-click.mjs';

function drag(axis = 'x', dpi = 96) {
  const scale = dpi / 96, boundary = Math.round(32 * scale);
  const travel = Math.round(48 * scale), rootHandle = 123;
  const workArea = { Left: 0, Top: 0, Right: 2400, Bottom: 1600 };
  const frame = gap => ({ Left: axis === 'x' ? gap : 0, Top: axis === 'y' ? gap : 0,
    Right: (axis === 'x' ? gap : 0) + 1280, Bottom: (axis === 'y' ? gap : 0) + 760 });
  const sample = (phase, offset, gap) => ({ phase, offset,
    cursor: { X: 700 + (axis === 'x' ? offset : 0), Y: 15 + (axis === 'y' ? offset : 0) },
    screen: frame(gap), visibleFrame: frame(gap), client: { Left: 0, Top: 0, Right: 1280, Bottom: 720 }, moveSize: rootHandle });
  return { axis, dpi, rootHandle, workArea, samples: [sample('start', 0, 0),
    ...Array.from({ length: travel }, (_, i) => sample('outward', i + 1, i + 1 <= boundary ? 0 : i + 1)),
    ...Array.from({ length: travel - boundary }, (_, i) => sample('approach', travel - i - 1, travel - i - 1 <= boundary ? 0 : travel - i - 1)),
    ...Array.from({ length: travel }, (_, i) => sample('outward-again', boundary + i + 1, boundary + i + 1))],
    released: true };
}

test('accepts the same 32 logical pixel boundary in both directions on either axis at multiple DPIs', () => {
  for (const axis of ['x', 'y']) for (const dpi of [96, 144, 192, 288, 768]) verifyNativeSnapDrag(drag(axis, dpi));
});

test('rejects the original repeated one-pixel snapback and failure to release', () => {
  for (const mode of ['snapback', 'stuck']) {
    const receipt = drag();
    for (const sample of receipt.samples.filter(item => item.phase === 'outward')) {
      if (mode === 'stuck' || sample.offset === 34) sample.visibleFrame = { ...receipt.samples[0].visibleFrame };
    }
    assert.throws(() => verifyNativeSnapDrag(receipt), /release|snap|follow/i);
  }
});

test('rejects early release, missing reacquisition, resizing and non-move-loop evidence', () => {
  const early = drag(); early.samples[1].visibleFrame.Left = 1; early.samples[1].visibleFrame.Right += 1;
  assert.throws(() => verifyNativeSnapDrag(early), /snap|follow/i);
  const noCapture = drag();
  for (const sample of noCapture.samples.filter(item => item.phase === 'approach')) {
    sample.visibleFrame.Left = sample.offset; sample.visibleFrame.Right = sample.offset + 1280;
  }
  assert.throws(() => verifyNativeSnapDrag(noCapture), /snap|follow/i);
  const resized = drag(); resized.samples[7].client.Right += 1;
  assert.throws(() => verifyNativeSnapDrag(resized), /size/i);
  const noLoop = drag(); noLoop.samples[1].moveSize = 0;
  assert.throws(() => verifyNativeSnapDrag(noLoop), /move loop/i);
  const noRelease = drag(); noRelease.released = false;
  assert.throws(() => verifyNativeSnapDrag(noRelease), /release/i);
});

test('rejects rebased release coordinates and a delayed release after reacquisition', () => {
  const rebased = drag();
  const released = rebased.samples.find(sample => sample.phase === 'outward' && sample.offset === 33);
  released.visibleFrame.Left = 1; released.visibleFrame.Right = 1281;
  assert.throws(() => verifyNativeSnapDrag(rebased), /snap|follow/i);
  const delayed = drag();
  const reversed = delayed.samples.find(sample => sample.phase === 'outward-again');
  reversed.visibleFrame.Left = 0; reversed.visibleFrame.Right = 1280;
  assert.throws(() => verifyNativeSnapDrag(delayed), /snap|follow/i);
});

test.runIf(process.platform === 'win32')('compiles native window and pointer helpers without operating the desktop', () => {
  execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    Add-Type -Path $env:SURTITLE_WINDOW_SOURCE
    $script = Get-Content -LiteralPath $env:SURTITLE_POINTER_SOURCE -Raw
    $source = [regex]::Match($script, "(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@").Groups[1].Value
    if (-not $source) { throw 'Native pointer source was not found' }
    Add-Type -TypeDefinition $source
  `], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env,
    SURTITLE_WINDOW_SOURCE: fileURLToPath(new URL('./native-window.cs', import.meta.url)),
    SURTITLE_POINTER_SOURCE: fileURLToPath(new URL('./native-video-click.ps1', import.meta.url)),
  } });
}, 35000);
