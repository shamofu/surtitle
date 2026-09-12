# Product reconsideration after the Transcribe dialogue pilot

Status: the local study workflow was accepted for implementation on 12 September
2026. See [draft study implementation](draft-study.md) for behavior, verification
and remaining observations. Recognition-mechanism experiments below remain
hypotheses. Historical scores, existing approvals and transport defaults remain
unchanged. This document does not authorize further provider requests.

## Product objective

The first useful release should let a learner watch a recording, find a relevant
expression, verify its source, and retain an accurate learning item without first
editing every subtitle in a multi-hour recording. Speech recognition supplies an
inspectable draft. The product should expose the accuracy and timing it actually
has, and concentrate confirmation on the material the learner will rehearse.

This changes the workflow and the promises attached to individual features. It
does not turn the historical failed or incomplete quality measurements into passes.

## Evidence and its limits

The [English dialogue pilot](transcribe-en-dialogue-2026-09-12.md) returned six
valid responses. The provisional full-source WER was 22.41% with the current
profile and 18.46% with the short candidate, including simultaneous speech and
unresolved joins. Reference-assisted selection of boundary alternatives still
left 21.99% and 17.43%. Boundary handling alone cannot recover omitted words.

Exact lexical timing proposals covered 383/477 and 406/477 reference words. The
matched-subset endpoint medians were good, but p95 was 570/600 ms and unmatched
words remained. Shorter requests improved some phrases in this recording, while
creating more joins and two unresolved boundaries instead of one. Neither a
general chunk-length winner nor a complete correction-effort measurement exists.

Google's [Transcribe model documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe?authuser=0&hl=en),
checked on 12 September 2026, identifies word timestamps as experimental and
warns of recognition degradation. It also states that synchronous transcription
does not provide utterance timestamps. Disabling word timestamps therefore does
not produce an equivalent timed subtitle stream. The previous two very short
timed/untimed controls produced the same recognized text; improvement on this
longer recording remains a hypothesis. The documented synchronous duration limit
does not establish accuracy over that duration or justify raising application caps.

## Recommended specification changes

| Area | Proposed behavior | Reuse and additional work |
| --- | --- | --- |
| Main playback unit | Replay the containing cue or contextual group when an expression is selected. Expose bounded adjustable lead-in and tail audio. Exact word replay/highlighting is an optional capability. | Existing multi-cue playback and context settings are reusable. Feature availability and labels must reflect actual timing provenance. |
| Text and timing | Store text revision, timing representation/provenance and review state separately. Preserve useful recognized text when word times are invalid. | Keep raw responses and manual revisions. Add explicit untimed/source-block presentation; do not manufacture cue or word times. |
| Learning before full completion | Display available machine-draft ranges while other ranges are pending or disputed. A problematic range does not block unrelated playback or study. | Add a draft overlay in Study and range-scoped selection snapshots. Existing whole-preview adoption remains available for a fully reviewed track. |
| Local confirmation | Confirm the selected expression, surrounding text and audio span when creating a review card or requesting its explanation. Allow an unresolved item to remain a bookmark/draft. | Reuse manual cards, audio extraction, revision checks and immutable card snapshots. Improve the combined text/audio adjustment interaction. |
| Existing captions | Present embedded text tracks and SRT/VTT as the first available starting point, with source and human/automatic/unknown provenance when known. | Reuse import/version handling. Never treat all supplied captions as verified or silently merge/replace them with ASR. |
| Conflicting or missing ranges | Keep original alternatives visible, provide source-block playback, and allow postponement while other material stays usable. | Reuse boundary editing and local range recovery. Keep coverage gaps explicit in preview and export. |
| Cloud processing | Ask for a useful selected time window instead of making whole-recording transcription a prerequisite. Separate the user's learning window from the transport chunk plan. | Reuse prepared-input and cost reservations. The whole recording remains available by explicit selection; progress does not automatically authorize more windows. |

Sentence-end stopping must mean an observed/reviewed sentence boundary. When only
a cue interval is available, label the action as stopping at the selected range's
end. Large playback padding must not be used to hide poor synchronization.

An untimed paragraph has only its containing source audio block until a separate
mapping is available. The UI must not animate word-level following or advertise
precise phrase playback using guessed fractions of that block. VAD identifies
acoustic pauses, not the correspondence between words and sounds.

## Range state and immutable selection contract

The representation should answer three independent questions:

1. Where did this text come from: supplied captions, model response or manual edit?
2. What timing is available: none, source block, cue spans or word anchors, and
   was it supplied, model-generated, aligned locally or manually edited?
