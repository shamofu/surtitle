# SPDX-License-Identifier: GPL-3.0-or-later
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'native-input-smoke.cs') -ReferencedAssemblies System.Windows.Forms, System.Drawing
$receipt = [SurtitleNativeInputSmoke]::Run()
$receipt | ConvertTo-Json -Compress
if (-not $receipt.passed) { exit 1 }
