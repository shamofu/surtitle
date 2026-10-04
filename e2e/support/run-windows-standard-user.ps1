# SPDX-License-Identifier: GPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Application,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ArgumentsBase64
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The standard-user launcher requires Windows and PowerShell 7.' }

if (-not [IO.Path]::IsPathFullyQualified($Application)) {
    if ($Application.IndexOfAny([char[]]'\/:') -ge 0) { throw 'Application must be an absolute executable path or a command name.' }
    $Application = @(Get-Command -Name $Application -CommandType Application -ErrorAction Stop)[0].Source
}
$applicationPath = [IO.Path]::GetFullPath($Application)
if ([IO.Path]::GetExtension($applicationPath) -ine '.exe' -or
    -not (Test-Path -LiteralPath $applicationPath -PathType Leaf)) {
    throw 'Application must resolve to an existing .exe file.'
}
$workingDirectory = (Get-Location).ProviderPath
if (-not $workingDirectory -or -not [IO.Directory]::Exists($workingDirectory)) {
    throw 'The working directory must be a filesystem directory.'
}

$utf8 = [Text.UTF8Encoding]::new($false, $true)
$argumentJson = $utf8.GetString([Convert]::FromBase64String($ArgumentsBase64))
# JsonDocument preserves the distinction between an array, a scalar and null.
$document = [Text.Json.JsonDocument]::Parse($argumentJson)
try {
    if ($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Array) {
        throw 'ArgumentsBase64 must encode a JSON array of strings.'
    }
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($element in $document.RootElement.EnumerateArray()) {
        if ($element.ValueKind -ne [Text.Json.JsonValueKind]::String) {
            throw 'Every application argument must be a string.'
        }
        $value = $element.GetString()
        if ($value.Contains([char]0)) { throw 'Application arguments cannot contain NUL.' }
        $arguments.Add($value)
    }
} finally {
    $document.Dispose()
}

Add-Type -Path (Join-Path $PSScriptRoot 'windows-standard-user.cs')
$exitCode = [SurtitleWindowsStandardUser]::Run($applicationPath, $arguments.ToArray(), $workingDirectory)
exit $exitCode
