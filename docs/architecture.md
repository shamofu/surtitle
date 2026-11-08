# Surtitle architecture

Surtitle is a Windows 11 x64 desktop application built with Rust, GPUI, GPUI Kit and SQLite. Cargo builds the native executable; standard NSIS packages it with its native libraries and notices.

| Component | Responsibility |
| --- | --- |
| `surtitle` GPUI views/controllers | Library, study, cards/review, settings, AI approval, durable raw input and data transfer |
| `surtitle` application/desktop host | Typed in-process services, resource events, Tokio workers, native window lifecycle and playback |
| `surtitle-core` | Learning data, subtitle parsing, FSRS scheduling and portable archives |
| `surtitle-tools` | Executable discovery, selection, bounded processes and managed updates |
| `surtitle-ai` | Shared request/approval lifecycle, Vertex and OpenAI adapters, encrypted credentials and per-service charge accounting |

Views call typed Rust facades that delegate to application services and the core crates. The UI receives credential status rather than saved secrets; approved provider operations and bounded external processes remain owned by their services. GPUI entities and native window lifetime stay on the GUI thread, while blocking and asynchronous work use the explicit Tokio runtime. These are in-process ownership boundaries, not a separate renderer sandbox. The production dependency graph excludes Electron, Tauri and WebView runtimes.

## Data and service boundaries

| Store | Authority |
| --- | --- |
| `learning.sqlite` | Cards, subtitles, review history and portable phrase/subtitle drafts |
| `workspace.sqlite` | Device-local, revisioned raw input for settings, existing-card edits and import |
| `preferences.json` | Committed non-budget preferences and the credential identifier |
| `charges.sqlite` | Budget limits, reservations and usage; older JSON budget copies are ignored |

Learning backups exclude operational settings, credentials, approvals and charge records. Settings patches update non-budget preferences or the complete budget group under revision checks. Preferences are saved atomically before in-memory replacement. The legacy full-settings operation spans two stores and is not atomic; later native reconfiguration failures require readback and user feedback.

The native UI uses Rust argument/result types directly. Native use cases enforce semantic constraints, expected revisions and source authority.

Resource events carry entity, process epoch and revision. Shared subscriptions coalesce notifications, request incremental snapshots and recover after gaps, focus/network changes or a visible-window checkpoint. Playback ticks are independent. Older reads cannot overwrite newer revisions or cross a restore boundary.

Settings and existing-card edits save after 500 ms idle or blur. Raw incomplete input survives navigation, acknowledged drafts survive restart, and conflicting input stays available for explicit recovery. Close, export, restore and source-changing actions freeze new submissions, drain admitted service operations and their GUI callbacks, and then flush every retained editor. Persistence failure leaves input available for retry. Phrase/subtitle drafts remain separate from committed learning content and require explicit save. Source changes and archive restore preserve their text but require explicit reconnection before saving.

## Study surface and native rendering

The native views preserve the original UI's roles: top navigation, a resumable media library, full-width phrase articles, reveal-before-grade review, and categorized settings. Activity opens beside the current page. Study's companion switches between transcript, transcription history, suggestions and a captured passage's meaning; changing tabs or advancing playback does not retarget an unfinished edit. Matching results may refresh the captured passage, while changed source identity requires explicit reselection.

Video and the current subtitle remain the primary study surface. The transcript uses a virtualized projection for search and marked cues while actions retain the original source identity. Long caption and row text scroll within bounded regions. Editing and approval dialogs are separate owned native GPUI windows; their parent is disabled until the dialog closes.

Windows presents libmpv through a stable child HWND using `gpu-next` and D3D11. Frames are not copied through CPU buffers into GPUI. Captions and controls stay outside the video surface, including fullscreen. The application disables GPUI DirectComposition before starting worker threads so native child composition remains available. GPUI prepaint synchronously supplies the viewport bounds on the GUI thread; loading another item hides the old surface and disables controls until that item's load succeeds. Eager media generations reject stale loads, controls and loop operations. Fake-platform tests do not establish physical composition, IME or audio behavior; required Windows acceptance is defined in [testing](testing.md#required-gpui-windows-acceptance).

Window fitting uses monitor work area, DPI and visible frame bounds. The 1280×720 logical client minimum is capped on smaller work areas. Appearance offers 1280×720, 1600×900 and 1920×1080 presets, while valid saved placement takes precedence. Windows retains normal maximized/minimized behavior; edge alignment moves without resizing. Retained controllers own editing state independently of visible rows; database reads are not paginated.

The bundled DLL is loaded by absolute path with restricted dependency search; mpv configuration, scripts and URL hooks are disabled. Basic playback uses mpv metadata and codecs without the separate FFmpeg CLI. Windows uses real libmpv. Linux supports compilation and shared service/component tests; its desktop entry point refuses product launch. Deterministic test adapters do not establish Windows rendering. See [native runtime and packaging](native-runtime.md).

## Behavioral boundaries

- **Playback and source identity:** Resume occurs only after native file-load confirmation. Loading positions cannot overwrite the saved resume point. Audio selections are absolute FFmpeg stream indices; mpv track IDs are mapped through `ff-index`. Preparation receipts and saved cards retain that selection.
- **Subtitle timing:** Precise cues support synchronized captions, sentence pauses and SRT/VTT. Text with only submitted-audio bounds remains a `source_block` and never acquires invented cue timing. Optional sentence pauses use cue-aligned punctuation/gap heuristics; explicit range playback and looping take priority.
- **Learning records:** Cards snapshot their validated adjacent source cues independently of editable card text and extracted audio. Edits preserve source snapshots, audio, schedules and review history. Removing a library item preserves originals and cards; deleting a card removes its review records. Unreferenced audio is not automatically removed.
- **Review:** FSRS remains the scheduler. An Again rating can return at its new due time with the answer concealed; stale snapshots cannot offer the already-rated schedule again. Ordinary review sends no AI request.
- **AI publication:** Requests and approvals are immutable, accounting is durable, and received subtitles publish without requiring a whole-transcript review. Local edits are protected from later arrivals. Source import/restore detaches prior publication authority. [AI behavior](ai.md) owns the detailed approval, retry, timing and recovery contracts.
- **Restore:** Validate first, back up SQLite and replace learning records transactionally. A generation change rejects old writers. Playback is held during replacement and reconciled afterward: a surviving available item reopens paused, otherwise the player detaches. Cleanup/player warnings after commit describe a completed restore; they do not imply rollback. See [export and restore](data-transfer.md) for formats, archive validation and audio retention.

See [tool management](tools.md) for executable and update rules, and [testing](testing.md) for verification.
