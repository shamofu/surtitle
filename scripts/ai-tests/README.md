# Local AI evaluation tools

These Node.js tools evaluate saved results using only standard libraries. They do not connect to cloud services, TTS, or service accounts. After `pnpm install --frozen-lockfile`, run `pnpm test:scripts scripts/ai-tests` for the offline Vitest suite.

## Prepare text inputs

`crates/ai/tests/fixtures/evaluation/text-corpus.json` provides original T01/T02/T03 source material and reference proposals. Export source-only `RequestTask` JSON; reference translations and meanings are never sent to the target model.

```powershell
node scripts/ai-tests/prepare-text-case.mjs --manifest crates/ai/tests/fixtures/evaluation/text-corpus.json --case-id T01-en --kind vocabulary --output work/ai-tests/T01-en-vocabulary.json
node scripts/ai-tests/prepare-text-case.mjs --manifest crates/ai/tests/fixtures/evaluation/text-corpus.json --case-id T02-en --kind explanation --term "look forward to" --proficiency A2 --output work/ai-tests/T02-en-explanation-A2.json
```

These commands only create local files. Paid execution separately requires an isolated validation root, credentials, an immutable model/input/settings quote, and explicit approval of the exact charge or unpriced scope.

## Evaluate saved results

```powershell
node scripts/ai-tests/evaluate.mjs --manifest REFERENCE.json --results PROVIDER_REPORT.json --case-id T01-en --output INITIAL_EVALUATION.json --rubric-template AI_REVIEW.json
node scripts/ai-tests/evaluate.mjs --manifest REFERENCE.json --results PROVIDER_REPORT.json --case-id T01-en --rubric AI_REVIEW.json --output REVIEWED_EVALUATION.json
```

Without `--case-id`, every reference case is required. Missing cases fail coverage. For a text-only assessment of a mixed report, preserve the original and create an explicit text-only derivative that records the original hash and excluded audio IDs; do not silently hide results.

An unfilled review template produces exit code 2 while still saving the report and template. Independently review the reference before reading the target model output, then record explicit per-item AI scores and evidence notes. The evaluator never labels AI review as human confirmation. Existing outputs are not overwritten. Exit 0 means the supplied evidence and gates pass, 2 means insufficient or failed evidence, and 1 means a file/format error. No report qualifies or unlocks a model.

References, results, and rubric hashes are recorded. The output review binds to `resultsSha256`; the separate reference review binds to `referencesSha256`. Changed files require new reviews. Authored oracle responses do not establish live quality even when every score passes.

## Metrics and gates

- English WER uses NFKC, lowercase, and whitespace-separated words. Punctuation separates words except internal apostrophes and decimal separators between digits. Contractions, fillers, repetitions, negation, numbers, and symbols remain.
- Japanese CER uses NFKC and lowercase, then removes punctuation and whitespace except numeric decimal separators. It counts Unicode code points, preserving symbols, iteration marks, fillers, repetitions, and numbers without morphological segmentation.
- Substitutions, deletions, and insertions are reported separately. An empty reference with invented speech has a null error rate and fails. Comparison size is bounded.
- Timing uses explicit reference-ID alignment. Start/end absolute errors are pooled; median and nearest-rank p95 are reported. Missing, unmatched, and changed-text IDs cannot hide behind an accurate subset. Subtitle intervals require positive width. Quantized point word anchors are measured as supplied and included in both endpoint errors, with `pointHypothesisCount`; their duration is never invented.
- Semantic dimensions are meaning, example/context, translated sense, and explanation for vocabulary/explanations; translation uses meaning and naturalness. Scores are 0 (wrong), 1 (requires correction), or 2 (usable). Each language/task group requires at least 20 reviewed items, every dimension mean at least 1.8, every score at least 1, and zero critical errors. Semantics are not graded by exact reference wording.
- Boundary assessment requires at least 20 distinct locations, zero omitted/added speech, and at least 90% accepted without correction. Repeating the same source boundary does not add locations. Correctly flagging a disagreement does not make the disagreement pass preservation.

## Report and review contracts

Input reports have `schemaVersion: 1` and `requests`. Each request needs `id`, matching `caseId`, `taskKind`, `state`, and `output` in Rust `ParsedOutput` format. Text source cue IDs/text/times must match the reference; audio uses `sourceAudioSha256`.

AI rubrics require `schemaVersion: 1`, `reviewMethod: "ai-review"`, `reviewer`, `reviewerModel`, ISO `reviewedAt`, and `resultsSha256`. The separate `referenceReview` is `{method: "ai-review", reviewer, model, reviewedAt, referencesSha256, independentOfModelOutput: true}`. The template leaves completion false. Do not mark it complete without doing the independent work.

