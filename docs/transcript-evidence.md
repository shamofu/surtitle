# Transcript response evidence and local review

This guide describes retained provider evidence, timing recovery and optional
local transcript review. New whole-recording, range and re-transcription jobs
publish received text in the ordinary subtitle list. No complete-transcript
adoption, VAD acknowledgement or boundary review is required before learning.
The default path uses one Transcribe VERBATIM request with word timestamps per
prepared chunk; no failure automatically invokes another model or paid retry.
See [AI behavior](ai.md#application-workflow) for the two-action start flow.

Production audio requests retain allowlisted provider evidence in the paid-work
SQLite database before settlement. The record binds the attempt, ordinal, model,
immutable input hash, frozen request hash, task hash, and parser revision. It is
separate from learning data and is not included in portable learning backups.

The wire allowlist consists of non-thought text, structured transcription text,
word text and offsets, transcription completion, candidate finish reason,
numeric usage counters, model version, and the content role needed by the parser.
Authorization, credential material, thought text, tool calls, and arbitrary
transport or provider diagnostic fields are not copied. Provider text is untrusted
content and the renderer displays it as plain text rather than HTML.

Storage limits are 2 MiB per sanitized response, 1 MiB of aggregate string data,
eight candidates, 4,096 parts per candidate, and 20,000 words per transcription.
Oversized values are omitted whole, never stored as a prefix that could be
mistaken for complete output. Such evidence cannot be reparsed. A malformed JSON
body records only a fixed rejection state; its bytes and parser diagnostics are
not retained. Missing/invalid usage keeps the reservation.

The review API distinguishes pending, invalid, valid empty and received results.
Text validity and word timing are separate: a complete response part with
usable text but unusable anchors produces a `source_block` with its actual
submitted audio bounds, including context. It remains readable and usable for
study without inventing word, sentence or subtitle times. Only precise `cue`
rows participate in synchronized captions, caption-group pause and SRT/VTT.
Fixed reason codes retain structural, completion, timing and settlement failures
in original evidence. Listing results returns metadata only; response bodies and
candidate text are loaded for one ordinal through a bounded detail IPC. A valid
empty response counts as received coverage, while an absent response stays pending.

An explicit local reparse uses the saved task and sanitized response, without
reading audio again, obtaining credentials, sending HTTP, or settling an attempt.
It creates a separate candidate bound to the evidence digest and current parser
revision. Repeating the same revision is idempotent; at most ten parser revisions
are retained per attempt. Original failed results and their cost records are unchanged.
An incomplete snapshot or a parser-invalid candidate cannot be selected.

Opening an older saved job's history can locally reparse complete evidence and
select a usable settled candidate, including recoverable source-block text.
This preserves the original failed result, approved job digest and cost records;
it does not send a request or automatically replace the current subtitles.
**Use saved results** is the explicit local application action for an eligible
complete older result. Separate advanced reparse/selection commands remain
bound to the current evidence and draft digests. Unresolved attempts cannot
contribute a selected provider reparse candidate. No clamping, interpolation,
model fallback or paid retry is performed.

Evidence persistence failure prevents settlement and provider-derived publication,
retaining the reservation. Settlement failure leaves evidence inspectable and
retains the hold; local reparsing never settles or acknowledges the attempt.

## Publication and original alternatives

Adjacent results are reconciled inside their shared submitted-audio interval
using word anchors. Repetition outside that interval is preserved. Conflicting
words select the chunk owning the time, then the candidate farther from the
submitted edge, then the smaller ordinal. Original alternatives remain in review
history. Time-based selection does not apply to untimed source-block text.

Each new approved job publishes locally as results arrive. Its device-local
session stores the original edition, expected complete row contents, generated
ownership, received coverage, deferred candidates and protected edit intervals.
Subtitle rows and the publication record commit atomically. The original edition
is saved once, unreceived old cues stay whole, and changed or deleted rows are
protected from later results. A final completion marker does not replace the
whole list. Restoring an edition or importing another subtitle source detaches
that session; learning restore removes its operational authority.

VAD observations remain in detailed preparation/review evidence. They guide
chunking and neither delete Transcribe text nor block publication. Normal
corrections use the subtitle editor. **Transcribe this range again** opens a new
estimate through the same transcription workspace.

## Manual range recovery

Manual correction is a separate local source for the preview. It never turns an
invalid provider response into valid evidence or changes its recorded validation
state. The user listens to a prepared audio range and supplies subtitle text and
positive-width times within its request interval, including overlapping context.
Copied provider text still requires explicit timing entries; invalid word times
are not copied, clamped, or relabeled as correct. Deleting every row requires a
separate confirmation of no speech throughout that range.

Each immutable revision records its ID, creation time, content, and native binding
to the job ID/digest, preparation, source hash, original subtitle revision,
ordinal, request interval, prepared audio hash, and frozen request hash. A
transactional selection version rejects competing or stale writes. Returning to
the prior non-manual source preserves the revision; that prior source can be a
previously selected local reparse rather than a provider result. A later provider
response updates the inspectable original while retaining the selected manual
revision.

The draft keeps original segments and source identity separate from effective
segments. Its digest includes the selected revision and range selection version.
Boundaries and VAD warnings are rebuilt from those effective segments, with
selection provenance in their review identities. Only unchanged decisions survive;
an old adoption digest is not revived by reselecting an earlier revision.

Saving requires the job to be inactive and any in-flight request to have finished.
The user must explicitly pause active sending first. An unknown outcome and its
hold may remain while local corrections are saved and adopted: neither action
settles, refunds, acknowledges, or resends that attempt. This does not relax the
settlement requirement for selecting a provider-derived reparse candidate.

Explicit application of a complete older result requires every range to have a
validated effective result or manual revision. A valid empty provider result
needs no additional no-speech confirmation; manually deleting all content still
requires that authored decision. Boundary alternatives and VAD observations are
optional reviews. Source identity, current digest and the subtitle replacement
interval are checked again. Applying the result uses the publication mechanism,
then records adoption without reapplying the whole list. Adoption never resumes
the job and blocks further sending from it. Original responses, reservations and
saved study cards are unchanged.

Transcript-review revision history, selections and publication sessions live in operational learning-database tables.
Portable learning exports omit them, and learning restore clears them instead of
importing a review or approval from another backup. This is separate from phrase
and subtitle editor drafts, which JSON/ZIP archives preserve with detached source
bindings. See [learning data transfer](data-transfer.md) and the [test guide](testing.md)
for regression and integration checks.