3. What did the user review, and which concrete issues remain unresolved?

Do not invent a model confidence score. Structural validity, absence of warnings
and user confirmation are different observations; none alone proves accuracy.

A selected learning item binds the source identity, audio range, text revision,
timing revision and relevant neighboring boundary decisions. Rust validates that
snapshot before extracting card audio, preparing AI input, or saving the card.
Later responses can populate untouched draft ranges but cannot overwrite manual
work, approved request input or saved cards. If a disputed boundary intersects a
selection, that selection needs a local decision; an unrelated dispute does not.

Study preview is not equivalent to replacing the committed subtitle track. Export
must explicitly identify whether it contains a draft, a reviewed track or selected
confirmed ranges. Missing intervals are reported in a coverage receipt and in the
UI; SRT/VTT exports must not insert artificial speech to mark those gaps. JSON can
retain full provenance, unresolved alternatives and coverage state.

Local editing, postponement and adoption do not send requests, release unknown
holds, or change failed API attempts into successes. Existing budget, credential,
tool-identity and backup exclusions continue to apply.

## Recognition mechanism: test hypotheses before adding another default

Keep the existing timed Transcribe path available. Do not automatically switch to
Flash, which failed the retained non-speech controls. Do not silently change to
Smart formatting to obtain a better-looking transcript: deleted fillers and
rewritten expressions can matter to a language learner.

A recognition-first path is a candidate: Transcribe without word timestamps,
followed by separately supplied or derived timing. Its text quality and timing
cost must each be measured. Local forced alignment can map supplied text, but it
does not verify that the text was spoken and can produce plausible times for
incorrect words. The previous Whisper experiment does not establish a usable
alignment replacement. New aligner dependencies, licensing and model downloads
would need their own review before adoption.

Transport duration should follow demonstrated recognition and correction effort.
Neither 60 seconds nor the longest provider-supported request is inherently the
correct application default. Avoid expanding the old evaluation matrix before
testing which mechanism is worth evaluating.

## New acceptance questions

Keep full WER/CER, endpoint errors and all omissions as diagnostic measurements.
Add separate reports for fillers/orthography, meaning-changing errors (including
negation, numbers, names and content words), missing turns and overlapping speech.
Do not remove inconvenient reference words after inspecting an output.

The product acceptance study should measure:

- Whether a learner can find an expression and replay its complete spoken context
  within a predefined duration allowance, including cases with poor word anchors.
- Correctness of saved text, meaning, source and audio; errors per selected item,
  not just average error across the recording.
- Manual edits, interaction count and elapsed effort needed to obtain that item.
- Whether postponing a bad range leaves unrelated learning usable and preserves
  every raw result, revision, card snapshot and reservation after restart.
- How much source audio actually needs correction, separately from machine warning
  duration and actual editing time.

Any revised numeric product thresholds must be declared before an independent
acceptance run and justified by the claimed feature. The old 10% recognition and
word-endpoint results remain reported under their original policy. The initial
product need not claim exact word synchronization; if that feature is offered,
its precision still needs dedicated evidence. The planned 100 real-player checks
can target contextual replay with a fixed maximum allowance, without relabeling
unheard automated tests as listening.

## Work sequence

1. Use the six saved responses in an isolated real-app profile. Implement and test
   draft display, range-local confirmation and immutable selection handling. These
   changes need no new AI request and should precede a larger model campaign.
2. Freeze a small set of replay/card tasks containing ordinary speech, missing
   fillers, a meaning-changing error, a disputed boundary and uncertain timing.
   Compare correction actions using the saved profiles; record actual listening
   and human effort only when performed.
3. If a further provider diagnostic is warranted, prepare the same existing
   four-minute English selection as two unsplit requests: word timestamps on and
   off, with every other setting held constant. This tests the recognition/timing
   tradeoff and gives a descriptive longer-request baseline against saved chunks.
   It is one exploratory recording, not a language-wide result. Quote its exact
   bytes, settings and limits and obtain approval before sending.
4. Add a Japanese counterpart with an independently resolved reference before
   choosing a recognition-first pipeline or a new default for both languages.
   Only then commit to the broader independent confirmation campaign.

The first two steps improve the product regardless of whether the provider's next
response is more accurate. Existing captions, interval playback, revisions, cards,
FSRS, export and cost controls remain the foundation. No commit, provider request,
transport setting change or historical quality-policy replacement is implied by
implementing the local study workflow.
