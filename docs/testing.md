# Application test guide

Vitest runs UI and script tests, Playwright checks browser behavior, WebdriverIO drives the real Tauri application, and cargo-nextest runs Rust tests. Maintained suites run in CI on their applicable OS; Windows native input runs separately and sequentially. The final `ci` job requires version validation, native build, browser, Linux, Windows and package jobs to succeed.

Ordinary tests use authored fixtures and disposable data without Vertex requests. AI integration tests exercise approval, execution, accounting and result application against real SQLite databases with offline transport. They do not measure generated-language quality; use [explicitly approved live verification](vertex-verification.md) for that.

## Routine checks

Install the [development prerequisites](../README.md#development), then run:

```sh
pnpm install --frozen-lockfile
pnpm setup:nextest
pnpm test
pnpm build
pnpm fmt:rust:check
pnpm test:rust
pnpm test:rust:no-default-features
pnpm test:rust:doc
pnpm lint:rust
pnpm audit:rust
node scripts/audit-js-licenses.mjs
node scripts/check-release.mjs --version-only
node scripts/check-production-features.mjs
```

`pnpm test:ui` and `pnpm test:scripts` select one Vitest project; `pnpm test:watch` watches both. IPC generation is checked by the script suite; use `pnpm check:ipc` for a focused check and `pnpm generate:ipc` after changing the Rust contract. Nextest uses separate workspace and no-default-feature profiles; doctests remain a Cargo invocation. Rust and native E2E retries are disabled.

## Browser checks

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

On Linux, use `pnpm exec playwright install --with-deps chromium`. CI runs the same suite in the pinned [browser image](../e2e/browser/Dockerfile). `pnpm test:structure` selects the UI structure/layout subset. Browser CI permits one retry and retains its evidence.

Browser fixtures exercise the real router, query providers, dialogs and virtualized transcript through test-only native transport. The ordinary preview has no fabricated persisted library. Assertions cover accessible roles, names, state, values, bounds and placement, without pixel baselines. Inspect failed assertions before changing a UI contract; review typography, colors and motion visually. Synthetic composition events do not establish real Windows IME behavior.

## Native E2E

Windows needs MSVC/Windows SDK, PowerShell 7, WebView2 and [prepared DLLs](native-runtime.md#build-and-prepare-native-inputs). Run `pwsh -File native/windows/native-prepare.ps1 -WithDevModel` before building. Use an ordinary, non-administrator PowerShell session so the fixture database and restricted app processes share medium integrity. Linux needs GTK/WebKitGTK development libraries, libmpv, WebKitWebDriver, Xvfb, D-Bus and FFmpeg; the [Dev Container](../.devcontainer/README.md) provides them, and the [Linux CI job](../.github/workflows/ci.yml) lists host packages. Put FFmpeg/ffprobe on PATH for the commands below.

For either OS:

```sh
pnpm setup:driver
pnpm build
pnpm build:native:e2e
pnpm build:fixtures
pnpm test:fixtures
```

Use disposable profiles and a separate Cargo target directory or retained E2E binary when also developing the ordinary app. Production builds reject E2E, test-support and development-validation features. Never reseed a running profile. Workers create isolated profiles; only restarts within one spec reuse them.

On Windows, prepare the matching signed EdgeDriver and set absolute paths (adjust `work/target` if using `CARGO_TARGET_DIR`):

```powershell
pwsh -File e2e/support/prepare-webdriver.ps1
$env:SURTITLE_NATIVE_DRIVER = "$PWD/work/webdriver/msedgedriver.exe"
$env:SURTITLE_TAURI_DRIVER = "$PWD/work/driver/bin/tauri-driver.exe"
$env:SURTITLE_E2E_BINARY = "$PWD/work/target/debug/surtitle.exe"
$env:SURTITLE_E2E_SEED_BINARY = "$PWD/work/target/debug/examples/seed_fixture.exe"
$env:SURTITLE_E2E_DATA_DIR = "$PWD/work/e2e-windows"
pnpm seed:fixtures "$env:SURTITLE_E2E_DATA_DIR" "$PWD/work/test-results/fixtures/日本語 & sample.mp4"
ffmpeg -v error -f lavfi -i 'testsrc2=size=320x180:rate=12:duration=3' -c:v libaom-av1 -cpu-used 8 -crf 50 -y work/e2e-av1.mkv
$env:SURTITLE_E2E_AV1_FIXTURE = "$PWD/work/e2e-av1.mkv"
pnpm test:e2e --exclude ./e2e/native/playback-rate.e2e.js
```

Run pointer/playback and slow titlebar-snap tests separately with a fresh profile and an available interactive desktop:

```powershell
$env:SURTITLE_E2E_DATA_DIR = "$PWD/work/e2e-windows-pointer"
pnpm seed:fixtures "$env:SURTITLE_E2E_DATA_DIR" "$PWD/work/test-results/fixtures/日本語 & sample.mp4"
$env:SURTITLE_E2E_NATIVE_INPUT = '1'
pnpm test:e2e --spec ./e2e/native/playback-rate.e2e.js
pnpm test:e2e --spec ./e2e/native/window-state.e2e.js --mochaOpts.grep 'releases slow titlebar drags'
Remove-Item Env:SURTITLE_E2E_NATIVE_INPUT
```

Only this mode requests foreground assistance for the verified application window. The snap test starts at the top-left corner, holds its verified titlebar through one-physical-pixel movements on each axis, checks the same 32 logical pixel boundary for snapping and release, and saves the cursor/frame traces; ordinary window-state coverage checks initial alignment and persistence without moving the cursor. CI also runs foreground-activation script tests and desktop/input preflights; its console-hiding preparation is restricted to hosted runners. Ordinary DOM/IPC specs do not require foreground ownership.

On Linux:

```sh
export SURTITLE_TAURI_DRIVER="$PWD/work/driver/bin/tauri-driver"
export SURTITLE_E2E_BINARY="${CARGO_TARGET_DIR:-$PWD/work/target}/debug/surtitle"
export SURTITLE_E2E_SEED_BINARY="${CARGO_TARGET_DIR:-$PWD/work/target}/debug/examples/seed_fixture"
export SURTITLE_E2E_DATA_DIR="$(mktemp -d)"
pnpm seed:fixtures "$SURTITLE_E2E_DATA_DIR" "$PWD/work/test-results/fixtures/日本語 & sample.mp4"
WEBKIT_DISABLE_COMPOSITING_MODE=1 dbus-run-session -- xvfb-run -a pnpm test:e2e
```

Set `SURTITLE_NATIVE_DRIVER` if WebKitWebDriver is not on PATH. Select an individual spec with `--spec ./e2e/native/draft-study.e2e.js` using the same prepared environment.

Windows E2E exercises real WebView2/libmpv; Linux uses WebKitGTK and an E2E-only playback adapter. Browser tests cannot establish native persistence, playback or window composition. Windows CI uses software rendering and null audio. For direct desktop graphics validation, set `SURTITLE_E2E_REAL_RENDERER=1` to use the shipped D3D11/automatic decoding settings; audio remains muted. Perceptual A/V synchronization, monitor changes and real IME input still need direct Windows verification. For native screenshots and resizing, use `saveNativeScreenshot` and `resizeNativeWindow` from [native-window.mjs](../e2e/support/native-window.mjs): WebDriver screenshots capture only the WebView, and its resize command targets the nested browser window.

## Explicit Rust integration suites

Some real-media tests are ignored in ordinary unit runs and selected explicitly in CI:

| Command | Required inputs and checks |
| --- | --- |
| `pnpm test:rust:required linux-ffmpeg` | Linux FFmpeg/ffprobe; source-clock PCM and selected audio-stream extraction |
| `pnpm test:rust:required windows-native` | Windows FFmpeg/ffprobe, prepared DLLs and development Silero model; extraction, mpv load/restore, VAD, chunk continuity and failure cleanup |

Set `SURTITLE_TEST_FFMPEG` to an absolute FFmpeg executable with matching ffprobe. Windows speech tests also need the pinned, hash-checked fixtures:

```powershell
$env:SURTITLE_TEST_FFMPEG = 'C:\Tools\ffmpeg\ffmpeg.exe'
python e2e/support/acquire-spoken-fixtures.py
$env:SURTITLE_SPOKEN_FIXTURES = "$PWD/work/spoken-fixtures"
pnpm test:rust:required windows-native
```

The runner validates nextest discovery against exact package/test names before serial execution. Missing inputs, changed discovery and failed or unexecuted groups fail the command. Update the registry in [run-required-rust-tests.mjs](../e2e/support/run-required-rust-tests.mjs) when moving an integration test. Ordinary workspace tests invoke their own crash helpers; do not register those helpers as standalone integrations.

## Results and failure evidence

Runner exit codes determine test success; the final CI job requires every prerequisite job to succeed. Native startup, readiness, hook and cleanup failures also fail the run. Expected IPC rejection is an application result; driver/transport errors remain failures. CI uploads diagnostics even after a failed test step.

| Evidence | Local path |
| --- | --- |
| Vitest JUnit | `work/test-results/vitest/` |
| Browser JSON/JUnit, failure screenshots and traces | `work/test-results/browser/`, `work/playwright-report/browser/` |
| Rust JUnit | `work/test-results/nextest/` |
| Required Rust discovery, execution and JUnit | `work/artifacts/required-rust-tests/<suite>/run-*/` |
| Native session logs, status and bounded failure diagnostics | `work/test-results/native/<run>/<spec>/` |
| Installer/runtime smoke | `work/artifacts/` |

Required-suite reruns use unique directories; `--evidence-dir <directory>` changes their parent. Native output names each spec and test as it runs, then reports counts, hook failures and diagnostic paths. Successful tests do not record screenshot sequences or videos. Reports and generated fixtures are ignored local outputs, not source-controlled acceptance records. See [native packaging](native-runtime.md#standard-tauri-installer) for production installer checks and [fixed AI responses](../crates/ai/tests/fixtures/README.md) for offline fixture maintenance.
