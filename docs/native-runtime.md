# Native runtime and packaging

The Windows x64 payload contains source-built `mpv-2.dll` and official CPU ONNX Runtime DLLs (`onnxruntime.dll`, `onnxruntime_providers_shared.dll`). [The runtime manifest](../native/runtime-windows-x64.json) selects their paths, notices, corresponding libmpv source archive, and prerequisites. CLI FFmpeg/ffprobe and Silero remain separate managed downloads.

## Dependency inputs and updates

| Input | Authoritative definition |
| --- | --- |
| mpv, FFmpeg, dav1d and other libmpv sources | [sources.json](../native/build/sources.json): repository, ref, fixed commit, archive SHA-256 and child destinations. Acquisition derives URLs and filenames. |
| Official ORT runtime, libmpv location, notices, Silero and VC Runtime | [runtime-windows-x64.json](../native/runtime-windows-x64.json). libmpv `sourceId` refers to the source catalog; its display version is not a second source selector. |
| Rust toolchain and compiler minimum | [rust-toolchain.toml](../rust-toolchain.toml) and `rust-version` in [Cargo.toml](../Cargo.toml). |

For mpv/FFmpeg updates, change the ref, commit and source hash together, including changed child sources. For ORT, update its official runtime URL/member paths and notices. Silero version, commit, URL, model/notice hashes and VC Runtime minimum/URL/files belong in the runtime manifest. Generated Rust model constants are not committed.

Source-download pins identify acquired inputs. Rebuilt runtime DLLs are not hash acceptance gates. Preserve FFmpeg's explicit D3D11VA/DXVA2 configuration and decoder checks; verify extraction separately from hardware playback because the managed FFmpeg CLI and libmpv's libraries are different builds. Runtime/model updates also need playback, VAD/chunk boundaries, cancellation and source/sample coverage checks; a version number or timing result is insufficient.

The pinned mpv source receives a [private composition bridge](../native/build/patches/mpv-owned-composition-swapchain.patch). It transfers one owned `IDXGISwapChain1` reference under mpv's playback core lock, without waiting for the video render thread. The pin publishes the swapchain before its initialization barrier and releases it only during core-protected teardown; recheck these invariants when updating mpv. The public borrowed `display-swapchain` property is unsafe for this handoff. The installed upstream client API stays unchanged. Rebuild and prepare the native runtime when this patch changes; the build recipe and libmpv corresponding-source archive both retain it.

## Build and prepare native inputs

