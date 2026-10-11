# Native runtime and packaging

The Windows x64 payload contains source-built `mpv-2.dll` and the official CPU ONNX Runtime DLLs, `onnxruntime.dll` and `onnxruntime_providers_shared.dll`. `native/runtime-windows-x64.json` lists their locations, notices, corresponding sources and prerequisites. Runtime DLLs and their build reports are not hash-checked at startup, during preparation, in CI or during packaging. CLI FFmpeg/ffprobe, yt-dlp, Deno and the Silero model remain separate managed downloads with their existing checks; they are not bundled into these DLL resources.

## Build and prepare native inputs

For input ownership and dependency updates, see [updating native dependencies](native-dependencies.md).

The libmpv recipe builds mpv, FFmpeg libraries, dav1d and the selected rendering/subtitle dependencies. FFmpeg programs, network protocols, Vulkan and OpenGL are disabled; Windows D3D11/WASAPI and CPU AV1 decoding remain available. ORT uses the selected official CPU release; its source package retains upstream archives, patches and notices. See [source rebuild instructions](../native/SOURCE-REBUILD.md) for dependency details.

```sh
docker buildx build --file native/build/Dockerfile --target export --provenance=false --output type=local,dest=work/native-ci-artifact .
```

Run from the repository root and use a fresh `work/native-ci-artifact/` directory with regular, non-symlink ancestors. The standard Buildx command uses the multi-stage Dockerfile's `export` target. It exports `mpv-2.dll`, `libmpv-source.tar.gz`, `onnxruntime-source.tar.gz` and informational build/source reports. Add standard Buildx flags, such as `--no-cache`, directly to the Docker command when needed.

Docker caches completed native build/source-packaging stages using their native source/configuration/script inputs. Frontend and documentation edits reuse those completed outputs. Native input changes invalidate the relevant stages. CI restores and saves the cache within GitHub's branch/ref scope. If acquisition needs a GitHub token, set `SURTITLE_NATIVE_GITHUB_TOKEN` and add `--secret id=github_token,env=SURTITLE_NATIVE_GITHUB_TOKEN` to the Docker command. The token remains a BuildKit secret.

CI downloads the native output before Windows checks and packaging. For a local checkout, obtain the same output or build it above, then run:

```powershell
node native/build/native-ci-artifact.mjs consume work/native-ci-artifact
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
```

Consumption copies the DLL and corresponding source archives into the ignored `work/native-ci-artifact/` directory. It leaves the tracked runtime manifest unchanged, including when a rebuilt DLL differs from a previous build. Preparation stages the DLLs/notices and downloads the selected official ORT archive; development preparation does not require build evidence or source archives. The native smoke test loads the selected DLLs and initializes mpv/ORT. `native-prepare.ps1 -WithDevModel` also installs the development Silero fixture for the explicit integration suites.

Missing DLLs, load failures and initialization errors remain actionable errors. Windows application playback, VAD and installer tests still run even when compilation comes from cache. Native artifact checksums, review evidence and PE dependency audits are not acceptance gates.

## Microsoft prerequisites

The app and ORT require Microsoft x64 VC Runtime, including `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `MSVCP140.dll` and `MSVCP140_1.dll`. They are system prerequisites, not copied into the package. `native/windows-prerequisite.nsh` and `native/vc-prerequisite.ps1` check the installation registry, files, minimum version and Microsoft signatures.

Interactive setup asks before downloading/opening Microsoft's installer and does not perform a quiet installation or automatic restart. Silent setup fails with code 1603 if the prerequisite is missing. An already installed valid runtime supports offline setup. WebView2 uses Tauri's interactive `downloadBootstrapper` mode; its fixed runtime/bootstrapper is not embedded in the Surtitle installer.

See [Microsoft runtime redistribution](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution), [installer behavior](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files), and the retained component notices.

## Standard Tauri installer

The application uses Tauri's standard NSIS template and official `nsis_tauri_utils.dll`, with its application-specific VC prerequisite hook.

Use a new disposable Windows profile for local installer verification. It requires FFmpeg and 7-Zip on PATH, the prepared native inputs, and the Microsoft prerequisites above.

```powershell
python native/windows/native-installer-prepare.py
pnpm setup:licenses
& ./work/package-tools/bin/cargo-about.exe generate scripts/licenses.hbs --output-file src-tauri/resources/notices/rust.html
node scripts/audit-js-licenses.mjs
pnpm package:app
pnpm setup:driver
pwsh -File e2e/support/prepare-webdriver.ps1
pnpm test:fixtures
# Run only in a new disposable Windows profile (CI does not need this switch):
pwsh -File native/windows/package-verify.ps1 -DisposableProfile
```

Preparation collects the pinned NSIS/plugin source, the plugin's locked source crates and the application's Rust runtime source under `work/installer-sources`, and stages installer notices. JavaScript/Rust notices are generated before every package build; these generated resources are not tracked in Git. `pnpm package:app` performs the locked standard Tauri build; Tauri downloads and caches its normal NSIS tools and official plugin.

Package testing runs the completed installer in a disposable profile. The lifecycle covers fresh install, installed-production UI/playback readiness, overwrite, uninstall and default learning-data/card-audio retention. Production smoke uses the normal installed binary; broader E2E uses a separate fixture-enabled build.

The source ZIP contains the application, Rust and JavaScript dependency sources, native source archives and installer sources/notices. Publication requires the expected release files and successful installer smoke after the required Linux, Windows and package jobs succeed. Public download checksums are generated for the installer and source ZIP; they do not gate runtime loading or packaging. Pinned source-download checks remain part of dependency acquisition.

Initial releases are unsigned. Exercise each release's installer through the lifecycle tests above.

## Local development versus CI

The optional [Dev Container](../.devcontainer/README.md) shares source with temporary output masks and private build dependencies. Its mount policy applies to that development container. Linux CI runs on the Ubuntu host, while the separate native Docker build uses BuildKit caching/secrets. Windows WebDriver uses restricted medium-integrity processes so the real app and its SQLite/WAL observers share the required execution environment.
