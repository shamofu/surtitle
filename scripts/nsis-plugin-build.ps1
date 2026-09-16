[CmdletBinding()]
param([string]$WorkDirectory = 'work/nsis-plugin-build')
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess -or $env:OS -ne 'Windows_NT') { throw 'Windows x64 is required.' }
$repository = Split-Path -Parent $PSScriptRoot
$work = [IO.Path]::GetFullPath((Join-Path $repository $WorkDirectory))
$pnpm = (Get-Command pnpm -ErrorAction Stop).Source
$packageManager = (Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json).packageManager
Push-Location -LiteralPath $repository
try {
    $pnpmVersion = (& $pnpm --version | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -ne 0 -or $packageManager -cne "pnpm@$pnpmVersion") { throw 'pnpm must match the repository packageManager pin.' }
} finally { Pop-Location }
$toolchain = (& rustc --print sysroot | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the installed Rust toolchain.' }
& python (Join-Path $PSScriptRoot 'nsis-plugin-build.py') prepare $work --toolchain $toolchain --pnpm-version $pnpmVersion
if ($LASTEXITCODE -ne 0) { throw 'Pinned plugin preparation failed.' }
$variables = @('CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTC', 'RUSTDOC', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'CARGO_TARGET_I686_PC_WINDOWS_MSVC_RUSTFLAGS')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:CARGO_HOME = Join-Path $work 'cargo-home'
    $env:CARGO_TARGET_DIR = Join-Path $work 'target'
    $env:RUSTC = Join-Path $toolchain 'bin/rustc.exe'
    $env:RUSTDOC = Join-Path $toolchain 'bin/rustdoc.exe'
    foreach ($name in @('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'CARGO_TARGET_I686_PC_WINDOWS_MSVC_RUSTFLAGS')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    $cargo = Join-Path $toolchain 'bin/cargo.exe'
    $manifest = Join-Path $work 'source/Cargo.toml'
    Push-Location -LiteralPath (Join-Path $work 'dependency-acquisition')
    try {
        $acquisitionVersion = (& $pnpm --version | Select-Object -Last 1).Trim()
        if ($LASTEXITCODE -ne 0 -or $acquisitionVersion -cne $pnpmVersion) { throw 'The isolated acquisition workspace selected a different pnpm version.' }
        & $pnpm install --frozen-lockfile --ignore-scripts 2>&1 | Tee-Object -FilePath (Join-Path $work 'logs/pnpm-install.log')
        if ($LASTEXITCODE -ne 0) { throw 'pnpm locked dependency acquisition failed.' }
        & python (Join-Path $PSScriptRoot 'nsis-plugin-build.py') verify-dependencies $work
        if ($LASTEXITCODE -ne 0) { throw 'pnpm changed the reviewed source or dependency lock.' }
        & $cargo vendor --respect-source-config --locked --offline --versioned-dirs (Join-Path $work 'vendor') > (Join-Path $work 'logs/vendor-config-generated.toml')
        if ($LASTEXITCODE -ne 0) { throw 'Offline vendoring of pnpm dependencies failed.' }
    } finally { Pop-Location }
    $vendorConfiguration = "[source.crates-io]`nreplace-with = `"vendored-sources`"`n[source.vendored-sources]`ndirectory = `"vendor`"`n"
    [IO.File]::WriteAllText((Join-Path $work 'vendor-config.toml'), $vendorConfiguration, [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path (Join-Path $work '.cargo') | Out-Null
    [IO.File]::WriteAllText((Join-Path $work '.cargo/config.toml'), $vendorConfiguration, [Text.UTF8Encoding]::new($false))
    # Cargo discovers configuration from cwd, not from --manifest-path.
    Push-Location -LiteralPath $work
    try {
        & $cargo metadata --locked --offline --format-version 1 --filter-platform i686-pc-windows-msvc --manifest-path $manifest > (Join-Path $work 'logs/cargo-metadata.json')
        if ($LASTEXITCODE -ne 0) { throw 'Locked dependency metadata capture failed.' }
        $flags = @('--sysroot', (Join-Path $work 'sysroot'), '-C', 'link-arg=/Brepro')
        $configuration = 'target.i686-pc-windows-msvc.rustflags = ' + (ConvertTo-Json -InputObject $flags -Compress)
        & $cargo build --release --frozen -p nsis-tauri-utils --target i686-pc-windows-msvc --manifest-path $manifest --config $configuration 2>&1 | Tee-Object -FilePath (Join-Path $work 'logs/build.log')
        if ($LASTEXITCODE -ne 0) { throw 'The offline plugin build failed.' }
    } finally { Pop-Location }
    $plugin = Join-Path $work 'target/i686-pc-windows-msvc/release/nsis_tauri_utils.dll'
    $hash = (Get-FileHash -LiteralPath $plugin -Algorithm SHA256).Hash
    & "$env:WINDIR/SysWOW64/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'nsis-plugin-smoke.ps1') -PluginPath $plugin -ExpectedSha256 $hash -OutputPath (Join-Path $work 'logs/plugin-smoke.json')
    if ($LASTEXITCODE -ne 0) { throw 'The actual i686 plugin smoke failed.' }
    & python (Join-Path $PSScriptRoot 'nsis-plugin-build.py') package $work
    if ($LASTEXITCODE -ne 0) { throw 'Plugin source/notice packaging failed.' }
} finally {
    foreach ($name in $variables) {
        if ($null -eq $previous[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
}
