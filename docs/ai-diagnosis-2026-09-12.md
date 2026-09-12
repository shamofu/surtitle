# Subtitle and explanation diagnosis — September 12, 2026

The authorized twenty-request diagnostic stage is complete: nineteen requests
returned structurally valid outputs and one explanation request was rejected with
HTTP 429. Successful parsing is not a quality pass. Flash 3.8 invented speech on both
non-speech controls, and four of the five received explanations require correction.
Transcribe performed better on timing and non-speech handling in these short samples.

## Scope and execution

The exact prepared campaign used Vertex AI `global`,
`gemini-3.5-transcribe-preview`, and `gemini-3.8-flash` with `LOW` thinking. It
contained six explanation requests, six audio conditions through each model, and
two recognition-only Transcribe requests with `wordTimestamp=false`. Each request
had one candidate and a 4,096-token output limit. The four speech clips contain
29.250 seconds of audio; duplicated speech, silence, and tone requests total
112.125 seconds.

Request six, the C1 explanation of 気づいた, returned HTTP 429. The application
retained its reservation and stopped. After explicit user approval, the same
reservation was acknowledged without refund and the fourteen never-attempted audio
jobs continued, with fifteen seconds between distinct requests. The failed
explanation was not retried. No other campaign, model switch, boundary repair, or
later evaluation stage was run.

Google documents capacity/quota-related causes for
[HTTP 429](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deploy/error-code-429).
The retained status alone does not establish the particular cause in this project.

## Explanation findings

An independent AI review used the frozen v2 criteria and original source contexts.
Each item has separate meaning, example/context, bilingual gloss, and explanation
scores, plus an accessibility assessment. This is not human review or measured
learner comprehension.

| Case | Assessment | Observed issue |
| --- | --- | --- |
| `keep an eye on`, C1 | Requires correction | The central monitoring sense is correct, but the comparison presents it as more inherently vigilant/caring than `watch` without adequate qualification. |
| `figured out`, B1 | Usable | Correct contextual meaning and a useful `why`/`how` construction; no forced synonym contrast. |
| `figured out`, C1 | Requires correction | Useful construction detail remains, but `find out`/`realize` are described as passive ways of learning, an overgeneralized comparison. |
| 白紙に戻った, A2 | Requires correction | The reset sense is retained, but “completely cancelled” is too broad for the discussion context unless it refers to previous arrangements. No restart or actor is invented here. |
| 白紙に戻った, B1 | Critical error | The meaning adds a completed restart, and the construction explanation confuses the subject/object roles of 戻る and 戻す. |
| 気づいた, C1 | Not assessed | HTTP 429; no generated explanation was available. |

One received item was usable, three needed correction, and one had critical errors.
All five were judged understandable in presentation at the requested levels;
accessibility does not make incorrect content safe. The comparison and A2 wording
downgrades are distinguished from the concrete B1 restart error. A separately
generated example may introduce its own context: the B1 example's budget problem
was not misreported as a cause asserted by the original subtitle.

