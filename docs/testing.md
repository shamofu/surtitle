# Application test guide

Tests cover application behavior, native dependencies and release packaging. Ordinary CI uses authored fixtures and makes no Vertex generation requests.

## Routine checks

```powershell
pnpm test
pnpm build
pnpm test:browser
pnpm fmt:rust:check
pnpm test:rust
pnpm test:rust:no-default-features
pnpm lint:rust
pnpm audit:rust
node scripts/check-version.mjs
node scripts/check-production-features.mjs
```

`pnpm test` runs React/jsdom and Node script tests. `pnpm test:ui` and `pnpm test:scripts` select one project; `pnpm test:watch` watches both.

The required `browser` CI job runs the browser suite and six visual comparisons in the same pinned Linux container. The aggregate `ci` check requires this job as well as version validation, native dependencies, Linux, Windows and package verification. See the [E2E guide](../e2e/README.md) for the visual baseline workflow; Windows browser runs do not generate the Linux reference images.

The maintained regressions cover:

- Immutable request approval, zero/unknown pricing, concurrent reservations, cancellation before dispatch, communication failure, crash recovery and settlement exactly once.
- Approval-bound transcription HTTP 429 retries: success and exhaustion, Retry-After timing, retained monetary holds and unpriced counts, legacy approvals, pause/cancel/restart, superseded workers, and retry-aware quotes and Japanese/English progress displays.
- Transcription pacing: normal and congestion-adjusted intervals, retry timing precedence, Japanese/English countdowns and processing details, pause/cancel while waiting, and preserved received subtitles without a UI-triggered send.
- Parser/citation validation, literal source preservation, pending/conflicting transcript ranges, local corrections, stale adoption and saved-card independence.
- Priced transcription start without duplicate consent, unpriced acknowledgement, automatic preparation, range re-transcription and setup restoration in the shared transcript panel.
- Transcribe text retained when word timing is missing, reversed, out of range or unaligned; source-block bounds preserve submitted context and never become synchronized captions or subtitle exports.
- Word-anchor boundary deduplication and deterministic conflict choice, while retaining repeated words elsewhere and original alternatives.
- Progressive publication across restart, original-edition saving once, unreceived whole-cue preservation, edit/translation/delete/move protection, newer-request ownership and injected transaction rollback.
- Source-block card audio subranges, persisted incomplete audio-range input, immutable source snapshots and version-3 archive compatibility with versions 1 and 2.
- Credential boundaries, learning export/restore, archive size limits, missing audio, atomic destination replacement and original media retention.
- Restore validation rejection, backup creation failure and an injected write failure after replacement has started, with database reopen and native playback reconciliation.
- Selected tool/audio-track identity, process cleanup, resource-scoped query invalidation, stale asynchronous results and failed preference writes.
- UI acknowledgement, asynchronous edits, confirmed-cue validation, replay/confirmation, review scheduling and real native persistence across process restarts.
- Native source/artifact integrity, package contents, production features and disposable installer data retention.

Application AI integration tests use the production approval, execution, parser, ledger and result-application paths with real disposable SQLite databases. The `surtitle-ai/test-support` feature replaces authentication and transport with fixed offline responses and bounded synchronization gates. It is enabled only through the desktop crate's development dependency; the production feature check rejects it. These tests cover multi-request execution, conflicting edits, cancellation, application failure and uncertain transport outcomes without cloud calls. They do not evaluate generated-language quality.

The [E2E guide](../e2e/README.md) covers browser and native application setup. [Native runtime and packaging](native-runtime.md) covers DLL smoke tests, source/notices audits and installer lifecycle verification. Installer lifecycle checks require a disposable Windows profile.

## Explicit Rust integration suites

Some Rust tests need real FFmpeg, Windows DLLs or optional speech data and therefore remain ignored in an ordinary unit run. `pnpm test:rust:required <suite>` invokes each selected test through Cargo with `--ignored --exact --test-threads=1`. It fails on a nonzero process result, zero matched tests or an ignored result. Cargo manages compilation reuse; the application code validates the selected tools and assets.

| Suite | Environment and behavior |
| --- | --- |
| `linux-ffmpeg` | Linux; card PCM tail/source-clock extraction and selected audio-stream extraction |
| `windows-ffmpeg` | The same extraction cases on Windows x64 |
| `windows-native` | Windows extraction plus real mpv load/restore and Silero preparation |
| `windows-six-hour` | Optional Windows six-hour streaming/performance acceptance |
| `windows-spoken` | Local Windows speech/pause review with existing explicit speech fixtures |

Set `SURTITLE_TEST_FFMPEG` to an existing absolute FFmpeg executable with its matching ffprobe. Windows native suites also need [prepared native DLLs](native-runtime.md) and `native-prepare.ps1 -WithDevModel` for Silero. Missing inputs fail the actual test rather than becoming skips.

```powershell
$env:SURTITLE_TEST_FFMPEG = 'C:\Tools\ffmpeg\ffmpeg.exe'
pnpm test:rust:required windows-native
```

Logs are written under `artifacts/required-rust-tests/<suite>/`; rerunning replaces those logs. Use `--evidence-dir <directory>` to retain another run. The runner bounds each Cargo build/test invocation and terminates only its owned process tree on timeout/interruption.

The runner selects full Rust test names. When moving an integration test between application modules, update the registry in `e2e/support/run-required-rust-tests.mjs` in the same change, then run the required suite. A normal workspace test run does not execute these ignored native tests.

The six-hour suite verifies complete sample coverage, bounded preparation time, storage use, temporary PCM cleanup and Windows process memory. It measures local silent-audio preparation, not speech quality. After preparing the native DLLs and development Silero model:

```powershell
$env:FFMPEG_PATH = $env:SURTITLE_TEST_FFMPEG
pnpm test:fixtures
$env:SURTITLE_LONG_AUDIO_FILE = Join-Path $PWD 'test-results/fixtures/six-hour-silence.flac'
pnpm test:rust:required windows-six-hour
```

The runner applies test-only optimization. The test writes its report under `work/ai-six-hour-acceptance/`; the manual native-acceptance workflow runs it separately.

The spoken suite requires `SURTITLE_SPOKEN_FIXTURES` containing the pinned WAV/TextGrid/text files for LibriSpeech `1089-134686-0001` and `1089-134686-0003`. Acquisition of all six files and alignment provenance is not automated; supply the matching local files before selecting this suite.

## Live verification and fixtures

Parser/worker tests use authored [fixed responses](../crates/ai/tests/fixtures/README.md). [Saved-response application checks](../e2e/README.md#saved-response-local-checks) require an explicitly prepared local profile. [CLI tool verification](tools.md#verification) includes opt-in tests of installed executables and managed downloads.

[Credential-based verification](vertex-verification.md) describes the development CLI and application workflow for explicitly approved Vertex requests. Inspect generated text and timing against the source; a valid API response, passing mock or automated player event does not establish model quality.
