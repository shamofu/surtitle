[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $workspace
$path = (Resolve-Path -LiteralPath $Installer).Path
$beforeHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
$destination = Join-Path $workspace ('work/installer-payload-audit-' + [Guid]::NewGuid().ToString('N'))
$cursor = [IO.Path]::GetDirectoryName($destination)
while ($cursor.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installer extraction must not traverse reparse points.' }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
}
if (Test-Path -LiteralPath $destination) { throw 'Installer audit extraction must be fresh.' }
$archiver = (Get-Command 7z.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $archiver x '-y' ('-o' + $destination) $path | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the exact installer payload.' }
if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Installer changed while extracting its payload.' }
& node scripts/native-installer-audit.mjs audit $path $destination
if ($LASTEXITCODE -ne 0) { throw 'The extracted installer payload does not match the prepared DLLs and notices.' }
