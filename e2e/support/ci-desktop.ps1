# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('inspect', 'apply', 'prepare-input')][string]$Action,
    [int]$ModeIndex = -1,
    [int]$Width,
    [int]$Height
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:CI -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'Desktop setup is restricted to GitHub-hosted Windows CI; local and self-hosted displays must not change.'
}
if ($Action -eq 'prepare-input') {
    $receipt = [ordered]@{ action = $Action; passed = $false }
    try {
        if (-not ('SurtitleCiDesktop' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'ci-desktop.cs') }
        $receipt = [SurtitleCiDesktop]::PrepareInputConsole()
    } catch {
        if (('SurtitleCiDesktop' -as [type]) -and [SurtitleCiDesktop]::LastInputConsoleReceipt) {
            $receipt = [SurtitleCiDesktop]::LastInputConsoleReceipt
        }
        $receipt.error = $_.Exception.Message
        throw
    } finally {
        $evidence = Join-Path (Get-Location).ProviderPath 'work/test-results/windows-input-console.json'
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($evidence)) | Out-Null
        $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidence -Encoding utf8
    }
    $receipt | ConvertTo-Json -Depth 8 -Compress
    return
}
if (-not ('SurtitleCiDesktop' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'ci-desktop.cs') }
if ($Action -eq 'apply') { [SurtitleCiDesktop]::Apply($ModeIndex, $Width, $Height) }
[SurtitleCiDesktop]::Inspect() | ConvertTo-Json -Depth 8 -Compress
