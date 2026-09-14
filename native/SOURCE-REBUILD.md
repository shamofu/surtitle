# Rebuilding from the published source ZIP

The source ZIP intentionally has no `.git` directory. Its effective native
manifest describes the binaries in that release. The steps below build a new
local candidate without inventing a commit or requiring those old binary hashes.
The separate same-commit release workflow still requires a real Git checkout and
all release tests; these instructions do not grant release approval.

Use Linux with Docker and an x86_64 Windows development environment with Rust
1.98.0, MSVC/Windows SDK, Node 24, pnpm 12.3.4 and PowerShell 7. Building the Docker
image acquires the compiler packages from Ubuntu; the subsequent native build
uses the source archives supplied in the ZIP. No host dependency/build directory
or named volume is mounted into the native builder.

## Build libmpv from the supplied archives

From the extracted ZIP's root in Linux, run these commands. The fixed container
name and output directory must not already exist.

```sh
docker build -f native/build/Dockerfile -t surtitle-source-builder .
docker create --name surtitle-source-rebuild surtitle-source-builder sleep infinity
docker start surtitle-source-rebuild
docker inspect --format '{{json .Mounts}}' surtitle-source-rebuild
# The preceding result must be []. Stop if it is not.
docker cp native-sources/libmpv/correspondingSource-libmpv-source.tar.gz surtitle-source-rebuild:/source-kit.tar.gz
docker exec surtitle-source-rebuild mkdir -p /source-kit /build/source-cache
docker exec surtitle-source-rebuild tar -xzf /source-kit.tar.gz -C /source-kit
docker exec surtitle-source-rebuild cp -r /source-kit/archives/. /build/source-cache/
docker exec surtitle-source-rebuild python3 /workspace/scripts/native-source-inputs.py /workspace /build/sources /build/source-cache
docker network disconnect bridge surtitle-source-rebuild
docker exec surtitle-source-rebuild bash /workspace/scripts/native-build.sh /workspace /build
docker exec surtitle-source-rebuild python3 /workspace/scripts/native-build-evidence.py /workspace /build /out/native-build
mkdir -p work/source-rebuild/runtime
docker cp surtitle-source-rebuild:/out/native-build/runtime/mpv-2.dll work/source-rebuild/runtime/mpv-2.dll
docker cp surtitle-source-rebuild:/out/native-build/libmpv-candidate-source.tar.gz work/source-rebuild/libmpv-candidate-source.tar.gz
docker cp surtitle-source-rebuild:/out/native-build/build-evidence.json work/source-rebuild/build-evidence.json
docker rm --force surtitle-source-rebuild
```

Only the final DLL, corresponding-source archive and evidence are exported.
Compiler packages, downloaded archives and intermediate build trees remain in
the removed container. Compiler versions and PE timestamps can change the DLL
hash; the resulting hash is recorded rather than compared with the old release.

## Prepare the local manifest and application

Use a separate extracted working copy for this local candidate. On Windows,
restore the effective manifest's source references to the files actually shipped
in the ZIP, then replace only libmpv's build-derived fields:

```powershell
$manifest = Get-Content native/runtime-windows-x64.json -Raw | ConvertFrom-Json
function Sha256($path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
foreach ($component in $manifest.components) {
    foreach ($field in @('correspondingSource','dependencyInventory','reviewEvidence')) {
        $files = @(Get-ChildItem -LiteralPath ("native-sources/" + $component.id) -Filter ($field + '-*') -File)
        if ($files.Count -ne 1) { throw "Missing or ambiguous source evidence: $($component.id)/$field" }
        $component.redistribution.$field.path = "native-sources/$($component.id)/$($files[0].Name)"
        $component.redistribution.$field.sha256 = Sha256 $files[0].FullName
    }
}
$mpv = $manifest.components | Where-Object id -EQ 'libmpv'
$mpv.version = '0.41.0-local-source-rebuild'
$mpv.localRuntimePath = 'work/source-rebuild/runtime'
$mpv.runtimeFiles[0].sha256 = Sha256 'work/source-rebuild/runtime/mpv-2.dll'
$mpv.redistribution.correspondingSource.path = 'work/source-rebuild/libmpv-candidate-source.tar.gz'
$mpv.redistribution.correspondingSource.sha256 = Sha256 $mpv.redistribution.correspondingSource.path
$mpv.redistribution.dependencyInventory.path = 'work/source-rebuild/build-evidence.json'
$mpv.redistribution.dependencyInventory.sha256 = Sha256 $mpv.redistribution.dependencyInventory.path
$mpv.redistribution.status = 'pending'
$mpv.redistribution.reason = 'Locally rebuilt candidate; repeat native/Windows/installer checks before redistribution.'
$manifest.PSObject.Properties.Remove('buildBinding')
$manifest | ConvertTo-Json -Depth 50 | Set-Content native/runtime-windows-x64.json -Encoding utf8NoBOM
pwsh scripts/native-prepare.ps1
pwsh scripts/native-smoke.ps1
pnpm install --frozen-lockfile
pnpm tauri dev
```

`native-prepare.ps1` downloads the fixed official ORT CPU binary identified by
the manifest. The ZIP also supplies ORT's complete source, exact dependency
archives/ports and comparison recipes in
`native-sources/onnxruntime/correspondingSource-onnxruntime-source.tar.gz`. Its
included README describes the source/header reconstruction. To rebuild ORT
itself, start with that archive's complete upstream ORT tree and its `build.py`
and CMake instructions; an independently built ORT DLL requires new native
hashes, import checks and VAD/application tests.

The top-level `vendor/` and `vendor-config.toml` contain the application's locked
Rust dependency sources. Copy the source replacement configuration into a local
`.cargo/config.toml` in this extracted copy to build with the supplied Rust
sources. `javascript-packages/` retains the exact JavaScript dependency sources;
the lockfile controls normal pnpm dependency acquisition. The source ZIP also
includes the exact Rust standard-library source and notices in
`native-installer-sources/rust-runtime-source.tar.gz`.

## Rebuild the installer utility and NSIS package

The NSIS utility has its own lockfile and repository-local i686 sysroot recipe:

```powershell
pwsh scripts/nsis-plugin-build.ps1
pwsh scripts/native-installer-prepare.ps1
pnpm tauri build --bundles nsis '--' --locked
pwsh scripts/native-installer-audit.ps1 -Installer (Get-ChildItem target/release/bundle/nsis/*.exe).FullName
```

The utility recipe reacquires pinned compiler/source inputs and locked crates;
`native-installer-sources/nsis-plugin-source.tar.gz` includes its original source,
complete vendor tree, lockfile and recipes for offline crate rebuilding. The
exact NSIS 3.11 source archive is supplied alongside it. The official NSIS tools
remain a build prerequisite. No Microsoft runtime is bundled; the app uses the
separately installed runtime described in [native-runtime.md](../docs/native-runtime.md).

The local rebuild remains ineligible for the project's automated release until
its source/notice review, fresh Windows tests and isolated installer lifecycle
are complete. Do not change pinned dependency hashes to match unexpected output,
or insert a synthetic Git SHA/Actions run identity to make a release gate pass.
The CI verifier reads original inputs from a separate checkout at the selected
commit. An extracted source ZIP does not need its own `.git` or a generated
review ledger to build a local candidate.
