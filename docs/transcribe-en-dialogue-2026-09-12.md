# Transcribe English dialogue partial pilot, 12 September 2026

This report records the separately approved six-request comparison following the
[completion follow-up](completion-followup-2026-09-12.md). It covers one English
dialogue selection only. It does not replace the frozen four-condition pilot,
establish independent confirmation, select a production chunk profile, or qualify
the Preview model for all learning materials.

## Fixed source and execution

The source is the AMI ES2002a meeting, from 62.72 to 302.72 seconds: a continuous
four-minute selection with 477 complete upstream human lexical annotations. The
existing English scoring normalization produces 482 word-error-rate units.
Attribution, usage conditions and original annotation verification are retained in
the [reference preparation record](transcribe-references.md). Simultaneous speakers
occupy 9.29 seconds of the selected source and are identified separately. No new
human listening or acoustic annotation was performed in this comparison.

Both profiles used the existing production Silero VAD and chunk planner, retained
all source samples, and added up to three seconds of context on each side. Every
prepared waveform and immutable copied input matched its reviewed source slice.
The reference and configuration were fixed before requesting model output.

| Profile | Target / search / maximum | Requests | Sent audio including context |
| --- | --- | --- | --- |
| Current | 120 / 90–150 / 180 seconds | 2 | 246 seconds |
| Short candidate | 60 / 45–75 / 90 seconds | 4 | 258 seconds |
| Total | Same 240-second source | 6 | 504 seconds |

All six requests used `gemini-3.5-transcribe-preview` at Vertex AI `global`,
`VERBATIM`, word timestamps enabled, diarization disabled, `en-US`, omitted
thinking, and an 8,192-token output limit. All six responses reported the same
model version, finished with `STOP`, passed the current parser and settled once.
No retry, model switch, input regeneration or additional request occurred.

## Recognition, timing and recovery observations

The offline native review uses the production transcript-draft builder and
stitcher on the exact prepared ranges and saved parsed responses. All six chunks
are present, nonempty and valid. Both profiles still have unresolved boundary
alternatives, so neither native draft is ready for adoption.

| Observation | Current 120-second profile | Short 60-second profile |
| --- | ---: | ---: |
| Original provider word records, including context | 428 | 466 |
| Preserved point-time word anchors | 18 | 22 |
| Reversed, nonmonotonic or out-of-range word records | 0 | 0 |
| Unresolved boundaries / total boundaries | 1 / 1 | 2 / 3 |
| Uncorrected provisional full-selection WER | 108 / 482 = 22.41% | 89 / 482 = 18.46% |
| Substitutions / deletions / insertions | 32 / 67 / 9 | 24 / 52 / 13 |
| Proposed exact lexical timing matches | 383 / 477 | 406 / 477 |
| Reference words without an exact timing match | 94 | 71 |
| Endpoint error median, matched subset only | 32 ms | 36 ms |
| Endpoint error p95, matched subset only | 570 ms | 600 ms |
| Native boundary intervals requiring review, union | 4.400 seconds | 12.748 seconds |

The full-selection WER retains fillers, repetitions and simultaneous turns, and
scores the uncorrected provisional draft including unresolved boundary effects.
It is a diagnostic of the current output, not the policy's separately adjudicated
clear-speech WER. The source's overlapping words are not silently deleted to make
the score better. A different interleaving of simultaneous speakers can also
affect this deterministic text alignment.

For a separate overlap diagnostic, 404 normalized reference units do not intersect
annotated simultaneous speech; 78 do. On the full provisional alignment, the
non-overlap reference units have 58 substitution/deletion errors for the current
profile and 34 for the short candidate. The 9/13 insertions cannot be assigned
reliably to an overlap condition from that alignment. Assigning none versus all
of those insertions gives diagnostic fractions of 14.36–16.58% and 8.42–11.63%.
These are not exact clear-speech WERs, confidence intervals or acoustically
adjudicated acceptance scores. In particular, the short interval crossing 10%
does not establish a pass.

An additional reference-assisted boundary-selection projection uses only complete
existing provider cues. It selects among the retained alternatives without
inserting reference words or changing any saved native draft. Its full-source
diagnostic is 106/482 (21.99%) versus 84/482 (17.43%). Those values are explicitly
reference-assisted, not unaided recognition scores or a native adoption result.
Resolving those boundary choices alone does not remove the recognition problems.

