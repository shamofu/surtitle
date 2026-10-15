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

The ten UI contracts in `e2e/browser/learning-structure.spec.ts` cover the study screen, phrase save form, partial import failure, transcription tab with its history entry, and phrase editing with autosave, each in Japanese/light and English/dark at 1024×700. They check accessible roles, names and states, form values, visible controls, overflow and element placement. Small inline accessibility snapshots describe meaningful UI structure; they do not serialize the whole DOM or CSS. Run this subset with `pnpm test:structure`, on Windows or Linux. The broader language/theme/viewport coverage remains in the functional suite.

`e2e/browser/surface-interactions.spec.ts` exercises the production dialog through a shared test fixture, covering Tab containment, synthetic composing-Escape retention, nested focus restoration, notification access and busy dismissal. It runs with normal and reduced motion. Synthetic composition events do not establish actual Windows IME behavior.

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

If Docker runs inside the existing WSL Ubuntu distribution, invoke these Docker commands through `wsl -d Ubuntu -u root --exec docker` and use absolute WSL paths for the build context and bind sources (for example `/mnt/c/path/to/surtitle`). The host's Windows `node_modules` must not be mounted into the container.

CI retains `test-results/browser` and `playwright-report/browser`, including assertion differences, failure screenshots and traces. Screenshots are diagnostic evidence, not a pixel-equality gate. For a local run, use the output mounts shown above to retain these reports after the container exits. Update the pinned Docker image and its version assertion together when changing Playwright.

## Native setup

1. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm build:native:e2e` and `pnpm build:fixtures`. Windows also needs the [native DLLs](../docs/native-runtime.md).
2. Install `tauri-driver` with `pnpm setup:driver`; set `SURTITLE_TAURI_DRIVER` to its absolute path. On Windows run `pwsh -File e2e/support/prepare-webdriver.ps1` for the matching EdgeDriver; on Linux use WebKitWebDriver.
3. Run `pnpm test:fixtures` using an existing FFmpeg. It generates the Japanese/space/ampersand video, multitrack media, subtitles and six-hour silence locally.
4. Use `pnpm seed:fixtures <fresh-data-directory> <absolute-media-path>` to create a disposable template. Set `SURTITLE_E2E_DATA_DIR` to that directory and `SURTITLE_E2E_BINARY` to the absolute E2E executable. Set `SURTITLE_E2E_SEED_BINARY` if `seed_fixture` is not alongside the executable in `examples/`; set `SURTITLE_NATIVE_DRIVER` when needed.
5. Run `pnpm test:e2e`; Linux uses `dbus-run-session -- xvfb-run -a pnpm test:e2e`. Each worker seeds a new profile with the authored translation and transcript-review presets. Only restarts within the same spec reuse that worker's profile.

Use a separate Cargo target directory or retain a separate E2E executable for local development. Fixture-enabled binaries must use disposable profiles. Release builds exclude `e2e-test`/`e2e-fixtures`, `test-support` and development validation.

The media-management spec covers track persistence, subtitle replacement/restoration, card retention, HTTP download recovery and AV1 playback. Windows CI generates the AV1 input and sets `SURTITLE_E2E_AV1_FIXTURE`; supply that path for a local run too. Select a spec with `--spec ./e2e/native/media-management.e2e.js`. Do not reseed an existing running profile.

## Coverage and diagnostics

Native tests exercise local imports, 20,000 subtitle rows with bounded rendering, subtitle edits, explicit adoption, contextual interval replay, review scheduling, audio-track selection, downloads/cancellation, card retention, learning restore and complete process restarts. Windows covers decoded native video visibility, six-hour seeking and actual FFmpeg audio extraction. The multitrack fixture deliberately has different mpv and FFmpeg IDs.

The subtitle workflow retains one owned media record across its import, replacement and restoration phases, then cleans it up even on failure. Each phase has its own test budget; real tool inspection waits up to the native IPC limit before asserting the requested track exists. Independent scenarios set up their own inputs. Transcript search checks both expected text and exclusion of nonmatching rows, so an empty result cannot satisfy the search assertion.

The AI recovery/transcript presets are authored saved results with explicit offline accounting. They protect SQLite/IPC behavior and unchanged charges; they do not test cloud recognition. Windows CI uses software rendering and null audio. Tests check actual window DPI, work-area fitting and native clipping in that environment; they do not claim coverage of manual monitor changes or hardware-decoding performance.

Windows test processes run at restricted medium integrity to support WebView2's driver environment and keep SQLite/WAL readers at the same integrity as the app. Normal DOM/IPC specs do not require OS foreground ownership. Windows CI runs them with `--exclude ./e2e/native/playback-rate.e2e.js`, then runs that spec separately with a fresh profile and `SURTITLE_E2E_NATIVE_INPUT=1`, even if a normal spec failed. This keeps all native specs covered without making ordinary tests depend on foreground permission.

Only the explicit native-input run enables foreground assistance from an existing high-integrity parent. It checks the application's job membership, executable, user, session, restricted token and actual window. If Windows refuses `SetForegroundWindow`, the parent may click a verified, uncovered titlebar point on that owned application, then wait for foreground acknowledgement. It never refocuses an already activated window. Playback and video input still run at medium integrity; ordinary medium launchers retain their existing activation path. WebDriver transport retries are disabled so timed-out mutations are not repeated. Script requests have bounded timeouts; failures retain screenshots and player/layout diagnostics under `test-results/native`.

Before builds and again immediately before Windows E2E, hosted CI hides its attached console or, when the shell has none, the foreground Windows Terminal belonging to the same runner user and session. It checks the executable and any package identity, verifies the same process and foreground window again before hiding it, then waits for visibility and foreground acknowledgement. This setup refuses local and self-hosted runs and retains ownership and before/after diagnostics in `test-results/windows-input-console.json`, with the early result preserved as `windows-input-console-pre-build.json`. Run it inside the outer PowerShell step before the restricted test launcher.

The early input checks inspect the rights on the existing window-station handle and launch a disposable medium window through the same foreground handoff, alongside a utility window with an empty client area matching Tao's event-target styles. Only a normal decorated application window with a real client area is eligible for activation. Unidentified job members whose executable-path query returns access denied are excluded; already identified targets still require full validation. The test window must acknowledge foreground, cursor movement and a real native click before the build begins. `test-results/windows-input-smoke.json` retains the result and launcher diagnostics; hiding the runner terminal alone is not evidence that native input works.

Before compiling the app, CI also runs `foreground-activation.test.mjs` by itself with `SURTITLE_E2E_NATIVE_INPUT=1`. Two disposable windows establish a real foreground-policy denial and verify the production caption fallback plus a native client click. The test skips ordinary script runs unless explicitly enabled, so it cannot compete with other UI tests for input.

Resize Windows test windows with `resizeNativeWindow` from `support/native-window.mjs`. EdgeDriver's `setWindowSize` moves and resizes the nested Chromium window instead of the Tauri window, separating HTML from the native video surface. The helper targets only the configured test executable, resizes the top-level client area and verifies that the WebView fills it. Native motion and layout checks also compare the actual video HWND rectangle with the DOM viewport in physical pixels. `saveNativeScreenshot` captures the application window including its native children; WebDriver screenshots capture only the WebView.

Focus a run with `pnpm test:e2e --spec ./e2e/native/draft-study.e2e.js` using the same prepared environment. Real FFmpeg/libmpv Rust integrations are selected through the [required suites](../docs/testing.md#explicit-rust-integration-suites).

Every maintained spec runs in automatic CI on its applicable OS. The native suite selects Windows and Linux specs explicitly, with native input kept sequential. WebDriver capabilities identify the OS; reports distinguish expected application rejection from driver failure. JUnit, session/startup logs and bounded failure diagnostics have unique run/spec/test paths. See the [result guide](../docs/testing.md#results-and-failure-evidence) for the shared summary.
