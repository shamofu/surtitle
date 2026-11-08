# SPDX-License-Identifier: GPL-3.0-or-later
# Shared bounded launcher, called only after the entry point's profile/path guards.
function Invoke-OwnedUiaWorker([string]$Workspace, [string[]]$Arguments, [string]$Output, [int]$TimeoutSeconds = 180) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Arguments -Compress)))
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $start = [Diagnostics.ProcessStartInfo]::new('pwsh')
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile','-NonInteractive','-File',(Join-Path $Workspace 'e2e/support/run-windows-standard-user.ps1'),'-Application',$windowsPowerShell,'-ArgumentsBase64',$encoded)) { $start.ArgumentList.Add($argument) }
    $start.WorkingDirectory = $Workspace
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    try {
        # The outer deadline includes stuck COM provider calls. The existing
        # standard-user launcher owns the worker's kill-on-close process job.
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $process.Kill($true); throw "Native UIA exceeded its $TimeoutSeconds-second watchdog." }
        if ($process.ExitCode -ne 0) { throw "Native UIA worker failed (exit $($process.ExitCode)); inspect $Output.stderr.log." }
    } finally {
        if (-not $process.HasExited) { $process.Kill($true); $null = $process.WaitForExit(5000) }
        $outText = if ($stdout.Wait(5000)) { $stdout.GetAwaiter().GetResult() } else { 'Output pipe did not close after worker termination.' }
        $errText = if ($stderr.Wait(5000)) { $stderr.GetAwaiter().GetResult() } else { 'Error pipe did not close after worker termination.' }
        [IO.File]::WriteAllText($Output + '.stdout.log', $outText)
        [IO.File]::WriteAllText($Output + '.stderr.log', $errText)
        $process.Dispose()
    }
}
