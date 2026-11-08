// SPDX-License-Identifier: GPL-3.0-or-later
// No coordinate input, keyboard, RPC or test-hook fallback: unknown accessibility fails closed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

public static class SurtitleProductionUia {
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc callback, IntPtr data);
    delegate bool MonitorProc(IntPtr monitor, IntPtr hdc, ref Rect rect, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    public static AutomationElement Root(Process app) {
        app.Refresh();
        if (app.HasExited) throw new Exception("Application exited before acceptance");
        return app.MainWindowHandle == IntPtr.Zero ? null : AutomationElement.FromHandle(app.MainWindowHandle);
    }
    public static AutomationElement FromHandle(long handle) { return AutomationElement.FromHandle(new IntPtr(handle)); }
    public static double[] Bounds(AutomationElement element) {
        Ready(element); var rect = element.Current.BoundingRectangle;
        if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) throw new Exception("Accessible bounds are empty");
        return new double[] { rect.Left, rect.Top, rect.Width, rect.Height };
    }
    public static void SetValue(AutomationElement element, string value) {
        Ready(element); var pattern = (ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern);
        if (pattern.Current.IsReadOnly) throw new Exception("Accessible input is read only");
        pattern.SetValue(value);
    }
    public static void Focus(AutomationElement element) { Ready(element); element.SetFocus(); }
    public static long OwnedDialog(int process, long owner) {
        var matches = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            uint id; GetWindowThreadProcessId(hwnd, out id);
            if (id == process && IsWindowVisible(hwnd) && GetWindow(hwnd, 4).ToInt64() == owner) matches.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        if (matches.Count > 1) throw new Exception("Ambiguous owned modal dialog");
        return matches.Count == 1 ? matches[0].ToInt64() : 0;
    }
    public static bool Enabled(long handle) { return IsWindowEnabled(new IntPtr(handle)); }
    public static bool FocusWithin(long handle, int process) {
        var element = AutomationElement.FocusedElement;
        if (element == null || element.Current.ProcessId != process) return false;
        for (int count = 0; element != null && count < 100; count++) {
            if (element.Current.NativeWindowHandle == handle) return true;
            element = TreeWalker.RawViewWalker.GetParent(element);
        }
        return false;
    }
    public static bool RejectsActivation(AutomationElement element) {
        // Exercise the actual provider, not this helper's Ready precondition.
        try { ActivateSupportedPattern(element); }
        catch (ElementNotEnabledException) { return true; }
        return false;
    }
    public static AutomationElement Id(AutomationElement root, string id) {
        if (root == null) return null;
        var found = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, id));
        if (found.Count > 1) throw new Exception("Duplicate automation identity: " + id);
        return found.Count == 1 ? found[0] : null;
    }
    static void Ready(AutomationElement element) {
        if (element == null || !element.Current.IsEnabled || element.Current.IsOffscreen) throw new Exception("Unavailable accessible control");
    }
    public static void Activate(AutomationElement element) {
        Ready(element);
        ActivateSupportedPattern(element);
    }
    static void ActivateSupportedPattern(AutomationElement element) {
        object pattern;
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) {
            ((InvokePattern)pattern).Invoke();
        } else if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) {
            ((TogglePattern)pattern).Toggle();
        } else {
            throw new Exception("Unsupported activation patterns for AutomationId='" + element.Current.AutomationId
                + "', ControlType='" + element.Current.ControlType.ProgrammaticName + "'");
        }
    }
    public static string Value(AutomationElement element) {
        Ready(element);
        return ((ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
    }
    public static AutomationElement Slider(AutomationElement root, string english, string japanese) {
        var found = root.FindAll(TreeScope.Descendants, new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Slider),
            new OrCondition(new PropertyCondition(AutomationElement.NameProperty, english), new PropertyCondition(AutomationElement.NameProperty, japanese))));
        if (found.Count != 1) throw new Exception("Missing or ambiguous slider: " + english);
        Ready(found[0]); return found[0];
    }
    public static double Range(AutomationElement slider, double expectedMaximum) {
        Ready(slider);
        var value = ((RangeValuePattern)slider.GetCurrentPattern(RangeValuePattern.Pattern)).Current;
        if (value.IsReadOnly || value.Minimum != 0 || value.Maximum != expectedMaximum) throw new Exception("Unexpected slider range");
        return value.Value;
    }
    public static void SetRange(AutomationElement slider, double maximum, double value) {
        Range(slider, maximum);
        ((RangeValuePattern)slider.GetCurrentPattern(RangeValuePattern.Pattern)).SetValue(value);
    }
    public static int[] OwnedViewportCapture(Process app, AutomationElement viewport) {
        Ready(viewport); app.Refresh();
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Exception("Cannot establish physical capture coordinates");
        try {
            var parent=app.MainWindowHandle; uint process;
            GetWindowThreadProcessId(parent,out process);
            if (app.HasExited || process!=(uint)app.Id || !IsWindowVisible(parent) || IsIconic(parent)
                || GetForegroundWindow()!=parent || viewport.Current.ProcessId!=app.Id)
                throw new Exception("Pixel capture requires the visible foreground application viewport");
            var bounds=Bounds(viewport);
            var area=new Rect { Left=(int)Math.Ceiling(bounds[0]), Top=(int)Math.Ceiling(bounds[1]),
                Right=(int)Math.Floor(bounds[0]+bounds[2]), Bottom=(int)Math.Floor(bounds[1]+bounds[3]) };
            Rect client; var origin=new Point();
            if (!GetClientRect(parent,out client) || !ClientToScreen(parent,ref origin)
                || area.Left<origin.X || area.Top<origin.Y || area.Right>origin.X+client.Right
                || area.Bottom>origin.Y+client.Bottom || area.Right-area.Left<32 || area.Bottom-area.Top<32)
                throw new Exception("Video viewport is not fully inside the application's physical client");
            var monitors=new List<MonitorInfo>();
            bool monitorFailure=false;
            if (!EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr monitor,IntPtr hdc,ref Rect rect,IntPtr data) {
                var info=new MonitorInfo { Size=Marshal.SizeOf(typeof(MonitorInfo)) };
                if (!GetMonitorInfo(monitor,ref info)) { monitorFailure=true; return false; }
                monitors.Add(info); return true;
            },IntPtr.Zero) || monitorFailure || monitors.Count!=1 || (monitors[0].Flags&1)==0)
                throw new Exception("Automated DDA fixture capture requires one active primary monitor; the multi-monitor matrix is separate");
            var screen=monitors[0].Monitor;
            if (area.Left<screen.Left || area.Top<screen.Top || area.Right>screen.Right || area.Bottom>screen.Bottom)
                throw new Exception("Video viewport is not fully on the verified monitor");
            // Never capture an occluding foreign/owned dialog. Inspect every
            // visible window above the main HWND, rather than sparse hit tests.
            var current=GetTopWindow(IntPtr.Zero); int inspected=0;
            for (;current!=IntPtr.Zero && current!=parent;current=GetWindow(current,2)) {
                if (++inspected>10000) throw new Exception("Unstable window stack during capture");
                if (!IsWindowVisible(current)) continue;
                int cloaked; Rect other;
                if (DwmGetWindowAttribute(current,14,out cloaked,4)==0 && cloaked!=0) continue;
                if (!GetWindowRect(current,out other)) throw new Exception("Cannot verify an overlapping window");
                if (other.Left<area.Right && other.Right>area.Left && other.Top<area.Bottom && other.Bottom>area.Top)
                    throw new Exception("Another visible window overlaps the video capture rectangle");
            }
            if (current!=parent) throw new Exception("Application window disappeared from the native stack");
            return new int[] { area.Left,area.Top,area.Right-area.Left,area.Bottom-area.Top,
                screen.Left,screen.Top,screen.Right-screen.Left,screen.Bottom-screen.Top };
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
    public static bool IsPaused(AutomationElement toggle) {
        Ready(toggle);
        string name = toggle.Current.Name;
        if (name == "Play" || name == "再生" || name == "再生 / Play") return true;
        if (name == "Pause" || name == "一時停止" || name == "一時停止 / Pause") return false;
        throw new Exception("Unknown playback state accessibility");
    }
}
