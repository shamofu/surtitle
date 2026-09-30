# Surtitle E2E checks

`pnpm test` runs UI and script regressions. `pnpm test:browser` checks the browser-only preview with Playwright; install Chromium with `pnpm exec playwright install chromium` (`--with-deps` on Linux). The preview provides no fake persisted library or native service.

`pnpm test:e2e` launches the actual fixture-enabled Tauri binary through `tauri-driver`. Windows uses real WebView2/libmpv and generated media; Linux uses WebKitGTK/Xvfb and a deterministic E2E-only playback adapter. No ordinary E2E test has cloud credentials or sends a billable provider request.

Browser interaction tests use explicit test-only native transport fixtures for study and import flows. They exercise the real router, query providers and virtualized transcript; persistence and playback integration remain the responsibility of native tests. The ordinary browser preview still has no fabricated native state.

## Browser CI and visual baselines

The required browser CI job runs the functional suite and `pnpm test:visual` in the image defined by `scripts/browser-tests.Dockerfile`. Its Playwright image is pinned by version and digest; Node, pnpm and Rust follow the repository pins. The source-only build context excludes host dependencies, build output and credentials. No desktop build is needed.

With a Linux Docker engine available, run the same environment locally:

```sh
docker build --platform linux/amd64 -f scripts/browser-tests.Dockerfile -t surtitle-browser-tests .
docker run --rm --init --ipc=host surtitle-browser-tests
```

The six visual checks cover the study screen, phrase save form and partial import failure, each in Japanese/light and English/dark at 1024×700. Browser locale, time zone, clock, scale and fonts are fixed; animations and the caret are disabled. Baselines live under `e2e/visual/snapshots`. Ordinary runs reject missing or changed images and never update them. The broader language/theme/viewport coverage remains in the functional suite.

Generate or deliberately update the six baselines in this same container, then inspect every PNG before including it in a change. The following PowerShell commands bind only the snapshots and diagnostic output; dependencies remain inside the container:

```powershell
New-Item -ItemType Directory -Force e2e/visual/snapshots, test-results, playwright-report | Out-Null
docker run --rm --init --ipc=host `
  --mount "type=bind,source=$($PWD.Path)/e2e/visual/snapshots,target=/app/e2e/visual/snapshots" `
  --mount "type=bind,source=$($PWD.Path)/test-results,target=/app/test-results" `
  --mount "type=bind,source=$($PWD.Path)/playwright-report,target=/app/playwright-report" `
  surtitle-browser-tests pnpm test:visual --update-snapshots
```

Repeat that command without `--update-snapshots` to check the new baselines. Rebuild the image after source or baseline changes to verify the default CI command against the complete current checkout. Windows runs of `pnpm test:browser` remain supported; direct Windows visual runs stop with instructions to use the fixed Linux environment.

If Docker runs inside the existing WSL Ubuntu distribution, invoke these Docker commands through `wsl -d Ubuntu -u root -- docker` and use absolute WSL paths for the build context and bind sources (for example `/mnt/c/path/to/surtitle`). The host's Windows `node_modules` must not be mounted into the container.

CI retains `test-results/browser`, `test-results/visual`, `playwright-report/browser` and `playwright-report/visual`, including actual/expected/diff images and failure traces. For a local run, use the output mounts shown above to retain these reports after the container exits. Update the Docker image and visual environment identifier together when changing Playwright; review regenerated baselines in the new rendering environment.

## Native setup

1. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm build:native:e2e` and `pnpm build:fixtures`. Windows also needs the [native DLLs](../docs/native-runtime.md).
2. Install `tauri-driver` with `pnpm setup:driver`; set `SURTITLE_TAURI_DRIVER` to its absolute path. On Windows run `pwsh -File scripts/prepare-webdriver.ps1` for the matching EdgeDriver; on Linux use WebKitWebDriver.
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

Focus a run with `pnpm test:e2e --spec ./e2e/native/draft-study.e2e.js` using the same prepared environment. Real FFmpeg/libmpv Rust integrations are selected through the [required suites](../docs/testing.md#explicit-rust-integration-suites).

## Saved-response local checks

`e2e/saved/` is excluded from the ordinary native glob. It exercises an explicitly prepared local profile from saved provider responses and the [frozen ten-task set](../docs/draft-study-task-set.json), including bookmark/replay persistence and a layout diagnostic.

These checks cover transport and persistence; they do not measure human listening, semantic correctness or editing effort. The separately opt-in public-download check is described in [upstream tests](upstream/README.md).
