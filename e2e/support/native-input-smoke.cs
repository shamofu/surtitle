// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// A disposable, medium-integrity window exercises the same launcher handoff
// before CI spends time compiling the application. Never sends input elsewhere.
public static class SurtitleNativeInputSmoke
{
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint size, out uint needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    public sealed class Receipt
    {
        public bool passed, foregroundConfirmed, cursorConfirmed;
        public int processId, buttonUps, cursorX, cursorY;
        public int? nativeErrorCode;
        public uint? inserted, failureForegroundProcess;
        public string window, error, pendingButtonCleanup, failureForegroundWindow;
    }

    static void IdlePointer()
    {
        foreach (int key in new[] { 1, 2, 4, 5, 6, 16, 17, 18, 91, 92 })
            if (GetAsyncKeyState(key) < 0) throw new InvalidOperationException("A mouse button or modifier is held; no smoke input was sent.");
    }

    static void OwnPoint(IntPtr window, Point expected, IntPtr foreground)
    {
        Point actual;
        if (GetForegroundWindow() != foreground || WindowFromPoint(expected) != window || !GetCursorPos(out actual)
            || actual.X != expected.X || actual.Y != expected.Y)
            throw new InvalidOperationException("The smoke window lost foreground or cursor ownership; no button input was sent.");
    }

    static bool MediumForeground(IntPtr window)
    {
        uint process;
        GetWindowThreadProcessId(window, out process);
        IntPtr handle = OpenProcess(0x1000, false, process), token = IntPtr.Zero, data = IntPtr.Zero;
        try
        {
            if (handle == IntPtr.Zero || !OpenProcessToken(handle, 8, out token)) return false;
            uint size;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
            if (size == 0 || size > 4096) return false;
            data = Marshal.AllocHGlobal((int)size);
            if (!GetTokenInformation(token, 25, data, size, out size)) return false;
            IntPtr sid = Marshal.ReadIntPtr(data);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            return count != 0 && Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1)) == 8192;
        }
        finally
        {
            if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }

    public static Receipt Run()
    {
        var receipt = new Receipt { processId = Process.GetCurrentProcess().Id };
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            using (var form = new Form())
            using (var timer = new System.Windows.Forms.Timer())
            {
                form.Text = "Surtitle CI native input check";
                form.StartPosition = FormStartPosition.CenterScreen;
                form.ClientSize = new Size(360, 160);
                form.MaximizeBox = false;
                form.MinimizeBox = false;
                form.ShowInTaskbar = true;
                form.BackColor = Color.DarkSlateBlue;
                var clock = Stopwatch.StartNew();
                bool sent = false, pendingButtonDown = false;
                Point target = new Point();
                form.MouseUp += delegate(object sender, MouseEventArgs args) {
                    if (sent && args.Button == MouseButtons.Left) receipt.buttonUps++;
                };
                timer.Interval = 50;
                timer.Tick += delegate {
                    try
                    {
                        if (clock.ElapsedMilliseconds > 20000)
                            throw new TimeoutException("Owned native input check exceeded 20 seconds; foreground=" + GetForegroundWindow().ToInt64());
                        IntPtr window = form.Handle;
                        if (sent)
                        {
                            if (receipt.buttonUps == 0) return;
                            OwnPoint(window, target, window);
                            receipt.foregroundConfirmed = true;
                            receipt.passed = receipt.buttonUps == 1;
                            if (!receipt.passed) throw new InvalidOperationException("Expected exactly one native mouse-up.");
                            form.Close();
                            return;
                        }
                        IntPtr foreground = GetForegroundWindow();
                        // Ordinary local launchers retain normal owned-window
                        // activation by a click. A high foreground must first
                        // yield through the CI parent's verified handoff.
                        if (foreground != window && !MediumForeground(foreground)) return;
                        receipt.window = "0x" + window.ToInt64().ToString("X");
                        // Deliberately away from the initial desktop-center cursor.
                        System.Drawing.Point screen = form.PointToScreen(new System.Drawing.Point(48, 48));
                        target = new Point { X = screen.X, Y = screen.Y };
                        IdlePointer();
                        if (WindowFromPoint(target) != window)
                        {
                            // Expose only our own window without activating or
                            // moving it; wait for the Z-order acknowledgement.
                            if (!SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0x0010 | 0x0002 | 0x0001))
                                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not expose the owned smoke window");
                            return;
                        }
                        if (!SetCursorPos(target.X, target.Y)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Smoke SetCursorPos failed");
                        OwnPoint(window, target, foreground);
                        receipt.cursorConfirmed = true;
                        receipt.cursorX = target.X; receipt.cursorY = target.Y;
                        IdlePointer();
                        OwnPoint(window, target, foreground);
                        sent = true;
                        var input = new[] { new Input { Mouse = new MouseInput { Flags = 2 } }, new Input { Mouse = new MouseInput { Flags = 4 } } };
                        uint inserted = SendInput(2, input, Marshal.SizeOf(typeof(Input)));
                        receipt.inserted = inserted;
                        pendingButtonDown = inserted == 1;
                        if (inserted != 2) throw new Win32Exception(Marshal.GetLastWin32Error(), "Smoke SendInput did not insert both owned button events: " + inserted);
                    }
                    catch (Exception error)
                    {
                        receipt.error = error.Message;
                        var native = error as Win32Exception;
                        receipt.nativeErrorCode = native == null ? (int?)null : native.NativeErrorCode;
                        IntPtr foreground = GetForegroundWindow();
                        uint foregroundProcess;
                        GetWindowThreadProcessId(foreground, out foregroundProcess);
                        receipt.failureForegroundWindow = "0x" + foreground.ToInt64().ToString("X");
                        receipt.failureForegroundProcess = foregroundProcess;
                        if (pendingButtonDown)
                        {
                            try
                            {
                                // Complete only our partial down, while the same
                                // owned window still owns foreground and point.
                                OwnPoint(form.Handle, target, form.Handle);
                                var release = new[] { new Input { Mouse = new MouseInput { Flags = 4 } } };
                                uint released = SendInput(1, release, Marshal.SizeOf(typeof(Input)));
                                receipt.pendingButtonCleanup = released == 1 ? "released-owned-down" : "release-failed: " + Marshal.GetLastWin32Error();
                            }
                            catch (Exception cleanup) { receipt.pendingButtonCleanup = "refused: " + cleanup.Message; }
                        }
                        form.Close();
                    }
                };
                form.Shown += delegate { timer.Start(); };
                Application.Run(form);
                timer.Stop();
            }
        }
        finally { SetThreadDpiAwarenessContext(previous); }
        return receipt;
    }
}
