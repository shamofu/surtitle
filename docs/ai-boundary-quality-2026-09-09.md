# Audio boundary evaluation — 2026-09-09

This is an offline evaluation of saved Transcribe responses using the production transcript-review engine. It sends no requests and does not alter the cost ledger or automatically adopt subtitles. The initial result below is retained as a baseline for any subsequent stitching change.

## Inputs and method

Twenty distinct constructed boundaries use independently sourced read speech: ten English LibriSpeech cases and ten Japanese JSUT cases. Each case concatenates three source utterances with recorded pauses, cuts within the middle utterance, and submits two chunks with up to three seconds of context on either side. The exact PCM inputs, original source hashes, transport/core intervals, and quote/job IDs are preserved privately under `work/ai-evaluation-20260909/`.

These are short stress cases, not spontaneous conversation and not 120-second chunks. They isolate overlapping-context behavior. Japanese source audio has restricted redistribution terms and is not included in repository fixtures or the application.

The reviewed references derive from upstream transcripts independently of Gemini outputs. This evaluation inspects saved text and timing metadata; it does not claim independent human listening or human timestamp annotation. Source details are also recorded in the audio provenance and reference-review artifacts.

`review-audio` verifies each prepared WAV hash and measured duration, matches its saved request, rebases accepted output to the original timeline, and calls the same draft builder as the application. Invalid output remains unavailable rather than being converted into silence. No generated reference text is supplied to the model.

## Baseline result

| Measure | Observed |
| --- | --- |
| Distinct boundaries | 20 |
| Sent requests | 40, one per prepared chunk |
| Valid accepted chunk outputs | 39 |
| Rejected chunk outputs | 1, English boundary 04 / first chunk |
| Fully received pairs | 19 |
| Pairs retaining a boundary conflict | 19 |
| Pair with an unavailable range | 1 |
| Drafts ready for adoption without boundary editing | **0 / 20** |
| Original accepted responses retained | All 39 |
| Automatic retry, paid repair, or adoption | None |

The 90% operational-boundary criterion **fails**. The engine does preserve conflicting originals and prevent premature adoption. That safety behavior does not establish usable automatic stitching.

The current comparison requires matching complete cues throughout the overlap window. A request-edge fragment can therefore conflict with a complete cue from its neighbor, even when the speech around the actual core cut agrees. For example, an English request ends with a partial phrase that the next request completes. Different cue splitting, Japanese orthography/punctuation, and genuine recognition disagreements also contribute.

The provisional draft deliberately retains alternatives. Counting this combined display as a final transcript would inflate duplication metrics and misrepresent its intended state. Text-addition/deletion and final WER/CER criteria remain unproven for an adopted automatic join; no adopted join exists in this baseline.

## Required improvement and constraints

Investigate conservative alignment of a transport-edge prefix/suffix with a matching full cue, and comparison across cue split/merge boundaries. Preserve every original result. Do not fabricate timestamps, silently drop contradictory words, collapse distinct repetitions, or lower the existing mismatch/repetition test requirements to obtain a pass.

Re-evaluate any changed stitching implementation against these same saved responses and additional deterministic adversarial fixtures. New results must identify the code/input hashes and remain separate from this baseline. Existing model-output failures must remain failures rather than being relabeled as received silence.

## Evidence

- `boundary-source-plans.json`: original source/transport plan and independent reference text.
- `boundary-review-manifest.json`: exact input mapping; SHA-256 `d6bb5958ff5c32de48c7b9aeb0f7f782ecb4acee86343afe059df68bd210e49c`.
- `audio-final-unsubmitted-index-completed-report.json`: final request, usage, and result evidence.
- `boundary-review.json`: production-engine baseline with retained originals, conflicts, and pending ranges.

All evidence paths above are relative to the ignored `work/ai-evaluation-20260909/` directory. Only this non-secret summary is part of the repository. See the [quality criteria](ai-test-plan.md) and [implementation status](status.md).

## Conservative transport-edge matching result

The revised engine was run offline against the same 40 saved request records and unchanged prepared WAVs. It now accepts a one-to-one prefix/suffix match only when the shorter cue touches its request edge within 400 ms, the other cue extends beyond that edge, the intact shared endpoint agrees within 250 ms, and the lexical units match exactly. Latin word boundaries and repeated units are retained. Ordinary Japanese comma/period marks are normalized; particles, homophones, and alternative written words are not treated as equivalent.

