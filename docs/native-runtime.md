# Native runtime and packaging

The Windows x64 payload contains source-built `mpv-2.dll` and the official CPU ONNX Runtime DLLs, `onnxruntime.dll` and `onnxruntime_providers_shared.dll`. `native/runtime-windows-x64.json` identifies their hashes, notices, sources and prerequisites. CLI FFmpeg/ffprobe, yt-dlp, Deno and the Silero model remain separate managed downloads or explicit existing tools; they are not bundled into these DLL resources.

## Build and prepare native inputs

For input ownership and representative version changes, see [updating native dependencies](native-dependencies.md).

The libmpv recipe builds mpv, FFmpeg libraries, dav1d and the selected rendering/subtitle dependencies. FFmpeg programs, network protocols, Vulkan and OpenGL are disabled; Windows D3D11/WASAPI and CPU AV1 decoding remain available. ORT uses the pinned official CPU release; its source package retains upstream archives, patches, notices and the observed PDB/source comparison. See [source rebuild instructions](../native/SOURCE-REBUILD.md) and `native/reviews/` for dependency details.

```sh
bash scripts/native-ci-build.sh
```

The wrapper uses the multi-stage Dockerfile's `export` target and writes a fresh `work/native-ci-artifact/` directory. It exports six files: `mpv-2.dll`, `libmpv-source.tar.gz`, `onnxruntime-source.tar.gz`, `libmpv-build-evidence.json`, `onnxruntime-source-inventory.json` and `SHA256SUMS.txt`. Optional Buildx flags, such as `--no-cache`, can be passed to the wrapper.

Docker caches completed native build/source-audit stages using their native source/configuration/script inputs. Frontend and documentation edits reuse those completed outputs. Native input changes invalidate the relevant stages. CI restores and saves the cache within GitHub's branch/ref scope. There is no separate ccache/source-copy protocol, commit-identity receipt or effective-manifest artifact. If acquisition needs a GitHub token, the optional BuildKit secret uses the `SURTITLE_NATIVE_GITHUB_TOKEN` environment variable; it is not a build argument or an image layer.

CI downloads the native output before Windows checks and packaging. For a local checkout, obtain the same output or build it above, then run:

```powershell
node scripts/native-ci-artifact.mjs verify work/native-ci-artifact
node scripts/native-ci-artifact.mjs consume work/native-ci-artifact
pwsh -File scripts/native-prepare.ps1
pwsh -File scripts/native-smoke.ps1
```

Verification checks the file set and hashes. Consumption updates this checkout's runtime manifest to the selected DLL/source paths and hashes; preparation stages the DLLs/notices and downloads the pinned official ORT archive. The native smoke test loads the selected DLLs and initializes mpv/ORT. `native-prepare.ps1 -WithDevModel` also installs the development Silero fixture for the explicit integration suites.

`node scripts/native-audit.mjs --release` checks actual DLLs/notices/source evidence and PE dependency closure. Output integrity and Windows application tests still run even when compilation comes from cache. A cache hit does not establish current app playback or installer behavior.

## Microsoft prerequisites

The app and ORT require Microsoft x64 VC Runtime, including `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `MSVCP140.dll` and `MSVCP140_1.dll`. They are system prerequisites, not copied into the package. `native/windows-prerequisite.nsh` and `native/vc-prerequisite.ps1` check the installation registry, files, minimum version and Microsoft signatures.

Interactive setup asks before downloading/opening Microsoft's installer and does not perform a quiet installation or automatic restart. Silent setup fails with code 1603 if the prerequisite is missing. An already installed valid runtime supports offline setup. WebView2 uses Tauri's interactive `downloadBootstrapper` mode; its fixed runtime/bootstrapper is not embedded in the Surtitle installer.

See [Microsoft runtime redistribution](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution), [installer behavior](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files), and the retained component notices. Historical local prerequisite checks did not exercise missing-runtime installation or UAC branches.

## Standard Tauri installer

The application uses Tauri's standard NSIS template and official `nsis_tauri_utils.dll`, with its application-specific VC prerequisite hook. There is no custom plugin alias, private i686 Rust sysroot or rewritten upstream installer template.

```powershell
python scripts/native-installer-prepare.py
pnpm setup:licenses
& ./work/package-tools/bin/cargo-about.exe generate scripts/licenses.hbs --output-file src-tauri/resources/notices/rust.html
node scripts/audit-js-licenses.mjs
pnpm package:app
# Run only in a new disposable Windows profile (CI does not need this switch):
pwsh -File scripts/package-verify.ps1 -DisposableProfile
```

Preparation collects the pinned NSIS/plugin source, the plugin's locked source crates and the application's Rust runtime source under `work/installer-sources`, and stages installer notices. JavaScript/Rust notices are generated before every package build; these generated resources are not tracked in Git. `pnpm package:app` performs the locked standard Tauri build; Tauri downloads and caches its normal NSIS tools and official plugin.

Package verification extracts the completed installer once, checks its embedded application, DLLs and notices, and tests that same installer in a disposable profile. The lifecycle covers fresh install, installed-production UI/playback readiness, overwrite, uninstall and default learning-data/card-audio retention. Production smoke uses the normal installed binary; broader E2E uses a separate fixture-enabled build.

The source ZIP contains the application, Rust and JavaScript dependency sources, native source archives and installer sources/notices. Verification extracts the source ZIP and checks the actual included source hashes. Publication validates the complete asset set, checksums and tested installer identity after the required Linux, Windows and package jobs succeed.

Historical local audits and exact old artifact identities are in [verification history](verification-history.md#last-recorded-local-package). They do not certify a new installer, establish completed installation or authorize publication. Initial releases are unsigned.

## Local development versus CI

The optional [Dev Container](../.devcontainer/README.md) shares source with temporary output masks and private build dependencies. Its mount policy applies to that development container. Linux CI runs on the Ubuntu host, while the separate native Docker build uses BuildKit caching/secrets. Windows WebDriver uses restricted medium-integrity processes so the real app and its SQLite/WAL observers share the required execution environment.
