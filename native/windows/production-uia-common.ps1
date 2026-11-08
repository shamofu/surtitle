# SPDX-License-Identifier: GPL-3.0-or-later
# Pure guards: dot sourcing this file never loads UIAutomation or starts a process.
function Assert-ProbeContext([bool]$Windows, [hashtable]$Environment, [bool]$Disposable, [string]$Local, [string]$DataRoot, [string]$AppId) {
    if (-not $Windows) { throw 'Production UIA requires Windows.' }
    $hosted = $Environment.CI -eq 'true' -and $Environment.GITHUB_ACTIONS -eq 'true' -and $Environment.RUNNER_ENVIRONMENT -eq 'github-hosted' -and $Environment.RUNNER_OS -eq 'Windows'
    if (-not $hosted -and -not $Disposable) { throw 'Use a hosted Windows runner or explicitly authorize a disposable Windows user profile.' }
    if ($AppId -notmatch '^[a-z][a-z0-9]*(\.[a-z0-9]+)+$') { throw 'Invalid application identity.' }
    $expected = [IO.Path]::GetFullPath((Join-Path $Local $AppId))
    if ([IO.Path]::GetFullPath($DataRoot).TrimEnd('\') -ine $expected.TrimEnd('\')) { throw 'Normal production builds must use the actual Windows known-folder profile.' }
}
function Assert-NoProbeLinks([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Probe paths must not traverse links.' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }; $current = $parent
    }
}
function Assert-ProbePaths([string]$Workspace, [string]$Application, [string]$Output, [string]$Executable) {
    $work = [IO.Path]::GetFullPath((Join-Path $Workspace 'work')) + [IO.Path]::DirectorySeparatorChar
    foreach ($path in @($Application, $Output)) {
        if (-not [IO.Path]::GetFullPath($path).StartsWith($work, [StringComparison]::OrdinalIgnoreCase)) { throw 'Probe application and evidence must remain inside workspace work/.' }
        Assert-NoProbeLinks $path
    }
    if ([IO.Path]::GetFileName($Application) -ine $Executable -or -not (Test-Path -LiteralPath $Application -PathType Leaf)) { throw 'Expected installed application executable.' }
    foreach ($evidence in @($Output, $Output + '.stdout.log', $Output + '.stderr.log')) {
        Assert-NoProbeLinks $evidence
        if (Test-Path -LiteralPath $evidence) { throw 'Existing probe evidence is protected.' }
    }
}
function Assert-SeededProfileSkeleton([string]$DataRoot) {
    Assert-NoProbeLinks $DataRoot
    if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) { throw 'Seed the disposable production profile first.' }
    $allowed = @('learning.sqlite','learning.sqlite-wal','learning.sqlite-shm','fixture.json')
    foreach ($item in Get-ChildItem -LiteralPath $DataRoot -Force) {
        if ($item.PSIsContainer -or $item.Name -notin $allowed -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Existing user state is protected; expected a freshly seeded profile.' }
    }
    foreach ($name in @('learning.sqlite','fixture.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $DataRoot $name) -PathType Leaf)) { throw 'Incomplete production fixture.' }
    }
}
