# Surtitle E2E checks

`pnpm test` runs UI and script regressions. `pnpm test:browser` checks the browser-only preview with Playwright; install Chromium with `pnpm exec playwright install chromium` (`--with-deps` on Linux). The preview provides no fake persisted library or native service.

`pnpm test:e2e` launches the actual fixture-enabled Tauri binary through `tauri-driver`. Windows uses real WebView2/libmpv and generated media; Linux uses WebKitGTK/Xvfb and a deterministic E2E-only playback adapter. No ordinary E2E test has cloud credentials or sends a billable provider request.

Browser interaction tests use explicit test-only native transport fixtures for study and import flows. They exercise the real router, query providers and virtualized transcript; persistence and playback integration remain the responsibility of native tests. The ordinary browser preview still has no fabricated native state.

## Browser CI and UI contracts

The required browser CI job runs `pnpm test:browser`, including the UI structure and layout contracts, in the image defined by `e2e/browser/Dockerfile`. Its Playwright image is pinned by version and digest; Node, pnpm and Rust follow the repository pins. The source-only build context excludes host dependencies, build output and credentials. No desktop build is needed.

With a Linux Docker engine available, run the same environment locally:

```sh
docker build --platform linux/amd64 -f e2e/browser/Dockerfile -t surtitle-browser-tests .
docker run --rm --init --ipc=host surtitle-browser-tests
```

The ten UI contracts in `e2e/browser/learning-structure.spec.ts` cover the study screen, phrase save form, partial import failure, transcription tab with its history entry, and the nested unsaved-phrase confirmation, each in Japanese/light and English/dark at 1024×700. They check accessible roles, names and states, form values, visible controls, overflow and element placement. Small inline accessibility snapshots describe meaningful UI structure; they do not serialize the whole DOM or CSS. Run this subset with `pnpm test:structure`, on Windows or Linux. The broader language/theme/viewport coverage remains in the functional suite.

There are no screenshot baselines to regenerate when spacing, colors or controls intentionally change. Update an assertion only when the intended UI contract changes, and inspect the failure first. These checks do not guarantee exact colors, typography or animation quality; review those visually when changing them.

To retain diagnostic output from a local container run, bind the report directories; dependencies remain inside the container:

```powershell
New-Item -ItemType Directory -Force test-results, playwright-report | Out-Null
docker run --rm --init --ipc=host `
  --mount "type=bind,source=$($PWD.Path)/test-results,target=/app/test-results" `
  --mount "type=bind,source=$($PWD.Path)/playwright-report,target=/app/playwright-report" `
  surtitle-browser-tests
```

Rebuild the image after source or test changes to verify the default CI command against the complete current checkout. Windows runs of `pnpm test:browser` exercise the same contracts without a platform-specific baseline.

If Docker runs inside the existing WSL Ubuntu distribution, invoke these Docker commands through `wsl -d Ubuntu -u root -- docker` and use absolute WSL paths for the build context and bind sources (for example `/mnt/c/path/to/surtitle`). The host's Windows `node_modules` must not be mounted into the container.

CI retains `test-results/browser` and `playwright-report/browser`, including assertion differences, failure screenshots and traces. Screenshots are diagnostic evidence, not a pixel-equality gate. For a local run, use the output mounts shown above to retain these reports after the container exits. Update the pinned Docker image and its version assertion together when changing Playwright.

## Native setup

1. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm build:native:e2e` and `pnpm build:fixtures`. Windows also needs the [native DLLs](../docs/native-runtime.md).
2. Install `tauri-driver` with `pnpm setup:driver`; set `SURTITLE_TAURI_DRIVER` to its absolute path. On Windows run `pwsh -File e2e/support/prepare-webdriver.ps1` for the matching EdgeDriver; on Linux use WebKitWebDriver.
3. Run `pnpm test:fixtures` using an existing FFmpeg. It generates the Japanese/space/ampersand video, multitrack media, subtitles and six-hour silence locally.
4. Use `pnpm seed:fixtures <fresh-data-directory> <absolute-media-path>` to create a disposable SQLite profile. Set `SURTITLE_E2E_DATA_DIR` to that profile, `SURTITLE_E2E_BINARY` to the absolute E2E executable, and `SURTITLE_NATIVE_DRIVER` to the native WebDriver when needed.
5. Set `SURTITLE_E2E_AI_RECOVERY=translation` and `SURTITLE_E2E_TRANSCRIPT_REVIEW=boundary` for the authored recovery presets. Run `pnpm test:e2e`; Linux uses `dbus-run-session -- xvfb-run -a pnpm test:e2e`.

