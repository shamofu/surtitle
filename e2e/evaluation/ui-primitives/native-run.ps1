# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param([switch]$Ime)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).ProviderPath
Set-Location -LiteralPath $workspace
$env:SURTITLE_E2E_BINARY = (Resolve-Path -LiteralPath 'work/ui-evaluation/native/bin/surtitle.exe').ProviderPath
$env:SURTITLE_E2E_DATA_DIR = (Resolve-Path -LiteralPath 'work/ui-evaluation/native/profile').ProviderPath
$env:SURTITLE_TAURI_DRIVER = (Resolve-Path -LiteralPath 'work/driver/bin/tauri-driver.exe').ProviderPath
$env:SURTITLE_NATIVE_DRIVER = (Resolve-Path -LiteralPath 'work/webdriver/msedgedriver.exe').ProviderPath
$env:SURTITLE_E2E_HARDWARE_RENDERING = '1'
$env:SURTITLE_WEBDRIVER_PORT = '4478'
$candidateSpec = if ($Ime) { 'native-ime.e2e.js' } else { 'native.e2e.js' }
& node e2e/support/run-native-e2e.mjs --spec "e2e/evaluation/ui-primitives/$candidateSpec"
exit $LASTEXITCODE
