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

Windows GPUI owners present libmpv's windowless `gpu-next` D3D11 composition swapchain. A pinned native bridge acquires an owned COM reference while mpv protects the VO lifetime; the public borrowed-pointer property is not used. The existing event drain refreshes the owned chain and coherent post-filter aspect on file load or video reconfiguration. Prepaint only clones that snapshot, avoiding mpv core-lock waits during loop seeks; ordinary playback polling remains synchronous. Source transitions retire the snapshot, and hide retires its visibility lease without discarding the current media. The backing size remains stable during companion reflow. A uniform visual scale fits its letterboxed content using the post-filter display aspect and rotation. Video pixels are never copied through CPU buffers into GPUI. Captions and controls stay outside the video viewport, including fullscreen.

GPUI paints an ordered transparent video aperture; later panels, menus and tooltips remain above video. Its rendered scene is copied on the GPU into a DirectComposition surface at the allocation's returned update offset. One device Commit publishes that surface update with the matching video placement and clip. This couples UI pixels and video geometry, not independently decoded video frames or audio timing. Desired, queued and published content retain their native-library owners; hide, source replacement and destruction invalidate visibility leases. Publication waits for the existing confirmed-media identity check. Standalone native consumers or owners without DirectComposition retain HWND playback with staged placement, rollback and bounded retry. Opaque Normal windows keep a black Windows redirection bitmap beneath native children; transparent windows retain their transparency path. GPUI owns pointer targeting over the full viewport, including letterbox bars. Eager media generations reject stale loads, controls and loop operations. Fake-platform tests do not establish physical composition, IME or audio behavior; required Windows acceptance is defined in [testing](testing.md#required-gpui-windows-acceptance).

Window fitting uses monitor work area, DPI and visible frame bounds. The 1280×720 logical client minimum is capped on smaller work areas. Appearance offers 1280×720, 1600×900 and 1920×1080 presets, while valid saved placement takes precedence. Windows retains normal maximized/minimized behavior; edge alignment moves without resizing. Retained controllers own editing state independently of visible rows; database reads are not paginated.

Motion timing and easing live in `ui/motion`. Main pages and companion tabs retain unique views and share a transition clock; interruption samples current positions before choosing exit sides. Outgoing content remains painted but leaves the pointer, keyboard, tooltip and AccessKit trees through the scoped `gpui-pre` patch. Companion width changes actual layout while keeping its inner text width fixed; no transform or opacity is applied to the native video ancestor. Buttons animate their decorative surface independently of labels, focus and hit regions. User filters in Library, Phrases and Transcript animate measured row positions with matching hit regions; scrolling, resizing and playback follow retire those offsets. The existing system/reduced-motion preference settles active effects without replaying them when re-enabled.

Owned GPUI dialogs use `desktop/dialog` for preparation, entry, open, exit and destruction. Every close path shares its guard and persistence lifecycle; Escape preserves IME and popup priority, and a continuation opens the next dialog only after native destruction and owner restoration. The Windows patch prepares hidden geometry and reveals only after a submitted renderer frame, then moves the whole HWND without resizing, changing stacking or activating it on every step. Per-window DWM transitions are disabled to prevent additional scaling/fading. OS/user placement changes invalidate the trajectory. OS file dialogs retain their standard lifecycle. Both patched crates retain their upstream sources and licenses; their application-specific changes must be reviewed when updating GPUI.

The bundled DLL is loaded by absolute path with restricted dependency search; mpv configuration, scripts and URL hooks are disabled. Basic playback uses mpv metadata and codecs without the separate FFmpeg CLI. Windows uses real libmpv. Linux supports compilation and shared service/component tests; its desktop entry point refuses product launch. Deterministic test adapters do not establish Windows rendering. See [native runtime and packaging](native-runtime.md).

## Behavioral boundaries

- **Playback and source identity:** Resume occurs only after native file-load confirmation. Loading positions cannot overwrite the saved resume point. Audio selections are absolute FFmpeg stream indices; mpv track IDs are mapped through `ff-index`. Preparation receipts and saved cards retain that selection.
- **Subtitle timing:** Precise cues support synchronized captions, sentence pauses and SRT/VTT. Text with only submitted-audio bounds remains a `source_block` and never acquires invented cue timing. Optional sentence pauses use cue-aligned punctuation/gap heuristics; explicit range playback and looping take priority.
- **Learning records:** Cards snapshot their validated adjacent source cues independently of editable card text and extracted audio. Edits preserve source snapshots, audio, schedules and review history. Removing a library item preserves originals and cards; deleting a card removes its review records. Unreferenced audio is not automatically removed.
- **Review:** FSRS remains the scheduler. An Again rating can return at its new due time with the answer concealed; stale snapshots cannot offer the already-rated schedule again. Ordinary review sends no AI request.
- **AI publication:** Requests and approvals are immutable, accounting is durable, and received subtitles publish without requiring a whole-transcript review. Local edits are protected from later arrivals. Source import/restore detaches prior publication authority. [AI behavior](ai.md) owns the detailed approval, retry, timing and recovery contracts.
- **Restore:** Validate first, back up SQLite and replace learning records transactionally. A generation change rejects old writers. Playback is held during replacement and reconciled afterward: a surviving available item reopens paused, otherwise the player detaches. Cleanup/player warnings after commit describe a completed restore; they do not imply rollback. See [export and restore](data-transfer.md) for formats, archive validation and audio retention.

See [tool management](tools.md) for executable and update rules, and [testing](testing.md) for verification.
