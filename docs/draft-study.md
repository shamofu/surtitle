# Study from received text and earlier draft bookmarks

New transcription jobs put received text directly into the Study page's
**Transcript** list while remaining audio is processed. Use those rows for
reading, replay, explanations, translation and cards without a draft-confirmation
or complete-transcript adoption step. Whole-recording, selected-range and
re-transcription jobs use the same flow. Embedded captions and SRT/VTT imports
also remain available without cloud transcription.

Rows marked **Audio range** contain Transcribe text whose word timings were
unusable. Their bounds are the actual submitted source audio, including context,
and do not imply sentence or word synchronization. They remain readable in the
ordinary list and are omitted from synchronized captions, caption-group pause
and SRT/VTT. The card form lets you choose audio inside this original range;
card audio must span at most 180 seconds, and unfinished range input is saved
with the phrase draft. A saved card retains the original text and bounds as well
as its selected audio subrange.

## Earlier draft bookmarks

The separate excerpt-bookmark workflow remains for earlier drafts and local
recovery. Phrase and subtitle editor drafts are a separate autosave feature;
[learning backups](data-transfer.md) preserve both kinds without transferring
their old source authority.

1. Open media, then **Transcript → Transcription history → Open earlier drafts**, and select a transcription job.
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
requires current confirmed text with usable cue timing or explicitly authored
times; enclosing source-block bounds are not synchronized cues. Subtitle export
adds a uniquely named coverage receipt. It does not claim to cover unselected
recording time or insert artificial speech for missing ranges.

General JSON/ZIP learning backups include bookmarks. Operational source snapshots,
job bindings and confirmation authority are removed from exported bookmarks and
removed defensively on restore. Restored bookmarks keep text and bounds for
reference, but require a new source selection before confirmation/card creation.
Saved card snapshots and separate card audio are preserved by ZIP backup and
restore. See [learning data transfer](data-transfer.md) for archive formats and
limits, and the [test guide](testing.md) for verification commands.
