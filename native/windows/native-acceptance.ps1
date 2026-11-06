# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$Fixture,
    [Parameter(Mandatory)][string]$BuildReceipt,
    [Parameter(Mandatory)][string]$ProductionSmoke,
    [string]$Output = 'work/artifacts/native-acceptance/gpui-native-acceptance.json',
    [string]$AppId,
    [string]$ExternalEvidence,
    [switch]$DisposableProfile
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-uia-common.ps1')
. (Join-Path $PSScriptRoot 'production-uia-launch.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$identity = Get-Content -LiteralPath (Join-Path $workspace 'packaging/app.json') -Raw | ConvertFrom-Json
if (-not $AppId) { $AppId = $identity.identifier }
if ($AppId -ne $identity.identifier -and $AppId -notmatch '^app\.surtitle\.evaluation\.[a-z0-9]+$') { throw 'Unknown application identity.' }
Assert-ProbeContext $IsWindows @{CI=$env:CI;GITHUB_ACTIONS=$env:GITHUB_ACTIONS;RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT;RUNNER_OS=$env:RUNNER_OS} ([bool]$DisposableProfile) ([Environment]::GetFolderPath('LocalApplicationData')) $DataRoot $AppId
$Output = [IO.Path]::GetFullPath($Output, $workspace)
Assert-ProbePaths $workspace $Application $Output $identity.executable
$Application=(Resolve-Path -LiteralPath $Application).Path
$Fixture=(Resolve-Path -LiteralPath $Fixture).Path
$BuildReceipt=(Resolve-Path -LiteralPath $BuildReceipt).Path
$ProductionSmoke=(Resolve-Path -LiteralPath $ProductionSmoke).Path
Assert-NoProbeLinks $DataRoot
foreach ($inputPath in @($BuildReceipt,$ProductionSmoke)) { Assert-NoProbeLinks $inputPath }
$receipt = Get-Content -LiteralPath $BuildReceipt -Raw | ConvertFrom-Json
$smoke = Get-Content -LiteralPath $ProductionSmoke -Raw | ConvertFrom-Json
if ($receipt.schema -ne 1 -or $receipt.productionBuild -ne $true -or $receipt.executableSha256 -ine (Get-FileHash -LiteralPath $Application -Algorithm SHA256).Hash -or $smoke.executableSha256 -ine $receipt.executableSha256 -or $smoke.passed -ne $true -or $smoke.normalBuild -ne $true -or $smoke.paidRequests -ne 0) { throw 'Native acceptance requires matching successful production smoke and actual installed-binary provenance.' }
$revision = & git -C $workspace rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $receipt.sourceRevision -ne $revision.Trim() -or $receipt.installerSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Native acceptance build provenance must identify the current source revision and installer.' }
if ($ExternalEvidence) {
    $ExternalEvidence=(Resolve-Path -LiteralPath $ExternalEvidence).Path
    Assert-NoProbeLinks $ExternalEvidence
    $external=Get-Content -LiteralPath $ExternalEvidence -Raw | ConvertFrom-Json
    if ($external.suite -ne 'gpui-windows-external' -or $external.executableSha256 -ne $receipt.executableSha256 -or $external.installerSha256 -ne $receipt.installerSha256 -or $external.sourceRevision -ne $receipt.sourceRevision) { throw 'External observations must identify this exact binary, installer and source revision before native collection.' }
}
$directory = [IO.Path]::GetDirectoryName($Output)
if (Test-Path -LiteralPath $directory) { throw 'Native acceptance evidence directory must be fresh; previous observations are protected.' }
New-Item -ItemType Directory -Path $directory | Out-Null
$automated = Join-Path $directory 'gpui-native-automated.json'
$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'native-acceptance-worker.ps1'),
    '-Application',$Application,'-DataRoot',$DataRoot,'-Fixture',$Fixture,'-Output',$automated,'-AppId',$AppId,'-BuildReceipt',$BuildReceipt,'-ProductionSmoke',$ProductionSmoke)
if ($DisposableProfile) { $arguments += '-DisposableProfile' }
Invoke-OwnedUiaWorker $workspace $arguments $Output 300
$combineArguments = @('--combine',$automated,$BuildReceipt,$Output)
if ($ExternalEvidence) { $combineArguments += $ExternalEvidence }
& node (Join-Path $workspace 'scripts/check-native-acceptance.mjs') @combineArguments
if ($LASTEXITCODE -ne 0) { throw "Required GPUI native acceptance is incomplete; inspect $Output for each failed/not_run case." }
