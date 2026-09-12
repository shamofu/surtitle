[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PluginPath,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
if ([Environment]::Is64BitProcess) { throw 'This test requires 32-bit Windows PowerShell for the i686 NSIS DLL.' }
$plugin = (Resolve-Path -LiteralPath $PluginPath).Path
if ((Get-FileHash -LiteralPath $plugin -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'Plugin hash mismatch before execution.' }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SurtitleNsisPluginSmoke {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string name, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void PluginCall(IntPtr window, int stringSize, IntPtr variables, ref IntPtr stack);
    static void Push(ref IntPtr stack, string value) {
        var memory = GlobalAlloc(0x40, new UIntPtr(2056));
        if(memory == IntPtr.Zero) throw new OutOfMemoryException();
        Marshal.WriteIntPtr(memory, stack);
        var characters = (value + "\0").ToCharArray();
        Marshal.Copy(characters, 0, IntPtr.Add(memory, IntPtr.Size), characters.Length);
        stack = memory;
    }
    static string Pop(ref IntPtr stack) {
        if(stack == IntPtr.Zero) throw new Exception("Missing NSIS result");
        var memory = stack;
        stack = Marshal.ReadIntPtr(memory);
        var value = Marshal.PtrToStringUni(IntPtr.Add(memory, IntPtr.Size));
        GlobalFree(memory);
        return value;
    }
    static void Check(IntPtr module, string name, string expected, params string[] values) {
        var stack = IntPtr.Zero;
        try {
            for(var index = values.Length - 1; index >= 0; index--) Push(ref stack, values[index]);
            var function = (PluginCall)Marshal.GetDelegateForFunctionPointer(GetProcAddress(module, name), typeof(PluginCall));
            function(IntPtr.Zero, 1024, IntPtr.Zero, ref stack);
            if(Pop(ref stack) != expected || stack != IntPtr.Zero) throw new Exception("Plugin result mismatch: " + name);
        } finally { while(stack != IntPtr.Zero) Pop(ref stack); }
    }
    public static int Run(string path) {
        var module = LoadLibraryExW(path, IntPtr.Zero, 0x100 | 0x800);
        if(module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            foreach(var name in new[]{"SemverCompare", "StrReplace", "FindProcess", "FindProcessCurrentUser", "KillProcess", "KillProcessCurrentUser", "RunAsUser"})
                if(GetProcAddress(module, name) == IntPtr.Zero) throw new Exception("Missing export: " + name);
            Check(module, "SemverCompare", "1", "1.2.1", "1.2.0");
            Check(module, "SemverCompare", "-1", "1.2.1-rc.1", "1.2.1");
            Check(module, "SemverCompare", "0", "invalid", "also-invalid");
            Check(module, "StrReplace", "日本語 & no, no.", "日本語 & yes, yes.", "yes", "no");
            return 4;
        } finally { FreeLibrary(module); }
    }
}
'@
$cases = [SurtitleNsisPluginSmoke]::Run($plugin)
if ((Get-FileHash -LiteralPath $plugin -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'Plugin changed during smoke.' }
$report = @{schemaVersion=1; sha256=$ExpectedSha256.ToLowerInvariant(); passed=$true; cases=$cases; architecture='i686'; scope='Exact DLL load, required exports, semantic version comparison and multilingual repeated-string replacement. Process mutation exports are checked for existence only.'}
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output "Plugin smoke passed: $cases cases; no installer or process-management functions were executed."
