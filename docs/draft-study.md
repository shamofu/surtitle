# Study from an incomplete transcript

The Study page has a **Study a draft** tab. A learner can inspect received text,
replay source audio and save a local bookmark while the rest of a transcription
job is incomplete or disputed. This does not replace the active subtitle track.
Existing embedded captions and SRT/VTT imports remain available without cloud
transcription. Imported captions are source material, not proof of correctness.

## Learning workflow

1. Open media, then **Study a draft**, and select a transcription job.
2. Select contiguous received cues, or open the original source block if timing
   is unusable or no response was received. Available text remains inspectable.
3. Save a bookmark. Edit its text and positive audio range inside the recorded
   source bounds. Listen to that range and explicitly confirm the excerpt.
4. Enter a term and meaning and save a card. The card stores the confirmed text,
   its audio clip and its provenance independently of future transcript edits.
5. Optionally choose a model and request an explanation estimate. The existing
   separate quote approval still controls sending. Saved suggestions open a card
   form for review; they never automatically save a card or alter the source.

Unresolved original warnings remain visible after confirming an excerpt. This
confirmation records a local authored decision; it does not certify all provider
timestamps, resolve the original boundary or declare the full track reviewed.
Untimed text has only the enclosing request range, including transmitted context.
The application does not interpolate sentence or word timestamps. Contextual
replay is available; exact word synchronization remains unqualified.

The editor marks its current interval as replayed only after native playback
accepts the operation. That is not automatic proof that the learner heard or
understood it; the user explicitly confirms the content. Editing text or time
requires another confirmation. Canonical caption-group pause is disabled while
studying a draft so unrelated adopted caption boundaries cannot stop that replay.

## Durable boundaries and safety

The common AI core stores a range-local snapshot with separate text and timing
revisions, source identity, relevant chunk/manual revisions and intersecting
boundaries, warnings and pending ranges. Display IDs are not stable identifiers:
revalidation uses unique ordered local text/time anchors, so an earlier unrelated
result can add cues without invalidating a later selection.

The native layer additionally binds the prepared job, retained evidence hashes,
source path and audio track. Source metadata is checked for local reads; full
content hashes are checked on confirmation, card extraction and cloud preparation
or approval. Card extraction is followed by a second source/version validation.
SQLite compare-and-swap writes reject an old editor or concurrent mutation.

None of bookmark preparation, editing, confirmation, card creation or export
sends a provider request. Unknown reservations, raw responses and API attempt
states remain unchanged. Explanation requests bind one immutable confirmed
excerpt, and use the existing reservation/approval/no-automatic-retry mechanism.
Changing that excerpt invalidates its old unexecuted quote. Received output is
retained even if its source subsequently becomes unavailable.

## Export and restore

An excerpt JSON export identifies selected-range-only coverage. SRT/VTT export
requires a current confirmed excerpt, writes real subtitle text only and adds a
uniquely named coverage receipt. It does not claim to cover unselected recording
time or insert artificial speech for missing ranges.

General JSON/ZIP learning backups include bookmarks. Operational source snapshots,
job bindings and confirmation authority are removed from exported bookmarks and
removed defensively on restore. Restored bookmarks keep text and bounds for
reference, but require a new source selection before confirmation/card creation.
Existing card snapshots and separate card audio continue to round-trip normally.

## Verification and limits

Fixed-response tests cover range-local staleness, invalid times with retained
text, unresolved/unknown requests, restarts, stale editors, immutable cards,
backup detachment and source changes. Renderer tests cover a 20,000-cue draft,
bounded paging, failed replay, local confirmation and explicit quote approval.
Real application checks use disposable profiles and no service-account key.

The [12 September verification record](draft-study-verification-2026-09-12.md)
distinguishes the complete Windows run, the focused Linux rerun and the checks
against saved real responses. The frozen [ten-task replay set](draft-study-task-set.json)
binds exact source text and timing anchors before the saved-response run. Its
observations record native playback transport and restart persistence, with
human listening and editing effort left unset.

Recognition accuracy is unchanged by this workflow. The historical English
dialogue WER/timing results remain in [the pilot report](transcribe-en-dialogue-2026-09-12.md).
The product does not claim that an automated player-state check constitutes
listening, validates semantic corrections or measures human editing effort.
Independent Japanese timing references and contextual listening assessments are
still required for the corresponding quality claims. No new model request,
transport default, automatic fallback, alignment dependency or release publication
is part of this local change.