Lexical checks support overlapping monitoring meanings for
[`watch`](https://dictionary.cambridge.org/us/dictionary/english/watch) and
[`keep an eye on`](https://dictionary.cambridge.org/us/dictionary/english/keep-an-eye-on),
and active information-seeking uses of
[`find out`](https://dictionary.cambridge.org/dictionary/english/find-out).
The intransitive reset expression describes a resulting blank state; it does not
establish a subsequent restart. See
[Digital Daijisen's entry](https://kotobank.jp/word/%E7%99%BD%E7%B4%99%E3%81%AB%E8%BF%94%E3%82%8B-600198).

## Audio findings

| Diagnostic | Transcribe | Flash 3.8 |
| --- | --- | --- |
| Four speech clips | All four produced valid timed output. One English proper name differed from the reference. | All four produced valid timed output with exact normalized text. |
| Exact digital silence, 10 seconds | Empty transcript | Four fabricated cues containing 35 normalized words |
| Deterministic tones, 10 seconds | Empty transcript | Four fabricated cues containing 29 normalized words about a driverless-car scene |
| English/Japanese recognition without word times | Both matched the selected references and the corresponding timed-mode text | Not part of this scope |

The exact immutable control inputs were rechecked after execution: every sample of
the silence file is zero, and every sample of the tone file matches the frozen
deterministic generator. Input hashes match the paid request bindings. Flash's
control outputs are therefore false-speech failures, not successful silence
detections, invalid JSON, or unavailable responses. The frozen Flash prompt already
explicitly requested an empty cue array when no speech is present.

Normalized English recognition was 0/28 and 1/19 word errors for Transcribe, versus
0/28 and 0/19 for Flash. The differing proper name was `Tintoret` versus
`Tintoretto`. Both models matched the Japanese references at 0/22 and 0/23 character
errors. These normalization-based scores do not certify punctuation or every
orthographic choice.

Timing uses automatic MFA word estimates for English and automatic Julius utterance
endpoints for Japanese, not human annotations. Transcribe's exact lexical word
matches covered 26/28 and 18/19 English reference tokens: a merged compound and the
changed proper name were excluded rather than forced into matches. Median scored
endpoint error was 30 ms for each English clip, with p95 of 60 ms and 70 ms.

Across the four speech recordings, Transcribe's outer start errors were
90/50/0/10 ms and outer end errors were 10/50/10/10 ms. Flash's outer start errors
were 500/540/300/290 ms and outer end errors were 300/430/150/40 ms. These outer
boundaries are a separate diagnostic aggregation. Partial Flash cues were not
falsely matched one-to-one to a full English utterance. Japanese internal word
timing remains unassessed.

Internal Flash cue boundaries also drifted. In the second English clip, the first
cue ended at 4.820 seconds, while the automatic reference for its exact text ended
at 3.010 seconds: a 1.810-second difference. This comparison aggregates the exact
contiguous reference words for that cue and remains separate from frozen
one-to-one utterance mappings. One Japanese Transcribe word retained a point
timestamp at 4.100 seconds; the evidence is preserved, but it does not supply a
standalone word duration for playback.

## Cost and preserved evidence

| Application accounting | USD |
| --- | ---: |
| New settled usage, using the reviewed price snapshots | 0.031747 |
| New acknowledged reservation for HTTP 429 | 0.044729 |
| New usage plus retained reservation | 0.076476 |
| Cumulative historical usage/holds plus this stage | 1.272194 |
| Authorized cumulative ceiling | 10.000000 |

The original additional reservation ceiling was USD 0.966557. All twenty jobs were
attempted at most once. The original 119 attempts are unchanged; the only change
to the six-attempt intermediate state was the separately approved acknowledgement
of the new 429 hold. No unknown reservation was refunded, no ledger was reset, and
no unpriced request was sent.

These are application accounting values, not a Google invoice. Flash's snapshots
conservatively retain the published standard rates before introductory credits;
see [Google pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).

Private evidence is under `work/quality-diagnostics-20260912/`: the original
campaign quote and references, `run-20260912/` for the six-request run and semantic
review, and `continuation-20260912/` for the approved audio continuation, input audit,
final report, and timing review. Every report preserves failed and empty results.
Historical and intermediate reports remain separate.
`diagnosis-final-index.json` records the final hashes, exact twenty-attempt scope,
unchanged historical rows, and verified cost totals.

The final stage-only derivative retains all twenty expected request rows, including
the rejected explanation, and excludes historical jobs only by exact campaign
membership. The rubric binds five semantic reviews and 49 legitimate timing
mappings to the final result/reference hashes. The evaluator retains failed gates
and `modelQualified=false`; automatic audio references are not promoted to human
ground truth. Its diagnostic status is `oracle_or_unverified_evidence`, rather than
a release qualification pass.

## Decisions

1. Keep Transcribe as the next transcription candidate to evaluate. These four
   short clips do not resolve the historical long-chunk and boundary failures.
   Untimed results provide recognition diagnostics only, not replacement subtitles.
2. Do not treat the current Flash subtitle adapter as a qualified fallback. Its
   false speech on both controls is a material failure despite good clean-speech
   recognition. A future change must preserve no-speech evidence and require review
   of speech/no-speech conflicts; merely accepting valid JSON is insufficient.
3. Refine explanations around the source's asserted facts, explicit grammatical
   roles, and optional, qualified usage distinctions. Keep the critical restart
   example as a regression. Do not put reference answers into production prompts.
4. After justified local fixes, prepare the independent sixty-request explanation
   and eighty-request boundary stages, each with its own input review, estimate,
   and approval. Do not claim completion, weaken thresholds, or rerun this stage
   until it happens to pass.

This reused development set is deliberately diagnostic. It does not satisfy the
minimum independent sample coverage, noisy/conversational speech coverage, Japanese
word-reference coverage, or long-video boundary qualification requirements.
Development remains on uncommitted `main`.
