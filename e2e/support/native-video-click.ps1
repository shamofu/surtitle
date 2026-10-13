# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding(DefaultParameterSetName = 'Input')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Input')][string]$Application,
    [Parameter(ParameterSetName = 'Input')][switch]$ActivateOnly,
    [Parameter(Mandatory, ParameterSetName = 'Inspect')][switch]$InspectInputDesktop
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native video pointer input requires Windows.' }
Add-Type -Path (Join-Path $PSScriptRoot 'native-window.cs')
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetGUIThreadInfo(uint thread, ref GuiThread info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetClipCursor(out Rect rect);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint size, out uint needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenWindowStation(string name, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr handle, int kind, IntPtr data, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectSecurity(IntPtr handle, ref uint information, IntPtr data, uint length, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint information, out IntPtr text, out uint length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr text);
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    static object Failure(int error) { return new { error, message = new Win32Exception(error).Message }; }
    static object UserObjectValue(IntPtr handle, int kind) {
        if (handle == IntPtr.Zero) return Failure(6);
        GetUserObjectInformation(handle, kind, IntPtr.Zero, 0, out uint size);
        int error = Marshal.GetLastWin32Error();
        if (size == 0 || size > 65536) return Failure(error);
        IntPtr data = Marshal.AllocHGlobal((int)size);
        try {
            if (!GetUserObjectInformation(handle, kind, data, size, out _)) return Failure(Marshal.GetLastWin32Error());
            if (kind == 2) return Marshal.PtrToStringUni(data);
            // USEROBJECTFLAGS: two BOOLs followed by DWORD dwFlags.
            if (kind == 1) return new { inherit = Marshal.ReadInt32(data) != 0, reserved = Marshal.ReadInt32(data, 4) != 0, flags = unchecked((uint)Marshal.ReadInt32(data, 8)) };
            return Marshal.ReadInt32(data) != 0; // UOI_IO
        } finally { Marshal.FreeHGlobal(data); }
    }
    static object UserObjectSecurity(IntPtr handle, uint information) {
        GetUserObjectSecurity(handle, ref information, IntPtr.Zero, 0, out uint size);
        int error = Marshal.GetLastWin32Error();
        if (size == 0 || size > 65536) return Failure(error);
        IntPtr data = Marshal.AllocHGlobal((int)size), text = IntPtr.Zero;
        try {
            if (!GetUserObjectSecurity(handle, ref information, data, size, out _)) return Failure(Marshal.GetLastWin32Error());
            if (!ConvertSecurityDescriptorToStringSecurityDescriptor(data, 1, information, out text, out _)) return Failure(Marshal.GetLastWin32Error());
            return Marshal.PtrToStringUni(text);
        } finally { if (text != IntPtr.Zero) LocalFree(text); Marshal.FreeHGlobal(data); }
    }
    static object TokenGroups(IntPtr token, int kind) {
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out uint size);
        int error = Marshal.GetLastWin32Error();
        if (size == 0 || size > 65536) return Failure(error);
        IntPtr data = Marshal.AllocHGlobal((int)size);
        try {
            if (!GetTokenInformation(token, kind, data, size, out _)) return Failure(Marshal.GetLastWin32Error());
            int count = Marshal.ReadInt32(data), offset = IntPtr.Size, stride = Marshal.SizeOf<SidAndAttributes>();
            if (count < 0 || count > (size - offset) / stride) throw new Exception("Invalid token group buffer");
            var groups = new List<object>();
            for (int index = 0; index < count; index++) {
                var group = Marshal.PtrToStructure<SidAndAttributes>(IntPtr.Add(data, offset + index * stride));
                if (!ConvertSidToStringSid(group.Sid, out IntPtr text)) { groups.Add(Failure(Marshal.GetLastWin32Error())); continue; }
                try { groups.Add(new { sid = Marshal.PtrToStringUni(text), attributes = "0x" + group.Attributes.ToString("X8") }); }
                finally { LocalFree(text); }
            }
            return new { count, groups };
        } finally { Marshal.FreeHGlobal(data); }
    }
    // Read-only preflight: never switches desktops, changes ACLs, moves the
    // cursor, activates a window, or calls any input API.
    public static object InspectInputDesktop() {
        IntPtr station = GetProcessWindowStation(), desktop = GetThreadDesktop(GetCurrentThreadId());
        object stationName = UserObjectValue(station, 2);
        IntPtr input = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS only
        int inputError = input == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        // Probe the exact SetCursorPos access prerequisite, independently of
        // read/diagnostic rights. Opening the handle never changes attributes.
        IntPtr writable = stationName is string name ? OpenWindowStation(name, false, 0x0010) : IntPtr.Zero;
        int writeError = writable == IntPtr.Zero ? (stationName is string ? Marshal.GetLastWin32Error() : 6) : 0;
        IntPtr token = IntPtr.Zero;
        object groups = null, restrictedGroups = null;
        try {
            if (OpenProcessToken(Process.GetCurrentProcess().Handle, 8, out token)) {
                groups = TokenGroups(token, 2); restrictedGroups = TokenGroups(token, 11);
            } else { groups = Failure(Marshal.GetLastWin32Error()); }
            return new {
                processId = Process.GetCurrentProcess().Id, sessionId = Process.GetCurrentProcess().SessionId,
                integrity = Integrity((uint)Process.GetCurrentProcess().Id), stationName,
                inputContext = InputContext(IntPtr.Zero),
                stationFlags = UserObjectValue(station, 1), threadDesktopName = UserObjectValue(desktop, 2),
                threadDesktopIsInput = UserObjectValue(desktop, 6),
                inputDesktopName = input != IntPtr.Zero ? UserObjectValue(input, 2) : Failure(inputError),
                inputDesktopError = inputError, writeAttributesAccess = writable != IntPtr.Zero,
                writeAttributesError = writeError, writeAttributesMessage = writeError == 0 ? null : new Win32Exception(writeError).Message,
                // Owner/group/DACL and the mandatory label are read separately:
                // unavailable READ_CONTROL never hides the successful access probes.
                stationSecurity = UserObjectSecurity(station, 0x7), stationLabel = UserObjectSecurity(station, 0x10),
                desktopSecurity = UserObjectSecurity(desktop, 0x7), desktopLabel = UserObjectSecurity(desktop, 0x10),
                groups, restrictedGroups
            };
        } finally {
            if (token != IntPtr.Zero) CloseHandle(token);
            if (input != IntPtr.Zero) CloseDesktop(input);
            if (writable != IntPtr.Zero) CloseWindowStation(writable);
            // GetProcessWindowStation/GetThreadDesktop handles are borrowed.
        }
    }
    static string Integrity(uint process) {
        IntPtr handle = OpenProcess(0x1000, false, process), token = IntPtr.Zero, data = IntPtr.Zero;
        try {
            if (handle == IntPtr.Zero || !OpenProcessToken(handle, 8, out token)) return "unavailable";
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out uint size);
            if (size == 0 || size > 4096) return "unavailable";
            data = Marshal.AllocHGlobal((int)size);
            if (!GetTokenInformation(token, 25, data, size, out _)) return "unavailable";
            var sid = Marshal.ReadIntPtr(data);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            return count == 0 ? "unavailable" : Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1)).ToString();
        } catch { return "unavailable"; }
        finally {
            if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
    static string InputContext(IntPtr root) {
        GetCursorPos(out Point cursor); GetClipCursor(out Rect clip);
        IntPtr cursorWindow = WindowFromPoint(cursor), foreground = GetForegroundWindow();
        GetWindowThreadProcessId(cursorWindow, out uint cursorProcess);
        GetWindowThreadProcessId(foreground, out uint foregroundProcess);
        var foregroundClass = new StringBuilder(256);
        GetClassName(foreground, foregroundClass, foregroundClass.Capacity);
        var result = "cursor=(" + cursor.X + "," + cursor.Y + ") HWND=0x" + cursorWindow.ToInt64().ToString("X") + " PID=" + cursorProcess
            + "; clip=(" + clip.Left + "," + clip.Top + "," + clip.Right + "," + clip.Bottom + ")"
            + "; helperIntegrity=" + Integrity((uint)Process.GetCurrentProcess().Id)
            + "; foregroundIntegrity=" + Integrity(foregroundProcess)
            + "; foreground HWND=0x" + foreground.ToInt64().ToString("X") + " PID=" + foregroundProcess + " class=" + foregroundClass;
        if (root != IntPtr.Zero) {
            GetWindowThreadProcessId(root, out uint rootProcess); GetWindowRect(root, out Rect outer);
            var origin = new Point(); ClientToScreen(root, ref origin);
            result += "; rootIntegrity=" + Integrity(rootProcess) + "; rootExStyle=0x" + GetWindowLongPtr(root, -20).ToInt64().ToString("X")
                + "; rootOuter=(" + outer.Left + "," + outer.Top + "," + outer.Right + "," + outer.Bottom + ")"
                + "; clientOrigin=(" + origin.X + "," + origin.Y + ")";
        }
        return result;
    }
    static void ValidateRoot(IntPtr root, uint expectedProcess) {
        GetWindowThreadProcessId(root, out uint actualProcess);
        if (actualProcess != expectedProcess || GetParent(root) != IntPtr.Zero || !IsWindowVisible(root)) throw new ArgumentException("Input target must remain the uniquely identified test application's visible root");
    }
    static void MovePointer(int x, int y) {
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        if (width < 2 || height < 2 || x < left || x >= left + width || y < top || y >= top + height) throw new Exception("The owned test point is outside the attached desktop; no input was sent");
        var inputs = new[] {
            new Input { Mouse = new MouseInput { X = (int)((long)(x - left) * 65535 / (width - 1)), Y = (int)((long)(y - top) * 65535 / (height - 1)), Flags = 0x8000 | 0x4000 | 0x0001 } },
        };
        if (SendInput(1, inputs, Marshal.SizeOf<Input>()) != 1) throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned pointer movement failed; no button input was sent");
        var clock = Stopwatch.StartNew();
        Point actual;
        do {
            if (!GetCursorPos(out actual)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not acknowledge owned pointer movement; no button input was sent");
            if (actual.X == x && actual.Y == y) return;
            Thread.Sleep(20);
        } while (clock.ElapsedMilliseconds < 500);
        GetClipCursor(out Rect clip);
        var owner = WindowFromPoint(actual);
        GetWindowThreadProcessId(owner, out uint ownerProcess);
        throw new Exception("Owned pointer movement did not reach its verified point; no button input was sent. "
            + "Expected=(" + x + "," + y + "); actual=(" + actual.X + "," + actual.Y + ")"
            + "; desktop=(" + left + "," + top + "," + width + "," + height + ")"
            + "; clip=(" + clip.Left + "," + clip.Top + "," + clip.Right + "," + clip.Bottom + ")"
            + "; cursor HWND=0x" + owner.ToInt64().ToString("X") + " PID=" + ownerProcess + "; " + InputContext(IntPtr.Zero));
    }
    static void PressPointer() {
        var inputs = new[] {
            new Input { Mouse = new MouseInput { Flags = 0x0002 } },
            new Input { Mouse = new MouseInput { Flags = 0x0004 } },
        };
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned pointer button input failed");
    }
    static bool CursorRemainsAt(Point expected, IntPtr window) {
        return GetCursorPos(out Point actual) && actual.X == expected.X && actual.Y == expected.Y && WindowFromPoint(actual) == window;
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
    static void PositionOwnedCaption(IntPtr root, uint expectedProcess, Point point) {
        if (!IsOwnedCaption(root, expectedProcess, point)) throw new Exception("The caption positioning target is not owned; no input was sent");
        EnsureIdlePointer(root);
        // SendInput movement may be blocked while an elevated CI console is
        // foreground. Position only over our verified, uncovered caption; the
        // following button event still uses SendInput and its integrity checks.
        // SetCursorPos requires the current input desktop and station access.
        // Never switch desktops, change permissions or inject into that console.
        if (!SetCursorPos(point.X, point.Y)) {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, "SetCursorPos failed; Win32Error=" + error + " (" + new Win32Exception(error).Message
                + "); no button input was sent. " + InputContext(root));
        }
        var clock = Stopwatch.StartNew();
        do {
            if (CursorRemainsAt(point, root)) return;
            Thread.Sleep(20);
        } while (clock.ElapsedMilliseconds < 500);
        throw new Exception("The owned caption did not acknowledge pointer positioning; no button input was sent. " + InputContext(root));
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
                EnsureIdlePointer(root);
                IntPtr previousForeground = GetForegroundWindow();
                PositionOwnedCaption(root, expectedProcess, point);
                if (!IsOwnedCaption(root, expectedProcess, point)) throw new Exception("The owned titlebar point changed before activation; no input was sent");
                EnsureIdlePointer(root);
                ValidateRoot(root, expectedProcess);
                if (!CursorRemainsAt(point, root)) throw new Exception("The owned titlebar point lost pointer ownership before activation; no button input was sent");
                IntPtr currentForeground = GetForegroundWindow();
                if (currentForeground == root) return;
                if (currentForeground != previousForeground) throw new Exception("Foreground ownership changed during caption positioning; no button input was sent. " + InputContext(root));
                PressPointer();
                return;
            }
            Thread.Sleep(20);
        }
        throw new Exception("No uncovered HTCAPTION point belongs to the owned test root; no input was sent. " + InputContext(root));
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
                + "; waitedMs=" + clock.ElapsedMilliseconds + "; " + InputContext(root));
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
            EnsureIdlePointer(root);
            MovePointer(x, y);
            EnsureIdlePointer(root);
            ValidateRoot(root, expectedProcess);
            GetWindowThreadProcessId(video, out uint finalVideoProcess);
            if (finalVideoProcess != expectedProcess || GetParent(video) != root || !IsWindowVisible(video)
                || GetForegroundWindow() != root || !CursorRemainsAt(new Point { X = x, Y = y }, video)) throw new Exception("The owned native video lost foreground or pointer ownership before input; no video input was sent");
            PressPointer();
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
}
'@
if ($InspectInputDesktop) {
    [SurtitleNativePointer]::InspectInputDesktop() | ConvertTo-Json -Depth 6
    exit 0
}
if (-not [IO.Path]::IsPathFullyQualified($Application) -or -not (Test-Path -LiteralPath $Application -PathType Leaf)) { throw 'Application must be an existing absolute executable path.' }
$expected = (Resolve-Path -LiteralPath $Application).ProviderPath
if ([IO.Path]::GetExtension($expected) -ine '.exe') { throw 'Application must be an executable.' }
$apps = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($expected)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected -and $_.MainWindowHandle -ne [IntPtr]::Zero })
if ($apps.Count -ne 1) { throw "Expected exactly one window for the configured test executable, found $($apps.Count)." }
$root = $apps[0].MainWindowHandle
$expectedProcess = [uint32]$apps[0].Id
try {
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
} catch {
    try { [Console]::Error.WriteLine('Native input desktop: ' + ([SurtitleNativePointer]::InspectInputDesktop() | ConvertTo-Json -Depth 6 -Compress)) }
    catch { [Console]::Error.WriteLine('Native input desktop diagnostics failed: ' + $_.Exception.Message) }
    throw
}
