# AI test plan

Updated 2026-09-09. This plan separates free, deterministic regression tests from explicitly authorized live Vertex evaluations. It does not itself authorize paid requests. See [AI design](ai.md), [verification instructions](vertex-verification.md), and [recorded status](status.md).

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