Run from the repository root with a fresh `work/native-ci-artifact/` output directory and regular, non-symlink ancestors. Select the backend locally. With wslc, export a tar file and extract it; this avoids redirecting the build client's binary output through a terminal or PowerShell pipeline:

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
New-Item -ItemType Directory -Path work/native-ci-artifact | Out-Null
wslc build --progress plain --file native/build/Dockerfile --target export --output type=tar,dest=work/native-ci-artifact.tar .
tar -xf work/native-ci-artifact.tar -C work/native-ci-artifact
```

Developers using Docker Buildx can run the same recipe with:

```sh
docker buildx build --file native/build/Dockerfile --target export --provenance=false --output type=local,dest=work/native-ci-artifact .
```

The export contains `mpv-2.dll` and `libmpv-source.tar.gz`. CI downloads that output to the same directory. Preparation and packaging consume these paths directly; no copy/import command or manifest rewrite is needed. Both backends cache stages by native sources and recipes; `--no-cache` forces rebuilding.

libmpv builds with FFmpeg libraries, dav1d and rendering/subtitle dependencies. FFmpeg programs/network protocols, Vulkan and OpenGL are disabled; D3D11/WASAPI, CPU AV1 decoding and explicitly selected hardware decoders remain enabled.

On Windows:

```powershell
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
```

Preparation stages DLLs/notices and downloads the official ORT archive. Add `-WithDevModel` to preparation for the Silero integration tests. Smoke loads the selected DLLs and initializes mpv/ORT; missing files, loading failures and initialization errors fail the command. Cached builds still require current [application and integration tests](testing.md).

The GPUI app composes libmpv's video swapchain below its UI, publishing video placement and matching UI pixels through one DirectComposition transaction. Captions and controls stay outside the video surface; the standalone native host retains its child-window path. See [native rendering](architecture.md#study-surface-and-native-rendering). Changes to that path need visible playback, codec/audio-track selection, seeking, repeat and input checks on actual Windows hardware.

For playback support, set `SURTITLE_PLAYBACK_DIAGNOSTICS` before launch to a fresh absolute JSONL filename on a local disk, inside an existing directory. Ordinary builds sample libmpv at most every 250 ms for ten minutes and write at most 8 MiB; no file is created without this opt-in, existing files are never overwritten, and output failures disable logging without failing playback. A bounded background writer keeps disk I/O off the GUI thread; `samplesOmitted` records queue overflow. Samples retain raw properties, unavailable values as `null` with mpv error codes, selected tracks, renderer/decoder, source-path SHA256 (not content hash), UTC/monotonic timing and property-read duration. `interval.avSyncEligible` requires advancing active A/V playback after a baseline; load/seek/reset boundaries invalidate intervals. For visible playback, also require `surfaceVisible`, consecutive records and available properties; an unchanged epoch alone does not prove continuity. Use raw counter endpoints within that uninterrupted interval for decoder/VO drop deltas. These counters do not measure Windows compositor/display drops. `avsync` is in seconds and compares mpv's audio-output-delay-adjusted playback clock with video PTS and timing adjustments; it does not measure physical speaker/display arrival. Logging is sampled and adds measurable overhead; check actual intervals, read durations, missing values and omissions before interpreting results. Shutdown may lose queued tail records, so the last complete recorded sample ends the measured window; process-exit time does not.

## Microsoft prerequisites

The app and ORT require Microsoft x64 VC Runtime (`VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `MSVCP140.dll`, `MSVCP140_1.dll`) as a system prerequisite. The [NSIS hook](../native/windows-prerequisite.nsh) and [PowerShell helper](../native/vc-prerequisite.ps1) check its registry installation, files, minimum version and Microsoft signatures.

Interactive setup asks before downloading/opening Microsoft's installer, with no quiet install or automatic restart. Silent setup returns 1603 if the prerequisite is missing; a valid existing runtime permits offline setup.

## Standard NSIS installer

The app uses NSIS with [the project installer](../packaging/windows.nsi), the VC prerequisite hook, and [native/windows/package.ps1](../native/windows/package.ps1). [Application identity](../packaging/app.json) retains the existing per-user installation and profile names; the workspace Cargo version supplies release metadata, and [runtime-windows-x64.json](../native/runtime-windows-x64.json) supplies VC prerequisite parameters. Ensure `cargo-about`, NSIS (`makensis.exe`), and prepared native runtime files (`work/resources/native/`) are available, then run:

```powershell
pwsh -File native/windows/package.ps1
```

The packaging script verifies that the production dependency graph excludes browser runtimes and development-only features, generates `work/resources/notices/rust.html` via `cargo-about` using [packaging/licenses.hbs](../packaging/licenses.hbs) and [about.toml](../about.toml), collects third-party notices under `work/resources/notices/`, builds `cargo build --release --locked --package surtitle --no-default-features`, and compiles `work/target/release/bundle/nsis/Surtitle_<version>_x64-setup.exe`. Set `SURTITLE_NSIS_COMPILER` or `SURTITLE_CARGO_ABOUT` to select custom tool paths, and pass `-NoBuild` to skip rebuilding Cargo when the release binary is already built.

During CI tag pushes (`refs/tags/vX.Y.Z`), the `publish` job verifies tag/commit alignment with `Cargo.toml` and `origin/main`, generates `SHA256SUMS.txt`, and creates a GitHub Release containing the installer, `libmpv-source.tar.gz`, and `SHA256SUMS.txt`.
