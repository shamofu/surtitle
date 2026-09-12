# Long-audio AI quality evaluation — 2026-09-09

The six long-audio requests do **not** establish a passing cloud-subtitle implementation. English Transcribe results have promising text and timing measurements, but one required an offline parser compatibility fix. Flash 3.8 reproduced English text well while placing subtitle boundaries several seconds away from independently aligned speech. Both Japanese requests failed output validation; neither is counted as a successful transcript.

This is an offline assessment of saved provider responses, automatic metrics, and AI review. No human listening or human timing annotation is claimed. It did not send requests, alter execution states, release reservations, or modify the learning database.

## Inputs and settings

Three constructed read-speech clips were sent once to each adapter/model:

| Case | Duration | Reference utterances | Reference words |
| --- | ---: | ---: | ---: |
| `audio-en-long-1` | 90.151 s | 12 | 221 |
| `audio-en-long-2` | 146.175 s | 12 | 378 |
| `audio-ja-long-1` | 94.000 s | 24 | No independent word labels |

The English recordings use LibriSpeech speech with independently produced Montreal Forced Aligner word times. The Japanese recordings use JSUT actual-utterance labels and upstream Julius phoneme alignment. The references were fixed and reviewed before these target requests. They contain unusual original wording; the evaluation did not replace it with a more plausible sentence after reading the results.

These are edited read-speech clips with recorded 300 ms inter-utterance pauses and minimal zero padding for millisecond alignment. They are not natural conversation or multi-hour benchmarks. Independent forced alignments can themselves be imperfect and are not human timing ground truth. Japanese source recordings remain private under their recorded terms; this document does not redistribute audio or complete source text.

The selected models were `gemini-3.5-transcribe-preview` with thinking omitted and `gemini-3.8-flash` with `LOW` thinking, both in `global`, with one candidate and an output setting of 8,192 tokens. Every quote digest, audio duration, saved source hash, and actual immutable WAV hash was verified locally. These explicit evaluation choices do not create product defaults or a model allowlist.

## Transcription results

WER and CER use the versioned `surtitle-en-wer-ja-cer-v1` normalization: Unicode NFKC, case normalization, and punctuation/spacing rules, while preserving repetitions, negation, and numbers. No post hoc equivalence rule for spelling variants or homophones was added.

| Case / model | Original execution | Evaluated evidence | Error rate | Errors / reference units |
| --- | --- | --- | ---: | ---: |
| English 1 / Transcribe | Completed | Original subtitles | WER **0.452%** | 1 / 221 |
| English 1 / Flash 3.8 | Completed | Original subtitles | WER **0%** | 0 / 221 |
| English 2 / Transcribe | Needs review | Offline reparse of the same saved response | WER **1.058%** | 4 / 378 |
| English 2 / Flash 3.8 | Completed | Original subtitles | WER **2.381%** | 9 / 378 |
| Japanese / Transcribe | Needs review | Raw text diagnostic only | CER **7.851%** | 38 / 484 |
| Japanese / Flash 3.8 | Needs review | No retained candidate text | **Unavailable** | — |

English 1 Transcribe's single difference was a proper-name spelling. English 2 Transcribe changed a name, rendered `define` as `to find`, and used the homophone `read` instead of `red`. Flash's nine English 2 differences were British/American spellings and `St.` versus `Saint`; the fixed metric counts them, while AI review distinguishes them from lost meaning. Good text accuracy does not compensate for inaccurate subtitle timing.

Japanese raw text includes both harmless orthographic changes and actual word confusions, such as a different noun where the reference says 上院議員. Its numeric CER is a diagnostic of retained text only: the invalid timestamps prevent accepting the result. Flash's report has an empty `candidateDiagnostics` array, no transcription parts, and `evidenceTruncated: false`. Because the sanitizer emits a diagnostic record for each candidate, this supports a missing, empty, or invalid candidate collection; it does not identify a particular provider blocking reason. No text is available for an honest CER measurement.

## Timing results and coverage

The original reference utterances and generated subtitles use different segmentation. A strict one-output-cue-to-one-reference-cue comparison remains in the machine report, with all missing and unmatched IDs. It cannot be substituted with a positional match.

