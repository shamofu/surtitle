# Study from an incomplete transcript

Open **Transcript** on the Study page, then choose **Study a draft**. A learner can inspect received text,
replay source audio and save a local bookmark while the rest of a transcription
job is incomplete or disputed. This does not replace the active subtitle track.
Embedded captions and SRT/VTT imports are also available without cloud
transcription. Review source text and timing before saving a card.

## Learning workflow

1. Open media, then **Transcript → Study a draft**, and select a transcription job.
2. Select contiguous received cues, or open the original source block if timing
   is unusable or no response was received. Available text remains inspectable.
3. Save a bookmark. Edit its text and positive audio range inside the recorded
   source bounds. Listen to that range and explicitly confirm the excerpt.
4. Enter a term and meaning and save a card. The card stores the confirmed text,
   its audio clip and its provenance independently of future transcript edits.
5. Optionally choose a model and request an explanation estimate. Separate quote
   approval controls sending. Saved suggestions open a card form for review;
   they never automatically save a card or alter the source.

Unresolved original warnings remain visible after confirming an excerpt. This
confirmation records a local authored decision; it does not certify all provider
timestamps, resolve the original boundary or declare the full track reviewed.
Untimed text has only the enclosing request range, including transmitted context.
The application does not interpolate sentence or word timestamps. Contextual
replay uses the selected source range.

The editor marks its current interval as replayed only after native playback
accepts the operation. The user must listen and explicitly confirm the content.
Editing text or time requires another confirmation. Canonical caption-group pause
is disabled while studying a draft so unrelated adopted caption boundaries cannot
stop that replay.

## Source binding

The common AI core stores a range-local snapshot with separate text and timing
revisions, source identity, relevant chunk/manual revisions and intersecting
boundaries, warnings and pending ranges. Display IDs are not stable identifiers:
revalidation uses unique ordered local text/time anchors, so an earlier unrelated
result can add cues without invalidating a later selection.

The native layer additionally binds the prepared job, retained evidence hashes,
source path and audio track. Source metadata is checked for local reads; full
content hashes are checked on confirmation, card extraction and cloud preparation
or approval. Card extraction is followed by a second source/version validation.
SQLite compare-and-swap writes reject a stale editor or concurrent mutation.

None of bookmark preparation, editing, confirmation, card creation or export
sends a provider request. Unknown reservations, raw responses and API attempt
states remain unchanged. Explanation requests bind one immutable confirmed
excerpt, and use the [AI approval and accounting rules](ai.md#credentials-and-dispatch).
Changing that excerpt invalidates its unexecuted quote. Received output is
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
Saved card snapshots and separate card audio are preserved by ZIP backup and
restore. See [learning data transfer](data-transfer.md) for archive formats and
limits, and the [test guide](testing.md) for verification commands.
