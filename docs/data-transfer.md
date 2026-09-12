# Learning data export and restore

JSON preserves learning records and review history without audio. ZIP contains
the same records and every registered card-audio clip. CSV/TSV export the phrase
collection; SRT/VTT export a selected media item's source subtitles and, when
available, a separate translation file.

Cards keep nominal source timestamps separately from the actual extracted audio
range. New clips include the configured playback context (150 ms per side by
default, up to 1,000 ms), bounded by the media duration. JSON/ZIP preserve this
`audioClipRange` metadata and validate that it contains the nominal source range.
Changing playback context or editing subtitles does not regenerate existing
clips or rewrite their saved source context. JSON retains the range as provenance
even though it does not include audio bytes.

ZIP export fails if a registered clip is missing, unreadable, outside managed
audio storage, or no longer a regular file. The error identifies its card and
asks the user to restore the clip. A card that never had audio is valid; a missing
registered clip is not silently converted into an audio-less card. Export does
not change the learning database or source audio.

JSON/ZIP export enforces the same byte limits as restore: 256 MiB for learning
JSON, 64 MiB per audio clip, and 8 GiB for the complete uncompressed ZIP contents.
The total includes both JSON and audio. Streaming checks enforce bytes actually
written, so compressed size and an earlier audio-file size check cannot bypass
the limits. A collection exceeding a limit fails export; archive splitting is
not implemented.

JSON and ZIP are first written to a uniquely created temporary file beside the
chosen destination. Only a successfully completed and synced file replaces the
destination through a same-directory rename. Serialization, input, size, ZIP
finalization, and replacement failures leave an existing destination unchanged
and remove only the owned temporary file. This is an application failure
guarantee, not a promise against hardware failure or filesystem corruption.

Restore previews and validates the archive before applying it, backs up the
current learning database, and places restored audio in a new managed directory.
It does not import credentials, cost ledgers, paid jobs, execution approvals, or
external-tool selections. Original media files are not bundled in backups.

The focused core tests use small injected limits to exercise exact-boundary and
overflow behavior without allocating large files. They also cover missing and
invalid registered clips, unchanged existing destinations, absence of incomplete
new destinations, temporary-file cleanup, and final rename failures.
