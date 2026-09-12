[CmdletBinding()]
param([Parameter(Mandatory)][string]$CandidateDirectory)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Candidate loading requires Windows.' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$candidate = (Resolve-Path -LiteralPath $CandidateDirectory).Path
if (-not $candidate.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate must stay inside the workspace.' }
$evidence = Get-Content -LiteralPath (Join-Path $candidate 'build-evidence.json') -Raw | ConvertFrom-Json
$dll = Join-Path $candidate 'runtime/mpv-2.dll'
if ($evidence.status -ne 'candidate-needs-review' -or $evidence.runtime.file -ne 'mpv-2.dll' -or (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -ne $evidence.runtime.sha256) { throw 'Candidate integrity verification failed.' }
$source = Join-Path $candidate $evidence.correspondingSourceCandidate.file
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $evidence.correspondingSourceCandidate.sha256) { throw 'Candidate source bundle changed.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class SurtitleCandidateSmoke {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string path, IntPtr reserved, uint flags);
  [DllImport("kernel32", CharSet=CharSet.Ansi, SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetModuleFileNameW(IntPtr module, StringBuilder path, int capacity);
  [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr Create();
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Initialize(IntPtr context);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void Destroy(IntPtr context);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int Option(IntPtr context, [MarshalAs(UnmanagedType.LPUTF8Str)] string key, [MarshalAs(UnmanagedType.LPUTF8Str)] string value);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr Property(IntPtr context, [MarshalAs(UnmanagedType.LPUTF8Str)] string key);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void Free(IntPtr value);
  static T Symbol<T>(IntPtr module, string name) where T: Delegate {
    var value=GetProcAddress(module,name); if(value==IntPtr.Zero) throw new Exception("Missing export "+name);
    return Marshal.GetDelegateForFunctionPointer<T>(value);
  }
  public static Dictionary<string,object> Run(string path) {
    var module=LoadLibraryExW(path,IntPtr.Zero,0x00000100|0x00000800);
    if(module==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot load candidate");
    IntPtr context=IntPtr.Zero; Destroy destroy=null;
    try {
      var actual=new StringBuilder(32768); GetModuleFileNameW(module,actual,actual.Capacity);
      if(!String.Equals(path,actual.ToString(),StringComparison.OrdinalIgnoreCase)) throw new Exception("Candidate path changed");
      context=Symbol<Create>(module,"mpv_create")(); if(context==IntPtr.Zero) throw new Exception("mpv_create failed");
      destroy=Symbol<Destroy>(module,"mpv_terminate_destroy");
      var option=Symbol<Option>(module,"mpv_set_option_string");
      // The candidate omits Lua and therefore has no ytdl script option.
      foreach(var pair in new string[][] {new[]{"config","no"},new[]{"vo","null"},new[]{"ao","null"}})
        if(option(context,pair[0],pair[1])<0) throw new Exception("Option failed "+pair[0]);
      if(Symbol<Initialize>(module,"mpv_initialize")(context)<0) throw new Exception("mpv_initialize failed");
      var get=Symbol<Property>(module,"mpv_get_property_string"); var free=Symbol<Free>(module,"mpv_free");
      string Read(string key) {var value=get(context,key); if(value==IntPtr.Zero) throw new Exception("Missing property "+key); try{return Marshal.PtrToStringUTF8(value);}finally{free(value);}}
      return new Dictionary<string,object>{{"mpvVersion",Read("mpv-version")},{"ffmpegVersion",Read("ffmpeg-version")},{"loadedPath",actual.ToString()},{"mpvInitialized",true},{"videoRendered",false},{"codecCoverageTested",false},{"releaseEligible",false}};
    } finally {if(context!=IntPtr.Zero && destroy!=null) destroy(context); FreeLibrary(module);}
  }
}
'@
$result = [SurtitleCandidateSmoke]::Run($dll)
$result['sha256'] = $evidence.runtime.sha256
$result['testedAt'] = [DateTime]::UtcNow.ToString('o')
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $candidate 'windows-load-smoke.json') -Encoding utf8
$result | ConvertTo-Json -Depth 5