The shorter fragment is removed from the proposed joined output only after every cue in that overlap has a unique match. The complete counterpart keeps its original text and timestamps. Ambiguous occurrences, independent contradictions, two partial halves without a complete counterpart, and differing cue grouping still require review. All original chunk arrays compare equal to the baseline, including the 39 accepted model outputs and the pending failed chunk. Every cue in a newly ready draft uses an exact original text/time tuple; no timestamps were synthesized.

| Measure | Baseline | After edge matching |
| --- | ---: | ---: |
| Drafts ready without boundary editing | 0 / 20 | **7 / 20 (35%)** |
| Pairs retaining a conflict | 19 | 12 |
| Pair with an unavailable range | 1 | 1 |
| Operational criterion of at least 90% | Fail | **Fail** |
| Additional requests / ledger changes / adoptions | 0 / 0 / 0 | 0 / 0 / 0 |

The newly ready cases are English 02, 07, 08, and 09, and Japanese 02, 04, and 07. Their complete-text diagnostics against the fixed references are:

| Case | WER/CER | Insertions / deletions |
| --- | ---: | ---: |
| English 02 | 2.778% WER | 0 / 0 |
| English 07 | 1.220% WER | 0 / 0 |
| English 08 | 0% WER | 0 / 0 |
| English 09 | 0% WER | 0 / 0 |
| Japanese 02 | 8.621% CER | 0 / 1 |
| Japanese 04 | 1.961% CER | 0 / 0 |
| Japanese 07 | 3.175% CER | 0 / 1 |

These figures include original recognition and orthographic differences; they are not a pure measure of stitching-induced errors. For example, a one-character kanji can replace a multi-character kana spelling. Engine readiness means the two chunks agree sufficiently for joining, not that the recognition is correct. The 13 unresolved drafts are not scored as final transcripts, and the 35% operational result remains insufficient.

Regression checks retain natural repetitions, reject non-edge substring matches and changed words, reject inconsistent shared endpoints, and prove that one matching fragment cannot hide a separate contradiction. At this stage the AI crate's all-feature suite passed 134 tests. Four ignored entries are two subprocess helpers and two explicit native/long-media integration tests, previously exercised separately. AI/validation CLI Clippy passed with warnings denied. Existing partial-contradiction and repeated-word tests were not weakened.

Separate retained artifacts:

- `boundary-review-edge-match.json`: revised production-engine output; SHA-256 `4724914d0a14ee7bf15fcad118f43cabaca2926696abfbccc18878dc089a5676`.
- `boundary-change-metrics.json`: baseline comparison, unchanged-raw assertions, final-text diagnostics, and input/code hashes.
- `measure-boundary-change.mjs`: offline comparison script.
- Baseline `boundary-review.json` remains SHA-256 `53bfff5391f558e7693068e7cd86cb9daff84cdedccd7232ee948439223b3ea7`.
- Evaluated `crates/ai/src/chunks.rs` SHA-256: `e9ffb7155bdeaf294b01a510d9101a0881bbf1392feaf8837223c7230659fa23`.

The comparison used no provider retry, reference rewrite, manual boundary resolution, paid repair, or automatic adoption.

## Continuous-cue group reconciliation result

A further bounded extension handles complementary clipped groups, including one cue on one side corresponding to two cues on the other. It uses a unique exact suffix/prefix overlap of at least eight lexical units with at least four distinct units. Every raw cue in the boundary group must participate in that overlap. Each paired unit belongs to intersecting observed cue intervals; both groups touch their respective request edges within 400 ms and extend beyond the opposite edge. Groups are limited to four cues per side, 512 lexical units, and a 30-second outer span, and cannot consume cues involved in a third boundary.

This is an ASCII-word lexical comparison with punctuation and case handling, not semantic matching or inferred word timing. Unspaced-script equivalences are not introduced. Multiple possible overlaps, a repeated overlap elsewhere in either group, a changed word, an unrelated additional cue, a short match, or inconsistent timing all keep the boundary reviewable.

The joined text keeps the left group's original prefix and the right group's original continuation, including its punctuation. Its start and end are the observed outer cue endpoints. No word duration or internal timestamp is generated. Source punctuation may still need editorial review; lexical agreement does not validate sentence punctuation or recognition quality.

