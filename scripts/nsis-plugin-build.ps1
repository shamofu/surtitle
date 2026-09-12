[CmdletBinding()]
param([string]$WorkDirectory = 'work/nsis-plugin-build')
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess -or $env:OS -ne 'Windows_NT') { throw 'Windows x64 is required.' }
$repository = Split-Path -Parent $PSScriptRoot
$work = [IO.Path]::GetFullPath((Join-Path $repository $WorkDirectory))
$toolchain = (& rustc --print sysroot | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the installed Rust toolchain.' }
& python (Join-Path $PSScriptRoot 'nsis-plugin-build.py') prepare $work --toolchain $toolchain
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
    & $cargo fetch --locked --manifest-path $manifest 2>&1 | Tee-Object -FilePath (Join-Path $work 'logs/fetch.log')
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency acquisition failed.' }
    & $cargo vendor --locked --offline --versioned-dirs --manifest-path $manifest (Join-Path $work 'vendor') > (Join-Path $work 'logs/vendor-config-generated.toml')
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency vendoring failed.' }
    $vendorConfiguration = "[source.crates-io]`nreplace-with = `"vendored-sources`"`n[source.vendored-sources]`ndirectory = `"vendor`"`n"
    [IO.File]::WriteAllText((Join-Path $work 'vendor-config.toml'), $vendorConfiguration, [Text.UTF8Encoding]::new($false))
    & $cargo metadata --locked --offline --format-version 1 --filter-platform i686-pc-windows-msvc --manifest-path $manifest > (Join-Path $work 'logs/cargo-metadata.json')
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency metadata capture failed.' }
    $flags = @('--sysroot', (Join-Path $work 'sysroot'), '-C', 'link-arg=/Brepro')
    $configuration = 'target.i686-pc-windows-msvc.rustflags = ' + (ConvertTo-Json -InputObject $flags -Compress)
    & $cargo build --release --frozen -p nsis-tauri-utils --target i686-pc-windows-msvc --manifest-path $manifest --config $configuration 2>&1 | Tee-Object -FilePath (Join-Path $work 'logs/build.log')
    if ($LASTEXITCODE -ne 0) { throw 'The offline plugin build failed.' }
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
