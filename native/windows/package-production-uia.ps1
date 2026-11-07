# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$Fixture,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$BuildReceipt,
    [string]$AppId,
    [switch]$DisposableProfile
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-uia-common.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$identity = Get-Content -LiteralPath (Join-Path $workspace 'packaging/app.json') -Raw | ConvertFrom-Json
if (-not $AppId) { $AppId = $identity.identifier }
if ($AppId -ne $identity.identifier -and $AppId -notmatch '^app\.surtitle\.evaluation\.[a-z0-9]+$') { throw 'Unknown application identity.' }
$local = [Environment]::GetFolderPath('LocalApplicationData')
$environment = @{CI=$env:CI; GITHUB_ACTIONS=$env:GITHUB_ACTIONS; RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT; RUNNER_OS=$env:RUNNER_OS}
Assert-ProbeContext $IsWindows $environment ([bool]$DisposableProfile) $local $DataRoot $AppId
Assert-ProbePaths $workspace $Application $Output $identity.executable
$Application=(Resolve-Path -LiteralPath $Application).Path
$Fixture=(Resolve-Path -LiteralPath $Fixture).Path
$BuildReceipt=(Resolve-Path -LiteralPath $BuildReceipt).Path
Assert-SeededProfileSkeleton $DataRoot
$roaming = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $AppId
if ($roaming -ine $DataRoot -and (Test-Path -LiteralPath $roaming)) { throw 'An existing roaming profile is protected.' }
if ([IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') -ine $local.TrimEnd('\')) { throw 'LOCALAPPDATA must match the real known folder.' }
Assert-NoProbeLinks $BuildReceipt
$receipt = Get-Content -LiteralPath $BuildReceipt -Raw | ConvertFrom-Json
if ($receipt.schema -ne 1 -or $receipt.productionBuild -ne $true -or $receipt.command -ne 'cargo build --release --locked --package surtitle --no-default-features' -or
    $receipt.executableSha256 -ine (Get-FileHash -LiteralPath $Application -Algorithm SHA256).Hash) { throw 'Installed binary lacks a matching production build receipt.' }
$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'production-uia-worker.ps1'),
    '-Application',$Application,'-DataRoot',$DataRoot,'-Fixture',$Fixture,'-Output',$Output,'-AppId',$AppId,'-BuildReceipt',$BuildReceipt)
if ($DisposableProfile) { $arguments += '-DisposableProfile' }
. (Join-Path $PSScriptRoot 'production-uia-launch.ps1')
Invoke-OwnedUiaWorker $workspace $arguments $Output
$result = Get-Content -LiteralPath $Output -Raw | ConvertFrom-Json
if ($result.passed -ne $true -or $result.normalBuild -ne $true -or $result.paidRequests -ne 0) { throw 'Incomplete production smoke evidence.' }