Each derived join now carries digest-bound `edgeGroupJoins` provenance: the method, `observed_cue_intervals` anchor kind, both original chunk ordinals and cue indices, overlap length, and joined text/times. The raw chunk arrays remain unchanged. Loading a draft rebuilds this evidence from the originals and rejects altered or removed provenance even if a caller recomputes the outer digest.

| Measure | Baseline | Edge matching | Edge groups |
| --- | ---: | ---: | ---: |
| Ready drafts | 0 / 20 | 7 / 20 | **11 / 20 (55%)** |
| Remaining conflicts | 19 | 12 | 8 |
| Unavailable pair | 1 | 1 | 1 |
| At least 90% ready | Fail | Fail | **Fail** |

Only English 03, 05, 06, and 10 became newly ready. Their final complete-text WER values are respectively 1.754%, 0%, 1.389%, and 0.917%, with no normalized word insertions or deletions. These figures retain model recognition differences outside or within the whole case and are not pure stitching-error scores. English 03 retains the repeated phrase “the words, the words.” The previous seven ready drafts retain identical final text and timings.

The remaining conflicts comprise five real text disagreements, two Japanese orthographic differences (`すべて`/`全て`, `時`/`とき`), and one missing counterpart at a request edge. They were not normalized away. The originally invalid English 04 chunk also remains unavailable. The result still does not meet the operational criterion.

The group-reconciliation checks passed 138 AI tests and 16 validation CLI tests; four AI entries remain ignored as described above. The subsequent explanation-prompt freeze regression brings the final AI total to 139 passing tests. Clippy passed for both crates and all targets with warnings denied. New tests cover both split directions, natural repetition, repeated/ambiguous overlaps, changed words, unmatched additional cues, non-edge/short matches, temporal inconsistency, and provenance tampering.

Third result and comparison artifacts, with the earlier two results preserved:

- `boundary-review-edge-group.json`: SHA-256 `fba677ae913e7eb66e8db5e2a05d6e89dc2e0ce99e34a85b3f111d462b64b35f`.
- `boundary-group-metrics-formatted.json`: final comparison and formatted-source hashes. `boundary-group-metrics.json` retains the same measurements from immediately before formatting one test statement.
- `measure-boundary-groups.mjs`: offline raw/provenance assertions and final-text diagnostics.
- Final formatted `crates/ai/src/chunks.rs`: SHA-256 `e482d5d8de7e1f89e650faf45656a039b5f553d53e7b57443de233a170e7de8c`.
- `crates/ai/src/transcript_review.rs`: SHA-256 `128ad092827f6f0eab578c3dc4c72dbc4691af3a7583559547323b5d1879d67b`.

This third evaluation also made zero provider requests, ledger changes, paid repairs, or subtitle adoptions.

## Residual review and lexical-integrity correction

A subsequent review found an implementation defect independent of the retained corpus failures: exact-cue comparison removed all spaces and ASCII punctuation. It could therefore consider `now here` equivalent to `nowhere`, or `3.5` equivalent to `35`, and discard one variant. Exact, fragment, and group comparisons now share lexical boundaries. Contiguous Unicode letters, numbers, and combining marks retain their word boundaries; Han and kana retain character units for unspaced fragments. NFC normalization and case comparison remain available, while decimal separators, currency/percentage symbols, signs, hyphens, and apostrophes remain significant. This does not infer pronunciation, synonyms, or kanji/kana equivalence.

Group matching still has its previous ASCII-word scope and original byte offsets. Symbols must agree but cannot count toward the minimum eight-word overlap or four-distinct-word requirement. Published overlap counts remain word-unit counts. Existing joined text, observed endpoints, and provenance therefore remain stable for these saved cases.

The final offline rerun still produces **11 / 20 ready drafts (55%)**, **8 conflicts**, and **1 unavailable pair**. Every complete draft compares equal to the third result: raw chunks, proposed text/times, conflict alternatives, pending ranges, join provenance, and digests. The correction prevents an unsafe equality case; it does not establish a higher corpus score or satisfy the 90% operational criterion.

The nine remaining cases have distinct causes:

