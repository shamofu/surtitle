# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('inspect', 'resize', 'resize-maximize', 'capture', 'monitor', 'move-monitor', 'snap-edge', 'close', 'maximize', 'restore')][string]$Action,
    [Parameter(Mandatory)][string]$Application,
    [int]$Width,
    [int]$Height,
    [string]$Screenshot,
    [long]$Monitor,
    [ValidateSet('left', 'right', 'top', 'bottom', 'top-left', 'bottom-right')][string]$Edge
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native window inspection requires Windows.' }
if (-not [IO.Path]::IsPathFullyQualified($Application) -or -not (Test-Path -LiteralPath $Application -PathType Leaf)) { throw 'Application must be an existing absolute executable path.' }
$expected = (Resolve-Path -LiteralPath $Application).ProviderPath
if ([IO.Path]::GetExtension($expected) -ine '.exe') { throw 'Application must be an executable.' }
$apps = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($expected)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expected -and $_.MainWindowHandle -ne [IntPtr]::Zero })
if ($apps.Count -ne 1) { throw "Expected exactly one window for the configured test executable, found $($apps.Count)." }
$window = $apps[0].MainWindowHandle
Add-Type -Path (Join-Path $PSScriptRoot 'native-window.cs')
if ($Action -in @('close', 'maximize', 'restore')) {
    [SurtitleNativeWindow]::SystemCommand($window, $Action)
    @{ requested = $Action } | ConvertTo-Json
    exit 0
}
if ($Action -eq 'monitor') {
    [SurtitleNativeWindow]::InspectMonitor($window) | ConvertTo-Json -Depth 6
    exit 0
}
if ($Action -eq 'move-monitor') {
    [SurtitleNativeWindow]::MoveToMonitor($window, $Monitor)
}
if ($Action -eq 'snap-edge') {
    [SurtitleNativeWindow]::SnapToEdge($window, $Edge)
}
if ($Action -in @('resize', 'resize-maximize')) {
    if ($Width -lt 1024 -or $Width -gt 8192 -or $Height -lt 700 -or $Height -gt 8192) { throw 'Client size must be within 1024..8192 by 700..8192 logical pixels.' }
    [SurtitleNativeWindow]::ResizeClient($window, $Width, $Height)
    if ($Action -eq 'resize-maximize') {
        [SurtitleNativeWindow]::SystemCommand($window, 'maximize')
    }
}
$geometry = [SurtitleNativeWindow]::Inspect($window)
if ($Action -eq 'capture') {
    $outputRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../test-results/native'))
    if (-not $Screenshot -or -not [IO.Path]::IsPathFullyQualified($Screenshot)) { throw 'Screenshot must have an absolute output path.' }
    $output = [IO.Path]::GetFullPath($Screenshot)
    if (-not $output.StartsWith($outputRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($output) -ine '.png') { throw 'Screenshot must be a PNG within test-results/native.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
    Add-Type -AssemblyName System.Drawing.Common
    $bounds = $geometry[0].screen
    $bitmap = [Drawing.Bitmap]::new($bounds.Right - $bounds.Left, $bounds.Bottom - $bounds.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $device = $graphics.GetHdc()
    try {
        # Ask only this application's window to render; never capture the wider desktop.
        if (-not [SurtitleNativeWindow]::PrintWindow($window, $device, 2)) { throw 'The application window could not be captured.' }
    } finally { $graphics.ReleaseHdc($device); $graphics.Dispose() }
    try { $bitmap.Save($output, [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
}
$geometry | ConvertTo-Json -Depth 6
