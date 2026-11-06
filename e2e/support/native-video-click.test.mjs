// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

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