| Array | Contents |
| --- | --- |
| `items` | `{requestId, itemId, scores, criticalErrors: [], note}`. Vocabulary/explanation IDs are output-order `item:0`, etc.; translation uses cue IDs. Dimensions are `meaning`, `exampleContext`, `translation`, `explanation`, or translation-only `meaning`, `naturalness`. |
| `timestampMatches` | `{requestId, referenceId, outputIndex, level: "cue"}`. Word alignment additionally uses `level: "word"` and `attemptId`. Never assume output positions are reference IDs. |
| `boundaries` | `{requestId, id, joinedText, originalLeft, originalRight, needsReview, reviewAccepted}` matched to reference `boundaries: [{id, text}]`. Record actual stitched output and both original responses. |

Word references use `words: [{id, startMs, endMs, text}]`. `outputIndex` addresses the ordered concatenation of `attempts[].evidence.audioTranscriptions[].words` from the explicitly selected settled attempt. Missing word references report `not_assessed_no_word_reference`; subtitle metrics never substitute for word metrics. Missing, truncated, or unfinished word evidence fails.

Real audio references use `evidenceKind: "ai-reviewed-reference"`, source/license metadata, and `evaluationUsePermitted: true`, together with the independently hash-bound reference review. Authored text can be assessed after independent AI reference review. Synthetic `authored-oracle` audio is not promoted to recorded-speech evidence, and AI review is never labeled as human review. Preserve actual materials and review records; provenance declarations alone are not proof.

Development reports retain bounded non-thought generated text and finish reasons in `attempts[].evidence.candidateDiagnostics`, including parser failures. Thoughts, credentials, and arbitrary provider diagnostics are excluded. Generated text can reproduce source material. Diagnostics are limited to 128 KiB, eight candidates, and 32 text parts each, with truncation flags. Unknown finish reasons become `UNRECOGNIZED`. This evidence is development-only and does not reconstruct text omitted from older reports.

## PCM fixtures and semantic regressions

```powershell
node scripts/ai-tests/generate-surrogate.mjs --output-dir work/ai-tests/local-fixtures
```

The generator writes 250 ms silence, 16,007-sample silence, and deterministic 12-second pulses/silence. `--duration-seconds 21600` supports a six-hour streaming fixture. It writes one second at a time and records provenance, hashes, and sample counts. Pulses are not speech and do not establish recognition quality. Windows SAPI output is not used because its redistribution terms were not verified.

Fill `user-speech-manifest.template.json` with rights-cleared recorded material, source/license/hash/duration/transcript, and independently checked timing from zero at the file start. Silence requires `classification: "silence"` and empty `cues`. Blank templates and synthetic pulses cannot pass a real-speech quality claim.

Use `crates/ai/tests/fixtures/evaluation/semantic-review-v2.json` for new semantic reviews. It keeps contrasts optional at every level, requires useful proficiency-specific depth, and preserves contextual meaning, grammatical roles and source uncertainty. New explanation acceptance also requires at least 90% judged understandable within each language/proficiency group; accessibility alone does not satisfy C1 depth. Record this separately with reasons, since the current evaluator's dimension means do not by themselves establish that learner-accessibility gate.

The v2 file includes fourteen intentionally mixed-quality authored calibration candidates. Independently review every candidate against its quoted source, selected term, explanation language and proficiency before reviewing new provider outputs. Store a separate hash-bound `ai-review` record with dimension-specific evidence, critical errors, and explicit understandability judgments. The inputs are unscored; neither valid JSON nor an all-pass template is a calibration result. Authored calibration and AI judgments do not establish live quality, held-out coverage, human review, or actual learner comprehension. Do not send calibration candidates, reference reasoning or scores to the target model.

`semantic-regressions.json` remains the unchanged historical record of dictionary-form transitivity, proficiency-depth, quoted-command and literal-fragment examples. Its earlier mandatory C1 contrast rule does not apply to new v2 reviews. Keep historical results and hashes intact; do not reclassify past failures by silently replacing their original rubric. Preserve valid paraphrases and distinguish lexical normalization from changing meaning or agency.

## Explicit long-audio preparation and metadata lookup

Audio preparation requires `--max-audio-seconds N`, with N from 1 through 240. The CLI measures complete 16 kHz mono PCM16 WAV data and rejects files exceeding that explicit limit. Input identity, duration limit, model, and settings bind to the quote digest. This supports 90–180-second cores with context. Each plan has one request. The legacy scope remains limited to 120 attempts and 90 minutes; additional campaigns require separately reviewed approval within the original monetary cap.

