# Surtitle architecture

Surtitle is a Windows 11 x64 desktop application built with Tauri, React, TypeScript, Rust and SQLite.

| Component | Responsibility |
| --- | --- |
| React renderer | Library, study, cards/review, settings, AI approval and data transfer |
| Tauri application | Typed IPC, application services, resource events and the native video window |
| `surtitle-core` | Learning data, subtitle parsing, FSRS scheduling and portable archives |
| `surtitle-tools` | Executable discovery, selection, bounded processes and managed updates |
| `surtitle-ai` | Request preparation, Vertex adapters, encrypted credentials and charge accounting |

The renderer cannot execute shell commands, read service-account keys, run SQL or send Vertex requests. Only the local Tauri window is an IPC client; remote documents are never loaded into its WebView. Commands delegate to application services and the core crates.

## Data and IPC

| Store | Authority |
| --- | --- |
| `learning.sqlite` | Cards, subtitles, review history and portable phrase/subtitle drafts |
| `workspace.sqlite` | Device-local, revisioned raw input for settings, existing-card edits and import |
| `preferences.json` | Committed non-budget preferences and the credential identifier |
| `charges.sqlite` | Budget limits, reservations and usage; older JSON budget copies are ignored |

Learning backups exclude operational settings, credentials, approvals and charge records. Settings patches update non-budget preferences or the complete budget group under revision checks. Preferences are saved atomically before in-memory replacement. The legacy full-settings operation spans two stores and is not atomic; later native reconfiguration failures require readback and user feedback.

The generated IPC map connects command names with Rust/TypeScript argument and result types. Run `pnpm generate:ipc` after command changes and `pnpm check:ipc` to verify it. Runtime validators cover event envelopes and result shapes; semantic constraints remain enforced in native use cases.

Resource events carry entity, process epoch and revision. Shared subscriptions coalesce notifications, request incremental snapshots and recover after gaps, focus/network changes or a visible-window checkpoint. Playback ticks are independent. Older reads cannot overwrite newer revisions or cross a restore boundary.

Settings and existing-card edits save after 500 ms idle or blur. Raw incomplete input survives navigation, acknowledged drafts survive restart, and conflicting input stays available for explicit recovery. Closing waits for pending editors and later input; persistence failure leaves the window available for retry. Phrase/subtitle drafts remain separate from committed learning content. Source changes and archive restore preserve their text but require explicit reconnection before saving.

## Study surface and native rendering

Video and the current subtitle remain the primary study surface. User actions open one companion panel at a time; progress does not open panels or resize video. React Aria owns modal focus, dismissal and IME-aware Escape.

Windows presents libmpv through a stable child HWND. Opaque popup regions, including rounded corners, are excluded with `SetWindowRgn`; uncovered playback remains visible. This requires opaque surfaces and stable geometry. Transparent effects and arbitrary transforms over video are unsupported, and video ancestors never transform. Panel transitions wait for confirmed native placement before admitting focus or exposing overlapping content. Reduced motion disables reveals and smooth transcript following. Browser tests alone cannot verify native composition.

Window fitting uses monitor work area, DPI and visible frame bounds. The 1280×720 logical client minimum is capped on smaller work areas; the initial size is 1600×900. Appearance offers 1280×720, 1600×900 and 1920×1080 presets, while valid saved placement takes precedence. Windows retains normal maximized/minimized behavior; edge alignment moves without resizing. Long phrase/subtitle lists are virtualized while retaining focused and edited rows; database reads are not paginated.

The bundled DLL is loaded by absolute path with restricted dependency search; mpv configuration, scripts and URL hooks are disabled. Basic playback uses mpv metadata and codecs without FFmpeg. Windows always uses real libmpv. The Linux `e2e-test` adapter is deterministic test support, not a Linux product or proof of Windows rendering. See [native runtime and packaging](native-runtime.md).

## Behavioral boundaries

- **Playback and source identity:** Resume occurs only after native file-load confirmation. Loading positions cannot overwrite the saved resume point. Audio selections are absolute FFmpeg stream indices; mpv track IDs are mapped through `ff-index`. Preparation receipts and saved cards retain that selection.
- **Subtitle timing:** Precise cues support synchronized captions, sentence pauses and SRT/VTT. Text with only submitted-audio bounds remains a `source_block` and never acquires invented cue timing. Optional sentence pauses use cue-aligned punctuation/gap heuristics; explicit range playback and looping take priority.
- **Learning records:** Cards snapshot their validated adjacent source cues independently of editable card text and extracted audio. Edits preserve source snapshots, audio, schedules and review history. Removing a library item preserves originals and cards; deleting a card removes its review records. Unreferenced audio is not automatically removed.
- **Review:** FSRS remains the scheduler. An Again rating can return at its new due time with the answer concealed; stale snapshots cannot offer the already-rated schedule again. Ordinary review sends no AI request.
- **AI publication:** Requests and approvals are immutable, accounting is durable, and received subtitles publish without requiring a whole-transcript review. Local edits are protected from later arrivals. Source import/restore detaches prior publication authority. [AI behavior](ai.md) owns the detailed approval, retry, timing and recovery contracts.
- **Restore:** Validate first, back up SQLite and replace learning records transactionally. A generation change rejects old writers. Playback is held during replacement and reconciled afterward: a surviving available item reopens paused, otherwise the player detaches. Cleanup/player warnings after commit describe a completed restore; they do not imply rollback. See [export and restore](data-transfer.md) for formats, archive validation and audio retention.

See [tool management](tools.md) for executable and update rules, and [testing](testing.md) for verification.
