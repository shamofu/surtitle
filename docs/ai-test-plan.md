# Application test guide

Tests protect application behavior and the build/package operations needed to deliver it. Ordinary CI uses authored fixtures and makes no Vertex requests. Historical model-scoring tools have been removed; their conclusions and source revision remain in [AI evaluation history](ai-evaluation-history.md).

## Routine checks

```powershell
pnpm test
pnpm build
pnpm fmt:rust:check
pnpm test:rust
pnpm test:rust:no-default-features
pnpm lint:rust
pnpm audit:rust
node scripts/check-production-features.mjs
```

`pnpm test` runs React/jsdom and Node script tests. `pnpm test:ui` and `pnpm test:scripts` select one project; `pnpm test:watch` watches both. Browser preview and native application tests use the separate commands in the [E2E guide](../e2e/README.md).

The maintained regressions cover:

- Immutable request approval, zero/unknown pricing, concurrent reservations, cancellation before dispatch, communication failure, crash recovery and settlement exactly once.
- Parser/citation validation, literal source preservation, pending/conflicting transcript ranges, local corrections, stale adoption and saved-card independence.
- Credential boundaries, learning restore, original media retention, selected tool/audio-track identity and process cleanup.
- UI acknowledgement, asynchronous edits, replay/confirmation, review scheduling and real native persistence across process restarts.
- Native source/artifact integrity, package contents, production features and disposable installer data retention.

Tests of exact workflow spelling, historical suite counts, pnpm's generic argument forwarding and retired research report formats are not required.

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

Logs are written under `artifacts/required-rust-tests/<suite>/`; rerunning replaces those logs. Use `--evidence-dir <directory>` to retain another local run. The runner bounds each Cargo build/test invocation and terminates only its owned process tree on timeout/interruption. It does not generate a second input-hash inventory or a suite receipt.

The six-hour suite uses `SURTITLE_LONG_AUDIO_FILE` and test-only optimization (sha2/tools level 3, AI level 1). Generate `test-results/fixtures/six-hour-silence.flac` with `pnpm test:fixtures` before selecting it. Rust asserts all 345,600,000 core samples, bounded preparation time, positive measured storage, removed temporary PCM and Windows process memory; its optional report remains under `work/ai-six-hour-acceptance/`. This measures local silent-audio preparation, not speech quality. The manual native-acceptance workflow runs it separately.

The spoken suite requires `SURTITLE_SPOKEN_FIXTURES` containing the existing pinned WAV/TextGrid/text files for LibriSpeech `1089-134686-0001` and `1089-134686-0003`. Reproducible acquisition of all six files and alignment provenance is not encoded for clean CI; no automatic speech download or mandatory hosted speech test is implied.

## Live verification and retained fixtures

Product parser/worker tests keep their authored [fixed responses](../crates/ai/tests/fixtures/README.md) and relevant regression data. Saved real-response application checks remain local, separate from removed WER/CER and campaign-scoring programs. [Credential-based verification](vertex-verification.md) explains the remaining development CLI and normal application workflow.

A valid API response, passing mock or automated player event does not certify model quality. Further evaluation should define its material, references, metrics and approved requests before execution; see [evaluation guidance](transcribe-production.md).
