// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Two disposable medium processes own every HWND used by the activation test.
// The foreground process supplies a real Windows policy denial; no API result
// or integrity level is replaced by a test double.
public static class ForegroundActivationFixture
{
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Point; public uint Private; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WindowClass {
        public uint Style; public IntPtr Procedure; public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background; public string Menu, Name;
    }
    delegate IntPtr WindowProcedure(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    static readonly WindowProcedure Procedure = Dispatch;
    static readonly ManualResetEventSlim Ready = new ManualResetEventSlim();
    static readonly ManualResetEventSlim Clicked = new ManualResetEventSlim();
    static Thread thread;
    static IntPtr window, selfJob, targetJob;
    static Process target;
    static Exception failure;
    static volatile bool locked;
    static bool sent, pendingButtonDown;
    static Timer lockWatchdog;
    static Point expectedPoint;
    static ClickReceipt receipt = new ClickReceipt();
    const uint ClickMessage = 0x8001, LockMessage = 0x8002;

    public sealed class ClickReceipt {
        public int processId, buttonUps; public bool foregroundConfirmed, cursorConfirmed;
        public uint inserted; public long window;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassW(ref WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool UnregisterClassW(string name, IntPtr instance);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern int GetMessageW(out Message message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", SetLastError = true)] static extern bool LockSetForegroundWindow(uint code);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    static void Check(bool value, string description) {
        if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), description);
    }
    public static IntPtr StartWindow(string title, int left) {
        thread = new Thread(() => {
            string name = "Surtitle Foreground Activation Fixture";
            IntPtr instance = GetModuleHandleW(null), previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
            try {
                Check(previous != IntPtr.Zero, "Set fixture DPI awareness");
                var definition = new WindowClass { Name = name, Instance = instance, Procedure = Marshal.GetFunctionPointerForDelegate(Procedure) };
                Check(RegisterClassW(ref definition) != 0, "Register fixture class");
                window = CreateWindowExW(0, name, title, 0x00CF0000, left, 100, 360, 200, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
                Check(window != IntPtr.Zero, "Create fixture window");
                ShowWindow(window, 4); // SW_SHOWNOACTIVATE.
                Ready.Set();
                Message message;
                int result;
                while ((result = GetMessageW(out message, IntPtr.Zero, 0, 0)) > 0) {
                    TranslateMessage(ref message); DispatchMessageW(ref message);
                }
                Check(result == 0, "Pump fixture window messages");
            } catch (Exception error) { failure = error; Ready.Set(); Clicked.Set(); }
            finally {
                if (window != IntPtr.Zero) DestroyWindow(window);
                UnregisterClassW(name, instance);
                if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!Ready.Wait(5000)) throw new TimeoutException("Fixture window was not created.");
        if (failure != null) throw failure;
        return window;
    }
    static IntPtr Dispatch(IntPtr handle, uint message, UIntPtr wParam, IntPtr lParam) {
        try {
            if (message == LockMessage) {
                if (GetForegroundWindow() != handle) throw new InvalidOperationException("Only the owned foreground fixture may establish the denial.");
                Check(LockSetForegroundWindow(1), "Lock owned foreground");
                locked = true;
                lockWatchdog = new Timer(_ => { if (locked) { LockSetForegroundWindow(2); locked = false; } }, null, 8000, Timeout.Infinite);
                return new IntPtr(1);
            }
            if (message == ClickMessage) {
                if (sent) throw new InvalidOperationException("Fixture click was requested twice.");
                foreach (int key in new[] { 1, 2, 4, 5, 6, 16, 17, 18, 91, 92 })
                    if (GetAsyncKeyState(key) < 0) throw new InvalidOperationException("A pointer button or modifier is held; no fixture input was sent.");
                expectedPoint = new Point { X = 48, Y = 48 };
                Check(ClientToScreen(handle, ref expectedPoint), "Read owned client point");
                if (GetForegroundWindow() != handle || WindowFromPoint(expectedPoint) != handle)
                    throw new InvalidOperationException("The target did not own foreground and its client point; no click was sent.");
                Check(SetCursorPos(expectedPoint.X, expectedPoint.Y), "Position owned client cursor");
                CheckPoint(handle);
                receipt.processId = Process.GetCurrentProcess().Id;
                receipt.window = handle.ToInt64();
                sent = true;
                var input = new[] { new Input { Mouse = new MouseInput { Flags = 2 } }, new Input { Mouse = new MouseInput { Flags = 4 } } };
                receipt.inserted = SendInput(2, input, Marshal.SizeOf(typeof(Input)));
                pendingButtonDown = receipt.inserted == 1;
                Check(receipt.inserted == 2, "Send owned client click");
                return IntPtr.Zero;
            }
            if (message == 0x0202 && sent) {
                CheckPoint(handle);
                receipt.buttonUps++;
                receipt.foregroundConfirmed = receipt.cursorConfirmed = true;
                Clicked.Set();
            }
            if (message == 0x0002) { PostQuitMessage(0); return IntPtr.Zero; }
        } catch (Exception error) {
            if (pendingButtonDown) {
                try {
                    CheckPoint(handle);
                    SendInput(1, new[] { new Input { Mouse = new MouseInput { Flags = 4 } } }, Marshal.SizeOf(typeof(Input)));
                } catch { /* Never send cleanup input to a point the fixture no longer owns. */ }
                pendingButtonDown = false;
            }
            failure = error; Clicked.Set(); return IntPtr.Zero;
        }
        return DefWindowProcW(handle, message, wParam, lParam);
    }
    static void CheckPoint(IntPtr handle) {
        Point cursor;
        if (GetForegroundWindow() != handle || WindowFromPoint(expectedPoint) != handle || !GetCursorPos(out cursor)
            || cursor.X != expectedPoint.X || cursor.Y != expectedPoint.Y)
            throw new InvalidOperationException("The owned fixture lost foreground or cursor ownership.");
    }
    public static void LockForeground() {
        Check(SendMessageTimeoutW(window, LockMessage, UIntPtr.Zero, IntPtr.Zero, 0x23, 1000, out UIntPtr result) != IntPtr.Zero,
            "Request owned foreground lock");
        if (failure != null) throw failure;
        if (result.ToUInt64() != 1 || GetForegroundWindow() != window) throw new InvalidOperationException("The foreground lock was not acknowledged.");
    }
    public static long ForegroundWindow() { return GetForegroundWindow().ToInt64(); }
    public static void RequestClick(long handle) { Check(PostMessageW(new IntPtr(handle), ClickMessage, UIntPtr.Zero, IntPtr.Zero), "Request owned client click"); }
    public static ClickReceipt WaitForClick() {
        if (!Clicked.Wait(30000)) throw new TimeoutException("No owned client click arrived within 30 seconds.");
        if (failure != null) throw failure;
        return receipt;
    }
    public static IntPtr ScopeSelf() {
        selfJob = CreateJobObjectW(IntPtr.Zero, null);
        Check(selfJob != IntPtr.Zero && AssignProcessToJobObject(selfJob, GetCurrentProcess()), "Scope foreground fixture process");
        return selfJob;
    }
    public static IntPtr StartTarget(string application, string script, string evidenceDirectory) {
        targetJob = CreateJobObjectW(IntPtr.Zero, null);
        Check(targetJob != IntPtr.Zero, "Create target fixture job");
        var start = new ProcessStartInfo(application) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Target", "-EvidenceDirectory", evidenceDirectory }) start.ArgumentList.Add(argument);
        target = Process.Start(start);
        Check(AssignProcessToJobObject(targetJob, target.Handle), "Scope target fixture process");
        return targetJob;
    }
    public static int TargetProcessId() { return target.Id; }
    public static bool TargetExited() { return target.HasExited; }
    public static string TargetError() { return target.HasExited ? target.StandardError.ReadToEnd() : "Target is still running."; }
    public static void Dispose() {
        if (lockWatchdog != null) lockWatchdog.Dispose();
        if (locked) { LockSetForegroundWindow(2); locked = false; }
        if (target != null) {
            if (!target.HasExited) target.Kill(true);
            target.WaitForExit(3000); target.Dispose();
        }
        if (window != IntPtr.Zero) PostMessageW(window, 0x0010, UIntPtr.Zero, IntPtr.Zero);
        if (thread != null) thread.Join(2000);
        if (targetJob != IntPtr.Zero) CloseHandle(targetJob);
        if (selfJob != IntPtr.Zero) CloseHandle(selfJob);
    }
}
