// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SurtitleCiDesktop {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MonitorInfo {
        public int Size; public Rect Bounds, WorkArea; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }
    // The display union occupies 16 bytes; retain the complete driver-supplied
    // DEVMODEW when testing/applying a mode, rather than inventing a resolution.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DevMode {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public ushort SpecVersion, DriverVersion, Size, DriverExtra;
        public uint Fields; public int PositionX, PositionY;
        public uint DisplayOrientation, DisplayFixedOutput;
        public short Color, Duplex, YResolution, TTOption, Collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
        public ushort LogPixels;
        public uint BitsPerPel, PelsWidth, PelsHeight, DisplayFlags, DisplayFrequency;
        public uint ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
    }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int index, ref DevMode mode);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, ref DevMode mode, IntPtr window, uint flags, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowEx(uint extended, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] static extern bool AdjustWindowRectExForDpi(ref Rect rect, uint style, bool menu, uint extended, uint dpi);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFamilyName(IntPtr process, ref uint size, StringBuilder name);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint size, out uint required);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr text);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SystemParametersInfo(uint action, uint parameter, IntPtr value, uint flags);

    public sealed class InputWindow {
        public string hwnd { get; set; }
        public uint processId { get; set; }
        public uint? sessionId { get; set; }
        public string className { get; set; }
        public bool visible { get; set; }
    }
    public sealed class InputConsoleSnapshot {
        public uint currentProcessId { get; set; }
        public uint sessionId { get; set; }
        public uint[] consoleProcessIds { get; set; }
        public InputWindow attachedConsole { get; set; }
        public InputWindow rootOwner { get; set; }
        public InputWindow foreground { get; set; }
    }
    public sealed class InputConsoleReceipt {
        public string action { get; set; } = "prepare-input";
        public bool passed { get; set; }
        public bool requestedHide { get; set; }
        public bool hideRequestAccepted { get; set; }
        public bool? fullWindowDragBefore { get; set; }
        public bool? fullWindowDragAfter { get; set; }
        public bool requestedFullWindowDrag { get; set; }
        public string outcome { get; set; }
        public string error { get; set; }
        public int? nativeErrorCode { get; set; }
        public string inspectionError { get; set; }
        public string currentUserSid { get; set; }
        public RunnerTerminalIdentity runnerTerminalBefore { get; set; }
        public RunnerTerminalIdentity runnerTerminalAfter { get; set; }
        public InputConsoleSnapshot before { get; set; }
        public InputConsoleSnapshot after { get; set; }
    }
    public sealed class RunnerTerminalIdentity {
        public InputWindow window { get; set; }
        public string executablePath { get; set; }
        public long creationTime { get; set; }
        public string userSid { get; set; }
        public string packageFamilyName { get; set; }
        public bool packaged { get { return packageFamilyName != null; } }
    }
    public static InputConsoleReceipt LastInputConsoleReceipt { get; private set; }

    public static void RequireHostedRunner() {
        if (!OperatingSystem.IsWindows() || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true"
            || Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows"
            || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted")
            throw new InvalidOperationException("Desktop setup is restricted to GitHub-hosted Windows CI; local and self-hosted displays must not change.");
    }
    static uint SessionId(uint processId) {
        uint sessionId;
        if (!ProcessIdToSessionId(processId, out sessionId)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect console process session");
        return sessionId;
    }
    static InputWindow InputWindowSnapshot(IntPtr window) {
        var result = new InputWindow { hwnd = "0x" + window.ToInt64().ToString("x") };
        if (window == IntPtr.Zero) return result;
        uint processId;
        if (GetWindowThreadProcessId(window, out processId) == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect console window process");
        var name = new StringBuilder(256);
        if (GetClassName(window, name, name.Capacity) == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect console window class");
        result.processId = processId;
        result.sessionId = SessionId(processId);
        result.className = name.ToString();
        result.visible = IsWindowVisible(window);
        return result;
    }
    static uint[] ConsoleProcesses() {
        var processes = new uint[64];
        for (int attempt = 0; attempt < 3; attempt++) {
            uint count = GetConsoleProcessList(processes, checked((uint)processes.Length));
            if (count == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect attached console processes");
            if (count <= processes.Length) { Array.Resize(ref processes, checked((int)count)); return processes; }
            if (count > 65536) throw new InvalidOperationException("Unexpected console process count");
            processes = new uint[checked((int)count)];
        }
        throw new InvalidOperationException("Attached console process list did not settle");
    }
    static InputConsoleSnapshot InputConsoleState() {
        var console = GetConsoleWindow();
        // Microsoft's console/Terminal owner resolution also accounts for ConPTY:
        // https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/desktop-mobile/wam#parent-window-handles
        var root = console == IntPtr.Zero ? IntPtr.Zero : GetAncestor(console, 3); // GA_ROOTOWNER
        uint currentProcessId = checked((uint)Environment.ProcessId);
        return new InputConsoleSnapshot {
            currentProcessId = currentProcessId, sessionId = SessionId(currentProcessId),
            consoleProcessIds = console == IntPtr.Zero ? Array.Empty<uint>() : ConsoleProcesses(),
            attachedConsole = InputWindowSnapshot(console), rootOwner = InputWindowSnapshot(root),
            foreground = InputWindowSnapshot(GetForegroundWindow())
        };
    }
    static void ValidateConsoleOwnership(InputConsoleSnapshot state, InputConsoleSnapshot original) {
        if (state.attachedConsole.hwnd == "0x0" || state.rootOwner.hwnd == "0x0"
            || Array.IndexOf(state.consoleProcessIds, state.currentProcessId) < 0
            || state.attachedConsole.sessionId != state.sessionId || state.rootOwner.sessionId != state.sessionId
            || (state.rootOwner.className != "ConsoleWindowClass" && state.rootOwner.className != "CASCADIA_HOSTING_WINDOW_CLASS")
            || state.attachedConsole.hwnd != original.attachedConsole.hwnd || state.attachedConsole.processId != original.attachedConsole.processId
            || state.rootOwner.hwnd != original.rootOwner.hwnd || state.rootOwner.processId != original.rootOwner.processId
            || state.rootOwner.className != original.rootOwner.className)
            throw new InvalidOperationException("Attached console ownership, class or session is invalid or changed; no other window will be hidden");
    }
    public static void ValidateRunnerTerminal(RunnerTerminalIdentity candidate, uint currentSessionId, string currentUserSid) {
        long windowHandle;
        if (candidate == null || candidate.window == null || string.IsNullOrEmpty(candidate.window.hwnd)
            || !candidate.window.hwnd.StartsWith("0x", StringComparison.Ordinal)
            || !long.TryParse(candidate.window.hwnd.Substring(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out windowHandle) || windowHandle == 0
            || candidate.window.processId == 0 || candidate.window.sessionId != currentSessionId
            || candidate.window.className != "CASCADIA_HOSTING_WINDOW_CLASS"
            || string.IsNullOrEmpty(currentUserSid) || candidate.userSid != currentUserSid || candidate.creationTime <= 0
            || string.IsNullOrEmpty(candidate.executablePath) || !Path.IsPathFullyQualified(candidate.executablePath)
            || !string.Equals(Path.GetFileName(candidate.executablePath), "WindowsTerminal.exe", StringComparison.OrdinalIgnoreCase)
            || (candidate.packageFamilyName != null && candidate.packageFamilyName != "Microsoft.WindowsTerminal_8wekyb3d8bbwe"
                && candidate.packageFamilyName != "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"))
            throw new InvalidOperationException("Foreground runner Terminal identity, user or session is invalid; no window will be hidden");
    }
    public static void ValidateSameRunnerTerminal(RunnerTerminalIdentity original, RunnerTerminalIdentity current) {
        if (original == null || current == null || original.window == null || current.window == null
            || original.window.hwnd != current.window.hwnd || original.window.processId != current.window.processId
            || original.window.sessionId != current.window.sessionId || original.window.className != current.window.className
            || original.creationTime != current.creationTime || original.userSid != current.userSid
            || original.packageFamilyName != current.packageFamilyName
            || !string.Equals(original.executablePath, current.executablePath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Captured runner Terminal identity changed; no other window will be hidden");
    }
    static string ProcessUserSid(IntPtr process) {
        IntPtr token = IntPtr.Zero, data = IntPtr.Zero, text = IntPtr.Zero;
        try {
            if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect runner token user"); // TOKEN_QUERY
            uint size;
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out size); // TokenUser
            int error = Marshal.GetLastWin32Error();
            if (error != 122 || size == 0 || size > 65536) throw new Win32Exception(error, "Cannot size runner token user");
            data = Marshal.AllocHGlobal(checked((int)size));
            if (!GetTokenInformation(token, 1, data, size, out size)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read runner token user");
            if (!ConvertSidToStringSid(Marshal.ReadIntPtr(data), out text)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot format runner token user");
            return Marshal.PtrToStringUni(text);
        } finally {
            if (text != IntPtr.Zero) LocalFree(text);
            if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }
    static RunnerTerminalIdentity RunnerTerminalState(IntPtr process, IntPtr window) {
        uint status = WaitForSingleObject(process, 0);
        if (status == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect runner Terminal lifetime");
        if (status != 258) throw new InvalidOperationException("Captured runner Terminal process exited"); // WAIT_TIMEOUT means still running
        var path = new StringBuilder(32768);
        uint pathSize = checked((uint)path.Capacity);
        if (!QueryFullProcessImageName(process, 0, path, ref pathSize)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect runner Terminal executable");
        long created, exited, kernel, user;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect runner Terminal creation time");
        uint familySize = 0;
        int packageError = GetPackageFamilyName(process, ref familySize, null);
        string family = null;
        if (packageError == 122 && familySize > 0 && familySize <= 1024) {
            var package = new StringBuilder(checked((int)familySize));
            packageError = GetPackageFamilyName(process, ref familySize, package);
            if (packageError != 0) throw new Win32Exception(packageError, "Cannot read runner Terminal package identity");
            family = package.ToString();
        } else if (packageError != 15700) { // APPMODEL_ERROR_NO_PACKAGE is an explicit unpackaged identity.
            throw new Win32Exception(packageError, "Cannot inspect runner Terminal package identity");
        }
        return new RunnerTerminalIdentity { window = InputWindowSnapshot(window), executablePath = path.ToString(),
            creationTime = created, userSid = ProcessUserSid(process), packageFamilyName = family };
    }
    static void HideInputWindow(InputConsoleReceipt receipt, InputWindow target, Func<bool, InputWindow> validate) {
        var window = new IntPtr(Convert.ToInt64(target.hwnd.Substring(2), 16));
        var current = validate(true);
        if (current.visible) {
            receipt.requestedHide = true;
            bool accepted = ShowWindowAsync(window, 0); // SW_HIDE
            int error = Marshal.GetLastWin32Error();
            receipt.hideRequestAccepted = accepted;
            if (!accepted) throw new Win32Exception(error, "Cannot request hiding the CI console");
        }
        var timeout = Stopwatch.StartNew();
        while (true) {
            current = validate(false);
            receipt.after = InputConsoleState();
            if (!current.visible && receipt.after.foreground.hwnd != target.hwnd) return;
            if (timeout.ElapsedMilliseconds >= 3000) throw new InvalidOperationException("CI console did not leave the visible foreground within three seconds");
            Thread.Sleep(50);
        }
    }
    static void PrepareRunnerTerminal(InputConsoleReceipt receipt) {
        var target = receipt.before.foreground;
        if (target.className != "CASCADIA_HOSTING_WINDOW_CLASS") {
            receipt.outcome = "no-runner-terminal";
            receipt.after = InputConsoleState();
            return;
        }
        // Hosted jobs own a fresh VM. Runner.Worker itself is started with
        // CREATE_NO_WINDOW, so its shell cannot identify the runner's Terminal via GetConsoleWindow.
        // https://github.com/actions/runner/blob/main/src/Runner.Listener/JobDispatcher.cs
        var process = OpenProcess(0x00101000, false, target.processId); // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect the captured runner Terminal");
        try {
            var window = new IntPtr(Convert.ToInt64(target.hwnd.Substring(2), 16));
            receipt.currentUserSid = ProcessUserSid(new IntPtr(-1)); // GetCurrentProcess pseudo-handle
            var original = RunnerTerminalState(process, window);
            receipt.runnerTerminalBefore = original;
            if (original.window.processId != target.processId || original.window.hwnd != target.hwnd)
                throw new InvalidOperationException("Captured foreground Terminal window changed before inspection");
            ValidateRunnerTerminal(original, receipt.before.sessionId, receipt.currentUserSid);
            HideInputWindow(receipt, target, beforeHide => {
                var current = RunnerTerminalState(process, window);
                receipt.runnerTerminalAfter = current;
                ValidateRunnerTerminal(current, receipt.before.sessionId, receipt.currentUserSid);
                ValidateSameRunnerTerminal(original, current);
                if (beforeHide && GetForegroundWindow() != window)
                    throw new InvalidOperationException("Captured runner Terminal is no longer foreground; no other window will be hidden");
                return current.window;
            });
            receipt.outcome = receipt.requestedHide ? "runner-terminal-hidden" : "runner-terminal-already-hidden";
        } finally { CloseHandle(process); }
    }
    static void PrepareFullWindowDrag(InputConsoleReceipt receipt) {
        if (!SystemParametersInfo(0x26, 0, out bool enabled, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect full-window dragging"); // SPI_GETDRAGFULLWINDOWS
        receipt.fullWindowDragBefore = enabled;
        if (!enabled) {
            receipt.requestedFullWindowDrag = true;
            // SPI_SETDRAGFULLWINDOWS; flags 0 changes this ephemeral session
            // without persisting a user preference or broadcasting a change.
            if (!SystemParametersInfo(0x25, 1, IntPtr.Zero, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot enable full-window dragging in the hosted CI session");
        }
        if (!SystemParametersInfo(0x26, 0, out enabled, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify full-window dragging after CI input preparation");
        receipt.fullWindowDragAfter = enabled;
        if (!enabled) throw new InvalidOperationException("Full-window dragging remained disabled after CI input preparation; live caption geometry is unavailable");
    }
    public static InputConsoleReceipt PrepareInputConsole() {
        RequireHostedRunner();
        var receipt = new InputConsoleReceipt();
        LastInputConsoleReceipt = receipt;
        try {
            receipt.before = InputConsoleState();
            PrepareFullWindowDrag(receipt);
            if (receipt.before.attachedConsole.hwnd == "0x0") {
                PrepareRunnerTerminal(receipt);
            } else {
                ValidateConsoleOwnership(receipt.before, receipt.before);
                HideInputWindow(receipt, receipt.before.rootOwner, beforeHide => {
                    var current = InputConsoleState();
                    ValidateConsoleOwnership(current, receipt.before);
                    return current.rootOwner;
                });
                receipt.outcome = receipt.requestedHide ? "hidden" : "already-hidden";
            }
            receipt.passed = true;
            return receipt;
        } catch (Exception error) {
            receipt.error = error.Message;
            if (error is Win32Exception nativeError) receipt.nativeErrorCode = nativeError.NativeErrorCode;
            throw;
        } finally {
            if (!receipt.passed) {
                try { receipt.after = InputConsoleState(); }
                catch (Exception error) { receipt.inspectionError = error.Message; }
            }
        }
    }
    static MonitorInfo Primary() {
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(MonitorFromPoint(new Point(), 1), ref info) || (info.Flags & 1) == 0) throw new Win32Exception("Primary monitor not found");
        return info;
    }
    static DevMode Mode() { return new DevMode { Size = checked((ushort)Marshal.SizeOf<DevMode>()) }; }
    static object Size(Rect rect) { return new { width = rect.Right - rect.Left, height = rect.Bottom - rect.Top }; }
    public static object Inspect() {
        RequireHostedRunner();
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception();
        IntPtr probe = IntPtr.Zero;
        try {
            var info = Primary();
            // An invisible per-monitor-aware HWND reports the actual primary DPI.
            probe = CreateWindowEx(0, "STATIC", "", 0x80000000, info.Bounds.Left + 1, info.Bounds.Top + 1, 1, 1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (probe == IntPtr.Zero) throw new Win32Exception();
            uint dpi = GetDpiForWindow(probe);
            if (dpi < 96 || dpi > 768) throw new InvalidOperationException("Invalid primary monitor DPI");
            // Capacity envelope includes both the new default and the tallest native fixture.
            var outer = new Rect { Right = checked((int)Math.Ceiling(1600 * dpi / 96.0)), Bottom = checked((int)Math.Ceiling(940 * dpi / 96.0)) };
            if (!AdjustWindowRectExForDpi(ref outer, 0x00cf0000, false, 0, dpi)) throw new Win32Exception();
            var modes = new List<object>();
            for (int index = 0; index < 4096; index++) {
                var mode = Mode();
                if (!EnumDisplaySettings(info.Device, index, ref mode)) break;
                modes.Add(new { index, width = mode.PelsWidth, height = mode.PelsHeight, bitsPerPixel = mode.BitsPerPel, frequency = mode.DisplayFrequency, interlaced = (mode.DisplayFlags & 2) != 0 });
            }
            return new { device = info.Device, bounds = Size(info.Bounds), workArea = Size(info.WorkArea), dpi, requiredClient = new { width = 1600, height = 940 }, requiredOuter = Size(outer), modes = modes.ToArray() };
        } finally { if (probe != IntPtr.Zero) DestroyWindow(probe); SetThreadDpiAwarenessContext(previous); }
    }
    public static void Apply(int index, int width, int height) {
        RequireHostedRunner();
        if (index < 0 || index >= 4096 || width < 1920 || height < 1080) throw new ArgumentException("Invalid CI display mode");
        var info = Primary();
        var mode = Mode();
        if (!EnumDisplaySettings(info.Device, index, ref mode) || mode.PelsWidth != width || mode.PelsHeight != height || mode.BitsPerPel != 32 || (mode.DisplayFlags & 2) != 0)
            throw new InvalidOperationException("Selected supported display mode changed before application");
        // CDS_TEST validates the enumerated mode. Flags 0 then changes only the
        // active session: no registry update, unsafe mode, or DPI preference.
        int tested = ChangeDisplaySettingsEx(info.Device, ref mode, IntPtr.Zero, 2, IntPtr.Zero);
        if (tested != 0) throw new InvalidOperationException("Display mode test failed: " + tested);
        int applied = ChangeDisplaySettingsEx(info.Device, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
        if (applied != 0) throw new InvalidOperationException("Display mode application failed: " + applied);
    }
}
