# Rebuilding from the published source ZIP

The source ZIP contains the application and its locked dependency sources,
including native and installer source archives. It has no `.git` directory;
Git metadata is not needed to build a local candidate. The included native
manifest refers to the source files shipped in that ZIP.

Use Linux with Docker Buildx for native dependencies and Windows x64 with
MSVC/Windows SDK, PowerShell 7, Python, the Rust toolchain in `package.json` and
Node from `.node-version` for the application. Install Rust before running pnpm.
The normal preparation commands acquire pinned upstream inputs and require
network access on their first run. A fully offline first build is not automated.

## Native dependencies

From a fresh extracted source directory, inspect the supplied source files and
build the native artifact:

```sh
node scripts/native-ci-artifact.mjs verify-source .
bash scripts/native-ci-build.sh
```

The build exports six files into a fresh `work/native-ci-artifact/` directory:
`mpv-2.dll`, `libmpv-source.tar.gz`, `onnxruntime-source.tar.gz`,
`libmpv-build-evidence.json`, `onnxruntime-source-inventory.json` and
`SHA256SUMS.txt`. Docker caches complete native stages by their source and recipe
inputs. The wrapper also accepts Buildx options, such as `--no-cache`.

The libmpv recipe compiles the pinned source archives. Compiler packages and
intermediate build trees remain inside Docker. Compiler versions and PE
timestamps may change a rebuilt DLL's hash; consumption records that new hash.
The ORT package retains the corresponding source and dependency reconstruction
for the pinned official CPU binary; this command does not compile a replacement
ORT runtime.

To inspect or adapt the supplied sources, start with the corresponding archives
under `native-sources/libmpv/` and `native-sources/onnxruntime/`. The libmpv archive
includes its source archives and build recipes. The ORT archive includes its
upstream tree, dependency inputs and comparison recipes. Independently compiling
ORT requires new runtime hashes, source evidence and application validation.

## Windows application

Use the same extracted working copy on Windows, including the six exported
native files, then run:

```powershell
node scripts/native-ci-artifact.mjs consume work/native-ci-artifact
pnpm install --frozen-lockfile
pwsh -File scripts/native-prepare.ps1
pwsh -File scripts/native-smoke.ps1
pnpm tauri dev
```

Consumption verifies the export and updates the local manifest's DLL and source
paths/hashes. Preparation stages native DLLs and notices and downloads the pinned
official ORT archive. The smoke check loads the selected DLLs and initializes
mpv/ORT. Native and Windows application checks must be repeated for a changed
runtime before redistribution; see [native runtime](../docs/native-runtime.md).

The top-level `vendor/` and `.cargo/config.toml` provide the locked Rust dependency
sources and portable source replacement. Save the supplied configuration if you
want to return to those sources after normal `pnpm install --frozen-lockfile`,
which acquires JavaScript and Rust dependencies and replaces the marked source
configuration. Restore that saved `.cargo/config.toml` in place; do not append it.
`javascript-packages/` retains the exact JavaScript dependency sources.

## Standard Tauri installer

From a fresh working copy with native resources prepared:

```powershell
python scripts/native-installer-prepare.py
pnpm package:app
# Only on a fresh CI runner or disposable Windows profile:
pwsh -File scripts/package-verify.ps1
```

Preparation collects source archives and installer notices. Tauri obtains and
caches its standard NSIS tools and official `nsis_tauri_utils.dll` during the
build. `native-installer-sources/` in the published ZIP retains NSIS source,
the official plugin's source and locked source crates, and the application's
Rust runtime source. The app uses Tauri's standard installer
template and its VC Runtime prerequisite hook. Microsoft runtime installation
remains a separate prerequisite; see the [native guide](../docs/native-runtime.md#microsoft-prerequisites).

Package verification extracts the installer once, checks the payload, and uses
that same installer for fresh install, installed-app smoke, overwrite, uninstall
and learning-data retention checks. A local build does not establish completion
of those checks or hosted CI. Publication additionally requires the workflow's
Linux, Windows and package jobs plus source and asset verification.
