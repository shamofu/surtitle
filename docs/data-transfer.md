# Learning data export and restore

JSON preserves learning records and review history without audio. ZIP contains
the same records and every registered card-audio clip. CSV/TSV export all saved
cards with columns `term`, `meaning`, `example`, `translation`, `explanation`,
`language`, `source`, `start_ms`, `end_ms`, and `due_at` (RFC-4180 quoted with
`\r\n` line endings and a leading `'` escaping spreadsheet formula prefixes `=`,
`+`, `-`, `@`, `\t`, `\r`). SRT/VTT import cleans inline markup (stripping ASS
`{\...}` overrides, `<ruby>` `<rt>`/`<rp>` annotations, known formatting tags,
and karaoke timestamps, and decoding basic HTML entities while keeping bare `&`
and non-tag `<`); SRT/VTT export writes a selected media item's source
subtitles and, when available, a separate translation file, emitting only
precise timed `cue` rows. Rows marked **Audio range** (`source_block`) are
omitted because their enclosing source bounds are not subtitle timings; JSON/ZIP
preserve their original text.

Export from a media item defaults to SRT for that item's subtitles. Export from
the library defaults to a ZIP backup. JSON/ZIP always cover the whole learning
collection, and CSV/TSV always cover all cards. The dialog describes the selected
scope before export, then lists the files actually written, including any
translation file, and offers to open their containing folder.

JSON/ZIP archives use version 3, preserving subtitle timing precision, phrase and
subtitle editor drafts, generated status and retained review alternatives. Restore
accepts versions 1 through 3; older rows default to precise `cue` timing. Restored drafts keep their text but are
detached from the old source; choose current subtitles explicitly to reconnect
them before saving a card or subtitle edit.

Cards keep nominal source timestamps separately from the actual extracted audio
range. New clips include the configured playback context (150 ms per side by
default, up to 1,000 ms), bounded by the media duration. JSON/ZIP preserve this
`audioClipRange` metadata and validate that it contains the nominal source range.
Changing playback context or editing subtitles does not regenerate existing
clips or rewrite their saved source context. JSON retains the range as provenance
even though it does not include audio bytes.

For a source-block card, the nominal card range can be an explicitly chosen
subrange of at most 180 seconds within the original audio block. Its immutable
`sourceCues` snapshot keeps the complete original text, source bounds and timing
precision. The extracted clip's context is validated around that chosen subrange,
without relabeling the source block as a synchronized cue.

ZIP export fails if a registered clip is missing, unreadable, outside managed
audio storage, or no longer a regular file. The error identifies its card and
asks the user to restore the clip. A card that never had audio is valid; a missing
registered clip is not silently converted into an audio-less card. Pending editor
changes are saved before export. Writing the archive does not change saved cards
or source audio.

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
Pending editor changes are saved before restore, the learning generation
advances transactionally on commit, and old editing sessions, publication
sessions, and operational transcript-review state are cleared afterward so
stale writers or pending background output cannot overwrite restored data or
drafts. A committed restore can report cleanup or playback warnings; the
restored data and refresh still take effect, and those warnings must not prompt
repeating the restore.

Backups exclude and restore never imports original media files, credentials,
cost ledgers, paid jobs, execution approvals, external-tool selections,
publication sessions, operational transcript-review decisions, or device-local
settings and existing-card/import drafts in `workspace.sqlite`. Old card drafts
in `workspace.sqlite` remain readable as stale input without applying over
restored cards, and paid-job digests and cost records stay in their separate
store.

See the [application test guide](testing.md) for export and restore regression
coverage.