```powershell
# Local preparation only. Choose the actual model, price and output settings.
.\target\debug\surtitle-ai-validation.exe prepare --data-root C:\ABS\validation --credential-id ID --case-id A01-en-chunk01 --audio-file C:\ABS\chunk01.wav --adapter audio --language en-US --max-audio-seconds 186 --model-id MODEL_ID --location global --max-output-tokens 8192 --thinking-level LOW --price-file C:\ABS\price.json
# Thinking can be omitted when appropriate. Transcribe uses --adapter transcribe.
.\target\debug\surtitle-ai-validation.exe list-models --data-root C:\ABS\validation --credential-id ID --location global
.\target\debug\surtitle-ai-validation.exe lookup-price --data-root C:\ABS\validation --credential-id ID --location global --model-id MODEL_ID
```

Metadata lookup uses Google GET/OAuth, never generation. Failure does not select another model, invent a price, or probe generation. Sending requires a separate reviewed digest and explicit charge or unpriced-scope approval.

## Review saved audio with the product stitching engine

`review-audio` opens no credentials or ledger and makes no network calls. Its manifest declares consecutive zero-based ordinals, contiguous core ranges, and integer-millisecond source offsets. Each WAV duration must match its sent range. `requestId` is the saved job UUID in `report.requests[].id`.

```json
{"schemaVersion":1,"cases":[{"id":"boundary-en-01","mediaId":"recording-en-01","sourceSha256":"ORIGINAL_SOURCE_SHA256","sourceRevision":"ORIGINAL_SOURCE_SHA256","chunks":[
  {"ordinal":0,"coreStartMs":0,"coreEndMs":4000,"requestStartMs":0,"requestEndMs":7000,"requestId":"LEFT_JOB_UUID","audioPath":"C:\\ABS\\left.wav","audioSha256":"LEFT_WAV_SHA256"},
  {"ordinal":1,"coreStartMs":4000,"coreEndMs":8000,"requestStartMs":1000,"requestEndMs":8000,"requestId":"RIGHT_JOB_UUID","audioPath":"C:\\ABS\\right.wav","audioSha256":"RIGHT_WAV_SHA256"}
]}]}
```

```powershell
.\target\debug\surtitle-ai-validation.exe review-audio --review-manifest C:\ABS\boundary-manifest.json --results C:\ABS\vertex-report.json --output C:\ABS\boundary-review.json
```

Hashes and measured WAV lengths are checked against both manifest and saved request. Only completed, settled parsed outputs are rebased by `requestStartMs` and sent through the product's shared draft engine. Raw clip-relative outputs, rebased outputs, attempt IDs, and input hashes remain in the artifact. Missing, failed, or malformed results stay pending, never inferred silence. `cases[].draft` exposes raw alternatives, pending ranges and conflicts. Only a new report is written. Declared cut offsets are not claimed to be proved by hashes alone.

Set optional `chunks[].noSpeechDetected: true` only when VAD found no speech throughout the entire sent range, including context; also provide `case.vadModelSha256`. Native preparation records this signal from local VAD. Returned speech creates `speech_in_vad_no_speech_range`, keeps the original output, and blocks adoption until explicitly acknowledged. VAD can be wrong: samples and subtitles are never deleted automatically. This offline command neither runs VAD nor acknowledges warnings.

## Reparse saved Transcribe evidence without sending

```powershell
.\target\debug\surtitle-ai-validation.exe reparse-audio --results C:\ABS\saved-report.json --request-id JOB_UUID --attempt-id ATTEMPT_UUID --audio-file C:\ABS\immutable-input.wav --output C:\ABS\reparsed-report.json
```

Reparsing requires one selected settled attempt, STOP completion, complete saved transcription evidence, and the identical measured audio. It cannot access credentials, send, resume a job, or write the ledger. The new artifact retains original execution state, usage and charges, and marks its replacement parsed output with `outputProvenance`, the original output, and source-report hash. It is evaluation evidence, not an adopted or newly executed job.

Quantized zero-duration word anchors are retained unchanged. Subtitles use positive spans derived only from observed word endpoints; point-only fragments join an adjacent group without dropping words or inventing timestamps. All-point output with no positive subtitle span remains invalid. Reverse/out-of-range timing, submillisecond ordering, and full-text anchoring checks remain enforced.

## Append-only evaluation campaigns