For a useful additional diagnostic, the evaluator aligns normalized text monotonically with Levenshtein distance and compares a generated cue's start/end only when that boundary word matches an independent reference word exactly. It uses the actual recorded endpoint, never interpolates a timestamp, and reports excluded endpoints. This is automated lexical alignment, not human adjudication of ambiguous repeated words. Start/end absolute errors are pooled; median uses the midpoint and p95 the nearest rank.

| Case / model | Cue endpoints compared | Excluded endpoints | Median error | p95 error |
| --- | ---: | ---: | ---: | ---: |
| English 1 / Transcribe | 26 / 26 | 0 | **34.5 ms** | **90 ms** |
| English 1 / Flash 3.8 | 14 / 14 | 0 | **1,796 ms** | **4,050 ms** |
| English 2 / Transcribe, derived | 54 / 56 | 2 | **35 ms** | **95 ms** |
| English 2 / Flash 3.8 | 59 / 60 | 1 | **832 ms** | **6,540 ms** |
| Japanese / either model | Not assessed | Invalid or absent output | — | — |

The target is a median of at most 150 ms and p95 of at most 400 ms. Both Flash comparisons exceed it substantially. Passing numbers on a subset do not establish full coverage: the excluded Transcribe endpoints and all unmatched words remain visible.

Transcribe also supplies word anchors. Exact normalized word-atom alignment excludes spelling differences and merged/split word forms instead of inventing per-word times:

| Case | Matched reference words | Missing reference / unmatched output | Median | p95 | Point anchors |
| --- | ---: | ---: | ---: | ---: | ---: |
| English 1 | 218 / 221 | 3 / 2 | 29 ms | 76 ms | 0 |
| English 2 | 375 / 378 | 3 / 4 | 25 ms | 75 ms | 11 |

These partial word measurements are promising but do not satisfy the evaluator's complete-coverage gate. Flash supplies no word anchors in this adapter, and the Japanese reference has no independent word labels, so word-level scores for those cases are unavailable.

## Parser compatibility and preserved failures

The English 2 Transcribe response contained 11 point anchors, such as a function word with equal start and end times after 100 ms quantization. The parser now preserves such anchors while requiring positive-width final subtitle spans. It continues to reject reversed or out-of-order anchors, out-of-range timestamps, and text not accounted for by the word sequence. It does not assign fabricated durations or delete words.

The same immutable response and WAV were reparsed offline into 28 positive-width cues. Joining their text reproduces the provider's original full text exactly. The derived report records its origin; the original job remains `needs_review`, its original saved output remains null, and its settled charge is unchanged. No audio was resent.

The Japanese Transcribe failure is different: one anchor starts at 7.600 s and ends at 7.500 s, followed by a later word starting at 7.500 s. This is a genuine reversed/out-of-order sequence, not an equal point anchor. Strict rejection is retained. The missing Japanese Flash candidate is also retained as a failure. Neither was converted into empty silence, given invented times, or counted as a pass.

## Cost, artifacts, and limits

These six attempts settled **44,519 microUSD ($0.044519)** in total: $0.021274 for English Transcribe, $0.010491 for English Flash, and $0.012754 for the two invalid Japanese responses. Invalid content still consumed provider usage. The comparison made no additional calls; this is a subset of the wider evaluation ledger.

Private local evidence under `work/ai-evaluation-20260909/` includes:

- `audio-final-unsubmitted-index-completed-report.json`: original final provider snapshot, including other evaluation requests.
- `audio-reference.json` and `audio-reference-review.json`: independently fixed references and provenance.
- `audio-en-long-2-transcribe-reparsed.json`: explicitly derived offline output, with unchanged original execution state and costs.
- `audio-long-metrics.json`: six-request numeric report, mappings, excluded IDs/endpoints, edit operations, hashes, and charges.
- `measure-long-audio.mjs`: offline reproduction script. It reads the original quotes and verifies immutable WAV bytes. Pass a new output filename to avoid overwriting evidence.

| Input | SHA-256 |
| --- | --- |
| Final provider snapshot | `489afe6b6e882bb20b0faf7bee9684cf4b199f626da9a5e417212c4da4a6e5c2` |
| Audio reference manifest | `3d8b45769b5ae3e10ac2caf254851793cf96800dd1374ddf6f498dc0bdce7f0e` |
| Pre-run reference review | `cbf35a5b898524d009ac71c0d52d466ff81ae1c9feac729a43618a2240a15152` |
| Derived English 2 output | `2a4fea02ad9d074d1541072e35f1bdf15295d0c09044f3e7624524be45fa5f3e` |