Use a separate Cargo target directory or retain a separate E2E executable for local development. Fixture-enabled binaries must use disposable profiles. Release builds exclude `e2e-test`/`e2e-fixtures`, `test-support` and development validation.

The media-management spec has three scenarios: the complete media/card lifecycle, HTTP download recovery, and optional AV1 playback. The HTTP fixture uses the generated source video and does not depend on the card lifecycle. To investigate one scenario, prepare a fresh profile using the steps above, then select it with `--spec ./e2e/native/media-management.e2e.js --mochaOpts.grep 'imports a local HTTP fixture'` (or the lifecycle/AV1 title). Do not reseed an existing running profile: the seed tool populates learning data and does not reset operational state.

## Coverage and diagnostics

Native tests exercise local imports, 20,000 subtitle rows with bounded rendering, subtitle edits, explicit adoption, contextual interval replay, review scheduling, audio-track selection, downloads/cancellation, card retention, learning restore and complete process restarts. Windows covers decoded native video visibility, six-hour seeking and actual FFmpeg audio extraction. The multitrack fixture deliberately has different mpv and FFmpeg IDs.

The track/subtitle/card lifecycle is one scenario because each step intentionally verifies the previous step's persisted result. Independent scenarios must set up their own inputs. Transcript search checks both the expected matching text and exclusion of nonmatching rows, so an empty result cannot satisfy the search assertion.

The AI recovery/transcript presets are authored saved results with explicit offline accounting. They protect SQLite/IPC behavior and unchanged charges; they do not test cloud recognition. Windows E2E uses software rendering and null audio, so audible output and hardware decoding need separate checks. Optional AV1 decoding is enabled only by an explicit `SURTITLE_E2E_AV1_FIXTURE`.

Windows test processes run at restricted medium integrity to support WebView2's driver environment and keep SQLite/WAL readers at the same integrity as the app. The launcher owns its process tree. WebDriver transport retries are disabled so timed-out mutations are not repeated. Script requests have bounded timeouts; failures retain screenshots and player/layout diagnostics under `test-results/native`.

Resize Windows test windows with `resizeNativeWindow` from `support/native-window.mjs`. EdgeDriver's `setWindowSize` moves and resizes the nested Chromium window instead of the Tauri window, separating HTML from the native video surface. The helper targets only the configured test executable, resizes the top-level client area and verifies that the WebView fills it. Native motion and layout checks also compare the actual video HWND rectangle with the DOM viewport in physical pixels. `saveNativeScreenshot` captures the application window including its native children; WebDriver screenshots capture only the WebView.

Focus a run with `pnpm test:e2e --spec ./e2e/native/draft-study.e2e.js` using the same prepared environment. Real FFmpeg/libmpv Rust integrations are selected through the [required suites](../docs/testing.md#explicit-rust-integration-suites).

## Saved-response local checks

`e2e/saved/` is excluded from the ordinary native glob. It exercises an explicitly prepared local profile from saved provider responses and the [frozen ten-task set](../docs/draft-study-task-set.json), including bookmark/replay persistence and a layout diagnostic.

These checks cover transport and persistence; they do not measure human listening, semantic correctness or editing effort. The separately opt-in public-download check is described in [upstream tests](upstream/README.md).
