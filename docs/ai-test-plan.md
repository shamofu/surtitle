# AI test plan

Updated 2026-09-13; historical quality criteria below retain their original scope. This plan separates free, deterministic regression tests from explicitly authorized live Vertex evaluations. It does not itself authorize paid requests. See [AI design](ai.md), [verification instructions](vertex-verification.md), and [recorded status](status.md).

For the subsequent Transcribe production campaign, use the separately versioned [review-assisted evaluation policy](transcribe-production.md) and [implementation evidence](transcribe-implementation-2026-09-12.md). That policy makes 90% automatic joining an improvement target and evaluates local recovery. The earlier criteria and reports below remain historical; vocabulary and explanations currently remain experimental.

## Execution stages

| Stage | Work | Generation requests | Completion evidence |
| --- | --- | --- | --- |
| A | Unit tests, fixed responses, injected faults, process crashes | None | Approval, credential, accounting, and replay invariants pass |
| B | Real FFmpeg/VAD, Tauri, SQLite, source audio, and review UI | None | Sample coverage, cancellation, recovery, and explicit adoption pass |
| C | Prepare independent references, audio, hashes, and quotes | None | Exact model/settings/scope and reservations are reviewable |
| D | Small live API contract samples for every task type | Approved scope only | Actual authentication, schema, timestamps, usage, and settings are understood |
| E | Quality evaluation against reviewed references | Approved scope only | Per-language and per-task criteria below are evaluated honestly |
| F | Regression, product behavior, and distribution verification | Normally none | Evidence matches implementation and remaining limitations are recorded |

A spending or credential invariant failure blocks further paid evaluation until corrected. An unknown outcome, unexpected model/endpoint, or unresolvable usage stops that batch. A rejected response with valid usage is charged and preserved, but cannot be counted as usable output. Retries need separate approval; remaining unsent cases are not silently turned into retries.

No application model catalog or quality allowlist is introduced. Evaluations describe tested models and conditions. Users may select an arbitrary compatible Gemini ID and explicitly approve a trial. Passing quality criteria is still required before claiming a reliable completed workflow.

## Mandatory regression coverage

- Approval binds immutable source bytes/revision, request bodies, model, location, output/thinking settings, price snapshot, request count, and submitted audio duration. Any changed quote digest clears UI acknowledgement.
- Priced budgets start at zero. Concurrent reservations cannot overspend a configured bound. Authentication-time cancellation or budget reduction is rechecked immediately before dispatch.
- Unpriced approval is explicit and scope-based. Successful unpriced usage, an unknown network outcome, known costs, and monetary holds remain distinct. Neither unpriced nor unknown is displayed as free.
- A completed request cannot be resent or settled twice. Process termination after reservation, dispatch, partial/full reception, and settlement preserves conservative recovery behavior.
- Unknown priced holds remain counted across day/month boundaries and acknowledgement. Reopening a process does not reactivate prior execution approval.
- Keys stay in Rust and DPAPI. Malformed keys, unauthorized access, failed decryption, invalid OAuth endpoints, and diagnostics containing secret-like material cannot expose credentials to IPC, logs, backups, or exports.
- HTTP errors, redirects, timeouts, truncated/oversized responses, malformed usage, thinking usage, invalid structured output, and over-reservation settlement exercise the production worker through private test doubles.
- Translations require a complete one-to-one source-ID mapping. Vocabulary/explanations require valid adjacent source cues and the selected phrase. Stale source text, times, status, or language prevents local application.
- Quoted instructions are data. URLs, code, JSON, and placeholders survive translation. A2/B1/C1 produce distinct frozen requests; dictionary-form normalization preserves semantic roles.
- Cards retain consistent source text, translation, audio range, selected audio stream, and immutable source cues. Later subtitle changes do not overwrite saved learning content.
- Review and export/restore send no AI requests. Restore cannot import cost ledgers, keys, paid jobs, approvals, or external-tool selections.

Run the relevant Rust tests, frontend tests, and Node evaluation tests after changes. Normal CI uses fixed responses and never consumes a Vertex budget.

## Audio and native integration

Core intervals must cover every selected PCM sample exactly once. Send intervals include all context overlap in their estimates. Test strong/weak pauses, 90–150-second targets, the 180-second maximum, short tails, long uninterrupted speech, and non-integer millisecond tails.