The validation root cannot be reinitialized or assigned a larger lifetime budget. Campaigns add a separately approved request/audio scope in the **same SQLite ledger**. They do not renew the legacy 120-attempt/90-minute pool, forgive unknown costs, or grant a retry. All campaigns share the original lifetime monetary cap. If historical costs from another root were already deducted when that cap was initialized, keep that deduction in place and do not add it again.

1. Prepare immutable, priced single-request jobs through the existing CLI. A job with any previous attempt, including an unsent released attempt, cannot join a campaign. Unpriced jobs and a ledger with unpriced historical attempts are rejected.
2. Create a jobs file containing `{"label":"Short quality diagnosis","jobIds":["JOB_UUID"],"expiresAtMs":ABSOLUTE_UTC_MILLISECONDS}`. Expiry must be within 24 hours of quote creation.
3. Run `campaign-quote --data-root ABS_ROOT --jobs-file ABS_JSON`. This writes an unapproved quote and immutable job membership. The quote records every job/digest/request-body hash, execution/price snapshot, exact request count, duplicate-inclusive audio duration and reservation sum. It makes no network requests. Quoting permanently assigns those jobs to the campaign; it is not a disposable estimate or an approval.
4. Review the full quote and obtain authorization for that concrete scope. Save its exact `approvalTemplate` as a separate JSON file, then run `campaign-approve --data-root ABS_ROOT --campaign-id ID --approval-file ABS_JSON`. This accepts the exact limits/digest/expiry once, but still does not approve or send an individual request.
5. Each explicit `run` additionally supplies `--campaign-id ID --campaign-digest SHA256` and the existing job digest/exact charge/unqualified-model acknowledgment. Its in-memory permit lasts at most 30 minutes, bounded by the campaign expiry. `--retry` and `--approve-unpriced` are forbidden for campaigns. A restart requires new per-request consent for still-unattempted jobs; attempted jobs are never automatically resumed.

`campaign-show` and `report` expose approval/expiry status and all scopes. `attemptedRequests`/`attemptedAudioDurationMs` include legacy and campaign attempts. `legacyAttemptedRequests`/`legacyAttemptedAudioDurationMs` isolate the original pool; `maxRequests`, `maxAudioDurationMs`, and corresponding remaining fields describe that unchanged pool. `chargedOrHeldMicrousd` includes every attempt exactly once, using actual charge when known and its reservation otherwise. Reserve and pre-dispatch checks enforce both the campaign and lifetime limits. Unscoped `AiStore` calls cannot send from a validation database.

`--adapter transcribe-text` is a development-only diagnostic with word timestamps disabled. It preserves untimed text in a distinct result variant. Evaluation can measure its recognition error, but it does not create subtitles, timing scores, or an adoption candidate.

## Coverage and review evidence for new quality evaluations

Use a **schema version 2** reference manifest for a new quality campaign. Preserve the reference `cases` and add an independently frozen `evaluationPlan`:

```json
{
  "candidates": [{"id":"flash-low","execution":{"model_id":"EXPLICIT_MODEL","location":"global","max_output_tokens":2048,"thinking":{"kind":"level","level":"LOW"},"price":{"id":"PRICE_ID","source":"SOURCE","observed_at_ms":1,"input_microusd_per_million":1,"output_microusd_per_million":1}}}],
  "cases": [{"caseId":"UNUSED_CASE_ID","taskKind":"explanation","terms":["selected expression"],"proficiencies":["A2","B1","C1"],"candidateIds":["flash-low"]}]
}
```

These model and price values are placeholders, not a catalog or approved rate. Non-explanation matrices omit `terms` and `proficiencies`. The evaluator expands case × selected term × proficiency × candidate before reading outputs. Missing or duplicate requests, wrong execution settings, and missing plan/request-body hashes fail coverage. Every selected case needs an explicit matrix; select a separately frozen manifest for a smaller stage. Legacy schema version 1 remains readable for historical regression inspection; it does not gain independent matrix coverage retroactively. Existing reports are never rewritten.

Native reports include `term`, `proficiency`, and `requestBodySha256`. Reviews must supply `evidence: {dimension: "specific source/output reasoning"}` for **every** scored dimension; absent/blank evidence makes the review invalid. Explanations with an explicit proficiency additionally require `understandableAtProficiency` and `proficiencyEvidence`; each level must reach 90% understandable. Language/task/candidate groups are scored independently so a good candidate cannot hide another candidate's failure. The generated review template leaves these values blank. Textual evidence requirements do not prove semantic correctness: use independent review and known-error calibration before accepting a final evaluation.
