// SPDX-License-Identifier: GPL-3.0-or-later
// No coordinate, keyboard, RPC or test-hook fallback: unknown accessibility fails closed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

public static class SurtitleProductionUia {
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder value, int max);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
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
    public static bool VideoSurface(Process app, out string observations) {
        int count = 0; var parent = app.MainWindowHandle;
        var surfaces = new List<string>();
        EnumChildWindows(parent, delegate(IntPtr child, IntPtr data) {
            var name = new System.Text.StringBuilder(256); GetClassName(child, name, name.Capacity);
            Rect rect;
            var owner = GetParent(child);
            if (owner == parent) {
                bool visible = IsWindowVisible(child), bounds = GetClientRect(child, out rect);
                surfaces.Add("handle=" + child.ToInt64() + ",parent=" + owner.ToInt64()
                    + ",class=" + name + ",visible=" + visible + ",bounds=" + bounds
                    + ",width=" + rect.Right + ",height=" + rect.Bottom);
                if (name.ToString().Equals("STATIC", StringComparison.OrdinalIgnoreCase) && visible
                    && bounds && rect.Right > 0 && rect.Bottom > 0) count++;
            }
            return true;
        }, IntPtr.Zero);
        observations = string.Join("; ", surfaces.ToArray());
        if (count > 1) throw new Exception("Ambiguous native video surface");
        return count == 1;
    }
    public static bool IsPaused(AutomationElement toggle) {
        Ready(toggle);
        string name = toggle.Current.Name;
        if (name == "Play" || name == "再生" || name == "再生 / Play") return true;
        if (name == "Pause" || name == "一時停止" || name == "一時停止 / Pause") return false;
        throw new Exception("Unknown playback state accessibility");
    }
}
