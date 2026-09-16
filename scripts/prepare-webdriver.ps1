# SPDX-License-Identifier: GPL-3.0-or-later
# Download only a signed Microsoft driver with the same major/minor/build as WebView2.
param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../work/webdriver'), [switch]$InstallRuntime)
$ErrorActionPreference = 'Stop'
$destination = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$runtimeRoots = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft/EdgeWebView/Application'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft/EdgeWebView/Application')
)
function Find-Runtime {
  $runtimes = foreach ($runtimeRoot in $runtimeRoots) {
    if (Test-Path -LiteralPath $runtimeRoot) {
      Get-ChildItem -LiteralPath $runtimeRoot -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'msedgewebview2.exe')) }
    }
  }
  $runtimes | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
}
$runtime = Find-Runtime
if (-not $runtime -and $InstallRuntime) {
  if ($env:GITHUB_ACTIONS -ne 'true') { throw '-InstallRuntime is restricted to the isolated GitHub Actions runner.' }
  $bootstrapper = Join-Path $destination 'MicrosoftEdgeWebview2Setup.exe'
  Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrapper
  $signature = Get-AuthenticodeSignature -LiteralPath $bootstrapper
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') { throw 'Invalid Microsoft WebView2 installer signature.' }
  $setup = Start-Process -FilePath $bootstrapper -ArgumentList @('/silent','/install') -Wait -PassThru -WindowStyle Hidden
  if ($setup.ExitCode -ne 0) { throw "WebView2 runtime installation failed: $($setup.ExitCode)" }
  $runtime = Find-Runtime
}
if (-not $runtime) { throw 'Install Microsoft Edge WebView2 Runtime before preparing its matching driver.' }
$runtimeVersion = [version]$runtime.Name
$version = $runtime.Name
$build = "$($runtimeVersion.Major).$($runtimeVersion.Minor).$($runtimeVersion.Build)"
# Driver patch releases need not equal the runtime patch. Microsoft's supported
# contract is equality of the first three components, not merely the major.
$latest = Invoke-WebRequest -Uri "https://msedgedriver.microsoft.com/LATEST_RELEASE_$($runtimeVersion.Major)_WINDOWS"
$latestVersion = if ($latest.Content -is [byte[]]) { [Text.Encoding]::Unicode.GetString($latest.Content).Trim([char]0xFEFF).Trim() } else { ([string]$latest.Content).Trim([char]0xFEFF).Trim() }
if ($latestVersion -match '^\d+\.\d+\.\d+\.\d+$' -and $latestVersion.StartsWith($build + '.')) { $version = $latestVersion }
$url = "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip"
$archive = Join-Path $destination 'edgedriver.zip'
Invoke-WebRequest -Uri $url -OutFile $archive
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
$driver = Join-Path $destination 'msedgedriver.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $driver
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
  throw 'The downloaded driver did not have a valid Microsoft Authenticode signature.'
}
$driverVersion = (& $driver --version)
if ($LASTEXITCODE -ne 0 -or $driverVersion -notmatch ('\b' + [regex]::Escape($build) + '\.\d+\b')) { throw 'The driver major/minor/build did not match WebView2.' }
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
@{ runtimeVersion=$runtime.Name; driverVersion=$version; url=$url; sha256=(Get-FileHash -LiteralPath $driver -Algorithm SHA256).Hash; verifiedPublisher=$signature.SignerCertificate.Subject; runnerElevated=$elevated; launchMode='restricted-medium' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'receipt.json')
Write-Host "WebView2 runtime=$($runtime.Name) driver=$version runnerElevated=$elevated; WebDriver launches with restricted medium integrity."
Write-Output $driver
if ($env:GITHUB_ENV) { "SURTITLE_NATIVE_DRIVER=$driver" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8 }
