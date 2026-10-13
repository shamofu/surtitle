// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

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

    public static void RequireHostedRunner() {
        if (!OperatingSystem.IsWindows() || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true"
            || Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows"
            || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted")
            throw new InvalidOperationException("Desktop setup is restricted to GitHub-hosted Windows CI; local and self-hosted displays must not change.");
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
