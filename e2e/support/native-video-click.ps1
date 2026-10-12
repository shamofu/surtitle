# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Application, [switch]$ActivateOnly)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native video pointer input requires Windows.' }
if (-not [IO.Path]::IsPathFullyQualified($Application) -or -not (Test-Path -LiteralPath $Application -PathType Leaf)) { throw 'Application must be an existing absolute executable path.' }
$expected = (Resolve-Path -LiteralPath $Application).ProviderPath
if ([IO.Path]::GetExtension($expected) -ine '.exe') { throw 'Application must be an executable.' }
$apps = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($expected)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected -and $_.MainWindowHandle -ne [IntPtr]::Zero })
if ($apps.Count -ne 1) { throw "Expected exactly one window for the configured test executable, found $($apps.Count)." }
$root = $apps[0].MainWindowHandle
$expectedProcess = [uint32]$apps[0].Id
Add-Type -Path (Join-Path $PSScriptRoot 'native-window.cs')
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class SurtitleNativePointer {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GuiThread { public uint Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect; }
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetGUIThreadInfo(uint thread, ref GuiThread info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    static void ValidateRoot(IntPtr root, uint expectedProcess) {
        GetWindowThreadProcessId(root, out uint actualProcess);
        if (actualProcess != expectedProcess || GetParent(root) != IntPtr.Zero || !IsWindowVisible(root)) throw new ArgumentException("Input target must remain the uniquely identified test application's visible root");
    }
    static Input[] PointerClick(int x, int y) {
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        if (width < 2 || height < 2 || x < left || x >= left + width || y < top || y >= top + height) throw new Exception("The owned test point is outside the attached desktop; no input was sent");
        return new[] {
            new Input { Mouse = new MouseInput { X = (int)((long)(x - left) * 65535 / (width - 1)), Y = (int)((long)(y - top) * 65535 / (height - 1)), Flags = 0x8000 | 0x4000 | 0x0001 } },
            new Input { Mouse = new MouseInput { Flags = 0x0002 } },
            new Input { Mouse = new MouseInput { Flags = 0x0004 } },
        };
    }
    static void EnsureIdlePointer(IntPtr root) {
        foreach (int key in new[] { 1, 2, 4, 5, 6, 16, 17, 18, 91, 92 }) {
            if (GetAsyncKeyState(key) < 0) throw new Exception("A mouse button or modifier is held; no test input was sent");
        }
        foreach (IntPtr window in new[] { root, GetForegroundWindow() }) {
            uint thread = GetWindowThreadProcessId(window, out _);
            if (thread == 0) throw new Exception("Could not verify GUI input ownership; no input was sent");
            var info = new GuiThread { Size = (uint)Marshal.SizeOf<GuiThread>() };
            if (!GetGUIThreadInfo(thread, ref info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inspect GUI input ownership; no input was sent");
            if (info.Capture != IntPtr.Zero || (info.Flags & 0x1e) != 0) throw new Exception("A GUI thread has mouse capture, a menu or a move/size operation; no input was sent");
        }
    }
    static bool IsOwnedCaption(IntPtr root, uint expectedProcess, Point point) {
        ValidateRoot(root, expectedProcess);
        if (point.X < short.MinValue || point.X > short.MaxValue || point.Y < short.MinValue || point.Y > short.MaxValue || WindowFromPoint(point) != root) return false;
        int coordinates = unchecked((int)((uint)(ushort)point.Y << 16 | (ushort)point.X));
        return SendMessageTimeout(root, 0x0084, UIntPtr.Zero, new IntPtr(coordinates), 0x23, 200, out UIntPtr hit) != IntPtr.Zero && hit.ToUInt64() == 2;
    }
    static void ActivateCaption(IntPtr root, uint expectedProcess) {
        ValidateRoot(root, expectedProcess);
        // Raise only the test window, preserving its position, size and inactive
        // state. A titlebar hit test, not foreground permission, gates input.
        if (!SetWindowPos(root, IntPtr.Zero, 0, 0, 0, 0, 0x4000 | 0x0010 | 0x0002 | 0x0001)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not expose the owned test titlebar; no input was sent");
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 1200) {
            if (!GetWindowRect(root, out Rect outer)) throw new Win32Exception();
            var client = new Point();
            if (!ClientToScreen(root, ref client)) throw new Win32Exception();
            int y = outer.Top + (client.Y - outer.Top) / 2;
            foreach (int divisor in new[] { 2, 3, 4 }) {
                var point = new Point { X = outer.Left + (outer.Right - outer.Left) / divisor, Y = y };
                if (!IsOwnedCaption(root, expectedProcess, point)) continue;
                var inputs = PointerClick(point.X, point.Y);
                if (!IsOwnedCaption(root, expectedProcess, point)) throw new Exception("The owned titlebar point changed before activation; no input was sent");
                EnsureIdlePointer(root);
                ValidateRoot(root, expectedProcess);
                if (WindowFromPoint(point) != root) throw new Exception("The owned titlebar point lost pointer ownership before activation; no input was sent");
                if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned titlebar activation input failed");
                return;
            }
            Thread.Sleep(20);
        }
        throw new Exception("No uncovered HTCAPTION point belongs to the owned test root; no input was sent");
    }
    static void ActivateCore(IntPtr root, uint expectedProcess) {
        ValidateRoot(root, expectedProcess);
        bool? requested = GetForegroundWindow() != root ? SetForegroundWindow(root) : (bool?)null;
        bool captionClicked = requested == false && GetForegroundWindow() != root;
        if (captionClicked) ActivateCaption(root, expectedProcess);
        // Activation crosses GUI input queues and can be acknowledged after
        // SetForegroundWindow or an owned-caption click returns. Video input
        // always waits for acknowledgement of this exact owned root.
        var clock = Stopwatch.StartNew();
        IntPtr foreground;
        while ((foreground = GetForegroundWindow()) != root && clock.ElapsedMilliseconds < 2000) Thread.Sleep(20);
        if (foreground != root) {
            GetWindowThreadProcessId(foreground, out uint foregroundProcess);
            var className = new StringBuilder(256);
            GetClassName(foreground, className, className.Capacity);
            throw new Exception("The configured test application did not acknowledge foreground activation; no video input was sent. "
                + "Expected root HWND=0x" + root.ToInt64().ToString("X") + " PID=" + expectedProcess
                + "; foreground HWND=0x" + foreground.ToInt64().ToString("X") + " PID=" + foregroundProcess
                + " class=" + className + "; SetForegroundWindow=" + (requested.HasValue ? requested.Value.ToString() : "not needed")
                + "; owned caption clicked=" + captionClicked
                + "; waitedMs=" + clock.ElapsedMilliseconds);
        }
        ValidateRoot(root, expectedProcess);
    }
    public static void Activate(IntPtr root, uint expectedProcess) {
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception();
        try { ActivateCore(root, expectedProcess); }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
    public static void Click(IntPtr root, uint expectedProcess, IntPtr video, int x, int y) {
        GetWindowThreadProcessId(video, out uint videoProcess);
        if (videoProcess != expectedProcess || GetParent(video) != root || !IsWindowVisible(video)) throw new ArgumentException("Click target must be the owned visible native video");
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception();
        try {
            ActivateCore(root, expectedProcess);
            if (WindowFromPoint(new Point { X = x, Y = y }) != video) throw new Exception("The retained video point is covered by another HWND; no input was sent");
            var inputs = PointerClick(x, y);
            EnsureIdlePointer(root);
            ValidateRoot(root, expectedProcess);
            GetWindowThreadProcessId(video, out uint finalVideoProcess);
            if (finalVideoProcess != expectedProcess || GetParent(video) != root || !IsWindowVisible(video)
                || GetForegroundWindow() != root || WindowFromPoint(new Point { X = x, Y = y }) != video) throw new Exception("The owned native video lost foreground or pointer ownership before input; no video input was sent");
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Native video pointer input failed");
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
}
'@
if ($ActivateOnly) {
    [SurtitleNativePointer]::Activate($root, $expectedProcess)
    @{ rootHandle = $root.ToInt64(); activated = $true } | ConvertTo-Json
    exit 0
}
$geometry = [SurtitleNativeWindow]::Inspect($root)
$videos = @($geometry | Where-Object { $_.parent -eq $root.ToInt64() -and $_.visible -and $_.className -ieq 'STATIC' })
if ($videos.Count -ne 1) { throw "Expected one visible native video host, found $($videos.Count)." }
$video = $videos[0]
$regions = @($video.regionRectangles | Where-Object { $_.Right -gt $_.Left -and $_.Bottom -gt $_.Top } | Sort-Object { ([long]$_.Right - $_.Left) * ([long]$_.Bottom - $_.Top) } -Descending)
if ($regions.Count -eq 0) { throw 'Native video has no explicitly retained region to click.' }
$region = $regions[0]
$x = $video.origin.X + [int][Math]::Floor(($region.Left + $region.Right) / 2)
$y = $video.origin.Y + [int][Math]::Floor(($region.Top + $region.Bottom) / 2)
[SurtitleNativePointer]::Click($root, $expectedProcess, [IntPtr]$video.handle, $x, $y)
@{ videoHandle = $video.handle; x = $x; y = $y; retainedRegion = $region } | ConvertTo-Json -Depth 3
