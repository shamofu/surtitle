# AI evaluation history

These dated observations describe specific saved runs, not current model certification. Automated parsing, AI review, forced alignment and player-state checks do not establish independent human listening or learning quality. The research programs formerly under `scripts/ai-tests/` have been removed; application parser, accounting and transcript-review regressions remain.

The original reports and research code are recoverable from [source commit d2b0b80a](https://github.com/shamofu/surtitle/tree/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0). Private evidence paths below are Git-ignored workspace records, not bundled assets. Consolidation does not change responses, scores, charges or holds. See [current status](status.md), [AI behavior](ai.md) and [evaluation scope](transcribe-production.md).

## Live functional verification — 9 September 2026

Nineteen serial Vertex requests used the earlier Flash Lite / Flash 3.5 and Transcribe Preview selections: one preceding vocabulary request, fourteen initial cases and four separately approved rechecks. The user authorized a cumulative USD 10 allowance. The normal application profile was separate.

Vocabulary, translation, explanation and short transcription paths returned usable examples, but the run was not an all-feature quality pass. Japanese vocabulary changed transitivity; split-expression citations initially omitted a source cue; a quoted command was mistranslated; Flash invented speech on two seconds of digital silence. The 7.060-second English clip matched its 21-word reference. The 1.272-second Japanese clip was too small to establish general accuracy.

The four rechecks fixed split-cue citations at A2/C1 and accepted a valid empty Transcribe STOP response with equal input/total token counts. Literal URL/code preservation improved, but the quoted phrase still failed semantic review. New settled charges were USD 0.001727. The original unknown silence attempt remained held rather than being refunded or rewritten as successful.

Evidence: `work/ai-functional-20260909/validation/all-features-report.json`, `all-features-after-recheck-report.json`, `work/ai-functional-20260909/reviews/`, and `work/ai-functional-20260909-native/`. Audio provenance is in that validation directory's `fixtures/PROVENANCE.md`. Restricted Japanese audio was never a public application fixture.

## Text and long-audio evaluation — 9 September 2026

The later validation root processed 119 requests once, with USD 0.234001 settled usage and no new unknown holds. Its original lifetime cap was USD 9.038283 after the earlier USD 0.961717 debit. Billing metadata returned HTTP 403; discovery/generation availability and price metadata were treated separately.

The final text subset contained 70 requests and 189 reviewed items. Ten extra B1 requests completed the same ten T01 expressions at A2/B1/C1 in both languages without modifying the original 179 scores. Five of six language/task groups passed. English explanations averaged 1.906/2; Japanese explanations averaged **1.767/2**, below the historical 1.80 criterion. The final text charge was USD 0.142765, including USD 0.018374 for the ten additions. These were AI judgments, not human review or general CEFR qualification.

The subsequent explanation-prompt refinement received offline approval/body-binding tests, but no new paid semantic evaluation. It does not erase the failed score.

| Long-audio case | Retained recognition evidence | Cue endpoints scored | Median / p95 endpoint error |
| --- | --- | --- | --- |
| English 1, Transcribe | WER 1/221 = 0.452% | 26/26 | 34.5 / 90 ms |
| English 1, Flash 3.8 | WER 0/221 = 0% | 14/14 | 1,796 / 4,050 ms |
| English 2, Transcribe | WER 4/378 = 1.058%, offline reparse | 54/56 | 35 / 95 ms |
| English 2, Flash 3.8 | WER 9/378 = 2.381% | 59/60 | 832 / 6,540 ms |
| Japanese, Transcribe | Raw-text diagnostic CER 38/484 = 7.851%; invalid times | Not assessed | Unavailable |
| Japanese, Flash 3.8 | No retained candidate text | Not assessed | Unavailable |

The historical timing targets were median <=150 ms and p95 <=400 ms. English Transcribe word matches covered 218/221 and 375/378 words, with p95 76/75 ms. Excluded endpoints/words still prevent complete-coverage claims. English 2's eleven equal-time anchors were reparsed without inventing word durations; its original failed state and USD 0.013182 charge remain unchanged. Reversed Japanese word times, the absent Japanese Flash candidate and an unusable English boundary chunk were not retried or relabeled.

Evidence root: `work/ai-evaluation-20260909/`. Final text results are `text-results-complete.json` (SHA-256 `bb3c04d4b7e7ecdd57fb81eb187013fcd30f0c69b2dec1253dca3e11e44b3c46`) and `text-rubric-complete.json` (`92eda5d241bcddfda73b7c69edde109fa03ff77251fd869dee02847acb7ba0af`). The independent reference manifest hash is `afc1b5c2a354e2df596b98e68627a8867c4d83db109e8273b13e06e39ae13879`. Original results, review files and audio provenance remain in that root.

## Boundary reconciliation — 9 September 2026

Twenty distinct recorded cuts progressed from 0/20 ready drafts, to 7/20 with conservative edge matching, to **11/20 (55%)** with continuous-cue group reconciliation. Eight conflicts and one unavailable pair remained; the historical >=90% automatic-stitching gate failed at every stage. Real text disagreements, Japanese orthographic differences and missing counterparts were not normalized away.

Joins preserved original cue text, observed outer endpoints and digest-bound provenance. They did not infer internal word times. Later lexical-boundary fixes prevented false equivalence such as `now here`/`nowhere` and `3.5`/`35`. Reprocessing and adding optional VAD evidence left all twenty historical drafts byte-identical, including the same failures, without another request or ledger change.

Evidence: `work/ai-evaluation-20260909/boundary-review-edge-group.json`, `boundary-review-lexical-integrity-final.json`, and `boundary-review-vad-optional-compatibility.json` share SHA-256 `fba677ae913e7eb66e8db5e2a05d6e89dc2e0ce99e34a85b3f111d462b64b35f`. The associated `boundary-group-metrics-formatted.json` and `boundary-lexical-integrity-metrics.json` retain comparisons and source identities. The current review-assisted policy treats automatic joining as an improvement target; that does not retroactively pass this earlier gate.

## Local Whisper experiments — 9–12 September 2026

The first raw-DTW alignment experiment retained all 37 English cue texts but worsened endpoint errors. Inspection found structural window boundaries being mistaken for acoustic onset. It was not adopted. A successful forced-alignment call also accepted unrelated-text controls, so alignment alone did not establish that text was spoken.

The later audio-only experiment used faster-whisper 1.2.1, CTranslate2 4.8.2 and multilingual `Systran/faster-whisper-base` commit `a80717a3a48b1b28aa687bca146cb7301feae1b1`. It used CPU float32, two threads, temperature zero, beam five, word timestamps, no previous-text conditioning and no VAD filtering. There were no inference retries or reference hints in recognition.

| Measure | English, 37 original Flash cues | Japanese, 28 original Transcribe cues |
| --- | --- | --- |
| Exact-text proposals | 22/37 (59.5%) | 8/28 (28.6%) |
| Required proposal coverage | >=80%, failed | >=80%, failed |
| Expected endpoints | 74 | 56 |
| Unavailable reference endpoints | 1 | 36 |
| Scored proposed endpoints | 44 | 4 |
| Proposed timing median / p95 | 148 / 555 ms | 100 / 240 ms, four endpoints only |

Both digital-zero controls produced invented words; both tone controls were empty. Coverage and silence failures independently prevented adoption. All 51 windows completed; recorded loading/inference time was 144.030 seconds, maximum 7.512 seconds per window, peak process RSS 785,346,560 bytes. These Linux-container measurements exclude interpreter/import startup and do not establish Windows application performance.

Evidence: `work/whisper-quality-20260912/final-evidence.json`, `recognition.json`, `evaluation.json`, `validation.json`. Recognition SHA-256: `6376e9c7af933e5e64635284580105fc92d2d48fc1e6dbf761b4e13f0081f8f8`; input plan: `9a062873eec00b40a4f2a64fa8b082b39597a8c34509777dcfbfe1e12d452fb1`; model: `d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9`. Models, dependencies and restricted Japanese audio stayed outside the application distribution. No cloud call or ledger change occurred.

## Twenty-request diagnosis — 12 September 2026

Nineteen results and one HTTP 429 were retained, each attempted once. Of five received explanations, one was usable, three required correction and one had a critical error adding a restart and confusing Japanese grammatical roles. The sixth explanation was unavailable. Presentation accessibility did not make incorrect content acceptable.

Both models transcribed four short speech clips. Transcribe returned empty transcripts for ten-second digital silence and deterministic tones; Flash invented 35 and 29 normalized words respectively. Exact control PCM samples and request bindings were rechecked. English Transcribe recognition was 0/28 and 1/19 errors; Flash was 0/28 and 0/19. Both matched the tiny Japanese references at 0/22 and 0/23 CER units. Transcribe timing matches covered 26/28 and 18/19 English words with p95 60/70 ms; these automatic-reference subsets did not establish general or Japanese word timing quality.

Evidence: `work/quality-diagnostics-20260912/diagnosis-final-index.json`, `run-20260912/` and `continuation-20260912/`. The index binds all twenty attempts, unchanged historical rows, final hashes and accounting. The final evaluator retained `modelQualified=false` and `oracle_or_unverified_evidence`, including the failed explanation and controls.

## English dialogue partial pilot — 12 September 2026

Six separately approved requests compared two profiles on AMI ES2002a at 62.72–302.72 seconds. The same continuous 240 seconds contain 477 complete upstream lexical annotations, normalized to 482 WER units, and 9.29 seconds of simultaneous speech. Current 120-second targeting sent two requests/246 seconds with context; the short 60-second candidate sent four/258 seconds. Total submitted audio was 504 seconds.

All six used `gemini-3.5-transcribe-preview`, `global`, VERBATIM, word timestamps, no diarization, `en-US`, omitted thinking and 8,192 output tokens. They returned valid nonempty STOP results and settled once, without retry or a new hold.

| Observation | Current profile | Short candidate |
| --- | --- | --- |
| Full provisional WER | 108/482 = 22.41% | 89/482 = 18.46% |
| Substitutions / deletions / insertions | 32 / 67 / 9 | 24 / 52 / 13 |
| Exact lexical timing matches | 383/477 | 406/477 |
| Reference words without a timing match | 94 | 71 |
| Matched endpoint median / p95 | 32 / 570 ms | 36 / 600 ms |
| Unresolved / total boundaries | 1/1 | 2/3 |
| Preserved point-time anchors | 18 | 22 |
| Boundary-review interval union | 4.400 seconds | 12.748 seconds |

WER includes fillers, repetitions, simultaneous turns and unresolved boundary effects. It is not separately adjudicated clear-speech WER. Reference-assisted projections (106/482 and 84/482) are derivatives, not unaided recognition results. Boundary-warning duration is not total correction effort; complete correction observations remain null. No new human listening occurred, no profile was promoted, and the other language/genre cells remain incomplete.

Evidence: `work/transcribe-production-20260912/candidate-approved-run-v1/` for approval/execution and `independent-ledger-audit.json`; `candidate-evaluation-v1/` for offline scores and unmatched IDs. The original `candidate-unapproved-quote-v1/` remains unchanged. Validator SHA-256: `5a9ab0aa6bfd50186c6b4f192b89a050a28e86e9b28b67b68e24e98b95e6d498`.

## References and unexecuted preparation — 12 September 2026

The original four-condition pilot remained a **preparation**, not a paid execution: current profile 8 requests/984 seconds, short profile 16 requests/1,032 seconds, total 24 requests/2,016 seconds/32,256,000 PCM samples. Fourteen pilot cuts did not satisfy the twenty-boundary independent-confirmation requirement. This frozen preparation is distinct from the six executed English-dialogue requests above.

`references-v2/report.json` verified AMI ES2002a (2,600 words), AMI ES2004a (2,614 words) and Koniwa Amagasaki 2011-04-20 (150 utterances). Partial edge words, competing Koniwa annotation levels and absent Japanese word anchors remained explicit. Five references in the original eight-source selection were still missing. The independent source manifest hash was `601cf815842624d2bc57ee70eacd884cd219433203a7e517590f71b011313107`.

On that date, exact Commons/publisher/Koniwa checks found no corresponding references for the five missing recordings. NICT SPREDS downloads returned maintenance HTML, not archives. Two alternative MIT lectures had publisher VTT files but no downloaded/listened-to media; their CC BY-NC-SA terms and cue-only timing did not make them approved replacements. These were dated retrieval observations, not claims about present availability.

Evidence root: `work/transcribe-production-20260912/`, including `source-materials/source-manifest-independent.json`, `pilot-preparations/`, `pilot-validation-preparation.json`, `references-v2/report.json`, and `reference-discovery/research-files.json`. Source/reference preparation requirements remain in [reference guidance](transcribe-references.md).

## Accounting across the recorded stages

| Stage | New settled usage, USD | New retained hold, USD | Cumulative charges + holds, USD |
| --- | ---: | ---: | ---: |
| Initial functional verification, including rechecks | 0.019505 | 0.942212 | 0.961717 |
| Later 119-request evaluation | 0.234001 | 0 | 1.195718 |
| Twenty-request diagnosis | 0.031747 | 0.044729 | 1.272194 |
| Six-request English dialogue | 0.040962 | 0 | 1.313156 |
| Total | **0.326215** | **0.986941** | **1.313156** |

The dialogue reservation was USD 0.675450; its charges split into USD 0.019766/current and USD 0.021196/short. Reservations were ceilings, not actual charges. Both historical holds remain retained. Values are application accounting from recorded usage/price snapshots, not a Google invoice. The cumulative authorized ceiling was USD 10; consolidating documentation authorizes no further request.

## Original report index

All paths below are under `docs/` in the source commit named above: [ai-verification-2026-09-09.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/ai-verification-2026-09-09.md), [ai-quality-2026-09-09.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/ai-quality-2026-09-09.md), [ai-audio-quality-2026-09-09.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/ai-audio-quality-2026-09-09.md), [ai-boundary-quality-2026-09-09.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/ai-boundary-quality-2026-09-09.md), [whisper-quality-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/whisper-quality-2026-09-12.md), [ai-diagnosis-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/ai-diagnosis-2026-09-12.md), [transcribe-en-dialogue-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/transcribe-en-dialogue-2026-09-12.md), and [transcribe-reference-discovery-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/transcribe-reference-discovery-2026-09-12.md). They retain the full original tables, commands, attribution links and intermediate artifact identities.
