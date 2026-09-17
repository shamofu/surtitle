# Evaluating transcription quality

The application supports review-assisted transcription and learning from available ranges. Quality evaluation is separate from build/test CI: the removed `scripts/ai-tests/` programs are not prerequisites for playback, transcription or release packaging. Current behavior is described in [AI design](ai.md) and [draft study](draft-study.md).

## Product questions

A useful evaluation should measure whether a learner can find an expression, replay its complete context and save correct text/audio with reasonable correction effort. Keep source omissions, meaning-changing errors, unresolved boundaries and timing coverage visible. Report exact word synchronization only when its own evidence supports that feature.

Independent listening, semantic correctness and manual editing effort cannot be inferred from an automated player's ready/paused state. The local [saved-response task set](draft-study-task-set.json) remains useful for exercising the application, while its human observations remain unset until performed.

Before a new live comparison, freeze the selected recording and range, models/settings, reference method, intended measurements and request budget. Compare candidates on the same source audio. Preserve failed/missing results, repetitions, overlap and every charge/hold. A new request or retry needs its own concrete approval; a prepared report is not permission to send.

## Historical policy and findings

The former `surtitle-transcribe-review-assisted-v1` research policy proposed EN/JA lecture/dialogue pilots and independent confirmation, two chunk profiles, twenty confirmation boundaries and one hundred player observations. Its automatic-join target was 90%, with preservation and review required. The older boundary study treated 90% as a gate. Those policies and their full schemas are recoverable from commit `d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0`; neither retroactively changes a recorded failed result.

The 24-request four-condition pilot was only prepared. A separately approved six-request English-dialogue comparison returned all responses, but neither profile qualified or was adopted as a new default. Its WER, incomplete timing coverage, unresolved boundaries and accounting are preserved in [AI evaluation history](ai-evaluation-history.md#english-dialogue-partial-pilot--12-september-2026).

Shorter chunks, untimed recognition followed by alignment, alternate formatting and new recognition models remain hypotheses. The existing Whisper experiment failed, and Flash's non-speech failures remain material. No new fallback, model download or transport default follows from the local draft-study workflow.

## References

Use independently attributable source text and timing; distinguish human annotation from forced alignment or unverified publisher captions. Complete coverage matters as much as errors on matched subsets. See [reference guidance](transcribe-references.md) and the dated discovery record in [evaluation history](ai-evaluation-history.md#references-and-unexecuted-preparation--12-september-2026).
