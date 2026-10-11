# Rebuilding from the published source ZIP

The source ZIP contains the application and its locked dependency sources,
including native and installer source archives. It has no `.git` directory;
Git metadata is not needed to build a local candidate. Supplied native source
archives live under `native-sources/`. The native manifest keeps the standard
`work/native-ci-artifact/` output paths so packaging a rebuilt candidate uses its
newly generated source archives.

Use Linux with Docker Buildx for native dependencies and Windows x64 with
MSVC/Windows SDK, PowerShell 7, Python, the Rust toolchain in `native/installer-inputs.json` and
Node from `.node-version` for the application. Install Rust before running pnpm.
The normal preparation commands acquire pinned upstream inputs and require
network access on their first run. A fully offline first build is not automated.

## Native dependencies

From a fresh extracted source directory, inspect the supplied source files and
build the native artifact:

```sh
docker buildx build --file native/build/Dockerfile --target export --provenance=false --output type=local,dest=work/native-ci-artifact .
```

The build exports `mpv-2.dll`, `libmpv-source.tar.gz`,
`onnxruntime-source.tar.gz` and informational build/source reports into a fresh
`work/native-ci-artifact/` directory. Docker caches complete native stages by their source and recipe
inputs. Add Buildx options, such as `--no-cache`, directly to the Docker command.

The libmpv recipe compiles the pinned source archives. Compiler packages and
intermediate build trees remain inside Docker. Compiler versions and PE
timestamps may change a rebuilt DLL's hash; runtime loading and artifact
consumption do not compare it with a recorded hash.
The ORT package retains the corresponding source and dependency reconstruction
for the pinned official CPU binary; this command does not compile a replacement
ORT runtime.

To inspect or adapt the supplied sources, start with the corresponding archives
under `native-sources/libmpv/` and `native-sources/onnxruntime/`. The libmpv archive
includes its source archives and build recipes. The ORT archive includes its
upstream tree and dependency inputs. Exercise application playback and VAD after
replacing a runtime, including when independently compiling ORT.

## Windows application

Use the same extracted working copy on Windows, including the exported
native files, then run:

```powershell
node native/build/native-ci-artifact.mjs consume work/native-ci-artifact
pnpm install --frozen-lockfile
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
pnpm tauri dev
```

Consumption stages the DLL and source archives in `work/native-ci-artifact/`
without changing the tracked runtime manifest. Preparation stages native DLLs
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
