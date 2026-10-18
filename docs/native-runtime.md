# Native runtime and packaging

The Windows x64 payload contains source-built `mpv-2.dll` and official CPU ONNX Runtime DLLs (`onnxruntime.dll`, `onnxruntime_providers_shared.dll`). [The runtime manifest](../native/runtime-windows-x64.json) selects their paths, notices, corresponding sources and prerequisites. CLI FFmpeg/ffprobe and Silero remain separate managed downloads.

## Dependency inputs and updates

| Input | Authoritative definition |
| --- | --- |
| mpv, FFmpeg, dav1d and other libmpv sources | [sources.json](../native/build/sources.json): repository, ref, fixed commit, archive SHA-256 and child destinations. Acquisition and packaging derive URLs, filenames and submodule records. |
| Official ORT runtime, libmpv location, notices, Silero and VC Runtime | [runtime-windows-x64.json](../native/runtime-windows-x64.json). libmpv `sourceId` refers to the source catalog; its display version is not a second source selector. |
| ORT source, vcpkg baseline and historical port selection | [onnxruntime-sources.json](../native/build/onnxruntime-sources.json). Required overlay recipes/patches come from that pinned ORT source archive; other ports come from the selected vcpkg baseline/port. |
| NSIS, official Tauri plugin, locked source crates and Rust source/notices | [installer-inputs.json](../native/installer-inputs.json). CI and Dev Container read `rust.version`; Cargo's `rust-version` remains a minimum requirement. |

For mpv/FFmpeg updates, change the ref, commit and source hash together, including changed child sources. For ORT, update its official runtime URL/member paths and matching source commit/hash, plus vcpkg inputs when required. Silero version, commit, URL, model/notice hashes and VC Runtime minimum/URL/files belong in the runtime manifest. Installer/toolchain updates must keep the Rust pin, `rust-toolchain.toml`, minimum compiler requirement and Tauri source records consistent. Generated Rust model constants and `work/installer-prerequisite.nsh` are not committed.

Source-download pins identify acquired inputs. Rebuilt runtime DLLs and informational build reports are not hash acceptance gates. Preserve FFmpeg's explicit D3D11VA/DXVA2 configuration and decoder checks; verify extraction separately from hardware playback because the managed FFmpeg CLI and libmpv's libraries are different builds. Runtime/model updates also need playback, VAD/chunk boundaries, cancellation and source/sample coverage checks; a version number or timing result is insufficient.

## Build and prepare native inputs

Run from the repository root with a fresh `work/native-ci-artifact/` output directory and regular, non-symlink ancestors. Select the backend locally. The current wslc exporter supports tar streams, not direct directory output; use PowerShell 7.4 or newer for [binary pipelines](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pipelines#using-native-commands-in-the-pipeline):

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
New-Item -ItemType Directory -Path work/native-ci-artifact | Out-Null
wslc build --progress plain --file native/build/Dockerfile --target export --output type=tar,dest=- . |
  tar -xf - -C work/native-ci-artifact
```

Developers using Docker Buildx can run the same recipe with:

```sh
docker buildx build --file native/build/Dockerfile --target export --provenance=false --output type=local,dest=work/native-ci-artifact .
```

The export contains `mpv-2.dll`, `libmpv-source.tar.gz`, `onnxruntime-source.tar.gz` and informational source/build reports. CI downloads that output to the same directory. Preparation and packaging consume these paths directly; no copy/import command or manifest rewrite is needed. Both backends cache stages by native sources and recipes; `--no-cache` forces rebuilding. For authenticated acquisition, supply `SURTITLE_NATIVE_GITHUB_TOKEN` through the build secret `--secret id=github_token,env=SURTITLE_NATIVE_GITHUB_TOKEN`.

libmpv builds with FFmpeg libraries, dav1d and rendering/subtitle dependencies. FFmpeg programs/network protocols, Vulkan and OpenGL are disabled; D3D11/WASAPI, CPU AV1 decoding and explicitly selected hardware decoders remain enabled. The ORT stages assemble corresponding source and dependency inputs for the official CPU release, rather than compiling a replacement DLL. See [source ZIP rebuilding](../native/SOURCE-REBUILD.md) for the distributed sources.

On Windows:

```powershell
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
```

Preparation stages DLLs/notices and downloads the official ORT archive. Development preparation needs the DLL but not source archives or build reports; packaging also needs corresponding sources. Add `-WithDevModel` to preparation for the required Silero integration suite. Smoke loads the selected DLLs and initializes mpv/ORT; missing files, loading failures and initialization errors fail the command. Cached builds still require current [application and integration tests](testing.md).

The app uses a native child window with popup exclusions; see [native rendering](architecture.md#study-surface-and-native-rendering). Changes to that path need visible playback, codec/audio-track selection, seeking, repeat and input checks on actual Windows hardware. Browser tests and software-rendered CI do not establish hardware decoding or perceptual A/V synchronization.

## Microsoft prerequisites

The app and ORT require Microsoft x64 VC Runtime (`VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `MSVCP140.dll`, `MSVCP140_1.dll`) as a system prerequisite. The [NSIS hook](../native/windows-prerequisite.nsh) and [PowerShell helper](../native/vc-prerequisite.ps1) check its registry installation, files, minimum version and Microsoft signatures.

Interactive setup asks before downloading/opening Microsoft's installer, with no quiet install or automatic restart. Silent setup returns 1603 if the prerequisite is missing; a valid existing runtime permits offline setup. WebView2 uses Tauri's interactive `downloadBootstrapper` mode, without an embedded fixed runtime/bootstrapper.

## Standard Tauri installer

The app uses Tauri's standard NSIS template and official `nsis_tauri_utils.dll`, plus its VC prerequisite hook. Install FFmpeg/ffprobe and 7-Zip on PATH, prepare the native inputs, and install the Microsoft prerequisites above. Run lifecycle verification only in a fresh CI runner or new disposable Windows profile.

```powershell
python native/windows/native-installer-prepare.py
pnpm setup:licenses
& ./work/package-tools/bin/cargo-about.exe generate scripts/licenses.hbs --output-file src-tauri/resources/notices/rust.html
node scripts/audit-js-licenses.mjs
pnpm package:app
pnpm setup:driver
pwsh -File e2e/support/prepare-webdriver.ps1
pnpm test:fixtures
# Local lifecycle testing requires a new disposable Windows profile:
pwsh -File native/windows/package-verify.ps1 -DisposableProfile
```

Installer preparation collects pinned NSIS/plugin source, locked plugin crates and Rust runtime source under `work/installer-sources`, and stages notices. Generate JavaScript/Rust notices before each package build; generated resources stay untracked. Tauri performs the locked build and obtains/caches its standard NSIS tools and plugin.

`package-verify.ps1` requires a Git checkout with a valid `GITHUB_SHA` (CI) or `HEAD` (local), because `git archive` supplies application source. That revision must contain the intended source; uncommitted changes are not archived. Use fresh `work/artifacts/release/` and `work/release-source/` directories. The script checks fresh install, installed-production UI/playback, overwrite, uninstall and default learning-data/card-audio retention. This uses the ordinary installed binary; broader native E2E uses a separate fixture-enabled build.

The source ZIP includes application, Rust/JavaScript dependency sources, native source archives and installer sources/notices. `node scripts/release.mjs --check` validates the assembled files, explicit version and installer-smoke result without publishing. After every required CI job succeeds, publication verifies the existing release tag/SHA, generates public checksums once, and uses GitHub CLI to publish the installer, source ZIP and checksums with generated release notes. Initial releases are unsigned; exercise each installer through the lifecycle checks above.