| Case | Retained evidence | Classification and handling |
| --- | --- | --- |
| English 01 | The clipped phrase says `and sauce`; the complete counterpart ends `flour-fattened sauce`. | A genuine lexical disagreement between responses. An unrelated matching sentence cannot justify deleting the extra word. |
| English 04 | The first response's last word spans 16.000–16.100 s, but its prepared request ends at 16.085 s. | Provider timing exceeds the input bound by 15 ms. The strict parser rejected the response; it remains unavailable, with its original evidence and settled 1,286 microUSD charge preserved. Observed timestamp granularity is not permission to fabricate or clamp word timings. |
| Japanese 01 | One full left cue ends 60 ms after the right request begins; no right counterpart was returned. | An omitted request-edge counterpart. The complete left cue is retained. A short overlap alone does not prove silence or agreement. |
| Japanese 03 | Corresponding wording differs at `として` / `が`. | A genuine lexical disagreement. Particle changes require review. |
| Japanese 05 | Responses differ at `巻き試験` / `期末試験` and `基礎が` / `木曽川`. | Genuine lexical disagreements; selecting an intended meaning would require evidence beyond exact stitching. |
| Japanese 06 | `すべて` / `全て`. | An orthographic difference, not an established recognition error. Exact written-form alignment intentionally leaves it reviewable. |
| Japanese 08 | `塀` / `兵`. | A changed written word. Similar pronunciation cannot certify the intended word. |
| Japanese 09 | `時` / `とき`. | An orthographic difference, not an established recognition error. No semantic normalization was added. |
| Japanese 10 | A clipped fragment differs at `老人や` / `疲労や`. | A genuine lexical disagreement. The earlier natural repetition remains preserved. |

Thus five cases contain lexical disagreements, two exceed the exact-written-form alignment scope, one lacks a context-edge counterpart, and one fails the provider timestamp contract. These are not nine interchangeable model recognition errors. No further automatic reconciliation was justified by this review. Explicit local review or a separately approved repair remains necessary; no repair or retry was performed for this assessment.

The final AI suite passes 143 tests with the same four ignored entries described above, and the validation CLI passes 16 tests. Clippy passes for both crates, all features and all targets, with warnings denied. Regression coverage includes accented word boundaries, Greek and Korean word spacing, NFC-equivalent accents, Unicode numeric separators, decimal/currency/percentage distinctions across all match paths, and preservation of an unmatched 60 ms context edge. Natural repetition and partial-contradiction regressions remain unchanged.

Retained final evidence:

- `boundary-review-lexical-integrity-final.json`: SHA-256 `fba677ae913e7eb66e8db5e2a05d6e89dc2e0ce99e34a85b3f111d462b64b35f`, identical to the third result.
- `boundary-lexical-integrity-metrics.json` and `measure-boundary-lexical-integrity.mjs`: full-draft equality assertions, residual classifications, and input/code hashes.
- Evaluated `crates/ai/src/chunks.rs`: SHA-256 `7b4c0426cfba29e1583f299a231d21ad8630b988433afdf4a4014574c1da82cb`.
- Earlier baseline, edge-match, and edge-group artifacts remain intact. Two intermediate lexical-check outputs also remain available; they preceded restoring the public word-unit count and are not substituted for the final result.

This correction and all reruns used zero provider requests, ledger changes, paid repairs, or subtitle adoptions.

## Optional VAD evidence compatibility check

After adding optional within-chunk VAD pause evidence for newly prepared audio, the same retained boundary manifest and provider report were read once through the production review engine to verify backward-compatible serialization. The new `boundary-review-vad-optional-compatibility.json` is byte-identical to `boundary-review-lexical-integrity-final.json`, with SHA-256 `fba677ae913e7eb66e8db5e2a05d6e89dc2e0ce99e34a85b3f111d462b64b35f`. All 20 draft digests, original responses, pending ranges, conflicts, and review decisions are unchanged. Evidence absent from historical inputs remains absent; no pause inference is invented for them.

`vad-optional-compatibility.json` records the input/output hashes and source hashes at execution, while `verify-vad-pause-compatibility.mjs` contains the byte-equality and unchanged-input assertions. This check made zero network requests, ledger changes, or adoptions. It establishes compatibility only: the retained 11/20 readiness result and failed 90% operational criterion are unchanged. The additional review safeguard is described in the [audio quality report](ai-audio-quality-2026-09-09.md#additional-local-review-safeguard).