```powershell
node work/ai-evaluation-20260909/measure-long-audio.mjs audio-long-metrics-reproduced.json
```

The separate 20-location overlap/stitch assessment is not included in these long-clip metrics. Three read-speech inputs, automatic alignments, and AI review do not establish general transcription quality, silence robustness, or production readiness. The failed results remain part of the evidence.

## Additional local review safeguard

Newly prepared audio now retains optional VAD pause evidence alongside the original source sample range, VAD model/runtime hashes, and a fixed detection policy. This uses the already computed Silero posterior: a review-only pause must remain below 0.35 for at least two seconds, and any uncertain frame ends the interval. The existing hysteresis used to choose chunk boundaries is unchanged. A subtitle must lie wholly inside the pause after excluding 250 ms at both edges before it triggers a warning. Short gaps and partly overlapping subtitles do not trigger this rule.

The warning describes a **VAD-estimated pause**, not verified silence. It preserves every returned word, subtitle timestamp, and raw response, and requires explicit digest-bound review before adoption. Whole-chunk no-speech warnings keep their original identity and do not receive a duplicate pause acknowledgment. The review UI exposes the interval for local playback and explains the estimate's limits. VAD does not remove audio, prevent an approved request from being billed, certify a transcript, or repair a model response.

Focused regressions verify threshold uncertainty, source/frame alignment, provenance and digest integrity, conservative cue containment, raw repetition/timing preservation, missing responses, acknowledgment separation, and historical serialization. The AI suite passes 151 tests with the same four explicit ignored entries; validation CLI tests pass 16, and transcript-review UI tests pass 11. Both Rust crates pass Clippy for all features and targets, and TypeScript checking passes. The real Silero/FFmpeg integration test also includes assertions for persisted pause evidence and retained generated text; its execution is recorded separately in the project status.

This is an additional local review safeguard, **not a measured improvement to the retained quality scores**. No provider request, paid retry, reference change, or historical receipt rewrite was performed. The previously failed timing, silence, and acceptance criteria remain failed.

### Real spoken-audio integration check

An additional explicit native integration test passed using two existing, hash-pinned LibriSpeech recordings (3.275 s and 2.680 s) with a constructed four-second digital-zero pause between them. The test copied both recordings' PCM unchanged, added one second of padding at each outer edge, and prepared the selection from 1.000 to 10.955 s using real FFmpeg, Silero and the pinned CPU ONNX Runtime. It made one local preparation call and no additional VAD inference pass.

Silero estimated a strict pause at **3.880–8.744 s**. After the 250 ms inward guards, the warning interval was **4.130–8.494 s**. An explicitly authored test subtitle at 5.500–6.500 s was preserved and marked provisional. The two actual speech subtitles at 1.330–3.800 s and 8.705–10.735 s remained confirmed with identical text and timestamps. Their reference spans came from separately retained upstream automatic MFA alignments, not the VAD output, a cloud response, or human timing annotation. The full-chunk no-speech flag remained absent, and adoption required the separate digest-bound warning acknowledgment.

Decoding the prepared FLAC reproduced all **159,280 selected PCM samples exactly**. The selected and decoded PCM both hash to `a400397def8e67c6afcc643cd0878caf74c71689841577769c66504e607d6f5f`. The test checked the six source audio/text/alignment files before and after processing. The retained report at `work/vad-spoken-pause-acceptance/spoken-pause-rLVAQC/report.json` has SHA-256 `1a658c9b2d77c1289007b9a07cd51986071afd0ba64bd15f937750d3dd2a5db6`; its receipt, original constructed audio, source provenance and raw test response remain separate from the historical model evaluations. No JSUT audio was used or redistributed.

```powershell
$env:SURTITLE_TEST_FFMPEG = 'C:\path\to\ffmpeg.exe'
$env:SURTITLE_SPOKEN_FIXTURES = Join-Path (Get-Location) 'work/ai-evaluation-20260909/fixtures'
cargo test --locked -p surtitle-ai real_spoken_audio_and_interior_pause_require_only_local_warning_review -- --ignored --nocapture
```

This test is ignored by default and requires the already available source fixtures and pinned native assets; it never downloads them. Each successful run retains a fresh local evidence directory. It passed in 16.68 seconds, and AI Clippy checks for all features/targets and formatting checks passed afterward. This verifies local warning behavior and sample preservation on clean read speech plus constructed silence. It does not establish noisy/conversational VAD accuracy, cloud transcription quality, or a higher corpus readiness score; it made zero network requests, ledger changes or subtitle adoptions.

