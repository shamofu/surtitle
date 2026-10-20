// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test.runIf(process.platform === 'win32')('caption dragging rejects disabled full-window dragging before activating even an invalid window', () => {
  // Replace only the external settings query in a second compiled class. The
  // real helper is compiled too, and HWND zero can never target user input.
  const result = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -Path (Join-Path (Split-Path $env:SURTITLE_NATIVE_POINTER_SOURCE) 'native-window.cs')
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($env:SURTITLE_NATIVE_POINTER_SOURCE, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw $errors[0] }
    $literal = $ast.Find({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains('public static class SurtitleNativePointer') }, $true)
    Add-Type -TypeDefinition $literal.Value
    $disabled = $literal.Value.Replace('public static class SurtitleNativePointer', 'public static class DisabledDragPointer')
    $disabled = $disabled.Replace('[DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags);', 'static bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags) { if (action != 0x26 || parameter != 0 || flags != 0) throw new Exception("Unexpected settings query"); value = false; return true; }')
    Add-Type -TypeDefinition $disabled
    try { [DisabledDragPointer]::DragCaption([IntPtr]::Zero, 0, 'x', 48); throw 'Disabled drag setting was accepted' }
    catch { if ($_.Exception.Message -notmatch 'full-window dragging.*prepare-input') { throw } }
    'Disabled full-window dragging rejected before native input'
  `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CI: '', GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', SURTITLE_NATIVE_POINTER_SOURCE: fileURLToPath(new URL('./native-video-click.ps1', import.meta.url)) } });
  assert.match(result, /Disabled full-window dragging rejected before native input/);
}, 15000);

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
