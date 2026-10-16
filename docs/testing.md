# Application test guide

Tests cover application behavior, native dependencies and release packaging. Ordinary CI uses authored fixtures and makes no Vertex generation requests.

Every maintained test runs automatically on pull requests and pushes on at least one applicable OS. Windows-only checks run on Windows; native input has its own sequential step. There are no manual-only test suites. Local commands select the same maintained tests.

Vitest owns unit and script tests, Playwright owns browser behavior, WebdriverIO owns the real Tauri application, and cargo-nextest owns Rust execution. The native suite retains the [external tauri-driver route](https://v2.tauri.app/develop/tests/webdriver/) shared with production package verification. WebdriverIO's newer embedded Tauri service is an available alternative, but requires an additional application plugin; this suite already owns profile isolation, driver matching and process cleanup, and does not need macOS support.

## Routine checks

```powershell
pnpm test
pnpm build
pnpm test:browser
pnpm check:ipc
pnpm fmt:rust:check
pnpm test:rust
pnpm test:rust:no-default-features
pnpm test:rust:doc
pnpm lint:rust
pnpm audit:rust
node scripts/check-version.mjs
node scripts/check-production-features.mjs
```

`pnpm test` runs React/jsdom and Node script tests. `pnpm test:ui` and `pnpm test:scripts` select one project; `pnpm test:watch` watches both.

Install cargo-nextest 0.9.148 with `pnpm setup:nextest` for Rust tests. Workspace and no-default-feature runs use separate nextest profiles; doctests remain a separate Cargo invocation. The audio-preparation example's four unit tests are also selected by the workspace suite. Test retries are disabled for Rust and native E2E; browser CI allows one retry and reports it separately.

The required `browser` CI job runs behavior, UI structure, state and layout checks in a pinned Linux container. `pnpm test:structure` runs the focused UI contracts, which are also included in `pnpm test:browser`. They assert accessible roles, names and states, form values, viewport bounds and element placement instead of comparing screenshot pixels. The aggregate `ci` check requires this job as well as version validation, native dependencies, Linux, Windows and package verification. See the [E2E guide](../e2e/README.md) for local commands and failure evidence. The same browser checks can also run directly on Windows.

The maintained regressions cover:

- Immutable request approval, zero/unknown pricing, concurrent reservations, cancellation before dispatch, communication failure, crash recovery and settlement exactly once.
- Approval-bound transcription HTTP 429 retries: success and exhaustion, Retry-After timing, retained monetary holds and unpriced counts, legacy approvals, pause/cancel/restart, superseded workers, and retry-aware quotes and Japanese/English progress displays.
- Serial native dispatch with interactive priority and bulk fairness; zero-floor pacing, congestion backoff, retry timing precedence, pause/cancel while waiting, and no UI-triggered send.
- Parser/citation validation, literal source preservation, pending/conflicting transcript ranges, local corrections, stale adoption and saved-card independence.
- Priced transcription start without duplicate consent, unpriced acknowledgement, automatic preparation, range re-transcription and setup restoration in the shared transcript panel.
- Transcribe text retained when word timing is missing, reversed, out of range or unaligned; source-block bounds preserve submitted context and never become synchronized captions or subtitle exports.
- Word-anchor boundary deduplication and deterministic conflict choice, while retaining repeated words elsewhere and original alternatives.
- Progressive publication across restart, original-edition saving once, unreceived whole-cue preservation, edit/translation/delete/move protection, newer-request ownership and injected transaction rollback.
- Source-block card audio subranges, persisted incomplete audio-range input, immutable source snapshots and version-3 archive compatibility with versions 1 and 2.
- Credential boundaries, learning export/restore, archive size limits, missing audio, atomic destination replacement and original media retention.
- Restore rejection/rollback before commit and explicit warnings after commit, with generation changes, editor invalidation, database reopen and native playback reconciliation.
- Selected tool/audio-track identity, staged preparation cancellation/source-change cleanup, resource/revision recovery, stale in-flight reads, failed refetch retry and generated IPC contracts.
- Settings/card autosave, incomplete/conflicting draft recovery, budget-store authority, failed writes and close waiting for detached saves or later input; card audio and review history survive edits/restart.
- React Aria modal focus/IME/Escape, native popup exclusions, monitor fitting, bounded list rendering, confirmed-cue replay and review scheduling.
- Native source/artifact integrity, package contents, production features and disposable installer data retention.

Application AI integration tests use the production approval, execution, parser, ledger and result-application paths with real disposable SQLite databases. The `surtitle-ai/test-support` feature replaces authentication and transport with fixed offline responses and bounded synchronization gates. It is enabled only through the desktop crate's development dependency; the production feature check rejects it. These tests cover multi-request execution, conflicting edits, cancellation, application failure and uncertain transport outcomes without cloud calls. They do not evaluate generated-language quality.

The [E2E guide](../e2e/README.md) covers browser and native application setup. [Native runtime and packaging](native-runtime.md) covers DLL loading/initialization smoke tests and installer lifecycle tests. Installer lifecycle checks require a disposable Windows profile.

## Explicit Rust integration suites

Some Rust tests need real FFmpeg or Windows DLLs and remain ignored in the unit run. `pnpm test:rust:required <suite>` selects them through nextest in automatic CI. Before execution, it compares nextest's JSON inventory with the exact registered package/test names. Missing, extra or unexpectedly non-ignored cases fail discovery. Package feature modes remain separate, and native tests run serially with per-test time limits. Nextest owns test execution and cancellation; the CI job bounds compilation time.

| Suite | Environment and behavior |
| --- | --- |
| `linux-ffmpeg` | Linux; card PCM tail/source-clock extraction and selected audio-stream extraction |
| `windows-native` | Windows extraction, real mpv load/restore, Silero preparation, real speech/pause detection and cancellation/source-change cleanup |

Set `SURTITLE_TEST_FFMPEG` to an existing absolute FFmpeg executable with its matching ffprobe. Windows native suites also need [prepared native DLLs](native-runtime.md) and `native-prepare.ps1 -WithDevModel` for Silero. Missing inputs fail the actual test rather than becoming skips.

```powershell
$env:SURTITLE_TEST_FFMPEG = 'C:\Tools\ffmpeg\ffmpeg.exe'
python e2e/support/acquire-spoken-fixtures.py
$env:SURTITLE_SPOKEN_FIXTURES = "$PWD/work/spoken-fixtures"
pnpm test:rust:required windows-native
```

Each invocation creates `artifacts/required-rust-tests/<suite>/run-*/` with discovery/execution logs, per-package JUnit and a summary recording failed or unexecuted groups. A rerun cannot overwrite or reuse a previous success report. `--evidence-dir <directory>` changes the parent directory.

The Windows native suite includes `prepare::tests::real_preparation_failures_remove_receipts_and_temporary_files`, which exercises real cancellation and source replacement and checks that failed preparation leaves neither a receipt nor temporary output.

The speech fixture script downloads two small WAV files from a pinned upstream commit and verifies their SHA-256 and PCM format. The required speech case checks positive Silero detection, a warning for an inserted interior pause, unchanged PCM and authored subtitle boundaries. It makes no cloud generation request.

The runner selects full Rust test names. When moving an integration test between application modules, update the registry in `e2e/support/run-required-rust-tests.mjs` in the same change, then run the required suite. A normal workspace test run does not execute these ignored native tests.

The required Silero case also completes a generated six-minute input through multiple chunks and verifies sample continuity, the exact endpoint and temporary PCM removal. Unit tests cover six-hour sample boundaries, while native E2E covers six-hour seeking. These are functional checks, not runtime or memory benchmarks. The two ignored crash helpers are invoked by ordinary parent tests and must not be selected as standalone integrations.

## Results and failure evidence

CI publishes a short console report, JUnit and an Actions step summary. Successful unit tests keep their console output quiet in CI; failed tests retain their logs. JavaScript reports are under `test-results/vitest`, browser JSON/JUnit/traces under `test-results/browser`, Rust reports under `test-results/nextest`, and native worker evidence under `test-results/native/<run>/<spec>`. Required Rust JUnit files are copied into their unique run directory; the temporary staging report is not counted twice.

`node scripts/summarize-tests.mjs` aggregates retained local reports, including separate reruns. CI also supplies step outcomes so failed setup and unexecuted steps are visible even when a runner produced no report. Native startup, readiness and cleanup failures have separate structured records and fail the run even when no test body ran. Expected IPC rejection is checked as an application result; transport failures remain failures. Successful tests do not produce screenshot sequences or videos. Failure diagnostics retain the original cause and have a bounded collection time. Native page records include two geometry samples and bounded animation details to distinguish layout movement from a failed stability check. Package summaries read only approved status fields from existing smoke reports.

## Live verification and fixtures

Parser/worker tests use authored [fixed responses](../crates/ai/tests/fixtures/README.md). [Native application checks](../e2e/README.md) use fresh offline profiles. [CLI tool verification](tools.md#verification) includes the required generated-media extraction tests.

[Credential-based verification](vertex-verification.md) describes the development CLI and application workflow for explicitly approved Vertex requests. Inspect generated text and timing against the source; a valid API response, passing mock or automated player event does not establish model quality.

Historical hardware/IME/DPI comparisons and the identified installed package are indexed in [redesign evidence](redesign/acceptance.md). Their counts and timing observations describe the recorded source, not the current suite. Use current commands above for new verification; retained historical paths are not supported test entry points.
