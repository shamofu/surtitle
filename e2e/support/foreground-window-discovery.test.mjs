// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { spawnWebDriver } from './webdriver-process.mjs';

const marker = 'SURTITLE_FOREGROUND_WINDOWS:';

test.runIf(process.platform === 'win32')('discovers real framed HWNDs while excluding an earlier visible Tao event target in the same owned process', async () => {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -Path $env:SURTITLE_FOREGROUND_SOURCE
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ForegroundWindowFixture {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WindowClass {
        public uint Style; public IntPtr Procedure; public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background; public string Menu, Name;
    }
    delegate IntPtr WindowProcedure(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    static readonly WindowProcedure Procedure = DefWindowProcW;
    static readonly List<IntPtr> Windows = new List<IntPtr>();
    static readonly List<string> Classes = new List<string>();
    static IntPtr job;

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassW(ref WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool UnregisterClassW(string name, IntPtr instance);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtrW(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int length);

    public static IntPtr Begin() {
        // No kill-on-close or UI restrictions: this additional job only scopes
        // the read-only production enumerator to the current disposable helper.
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero || !AssignProcessToJobObject(job, GetCurrentProcess()))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not scope the fixture process to its own job");
        return job;
    }
    static IntPtr Create(string name, uint style, uint extendedStyle, int width, int height) {
        var definition = new WindowClass { Name = name, Instance = GetModuleHandleW(null), Procedure = Marshal.GetFunctionPointerForDelegate(Procedure) };
        if (!Classes.Contains(name)) {
            if (RegisterClassW(ref definition) == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Register fixture class");
            Classes.Add(name);
        }
        IntPtr window = CreateWindowExW(extendedStyle, name, "Surtitle discovery regression", style, 0, 0, width, height,
            IntPtr.Zero, IntPtr.Zero, definition.Instance, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Create fixture window");
        Windows.Add(window);
        return window;
    }
    public static IntPtr CreateEventTarget() {
        // Match tao 0.35.3 create_event_target_window, including the later style
        // update that makes its zero-size utility window technically visible.
        IntPtr window = Create("Tao Thread Event Target", 0, 0x080800A0, 0, 0);
        SetWindowLongPtrW(window, -16, new IntPtr(unchecked((long)0x90000000u)));
        return window;
    }
    public static IntPtr CreateMain(string className) {
        IntPtr window = Create(className, 0x00CF0000, 0, 360, 200);
        ShowWindow(window, 4); // SW_SHOWNOACTIVATE; no focus, cursor or input calls.
        return window;
    }
    public static object Read(IntPtr window) {
        Rect outer, client;
        if (!GetWindowRect(window, out outer) || !GetClientRect(window, out client)) throw new Win32Exception();
        var name = new StringBuilder(256); GetClassNameW(window, name, name.Capacity);
        return new { window = window.ToInt64(), root = GetAncestor(window, 2).ToInt64(), owner = GetWindow(window, 4).ToInt64(),
            visible = IsWindowVisible(window), className = name.ToString(),
            style = unchecked((uint)GetWindowLongPtrW(window, -16).ToInt64()),
            extendedStyle = unchecked((uint)GetWindowLongPtrW(window, -20).ToInt64()), outer, client };
    }
    public static void Remove(IntPtr window) { if (!DestroyWindow(window)) throw new Win32Exception(); Windows.Remove(window); }
    public static void Dispose() {
        foreach (IntPtr window in Windows) DestroyWindow(window);
        foreach (string name in Classes) UnregisterClassW(name, GetModuleHandleW(null));
        if (job != IntPtr.Zero) CloseHandle(job);
    }
}
'@
    try {
      $ownedJob = [ForegroundWindowFixture]::Begin()
      $application = [Environment]::ProcessPath
      $utility = [ForegroundWindowFixture]::CreateEventTarget()
      $utilityState = [ForegroundWindowFixture]::Read($utility)
      $beforeMain = @([SurtitleWindowsStandardUser]::InspectForegroundJob($ownedJob, $application))
      if ($beforeMain.Count -ne 0) { throw 'The visible Tao event target was selected before a main window existed.' }
      $observed = @()
      foreach ($name in @('Surtitle Generic Framed Fixture', 'Tauri Window', 'Tao Thread Event Target')) {
        $main = [ForegroundWindowFixture]::CreateMain($name)
        $candidates = @([SurtitleWindowsStandardUser]::InspectForegroundJob($ownedJob, $application))
        if ($candidates.Count -ne 1 -or $candidates[0].window -ne $main.ToInt64()) {
          throw ('Production discovery did not select only the framed main window: ' + ($candidates | ConvertTo-Json -Depth 8 -Compress))
        }
        $observed += $candidates[0]
        [ForegroundWindowFixture]::Remove($main)
      }
      $afterMain = @([SurtitleWindowsStandardUser]::InspectForegroundJob($ownedJob, $application))
      if ($afterMain.Count -ne 0) { throw 'Discovery fell back to the utility window after the main window was destroyed.' }
      '${marker}' + (@{ utility = $utilityState; candidates = $observed } | ConvertTo-Json -Depth 8 -Compress)
    } finally { [ForegroundWindowFixture]::Dispose() }
  `;
  const child = spawnWebDriver('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SURTITLE_FOREGROUND_SOURCE: fileURLToPath(new URL('./windows-standard-user.cs', import.meta.url)) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', launchError, timedOut = false;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
  const result = await new Promise(resolve => {
    child.once('error', error => { launchError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(timedOut, false, stderr);
  assert.equal(launchError, undefined, stderr);
  assert.equal(result.code, 0, stderr || stdout);
  assert.equal(result.signal, null, stderr);
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
  assert.equal(lines.length, 1, stdout);
  const { utility, candidates } = JSON.parse(lines[0].slice(marker.length));
  console.info(JSON.stringify({ utility, candidates }));
  assert.equal(utility.className, 'Tao Thread Event Target');
  // Win32 may add WS_CLIPSIBLINGS; the visible popup still has no main frame.
  assert.equal((utility.style & 0x90000000) >>> 0, 0x90000000);
  assert.equal(utility.style & 0x00C80000, 0);
  assert.equal(utility.extendedStyle, 0x080800A0);
  assert.equal(utility.visible, true, 'The fixture must reproduce the old visible-root false positive');
  assert.equal(utility.root, utility.window);
  assert.equal(utility.owner, 0);
  assert.deepEqual(candidates.map(window => window.className), ['Surtitle Generic Framed Fixture', 'Tauri Window', 'Tao Thread Event Target'],
    'Main-window discovery must depend on real styles and geometry, not a class-name allowlist or blocklist');
  for (const window of candidates) {
    assert.equal(window.integrity, 8192);
    assert.equal(window.inJob, true);
    assert.equal(window.style & 0x00C80000, 0x00C80000);
    assert(window.clientWidth > 0 && window.clientHeight > 0 && window.outerWidth > window.clientWidth && window.outerHeight > window.clientHeight);
  }
}, 40000);