Use real FFmpeg, Silero, and ONNX Runtime for local preparation. Verify the chosen audio stream rather than assuming the first stream. Tool replacement, disappearance, corrupt models, decode failures, insufficient storage, and cancellation must not produce an adoptable receipt. Streaming memory must remain bounded.

A six-hour fixture is processed locally in full; record elapsed time, peak memory scope, temporary storage, final storage, sample counts, and tool hashes. The [recorded silent fixture](ai.md#six-hour-local-processing-evidence) is a processing test, not a speech-quality benchmark.

Native E2E verifies SQLite and IPC through real WebView2/libmpv on Windows and WebKitGTK under Xvfb on Linux. Use multilingual paths containing spaces and ampersands. Check 20,000-cue navigation, six-hour metadata/seeking, source-track persistence, subtitle version replacement/recovery, card audio, URL cancellation/retry cleanup, and that no paid requests occur.

### Required integration suites

`scripts/run-required-rust-tests.mjs` makes selected ignored regressions mandatory. It compiles each selected Rust test target once, obtains its executable from Cargo's JSON output, and lists each complete test name with `--ignored --exact`. Each listing must contain exactly that one test. Execution requires its success line, exactly one pass, and zero ignored tests; a successful process that runs zero tests is a failure. Tests run sequentially with `--test-threads=1`. Success output is retained with `--show-output`; stdout, stderr, command arguments, durations, input paths/hashes and the suite report are written below `artifacts/required-rust-tests/<suite>/`. An existing evidence directory is rejected; use `--evidence-dir` for another fresh local run.

The ordinary Linux verification runs `linux-ffmpeg` (three tests). The ordinary Windows job runs `windows-native` (six tests) after consuming its same-run/SHA native artifact, preparing/smoke-checking the DLLs and development model, and making FFmpeg available. The two card-audio tests were already explicitly executed by both jobs; this replaces their permissive prefix invocation and adds the selected-stream test, without duplicating card coverage. `windows-ffmpeg` is the same three-test subset for local Windows checks that do not have native DLLs/model prepared.

The following inventory accounts for all 12 ignored declarations. Ordinary `cargo test --workspace --all-features` still leaves explicit integration tests ignored. Child helpers are deliberately invoked only by their parent tests.

| Complete Rust test name | Execution and dependency |
| --- | --- |
| `tool_commands::card_audio::tests::installed_ffmpeg_preserves_native_rate_wav_tail_without_padding` | Linux/Windows FFmpeg suites; selected absolute FFmpeg path and adjacent ffprobe; generated PCM |
| `tool_commands::card_audio::tests::installed_ffmpeg_preserves_source_clock_and_cleans_failed_outputs` | Linux/Windows FFmpeg suites; generated PCM/AAC/MP3, timestamp offsets and cleanup |
| `command::tests::multitrack_extraction_preserves_selected_stream` | Linux/Windows FFmpeg suites; generated one-second 440/880 Hz multitrack MKV and both extracted waveforms |
| `player::subtitle_tests::real_mpv_load_restores_position_and_maps_audio_stream` | `windows-native`; `surtitle --lib --features e2e-test`, native DLLs, FFmpeg |
| `commands::restore_tests::real_mpv_restore_reconciles_resume_audio_subtitles_and_stale_ticks` | `windows-native`; same native prerequisites, independent temporary profile |
| `prepare::tests::real_silero_and_ffmpeg_preserve_selection_time` | `windows-native`; `surtitle-ai --lib --no-default-features`, pinned ORT/Silero, generated PCM, FFmpeg |
| `command::tests::installed_tools_probe_and_extract` | Explicit local manual diagnostic; existing absolute `SURTITLE_TEST_FFMPEG`, `SURTITLE_TEST_YTDLP` and `SURTITLE_TEST_DENO` paths; local extraction and capability probes |
| `manager::tests::live_rolling_update` | Explicit Windows manual diagnostic with `SURTITLE_TEST_UPDATE=ffmpeg\|deno\|yt-dlp`; downloads and executes the selected tool in temporary app-owned storage |
| `prepare::tests::six_hour_streaming_acceptance` | `windows-six-hour`; separate manual native-acceptance workflow or prepared local environment; generated six-hour silence |
| `prepare::spoken_pause_test::real_spoken_audio_and_interior_pause_require_only_local_warning_review` | `windows-spoken`; local only, existing explicit speech fixture directory and native prerequisites |
| `ledger::fault_tests::process_checkpoint_child` | Subprocess helper for ordinary parent fault tests, with an isolated temporary database; never selected independently |
| `vertex::fault_tests::crash_child_after_paid_dispatch` | Subprocess helper for ordinary parent crash tests using fixed transport; its name does not mean a real paid API call |

The Windows E2E suites remain necessary. Media management already checks restored playback/audio selection after an entire application restart and the frequency of saved card audio. Sentence playback already checks caption stops and repeat priority. The additional direct libmpv tests cover load-in-progress/play reconciliation, invalid-media completion, and restoration while another thread persists playback ticks every millisecond, including the actual restored subtitle text, stop boundaries and missing/removed media. The small tools test additionally checks both selected frequencies on Linux. Native E2E software rendering uses `hwdec=no`, D3D11 WARP and null audio; it does not establish hardware-decoder or speaker-output quality.

The upstream workflow and its separate live integration target were removed from main. The required runner therefore has no upstream acquisition suite or snapshot handoff. The two remaining tools diagnostics above stay manual and are outside ordinary CI. The external-path diagnostic uses already selected executables and performs no tool acquisition; the rolling-update diagnostic acquires its selected tool only when explicitly invoked. Required suites treat an unsupported OS, missing executable, absent native asset, wrong hash, missing test or skipped test as an error.

Local commands, after preparing the relevant dependencies:

```sh
SURTITLE_TEST_FFMPEG="$(command -v ffmpeg)" node scripts/run-required-rust-tests.mjs linux-ffmpeg
```

```powershell
$env:SURTITLE_TEST_FFMPEG = 'C:\Tools\ffmpeg\ffmpeg.exe'
node scripts/run-required-rust-tests.mjs windows-ffmpeg

# Requires an already selected source-built native payload; the model remains a development fixture.
pwsh scripts/native-prepare.ps1 -WithDevModel
pwsh scripts/native-smoke.ps1
node scripts/run-required-rust-tests.mjs windows-native

# Authored silence is generated locally; no speech recording is downloaded.
node scripts/generate-fixtures.mjs
$env:SURTITLE_LONG_AUDIO_FILE = Join-Path $PWD 'test-results/fixtures/six-hour-silence.flac'
node scripts/run-required-rust-tests.mjs windows-six-hour

$env:SURTITLE_SPOKEN_FIXTURES = 'C:\existing\reviewed-librispeech-fixtures'
node scripts/run-required-rust-tests.mjs windows-spoken
```

The optional existing-tool diagnostic can be invoked separately after setting all three executable paths; it does not use the required-suite runner:

```powershell
$env:SURTITLE_TEST_YTDLP = 'C:\Tools\yt-dlp.exe'
$env:SURTITLE_TEST_DENO = 'C:\Tools\deno.exe'
cargo test -p surtitle-tools --lib --locked command::tests::installed_tools_probe_and_extract -- --ignored --exact --test-threads=1 --show-output
```

Silero is fetched by `native-prepare.ps1 -WithDevModel` from the commit-fixed URL in `native/runtime-windows-x64.json` and checked against its SHA-256. It is MIT-licensed and stays under `work/native-fixtures`, outside bundled resources. The runner checks the manifest's three DLL hashes and model hash before native execution; in CI it also requires the effective manifest's current SHA. The AI integration tests retain their independently fixed ORT DLL/model expectations. A deliberate ORT/model version change must update the corresponding tests and evidence together.

The spoken test requires six existing hash-pinned files: WAV, text and TextGrid for LibriSpeech utterances `1089-134686-0001` and `1089-134686-0003`. The WAV files preserve 52,400 and 42,880 PCM samples. TextGrid alignment is not human timing ground truth. A reproducible acquisition/conversion route for these exact six bytes, including distributable alignment provenance and license evidence, is not yet encoded for clean CI. Therefore no speech download or scheduled speech suite is added. Existing local fixtures can run the strict suite; [historical spoken-pause evidence](ai-audio-quality-2026-09-09.md#real-spoken-audio-integration-check) remains separate from a new hosted CI result.

Six hours describes input duration, not elapsed test time. The manual `native-acceptance.yml` builds and consumes the same-run/SHA native artifact, generates silence, and invokes only `windows-six-hour`. That suite uses test-only optimization levels 3 for sha2/surtitle-tools and 1 for surtitle-ai, matching the historical measurement configuration. It requires all 345,600,000 core samples, zero cloud calls, removed temporary PCM, positive measured storage/chunk counts and Windows working-set evidence with its limited scope. Preparation must finish within 360 seconds; the external process watchdog also bounds hangs. The acceptance workflow has no publish job and does not promote its output into a release.

| Work | Cost evidence and current limit |
| --- | --- |
| Existing card regressions | Local Windows 2026-09-13: native-rate tail 15.79 seconds and source-clock/cleanup 184.98 seconds, both passing. Historical source-clock run: 194.14 seconds |
| Added selected-stream regression | Local Windows 2026-09-13: 12.38 seconds, passing. One-second generated media and two half-second extractions; each FFmpeg command has a 30-second internal bound, runner limit three minutes; hosted timing remains to be measured |
| Direct libmpv/Silero regressions | Short generated inputs and bounded player waits; runner limit three minutes each; no new native execution measurement without prepared DLLs/model |
| Manual tools diagnostics | External-path probe/extraction and rolling-update acquisition have no new execution measurement or hosted CI budget; neither is selected by the required runner |
| Six-hour acceptance | Historical preparation 122.2166538 seconds, 180 chunks and about 51 MB Rust-process peak working set; excludes FFmpeg and OS cache. New hosted measurements remain separate |
| Compilation | Local Windows 2026-09-13: Tauri library target 103.924 seconds, tools library target 31.226 seconds. Targets compile once per suite, with a 20-minute process watchdog and existing Rust caches |

The 2026-09-13 local `windows-ffmpeg` run passed all three exact-name/list/run checks with the existing user-selected FFmpeg n9.0.1; the external executables were hashed before and after tests and were not copied into distribution. Evidence, including stdout/stderr, measured command durations, selected tool hashes/version and the successful suite report, is retained under `work/required-rust-verification-20260913/`. Compilation used the separate `work/required-rust-target` output directory. The two libmpv test names were also confirmed by actual exact listings; neither body ran. These are local working-checkout results, not a hosted same-SHA native run.

The runner's 14 local unit checks cover suite selection, exact-name/zero-count failures, environment/hash failures, tool replacement during a passing test, acceptance-report/PCM validation and timeout termination of its own process tree while an unrelated process continues. Full native execution and hosted workflow success are separate completion evidence; this checkout did not have the prepared native DLLs/model. None of these suites makes an external paid API request or changes the existing native source/license, installer, container-isolation, same-SHA or release-publication gates.

## Transcript review and repair

- Missing chunks remain pending. An empty, successfully received transcription is distinct from an unreceived response.
- Stitching only removes matching overlap at matching times. Natural repetition elsewhere remains intact. Disagreements retain both original results.
- A VAD no-speech range containing generated text requires explicit review; acknowledgement changes the draft digest without discarding the original.
- Adoption requires all chunks, resolved boundaries/warnings, a fresh digest, and a separate final acknowledgement. SQLite updates and the adoption marker are atomic.
- Reapplication after restart preserves later manual edits and cards.
- Boundary repair prepares no more than 30 seconds as a separate immutable job with a separate quote/approval. Its output remains a review alternative, not an automatic replacement.

Fixed native fixtures are restricted to the e2e-test feature and dedicated data roots. They do not establish real-model quality.

## References and evaluation data

The repository's authored corpus has T01/T02/T03 English and Japanese cases, 120 source cues, 61 vocabulary reference proposals, and 20 boundary proposals. Authored references and synthetic timestamps must not be passed off as independently recorded speech.

A quality run requires a reference review independent of the target output. Automated metrics and an explicit **AI review** are the selected evaluation method. Record reviewer, reviewer model, time, reference hash, result hash, and limitations. Do not claim that an independent human listened, annotated, or approved the results unless that happened.

Audio must have recorded evaluation rights, source, license, SHA-256, sample rate, duration, language, transcript, and timing provenance. Private-use audio remains private and is not bundled. Forced alignments are independent timing estimates, not human timing ground truth. Constructed concatenations and TTS are identified and cannot alone establish natural-conversation quality.

Evaluation uses only source content as model input; gold translations and explanations are not submitted. Store raw responses and references separately before scoring.

## Quality criteria

Criteria are fixed before evaluation and are not relaxed to obtain a pass. Report incomplete coverage separately from failure.

| Area | Initial criterion |
| --- | --- |
| API and source validity | 100% valid accepted schemas/source IDs; all invalid responses rejected |
| Vocabulary and explanations | At least 20 items per language and task; meaning, example context, translation, and explanation scored 0/1/2; each mean at least 1.8 and each item at least 1 |
| Critical semantic errors | No reversed meaning, negation, quantity, semantic roles, or invented sources |
| Proficiency | The same 10 expressions at A2/B1/C1; at least 90% understandable and in the requested explanation language for each level |
| Translation | At least 20 sentences each direction; meaning/naturalness means at least 1.8, with no critical reversals or quantity errors |
| Clear speech | English WER and Japanese CER at most 10%; fillers, self-corrections, and repetitions stay in the reference |
| Digital silence | No invented speech; noise/music are separate conditions |
| Transcribe word timing | Matched independent reference endpoints: median absolute error at most 150 ms, p95 at most 400 ms; missing/unmatched words reported |
| Subtitle timing | Same 150 ms median / 400 ms p95 thresholds for the general audio adapter; no assumed word timing |
| Segment playback | At least 95% of accepted source ranges contain the intended speech without clipped starts/ends in the real player |
| Stitching | At least 20 distinct boundaries; no text added/deleted by stitching valid originals; discrepancies retain originals |
| Operational boundaries | At least 90% usable without manual edits; boundary WER/CER no more than five percentage points worse than interiors |

A score of 0 means incorrect, 1 needs revision, and 2 is usable as written. Semantic scores require actual inspection, not automatic uniform values. Timestamp matching uses explicit reference/output pairs and records excluded/missing material; good metrics on a subset cannot hide missing output. Repeated evaluation of the same boundary does not increase distinct-boundary coverage.

WER/CER use versioned NFKC/case normalization. English retains in-word apostrophes and decimal/thousands separators between digits; Japanese removes punctuation/whitespace except such numeric separators and compares Unicode code points. Normalization must not silently erase negation, numbers, fillers, or repetitions. Review the original text as well as the normalized metric.

Representative repeated trials, if needed, are separately approved and counted in the budget. A single favorable response does not demonstrate stability.

## Live limits and records

The validation CLI uses an isolated data root, one request per job, and a required audio limit of 1–240 seconds for each complete mono 16 kHz PCM16 WAV. The user's selected bound must cover measured samples. Lifetime ceilings remain 120 attempts and 90 minutes, including conservatively counted interrupted/undispatched attempts. Priced execution also requires explicit per-job, daily, monthly, and lifetime monetary limits. Unpriced execution cannot provide a monetary guarantee and must be separately acknowledged.

Record source state, OS, exact model/settings, official API/price observation, prepared audio/tool hashes, core/send intervals, request count, plan digest, approval, usage, known charges, unknown holds, and score evidence. Preserve prior ledgers and authorization accounting; creating another data root does not create more user authorization.

The currently authorized comparison is Transcribe and Flash 3.8 within the pre-existing cumulative USD 10 permission, including old costs and holds. This session-specific permission is not a default for future users or CI.

Use the [evaluation tools](../scripts/ai-tests/README.md) with a reviewed reference manifest and saved report. Missing review/coverage or quality failure returns exit code 2; malformed input returns 1. Offline scoring, subtitle export, and production-engine stitching do not send requests.

## Distribution and remaining conditions

When a model fails, retain its input, result, charge, and reason. Do not silently switch models. An explicit alternative is a separate job. If both transcription approaches fail the intended quality criteria, do not call cloud subtitles complete. Optional Whisper assistance would require its own design and evidence.

Normal CI runs deterministic and short native tests. Heavy six-hour tests are separate. Any future paid CI evaluation needs its own manual start, credential handling, and budget authorization. Native redistribution closure and installer verification remain release requirements independent of AI quality.
