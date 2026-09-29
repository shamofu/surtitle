# Surtitle architecture

Surtitle is a Windows 11 x64 desktop application built with Tauri, React, TypeScript, Rust and SQLite.

The React renderer presents typed commands and listens to player events. It cannot execute shell commands, read service-account keys, run SQL, or send Vertex requests. The local Tauri window is the only IPC client. Remote documents are never loaded into the application WebView.

| Component | Responsibility |
| --- | --- |
| `surtitle-core` | Learning data, subtitle parsing, FSRS scheduling and portable archives |
| `surtitle-tools` | Tool discovery, executable selection, receipts, bounded processes and managed updates |
| `surtitle-ai` | Request preparation, Vertex adapters, encrypted credentials and the durable charge ledger |
| Tauri application | Service composition, IPC commands and the native child video window |

## Code organization

The renderer separates application composition (`src/app`), learning features (`src/features`) and shared transport/contracts/UI (`src/shared`). Library, study, cards/review, AI approval, settings/tools and transfer each own their commands and presentation. Playback, transcript review and draft study remain within the study feature. Cross-feature dialogs are composed by their parent; AI job actions report a transcript-review intent instead of importing the study dialog. IPC data contracts are shared, while business logic stays with its feature.

Appearance, notifications, native-surface visibility and the application snapshot have separate providers. The snapshot uses one backend query with domain selectors. Feature query keys identify media, jobs and selections. Reads and player controls do not invalidate persisted data; successful mutations refresh their affected keys. Restoring learning data invalidates all persisted-data queries. A five-second `app-changed` heartbeat refreshes the snapshot and active learning/AI views. Editor revisions and mutation barriers prevent background results from replacing unsaved edits or a newer selection.

Tauri command adapters live under `src-tauri/src/commands`; application use cases and runtime ownership live under `src-tauri/src/application`. Dependencies flow from commands to application to the core/tools/AI crates and native player. Application code never calls IPC commands.

The playback coordinator owns the player session and the synchronization boundary around native operations, database reconciliation and poll-and-save. Settings persistence clones the current preferences, applies the update, saves atomically and only then publishes the new in-memory value. Failed saves leave the previous in-memory preferences intact. Full settings changes are serialized and persist preferences before updating the separate AI ledger. The ledger is the authority for both displayed and enforced budgets, including after a ledger write failure or restart; these two stores do not share a transaction.

Core storage methods are grouped by learning responsibility, with one confirmed-cue selection validator shared by replay and card creation. AI modules separate request construction, output parsing, chunk planning, transcript reconciliation and ledger operations. The development validation CLI rejects invalid arguments before opening its data root or recovering the ledger. See [AI behavior](ai.md) for approval, dispatch and settlement rules.

Build and packaging helpers are documented in the [script reference](../scripts/README.md) and [native runtime guide](native-runtime.md).

## Behavioral boundaries

The learning database is separate from operational settings, credentials, charge reservations and prepared jobs. Restoring learning data validates the archive, creates a SQLite backup, then replaces learning records in a transaction. The playback coordinator holds native commands and poll-and-save ticks throughout replacement and player reconciliation. If the current item survives and its file exists, it reopens paused at the restored position with the restored audio choice, subtitles and sentence endpoints. Removed or missing items leave the player stopped and detached. CSV/TSV exports escape spreadsheet formulas; ZIP import rejects traversal, symlinks, duplicate entries and unexpected files. See [export and restore](data-transfer.md) for formats, size limits and audio retention.

Playback resumes only after the native player confirms that the requested file has loaded. Positions emitted during loading cannot replace the stored resume point. An audio choice is stored as the absolute FFmpeg stream index; mpv track IDs are mapped through `ff-index` rather than treated as interchangeable IDs. Transcription receipts and saved cards retain the selected audio index. Basic playback uses mpv metadata without requiring FFmpeg installation.

Optional sentence pauses are enforced in the native player. The common core groups consecutive source cues using terminal punctuation, two-second gaps, and the final subtitle. Common abbreviations continue into the next cue; overlapping cues remain together. These are cue-aligned heuristics, not inferred word times: several sentences inside one cue share its recorded end. Resume and free seeking select the next later endpoint, subtitle changes replace the endpoints, and explicit source-range playback or looping takes priority. The setting starts disabled. Vocabulary candidates can replay their complete adjacent source-cue range through a command that derives the times from the current database.

Study subtitle sources are changed explicitly. Importing a file or extracting a chosen embedded text stream requires replacement acknowledgement when subtitles already exist, saves the entire previous edition, and checks that the media and subtitles did not change during extraction. Previous editions can be restored. Playback-caption controls are separate from this study-source choice; image subtitle extraction is unsupported.

Cards may cite one subtitle or an ordered, adjacent set of confirmed subtitles. The database validates all IDs, media ownership, adjacency and the 180-second maximum, then derives the audio range itself. Each card stores immutable `sourceCues`, including original text, translation and timing. Editing card text changes neither these snapshots nor audio, scheduling or review history. Removing a library item preserves original files and saved cards; deleting a card removes its review records. Unreferenced audio clips are not automatically deleted.

The review page tracks completed schedule revisions rather than permanently excluding a card ID. An Again rating can return at its newly stored due time while the page stays open, with the answer concealed. A stale snapshot cannot immediately offer the already-rated schedule again. The next due time schedules a local wake-up; ordinary review never sends an AI request.

URL imports are background jobs with explicit cancellation and retry. Direct media URLs stream without CLI tools; completed public YouTube videos use independently selected yt-dlp, Deno and FFmpeg. The app limits concurrent downloads to two, caps stored data at 100 GiB per job, and preserves a 256 MiB free-space reserve. A partial download stays in an app-owned staging directory and is removed on failure, cancellation or startup recovery. Interrupted jobs never restart automatically. Completion emits a library refresh event. Reported stored bytes include intermediate merge files and are not a bandwidth or ETA measurement.

Bundled mpv uses its own metadata and codecs for basic playback. FFmpeg is unnecessary until extraction, conversion, or merging. mpv is loaded from an absolute bundled DLL path with restricted dependency search; its config, scripts and URL hooks are disabled. Windows always uses real libmpv. The deterministic Linux adapter is compiled only with `e2e-test`, cannot substitute for the Windows native test, and is not a supported Linux product.

External executable discovery and managed updates belong to `surtitle-tools`; see [tool management](tools.md) for selection, process lifetime and update rules. Development checks and their coverage are described in the [test guide](testing.md).
