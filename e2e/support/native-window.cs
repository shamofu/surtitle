// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Linq;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class SurtitleNativeWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Bounds, WorkArea; public uint Flags; }
    delegate bool EnumWindow(IntPtr handle, IntPtr parameter);
    delegate bool EnumMonitor(IntPtr handle, IntPtr device, ref Rect bounds, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr device, IntPtr clip, EnumMonitor callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr root, EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr handle, uint attribute, out Rect value, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, ref Rect lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetClientRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] static extern bool ClientToScreen(IntPtr handle, ref Point point);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr handle);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int max);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr handle, IntPtr device, uint flags);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr handle, IntPtr region);
    [DllImport("gdi32.dll")] static extern uint GetRegionData(IntPtr region, uint length, IntPtr data);

    static Rect[] RegionRectangles(IntPtr handle) {
        IntPtr region = CreateRectRgn(0, 0, 0, 0), data = IntPtr.Zero;
        if (region == IntPtr.Zero) throw new Win32Exception();
        try {
            if (GetWindowRgn(handle, region) == 0) return null;
            uint bytes = GetRegionData(region, 0, IntPtr.Zero);
            if (bytes < 32 || bytes > 1024 * 1024) throw new Exception("Invalid native region size");
            data = Marshal.AllocHGlobal(checked((int)bytes));
            if (GetRegionData(region, bytes, data) != bytes) throw new Win32Exception();
            int header = Marshal.ReadInt32(data), count = Marshal.ReadInt32(data, 8);
            if (header != 32 || count < 0 || 32L + count * 16L > bytes) throw new Exception("Invalid native region data");
            var result = new Rect[count];
            for (int index = 0; index < count; index++) result[index] = Marshal.PtrToStructure<Rect>(IntPtr.Add(data, 32 + index * 16));
            return result;
        } finally { if (data != IntPtr.Zero) Marshal.FreeHGlobal(data); DeleteObject(region); }
    }

    static object Read(IntPtr handle) {
        if (!GetWindowRect(handle, out Rect screen) || !GetClientRect(handle, out Rect client)) throw new Win32Exception();
        var origin = new Point();
        if (!ClientToScreen(handle, ref origin)) throw new Win32Exception();
        var name = new StringBuilder(256); GetClassName(handle, name, 256);
        var visibleFrame = VisibleFrame(handle, screen);
        return new { handle = handle.ToInt64(), parent = GetParent(handle).ToInt64(), className = name.ToString(), visible = IsWindowVisible(handle), maximized = IsZoomed(handle), dpi = GetDpiForWindow(handle), screen, visibleFrame, client, origin,
            regionRectangles = name.ToString().Equals("STATIC", StringComparison.OrdinalIgnoreCase) ? RegionRectangles(handle) : null };
    }
    static Rect VisibleFrame(IntPtr handle, Rect fallback) {
        return DwmGetWindowAttribute(handle, 9, out Rect frame, Marshal.SizeOf<Rect>()) == 0
            && frame.Right > frame.Left && frame.Bottom > frame.Top ? frame : fallback;
    }
    public static void SnapToEdge(IntPtr root, string edge) {
        if (GetParent(root) != IntPtr.Zero || IsZoomed(root)) throw new ArgumentException("Snap target must be a normal top-level window");
        if (!new[] { "left", "right", "top", "bottom", "top-left", "bottom-right" }.Contains(edge)) throw new ArgumentException("Invalid snap edge");
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception();
        try {
            if (!GetWindowRect(root, out Rect outer)) throw new Win32Exception();
            var visible = VisibleFrame(root, outer);
            var area = ReadMonitor(MonitorFromWindow(root, 2)).WorkArea;
            int x = edge.Contains("left") ? area.Left - visible.Left : edge.Contains("right") ? area.Right - visible.Right : 0;
            int y = edge.Contains("top") ? area.Top - visible.Top : edge.Contains("bottom") ? area.Bottom - visible.Bottom : 0;
            var proposed = new Rect { Left = outer.Left + x, Top = outer.Top + y, Right = outer.Right + x, Bottom = outer.Bottom + y };
            // Non-input coverage starts already aligned. Acquisition and release
            // require cursor motion and are covered by the real caption drag.
            if (!SetWindowPos(root, IntPtr.Zero, proposed.Left, proposed.Top, 0, 0, 0x0001 | 0x0004 | 0x0010)) throw new Win32Exception();
            if (SendMessageTimeout(root, 0x0231, IntPtr.Zero, IntPtr.Zero, 2, 2000, out _) == IntPtr.Zero) throw new Win32Exception();
            try {
                if (SendMessageTimeout(root, 0x0216, IntPtr.Zero, ref proposed, 2, 2000, out IntPtr handled) == IntPtr.Zero || handled == IntPtr.Zero)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Application did not handle the native drag message");
                if (proposed.Right - proposed.Left != outer.Right - outer.Left || proposed.Bottom - proposed.Top != outer.Bottom - outer.Top)
                    throw new InvalidOperationException("Magnetic snapping changed window size");
                if (!SetWindowPos(root, IntPtr.Zero, proposed.Left, proposed.Top, 0, 0, 0x0001 | 0x0004 | 0x0010)) throw new Win32Exception();
            } finally {
                if (SendMessageTimeout(root, 0x0232, IntPtr.Zero, IntPtr.Zero, 2, 2000, out _) == IntPtr.Zero) throw new Win32Exception();
            }
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
    public static object[] Inspect(IntPtr root) {
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inspect native bounds in physical pixels");
        try {
            var rows = new List<object>(); rows.Add(Read(root));
            EnumChildWindows(root, (handle, _) => { rows.Add(Read(handle)); return true; }, IntPtr.Zero);
            return rows.ToArray();
        } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
    static List<IntPtr> MonitorHandles() {
        var result = new List<IntPtr>();
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr handle, IntPtr device, ref Rect bounds, IntPtr parameter) => { result.Add(handle); return true; }, IntPtr.Zero)) throw new Win32Exception();
        return result;
    }
    static MonitorInfo ReadMonitor(IntPtr handle) {
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(handle, ref info)) throw new Win32Exception();
        return info;
    }
    public static object InspectMonitor(IntPtr root) {
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception();
        try {
            var monitors = new List<object>();
            foreach (var handle in MonitorHandles()) {
                var info = ReadMonitor(handle);
                monitors.Add(new { handle = handle.ToInt64(), primary = (info.Flags & 1) != 0, bounds = info.Bounds, workArea = info.WorkArea });
            }
            return new { current = MonitorFromWindow(root, 2).ToInt64(), monitors = monitors.ToArray() };
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
    public static void MoveToMonitor(IntPtr root, long monitor) {
        if (GetParent(root) != IntPtr.Zero) throw new ArgumentException("Move target must be the top-level application window");
        var target = new IntPtr(monitor);
        if (!MonitorHandles().Contains(target)) throw new ArgumentException("Target monitor is not attached");
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception();
        try {
            var info = ReadMonitor(target);
            // Move only the explicitly selected test application, without changing
            // activation, z-order, or any system display preference.
            if (!SetWindowPos(root, IntPtr.Zero, info.WorkArea.Left + 16, info.WorkArea.Top + 16, 0, 0, 0x0001 | 0x0004 | 0x0010)) throw new Win32Exception();
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
    public static void ResizeClient(IntPtr root, int width, int height) {
        if (GetParent(root) != IntPtr.Zero) throw new ArgumentException("Resize target must be the top-level application window");
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resize the native window in physical pixels");
        try {
            if (!GetWindowRect(root, out Rect outer) || !GetClientRect(root, out Rect client)) throw new Win32Exception();
            double scale = GetDpiForWindow(root) / 96.0;
            if (scale < 0.5 || scale > 8) throw new ArgumentException("Invalid window DPI");
            int physicalWidth = checked((int)Math.Round(width * scale));
            int physicalHeight = checked((int)Math.Round(height * scale));
            int borderWidth = outer.Right - outer.Left - client.Right + client.Left;
            int borderHeight = outer.Bottom - outer.Top - client.Bottom + client.Top;
            // Preserve position, z-order and activation; let Tauri resize its own WebView.
            if (!SetWindowPos(root, IntPtr.Zero, 0, 0, physicalWidth + borderWidth, physicalHeight + borderHeight, 0x0002 | 0x0004 | 0x0010)) throw new Win32Exception();
        } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
    public static void SystemCommand(IntPtr root, string action) {
        if (GetParent(root) != IntPtr.Zero) throw new ArgumentException("Command target must be the top-level application window");
        // Exercise the same native close/maximize/restore path as the title bar.
        int command = action == "close" ? 0xF060 : action == "maximize" ? 0xF030 : action == "restore" ? 0xF120 : throw new ArgumentException("Invalid system command");
        if (!PostMessage(root, 0x0112, new IntPtr(command), IntPtr.Zero)) throw new Win32Exception();
    }
}
