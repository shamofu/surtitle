# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('inspect', 'apply')][string]$Action,
    [int]$ModeIndex = -1,
    [int]$Width,
    [int]$Height
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:CI -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'Desktop setup is restricted to GitHub-hosted Windows CI; local and self-hosted displays must not change.'
}
Add-Type -Path (Join-Path $PSScriptRoot 'ci-desktop.cs')
if ($Action -eq 'apply') { [SurtitleCiDesktop]::Apply($ModeIndex, $Width, $Height) }
[SurtitleCiDesktop]::Inspect() | ConvertTo-Json -Depth 8 -Compress
