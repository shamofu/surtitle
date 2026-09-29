# Application test guide

Tests cover application behavior, native dependencies and release packaging. Ordinary CI uses authored fixtures and makes no Vertex generation requests.

## Routine checks

```powershell
pnpm test
pnpm build
pnpm fmt:rust:check
pnpm test:rust
pnpm test:rust:no-default-features
pnpm lint:rust
pnpm audit:rust
node scripts/check-version.mjs
node scripts/check-production-features.mjs
```

`pnpm test` runs React/jsdom and Node script tests. `pnpm test:ui` and `pnpm test:scripts` select one project; `pnpm test:watch` watches both.

The maintained regressions cover:

- Immutable request approval, zero/unknown pricing, concurrent reservations, cancellation before dispatch, communication failure, crash recovery and settlement exactly once.
- Parser/citation validation, literal source preservation, pending/conflicting transcript ranges, local corrections, stale adoption and saved-card independence.
- Credential boundaries, learning export/restore, archive size limits, missing audio, atomic destination replacement and original media retention.
- Selected tool/audio-track identity, process cleanup, resource-scoped query invalidation, stale asynchronous results and failed preference writes.
- UI acknowledgement, asynchronous edits, confirmed-cue validation, replay/confirmation, review scheduling and real native persistence across process restarts.
- Native source/artifact integrity, package contents, production features and disposable installer data retention.

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

The runner selects full Rust test names. When moving an integration test between application modules, update the registry in `scripts/run-required-rust-tests.mjs` in the same change, then run the required suite. A normal workspace test run does not execute these ignored native tests.

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
