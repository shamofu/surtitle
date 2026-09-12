# Transcript response evidence and local review

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

The review API distinguishes pending, invalid, valid empty, and received valid
results. Fixed reason codes describe missing candidates, incomplete responses,
invalid structure, reversed or out-of-range times, word alignment failures, and
unresolved settlement. Listing results returns metadata only. Response bodies and
candidate text are loaded for one ordinal through a separate bounded detail IPC.

An explicit local reparse uses the saved task and sanitized response, without
reading audio again, obtaining credentials, sending HTTP, or settling an attempt.
It creates a separate candidate bound to the evidence digest and current parser
revision. Repeating the same revision is idempotent; at most ten parser revisions
are retained per attempt. Old failed results and their cost records are unchanged.
An incomplete snapshot or a parser-invalid candidate cannot be selected.

Selecting a valid candidate for the draft requires a separate action and current
draft digest. Unresolved attempts cannot contribute a selected reparse candidate. The
native layer revalidates its binding and output on each use, and the normal
source, boundary, VAD-warning, and explicit-adoption gates still apply. Selection
does not replace subtitles or alter saved study cards. No clamping, interpolation,
text rewrite, model fallback, or paid retry is performed by this workflow.

Evidence persistence failure prevents settlement and provider-derived adoptable output, retaining
the reservation. Settlement failure leaves the evidence intact; interruption
recovery retains the hold, and a local reparse candidate cannot bypass it. Offline fault
tests exercise both failures through the production worker with SQLite triggers.

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

Adoption requires every range to have a validated effective result or a manual
revision, including explicit no-speech confirmation, and all remaining boundary
and warning reviews to be complete. Source identity, current digest, and the
existing subtitle replacement interval are checked again. Adoption is separate
from saving, never resumes the job, and blocks further native approval of that
adopted job. Original responses, reservations, and saved study cards are unchanged.

Revision history and selections live in operational learning-database tables.
Portable learning exports omit them, and learning restore clears them instead of
importing an old review or approval. Tests cover immutable history, competing
selection versions, restart, restore exclusion, stale source/digest rejection,
later responses, and preservation of invalid evidence and unknown holds through
manual correction and adoption.
