[CmdletBinding()]
param([string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This native loader smoke test requires Windows x64.'
}
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = if ($RuntimeDirectory) { [IO.Path]::GetFullPath($RuntimeDirectory) } else { Join-Path $repoRoot 'src-tauri/resources/native' }
if (-not $runtime.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Native smoke directory must be inside the workspace.' }
# Verify the complete expected set before allowing executable native code to load.
& node (Join-Path $PSScriptRoot 'native-audit.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Native artifact verification failed' }
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'native/runtime-windows-x64.json') -Raw | ConvertFrom-Json
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'native/vc-prerequisite.ps1') -CheckOnly
if ($LASTEXITCODE -ne 0) { throw 'Install the separately managed Microsoft VC x64 Runtime prerequisite before native execution. This check does not install it.' }
foreach ($file in $manifest.components.runtimeFiles) {
    if ((Get-FileHash -LiteralPath (Join-Path $runtime $file.target) -Algorithm SHA256).Hash -ne $file.sha256) { throw "Installed native hash mismatch: $($file.target)" }
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class SurtitleNativeSmoke {
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibraryExW(string path, IntPtr reserved, uint flags);
    [DllImport("kernel32", CharSet = CharSet.Ansi, SetLastError = true)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetModuleFileNameW(IntPtr module, StringBuilder path, int capacity);
    [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate ulong ApiVersion();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr PointerCall();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Initialize(IntPtr context);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void Destroy(IntPtr context);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Option(IntPtr context, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, [MarshalAs(UnmanagedType.LPUTF8Str)] string value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr Property(IntPtr context, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void Free(IntPtr memory);
    static T Symbol<T>(IntPtr module, string name) where T : Delegate {
        var ptr = GetProcAddress(module, name);
        if (ptr == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Missing export " + name);
        return Marshal.GetDelegateForFunctionPointer<T>(ptr);
    }
    public static Dictionary<string, object> Run(string directory, string[] expectedFiles) {
        var handles = new Dictionary<string, IntPtr>(StringComparer.OrdinalIgnoreCase);
        var loaded = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var order = new List<IntPtr>();
        IntPtr mpv = IntPtr.Zero;
        Destroy destroy = null;
        try {
            // Load optional runtimes by full path before their users. DLL search
            // is restricted to the verified app-local directory and System32.
            string[] priority = { "vulkan-1.dll" };
            var files = new List<string>();
            foreach (var file in priority) if (Array.Exists(expectedFiles, name => String.Equals(name, file, StringComparison.OrdinalIgnoreCase))) files.Add(file);
            foreach (var file in expectedFiles) if (!files.Contains(file)) files.Add(file);
            foreach (var file in files) {
                var path = Path.GetFullPath(Path.Combine(directory, file));
                var module = LoadLibraryExW(path, IntPtr.Zero, 0x00000100 | 0x00000800);
                if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot load " + path);
                order.Add(module);
                var actual = new StringBuilder(32768);
                if (GetModuleFileNameW(module, actual, actual.Capacity) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!String.Equals(Path.GetFullPath(actual.ToString()), path, StringComparison.OrdinalIgnoreCase)) throw new Exception("Loaded non-local module: " + actual);
                handles[file] = module;
                loaded[file] = actual.ToString();
            }
            var mpvLibrary = handles["mpv-2.dll"];
            ulong api = Symbol<ApiVersion>(mpvLibrary, "mpv_client_api_version")();
            mpv = Symbol<PointerCall>(mpvLibrary, "mpv_create")();
            if (mpv == IntPtr.Zero) throw new Exception("mpv_create failed");
            destroy = Symbol<Destroy>(mpvLibrary, "mpv_terminate_destroy");
            var setOption = Symbol<Option>(mpvLibrary, "mpv_set_option_string");
            foreach (var pair in new string[][] { new[] {"config", "no"}, new[] {"ytdl", "no"}, new[] {"terminal", "no"}, new[] {"vo", "null"}, new[] {"ao", "null"} }) {
                int result = setOption(mpv, pair[0], pair[1]);
                if (result < 0 && !(pair[0] == "ytdl" && result == -5)) throw new Exception("mpv option failed: " + pair[0] + " " + result);
            }
            int initialized = Symbol<Initialize>(mpvLibrary, "mpv_initialize")(mpv);
            if (initialized < 0) throw new Exception("mpv_initialize failed: " + initialized);
            var get = Symbol<Property>(mpvLibrary, "mpv_get_property_string");
            var free = Symbol<Free>(mpvLibrary, "mpv_free");
            string ReadProperty(string name) {
                var ptr = get(mpv, name);
                if (ptr == IntPtr.Zero) throw new Exception("Cannot read mpv property " + name);
                try { return Marshal.PtrToStringUTF8(ptr); } finally { free(ptr); }
            }
            var ortBase = Symbol<PointerCall>(handles["onnxruntime.dll"], "OrtGetApiBase")();
            if (ortBase == IntPtr.Zero) throw new Exception("OrtGetApiBase failed");
            var ortVersionCall = Marshal.GetDelegateForFunctionPointer<PointerCall>(Marshal.ReadIntPtr(ortBase, IntPtr.Size));
            var ortVersion = Marshal.PtrToStringUTF8(ortVersionCall());
            return new Dictionary<string, object> {
                {"loadedFiles", loaded}, {"mpvApiVersion", api}, {"mpvVersion", ReadProperty("mpv-version")},
                {"ffmpegVersion", ReadProperty("ffmpeg-version")}, {"onnxruntimeVersion", ortVersion},
                {"mpvInitialized", true}, {"realVideoSurfaceTested", false}, {"sileroInferenceTested", false}
            };
        } finally {
            if (mpv != IntPtr.Zero && destroy != null) destroy(mpv);
            for (int i = order.Count - 1; i >= 0; i--) FreeLibrary(order[i]);
        }
    }
}
'@
$files = @($manifest.components.runtimeFiles | ForEach-Object { $_.target })
$result = [SurtitleNativeSmoke]::Run($runtime, $files)
$result['sha'] = $env:GITHUB_SHA
$result['testedAt'] = [DateTime]::UtcNow.ToString('o')
$result['releaseEligible'] = $false
$artifactDirectory = Join-Path $repoRoot 'artifacts'
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$json = $result | ConvertTo-Json -Depth 5
$json | Set-Content -LiteralPath (Join-Path $artifactDirectory 'native-smoke.json') -Encoding utf8
Write-Host $json
