# Rebuilding from the published source ZIP

The source ZIP contains the application and its locked dependency sources,
including native and installer source archives. It has no `.git` directory;
Git metadata is not needed to build a local candidate. Supplied native source
archives live under `native-sources/`. The native manifest keeps the standard
`work/native-ci-artifact/` output paths so packaging a rebuilt candidate uses its
newly generated source archives.

Use wslc or Linux with Docker Buildx for native dependencies and Windows x64 with
MSVC/Windows SDK, PowerShell 7, Python, the Rust toolchain in `native/installer-inputs.json` and
Node from `.node-version` for the application. Install Rust before running pnpm.
The normal preparation commands acquire pinned upstream inputs and require
network access on their first run. A fully offline first build is not automated.

## Native dependencies

From a fresh extracted source directory, inspect the supplied source files and
build the native artifact:

On Windows with wslc and PowerShell 7.4 or newer, stream the tar export into the new output directory:

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
New-Item -ItemType Directory -Path work/native-ci-artifact | Out-Null
wslc build --progress plain --file native/build/Dockerfile --target export --output type=tar,dest=- . |
  tar -xf - -C work/native-ci-artifact
```

With Docker Buildx:

```sh
docker buildx build --file native/build/Dockerfile --target export --provenance=false --output type=local,dest=work/native-ci-artifact .
```

The build exports `mpv-2.dll`, `libmpv-source.tar.gz`,
`onnxruntime-source.tar.gz` and informational build/source reports into a fresh
`work/native-ci-artifact/` directory. Use that output directly for Windows
preparation and packaging. Both backends cache native stages by their source and
recipe inputs; add `--no-cache` to the chosen build command when needed.

The libmpv recipe compiles the pinned source archives. Compiler packages and
intermediate build trees remain inside the container. Compiler versions and PE
timestamps may change a rebuilt DLL's hash; runtime loading does not compare it
with a recorded hash.
The ORT package retains the corresponding source and dependency reconstruction
for the pinned official CPU binary; this command does not compile a replacement
ORT runtime. Its required overlay port recipes and patches are extracted from
the same hash-verified ORT source archive; other ports come from the pinned
vcpkg baseline or selected historical port.

To inspect or adapt the supplied sources, start with the corresponding archives
under `native-sources/libmpv/` and `native-sources/onnxruntime/`. The libmpv archive
includes its source archives and build recipes. The ORT archive includes its
upstream tree and dependency inputs. Exercise application playback and VAD after
replacing a runtime, including when independently compiling ORT.

## Windows application

Use the same extracted working copy on Windows, including the exported
native files, then run:

```powershell
pnpm install --frozen-lockfile
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
pnpm tauri dev
```

The exported DLL and source archives stay in `work/native-ci-artifact/`.
Application commands use `work/target` for Rust builds, `work/dist` for the frontend and `work/artifacts` for distribution output. Use `pnpm rust` for additional Cargo commands so the same output default applies.
Preparation stages native DLLs
and notices and downloads the selected official ORT archive. The smoke check
loads the selected DLLs and initializes mpv/ORT. Windows application tests cover
playback and VAD; see [native runtime](../docs/native-runtime.md).

The top-level `vendor/` and `.cargo/config.toml` provide the locked Rust dependency
sources and portable source replacement. Save the supplied configuration if you
want to return to those sources after normal `pnpm install --frozen-lockfile`,
which acquires JavaScript and Rust dependencies and replaces the marked source
configuration. Restore that saved `.cargo/config.toml` in place; do not append it.
`javascript-packages/` retains the exact JavaScript dependency sources.

## Standard Tauri installer

From a fresh working copy with native resources prepared:

```powershell
python native/windows/native-installer-prepare.py
pnpm package:app
```

Preparation collects source archives and installer notices. Tauri obtains and
caches its standard NSIS tools and official `nsis_tauri_utils.dll` during the
build. `native-installer-sources/` in the published ZIP retains NSIS source,
the official plugin's source and locked source crates, and the application's
Rust runtime source. The app uses Tauri's standard installer
template and its VC Runtime prerequisite hook. Microsoft runtime installation
remains a separate prerequisite; see the [native guide](../docs/native-runtime.md#microsoft-prerequisites).

`native/windows/package-verify.ps1` assembles release assets from Git history and
therefore requires a Git checkout or CI checkout, rather than this extracted
ZIP. Run it only in a fresh CI runner or disposable Windows profile, following
the [native packaging guide](../docs/native-runtime.md#standard-tauri-installer).
Package testing uses the installer for fresh install, installed-app smoke, overwrite, uninstall
and learning-data retention checks. A local build does not establish completion
of those checks or hosted CI. Publication additionally requires the workflow's
Linux, Windows and package jobs plus the expected release files and successful
installer smoke. There are no runtime checksum or review-evidence gates.
