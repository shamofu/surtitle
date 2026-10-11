# Saving input without interrupting study

Decision reviewed on 2026-10-11. This change keeps the existing SQLite/rusqlite dependencies and adds device-local `workspace.sqlite` for unfinished settings, existing-card edits, and import inputs. It does not replace the learning database, change an approved AI plan, or migrate real user data during development.

## Evidence and alternatives

The previous settings screen sent a complete `AppSettings` object. Its save wrote `preferences.json` before changing limits in `charges.sqlite`; those writes could fail separately. Editing an existing card retained its fields only in React state and used a second close confirmation. Existing phrase/subtitle drafts have source-cue bindings and belong to portable learning archives, so reusing them for settings or import queues would mix different lifecycles.

| Option | Assessment |
| --- | --- |
| Extend atomic preferences JSON | Retain it for small committed preferences and existing service state. Each save rewrites the document, and it cannot atomically compare a card/draft revision or commit a separate ledger change. |
| Tauri Store plugin | Its current API provides file-backed key/value values, manual save, and configurable autosave. Those conveniences do not remove this application's need for checked revisions, source generations, and separate budget ownership. Adding it would duplicate the existing preferences store. [Official Store documentation](https://v2.tauri.app/plugin/store/). |
| Existing rusqlite with a local workspace database | Selected for draft writes: the revision check, sequence increment and content update share one immediate transaction. No new runtime dependency is needed. SQLite serializes writes, while WAL permits concurrent readers; `BEGIN IMMEDIATE` takes the write transaction before the read/compare step. [SQLite isolation documentation](https://www.sqlite.org/isolation.html). |

This decision is based on transaction boundaries and the existing supported runtime, not on a claim that newer storage libraries are unsuitable or that every application should use SQLite. It does not claim an unmeasured throughput advantage.

## Ownership and contracts

- `learning.sqlite` remains the authority for committed cards, review schedules, subtitles and portable learning drafts. Existing-card autosave checks only editable content plus the learning generation, then updates the current card inside one transaction. Reviews, audio, source snapshots and schedules cannot be overwritten by a stale form.
- `charges.sqlite` is the sole authority for monetary limits. New settings patches accept either a complete budget group or non-budget preferences, never both. Budget-only writes do not touch JSON. JSON serialization omits all three budget fields, and old JSON budget copies are ignored on read.
- `preferences.json` keeps committed non-budget settings and the existing credential identifier. Secret credential material remains with the existing vault. `get_settings_state` returns effective settings and a revision; `update_settings_patch` checks that revision under the existing settings transition lock. Credential/project fields cannot be patched. A location change clears model prices in the same preference write.
- `workspace.sqlite` stores allowlisted raw string fields, so an empty number, incomplete text or failed apply can survive closing/restarting. The global monotonically increasing draft revision rejects old saves and deletes, including after a draft is deleted and recreated. Structured model fields reject unknown nested properties, including credential-shaped data. No AI approval or credential payload is a draft field.

The legacy full settings command remains for compatibility; it still spans two durable stores and is not presented as an atomic operation. New autosave never calls it. A preference commit can also precede a native playback reconfiguration error: clients must read back the committed state and keep failure feedback rather than pretend both effects rolled back.

## Migration and recovery

Opening a profile creates the new workspace database with schema version 1 and adds one local learning-generation row if absent. Existing learning records, approved digests and ledger balances are untouched. Newer unsupported workspace schemas fail explicitly rather than being overwritten. Learning restore changes its generation within the same transaction that replaces learning records. Older card drafts remain readable with `stale: true`, and old card-edit revisions cannot apply even when the restored card has identical text. Workspace drafts are device-local and excluded from portable archives.

The renderer serializes saves, preserves newer local input when an earlier write completes, and clears only the exact saved draft revision. A failed draft write keeps the previous durable version. A failed content application leaves the raw draft intact. A failed learning-database restore transaction leaves the prior generation and content unchanged. No ordinary navigation needs an unsaved-changes confirmation once the draft write has completed.

Final review reproduced a failure after a successful restore transaction: rejecting the preferences-file replacement returned an error despite already replacing learning data, suppressing the restore notification and leaving the renderer on old editor sessions. A committed restore now returns `RestoreResult { warnings }`, reconciles playback, and always publishes its restore revision after releasing native locks. Later transcription-session cleanup, continuation-preference cleanup, or playback reopen/stop failures become explicit warnings about the completed restore. They never invite a second replacement or claim the database rolled back. The renderer clears old editor sessions and refreshes restored content even when warnings are present. A deterministic temporary-profile regression rejects preferences replacement with a directory at its destination, then verifies new content/generation, the warning and exactly one restore event. Shared Rust/TypeScript wire fixtures cover the result DTO.

The post-fix Rust 1.99 workspace run passed 555 tests with zero failures and 12 harness entries ignored, including subprocess helpers exercised by parent tests; workspace formatting and strict all-targets/all-features clippy passed. [Final boundary-review evidence](evidence/restore-boundary-2026-10-11.json) keeps that run separate from prior native integration observations.

The one affected real-MPV restore integration was then rerun explicitly against the final FFmpeg 9.0.2-based DLL on Rust 1.99: **1 passed, 0 failed, 0 skipped, 7.66 seconds**. It exercised backup/transaction failure recovery, restored resume/audio-stream/subtitle state, concurrent persisted ticks, sentence pause, missing-source recovery and volume after restart. It uses an isolated profile and hidden native window; it does not claim an audible-quality test. The same boundary-review evidence records the exact DLL hash and fresh log.

## Verification

Core tests cover raw invalid input across restart, stale write/delete rejection, delete/recreate revision reuse, rejected SQLite writes, private-field rejection, card review/audio preservation, deletion races, and learning-restore invalidation. Native settings tests cover patch conflicts, invalid values, allowlisted properties, budget-only failure/readback, legacy preference migration, and price invalidation. All tests create isolated temporary profiles; none opens the installed app's data.


Draft-selection card forms use the same durable workspace with kind `draft_card`, bound to the selection ID, its version and the learning generation. Incomplete term/meaning/translation/explanation are persisted without creating a card. A changed, removed or restored selection leaves previous input available for explicit recovery; it never transfers automatically to the new source. Explicit card creation consumes the exact draft revision after success. Closing while a card save is active waits for the operation and persistence, including after editor unmount; ordinary study navigation similarly resumes after the pending save without a confirmation dialog.


The explicit `windows-native` acceptance suite passed all six required integration tests with zero skips on 2026-10-11. Its real MPV restore case exercised backup failure, transaction failure, retained subtitles, restored audio/resume position, stale persisted ticks, sentence-end pause, missing-source recovery and volume after restart in temporary profiles. The companion six-hour preparation test also passed. [Named results and durations](evidence/native-acceptance-2026-10-11.json) keep these integration checks separate from unit-test counts.

After adopting Rust 1.99, the six native integration tests were rebuilt and all passed again with zero skips. [The separate 1.99 record](evidence/native-acceptance-rust-1.99.json) preserves that provenance; it does not relabel the earlier six-hour result. Final close-race review also reproduced destruction while another phrase draft was still saving. All editor persistence now participates in the shared close-task barrier, including detached phrase editors. Closure rechecks newer input and newly registered tasks before destruction; failure keeps the window open. The native failure surface offers retry or continued editing, rather than a discard action that could silently bypass an unrelated failed save.