## Source-range containment diagnostic

An offline diagnostic compared each fully mapped cue's requested interval with the independent first/last word times already recorded above. This tests strict reference containment, not actual player execution or human-perceived clipping. Even a cue with small absolute timestamp error may begin after the estimated first speech sample or end before the last one.

| Output | Fully mapped / total cues | Strictly contained | Largest start / end shortfall | Contained with hypothetical 150 ms context on both sides |
| --- | ---: | ---: | ---: | ---: |
| English 1 / Transcribe | 13 / 13 | 0 | 90 / 60 ms | 13 / 13 |
| English 2 / Transcribe, derived | 26 / 28 | 1 | 105 / 90 ms | 26 / 26 |
| English 1 / Flash | 7 / 7 | 2 | 3,095 / 2,266 ms | 2 / 7 |
| English 2 / Flash | 29 / 30 | 7 | 1,285 / 6,600 ms | 8 / 29 |

The context column is a sensitivity diagnostic; no replay-context feature, subtitle-time change or new passing threshold was applied. It suggests that small playback margins and Flash's multi-second timing errors need different remedies. Unmapped endpoints and both invalid Japanese outputs remain unavailable. English 2 Transcribe is still a derived offline result whose original job requires review. Forced alignments remain timing estimates, and these numbers do not establish the 95% real-player source-range criterion.

The reproducible local script is `work/ai-evaluation-20260909/measure-playback-containment.mjs`. Its immutable report `playback-containment-diagnostic.json` has SHA-256 `a836e3bd3bcf9348802427018a9950a7da09a343cfc15f10b66719ca68a08a6f`, verifies the existing metric inputs, and records all mapped intervals and exclusions. It made no network request, ledger change or subtitle adoption.

## Local Whisper alignment experiment

A bounded CPU experiment tested one direct conversion from CTranslate2 4.8.2 Whisper alignment transitions to cue endpoints. It used the pinned multilingual base model, the 37 unchanged English Flash cues and original PCM above, plus digital-silence and unrelated-text controls. Each search window included at most ten seconds of context per side and lasted at most 30 seconds. The aligner received no reference transcript or reference times. It generated no replacement text and applied no interpolation, confidence threshold, VAD cleanup or reference-guided retiming.

The raw alignment was frozen before a separate scoring process read the independent MFA references. Every cue retained its exact text, but the predeclared endpoint conversion made timing worse:

| Input | Compared endpoints | Original median / p95 | Experimental median / p95 |
| --- | ---: | ---: | ---: |
| English 1 | 14 / 14 | 1,796 / 4,050 ms | 7,582 / 14,030 ms |
| English 2 | 59 / 60 | 832 / 6,540 ms | 9,286 / 15,757 ms |

All 37 derived starts coincided with their search-window origins. Inspection of the [pinned sequence and attention slicing](https://github.com/OpenNMT/CTranslate2/blob/v4.8.2/src/models/whisper.cc) and [DTW initialization](https://github.com/OpenNMT/CTranslate2/blob/v4.8.2/src/dtw.cc) explains the interpretation error: row zero is the no-timestamps decoder query predicting the first supplied token, and the complete-matrix path begins at its first frame. That structural path boundary is not an independently estimated acoustic onset. The experiment therefore rejects this endpoint conversion; it does not establish that Whisper or CTranslate2 cannot align speech.

The speech cases contained 85 zero-width transition spans among 866 supplied tokens, with no missing or reversed spans. Both negative controls also returned paths, so API success alone does not establish that the supplied words were spoken. No validity threshold was fitted to these two controls. The failed conversion was not integrated into the product or rerun with tuned parameters, and historical quality scores remain unchanged.

The retained protocol, source interpretation, license evidence and per-cue measurements are under `work/whisper-align-experiment-20260909/`. The unchanged raw `alignment.json` has SHA-256 `1bae9af846cd535406452c835a6dd5669b65b1ab67e321a215dc65a2a3dc9f1f`. All model files, wheels, audio and dependency trees stayed inside the Dev Container; only selected scripts and reports were exported. No volume was added. The experiment made zero Vertex calls, ledger changes or subtitle adoptions.
