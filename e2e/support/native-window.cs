// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class SurtitleNativeWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    delegate bool EnumWindow(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr root, EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetClientRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)] static extern bool ClientToScreen(IntPtr handle, ref Point point);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr handle);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int max);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr handle, IntPtr device, uint flags);

    static object Read(IntPtr handle) {
        if (!GetWindowRect(handle, out Rect screen) || !GetClientRect(handle, out Rect client)) throw new Win32Exception();
        var origin = new Point();
        if (!ClientToScreen(handle, ref origin)) throw new Win32Exception();
        var name = new StringBuilder(256); GetClassName(handle, name, 256);
        return new { handle = handle.ToInt64(), parent = GetParent(handle).ToInt64(), className = name.ToString(), visible = IsWindowVisible(handle), dpi = GetDpiForWindow(handle), screen, client, origin };
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
}
