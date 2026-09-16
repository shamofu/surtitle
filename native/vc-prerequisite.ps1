[CmdletBinding()]
param([switch]$CheckOnly, [switch]$InstallWithConsent)
$ErrorActionPreference = 'Stop'
# NSIS can inherit PowerShell 7's module paths before starting Windows PowerShell.
# This checker uses only inbox cmdlets; resolve them against its own host version.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')

$minimum = [Version]'14.44.35211.0'
$downloadUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
    Write-Output 'The x64 Windows prerequisite checker must run in 64-bit Windows PowerShell.'
    exit 12
}
if ($CheckOnly -eq $InstallWithConsent) { Write-Output 'Choose check-only or explicitly consented installation.'; exit 12 }

function Test-MicrosoftSignature([string]$path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    return $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(^|,\s*)O=Microsoft Corporation(,|$)'
}
function Test-Prerequisite {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $key = $base.OpenSubKey('SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')
        if (-not $key) { return $false }
        try {
            if ($key.GetValue('Installed', 0) -ne 1) { return $false }
            $version = [Version](([string]$key.GetValue('Version', '')).TrimStart('v'))
            if ($version -lt $minimum) { return $false }
        } finally { $key.Dispose() }
    } finally { $base.Dispose() }
    foreach ($name in @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
        $path = Join-Path ([Environment]::GetFolderPath('System')) $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($path)
        $version = [Version]::new($info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart, $info.FilePrivatePart)
        if ($version -lt $minimum -or -not (Test-MicrosoftSignature $path)) { return $false }
    }
    return $true
}

try {
    if (Test-Prerequisite) { Write-Output 'Microsoft x64 VC Runtime prerequisite is installed and verified.'; exit 0 }
    if ($CheckOnly) { Write-Output 'Install Microsoft Visual C++ x64 Runtime 14.44.35211 or newer before starting Surtitle.'; exit 10 }
    # NSIS obtains explicit consent before passing this switch. The Microsoft
    # installer remains interactive so its own terms and UAC prompt are visible.
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('surtitle-vc-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $installer = Join-Path $temporary 'VC_redist.x64.exe'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $installer -MaximumRedirection 8 -TimeoutSec 180
        if (-not (Test-MicrosoftSignature $installer)) { throw 'The downloaded Microsoft installer signature is invalid.' }
        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer)
        $version = [Version]::new($info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart, $info.FilePrivatePart)
        if ($version -lt $minimum) { throw 'The downloaded Microsoft installer is older than the required version.' }
        $process = Start-Process -FilePath $installer -ArgumentList @('/install', '/norestart') -Verb RunAs -Wait -PassThru
        if ($process.ExitCode -eq 3010) { Write-Output 'Microsoft requires a restart. Restart Windows and run Surtitle Setup again.'; exit 13 }
        if ($process.ExitCode -notin @(0, 1638)) { throw ('Microsoft installation was cancelled or failed: ' + $process.ExitCode) }
        if (-not (Test-Prerequisite)) { throw 'The installed Microsoft prerequisite did not pass the version/signature check.' }
        Write-Output 'Microsoft x64 VC Runtime prerequisite is installed and verified.'
        exit 0
    } finally {
        # Remove only the two files/directories created by this invocation.
        if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force }
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
} catch {
    Write-Output ('VC prerequisite could not be verified or installed: ' + $_.Exception.Message + ' Install it directly from https://aka.ms/vs/17/release/vc_redist.x64.exe and retry. Offline setup requires the prerequisite to be installed already.')
    exit 11
}