Timing matches are automatic exact lexical proposals against upstream human word
coordinates. Core ownership chooses among duplicate-context candidates, never
minimum timing error. No new listener verified these correspondences. The good
medians do not establish complete timing coverage: 94 or 71 reference words lack
an exact match, and even the matched-subset p95 exceeds 400 ms. Point anchors are
reported unchanged; no duration was interpolated.

Native boundary review intervals are not the total audio duration needing
correction. Recognition errors also occur away from boundaries, and the complete
manual correction observation has not been performed. That metric remains
`null`, rather than reporting zero or treating entire chunks as incorrect.
The offline review does not supply within-chunk VAD contradiction evidence, so
its adoption result is not a complete desktop warning check.

The short candidate has fewer full-draft recognition errors in this one recording,
but more unresolved boundaries and a slightly worse matched-subset timing p95.
This does not meet the evidence needed to change the production profile. The
existing chunk setting remains unchanged; English lectures, both Japanese cells,
independent confirmation, difficult-condition qualification and 100 real-player
listening observations remain outstanding.

## Reference-based examples

A separate six-example review records exact source/reference IDs, speaker groups,
request offsets and output cue indices. Both profiles omit the opening filler and
some backchannels, and both omit an annotated overlapping volunteer response.
The short candidate retains the named phrase “Planet of the Apes” where the
current profile returns “planet Earth”. It also better matches one later content
phrase. These are local observations, not a profile-wide quality ranking.

The short profile's adjacent requests disagree on the repeated “blue / Blue
beagle” phrase. The later request starts at 239.900 seconds, inside the annotated
word at 239.850–239.980 seconds. Its partial word context is explicitly retained;
the differing phrase is not mislabeled as a fully observed hallucination. No
reference-based example was recorded as newly listened-to audio.

## Authorization and accounting

The user approved this exact scope by replying “Proceed” to the preceding quote.
The runner accepted the original campaign approval template, checked each job's
immutable manifest and reservation, and invoked requests serially. It required a
completed result and known settlement within the reservation before continuing.

| Accounting item | USD |
| --- | ---: |
| Approved reservation for this comparison | 0.675450 |
| Current profile calculated charge | 0.019766 |
| Short profile calculated charge | 0.021196 |
| Total new calculated charge | 0.040962 |
| New unknown holds | 0 |
| Preserved earlier HTTP 429 hold | 0.044729 |
| Cumulative calculated charges and retained holds, including earlier roots | 1.313156 |

Charges were calculated from reported usage at the independently reviewed price
snapshot: USD 2 per million audio-input tokens and USD 12 per million output
tokens. The price source is Google's [official pricing page](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).
The reservation included the full configured output allowance; it was not
the actual charge. These values are application accounting, not a Google invoice.
The previous 139 attempts and all historical table rows remained unchanged. The
same validation root retains its USD 9.038283 lifetime cap, which already deducts
USD 0.961717 from the user's cumulative USD 10 allowance for earlier history.

An independent read-only audit verified live SQLite against the saved reports,
all prior rows, six unique campaign members with one serial settled attempt each,
unchanged limits and the original hold. Its receipt is
`candidate-approved-run-v1/independent-ledger-audit.json` under the work directory.

## Retained evidence

The original unapproved quote remains unchanged under
`work/transcribe-production-20260912/candidate-unapproved-quote-v1/`. Approval,
per-request command results, bounded provider evidence, before/after ledger
records and the final execution summary are retained separately under
`work/transcribe-production-20260912/candidate-approved-run-v1/`.

Offline review, complete alignment diagnostics and all unmatched reference IDs
are under `work/transcribe-production-20260912/candidate-evaluation-v1/`.
These artifacts never update the provider response, cost ledger or learning data.
Seven focused evaluator tests passed, including retained repetitions, exact
reference denominators, invalid/point time evidence, submillisecond point
preservation and incomplete correction observations. An independent implementation
of the numeric checks reproduced the reported WER and endpoint summaries.
The generic submillisecond diagnostic fix did not change any observed result.

The native source/recipe/packaging input check still passed. No product source or
production model/chunk setting changed during this evaluation, so the previously
verified normal application and installer remain the same builds.

The executed validator SHA-256 is
`5a9ab0aa6bfd50186c6b4f192b89a050a28e86e9b28b67b68e24e98b95e6d498`.
Its recorded source inventory matched before execution. This development-only CLI
uses the application's request, parsing and accounting code, a separate validation
profile and the Rust credential vault; it is excluded from normal app packaging.
Credentials and authentication tokens were not printed or copied into reports.

Development remains on uncommitted `main`; no build, installer or evaluation
artifact was published.
