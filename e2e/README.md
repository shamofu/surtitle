# Surtitle E2E checks

`pnpm test` runs UI and script regressions. `pnpm test:browser` checks the browser-only preview with Playwright; install Chromium with `pnpm exec playwright install chromium` (`--with-deps` on Linux). The preview provides no fake persisted library or native service.

`pnpm test:e2e` launches the actual fixture-enabled Tauri binary through `tauri-driver`. Windows uses real WebView2/libmpv and generated media; Linux uses WebKitGTK/Xvfb and a deterministic E2E-only playback adapter. No ordinary test has cloud credentials or accepts a paid quote.

## Native setup

1. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm build:native:e2e` and `pnpm build:fixtures`. Windows also needs the [native DLLs](../docs/native-runtime.md).
2. Install `tauri-driver` with `pnpm setup:driver`; set `SURTITLE_TAURI_DRIVER` to its absolute path. On Windows run `pwsh -File scripts/prepare-webdriver.ps1` for the matching EdgeDriver; on Linux use WebKitWebDriver.
3. Run `pnpm test:fixtures` using an existing FFmpeg. It generates the Japanese/space/ampersand video, multitrack media, subtitles and six-hour silence locally.
4. Use `pnpm seed:fixtures <fresh-data-directory> <absolute-media-path>` to create a disposable SQLite profile. Set `SURTITLE_E2E_DATA_DIR` to that profile, `SURTITLE_E2E_BINARY` to the absolute E2E executable, and `SURTITLE_NATIVE_DRIVER` to the native WebDriver when needed.
5. Set `SURTITLE_E2E_AI_RECOVERY=translation` and `SURTITLE_E2E_TRANSCRIPT_REVIEW=boundary` for the authored recovery presets. Run `pnpm test:e2e`; Linux uses `dbus-run-session -- xvfb-run -a pnpm test:e2e`.

Use a separate Cargo target directory or retain a separate E2E executable for local development. Fixture-enabled binaries must use disposable profiles. Release builds exclude `e2e-test`/`e2e-fixtures` and development validation.

## Coverage and diagnostics

Native tests exercise local imports, 20,000 subtitle rows with bounded rendering, subtitle edits, explicit adoption, contextual interval replay, review scheduling, audio-track selection, downloads/cancellation, card retention, learning restore and complete process restarts. Windows covers decoded native video visibility, six-hour seeking and actual FFmpeg audio extraction. The multitrack fixture deliberately has different mpv and FFmpeg IDs.

The AI recovery/transcript presets are authored saved results with explicit offline accounting. They protect SQLite/IPC behavior and unchanged charges; they do not test cloud recognition. Windows E2E uses software rendering and null audio, so audible output and hardware decoding need separate checks. Optional AV1 decoding is enabled only by an explicit `SURTITLE_E2E_AV1_FIXTURE`.

Windows test processes run at restricted medium integrity to support WebView2's driver environment and keep SQLite/WAL readers at the same integrity as the app. The launcher owns its process tree. WebDriver transport retries are disabled so timed-out mutations are not repeated. Script requests have bounded timeouts; failures retain screenshots and player/layout diagnostics under `test-results/native`.

Focus a run with `pnpm test:e2e --spec ./e2e/native/draft-study.e2e.js` using the same prepared environment. A focused pass does not replace a failed full-suite run. Real FFmpeg/libmpv Rust integrations are selected through the [required suites](../docs/ai-test-plan.md#explicit-rust-integration-suites).

## Saved-response local checks

`e2e/saved/` is excluded from the ordinary native glob. It exercises an explicitly prepared local profile from saved provider responses and the [frozen ten-task set](../docs/draft-study-task-set.json), including bookmark/replay persistence and a layout diagnostic. These application checks remain available after removal of the separate research-scoring tools.

Their observations establish transport and persistence, not human listening, semantic correctness or editing effort. The [verification history](../docs/verification-history.md#draft-study--1213-september-2026) records the original candidate identities, failures and focused reruns. The separately opt-in public-download check is described in [upstream tests](upstream/README.md).
