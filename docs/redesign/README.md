# Learning-first redesign

This work implements the approved whole-application redesign. Existing technologies are candidates, not protected assumptions. Windows 11 x64, Japanese/English, both themes, existing learning history and charge records are compatibility requirements.

## Decision order

1. Measure the current application using the same material and small/large datasets as the candidates.
2. Establish rendering capabilities before choosing interaction primitives.
3. Select by learning workflow and media/data compatibility, interruption and latency, actual Windows stability/performance, then maintainability. Migration effort alone is not a rejection reason.
4. Record keep/update/replace/remove decisions, alternatives, measurements, migration and limitations. A prototype, browser fixture or software renderer is not hardware-video evidence.
5. Implement durable editing, targeted synchronization and AI scheduling before migrating all learning surfaces.

## Product acceptance

- Video is the main study surface. At 100% scaling, 16:9 material has at least 300 CSS pixels of actual picture height at 1024×700 and 450 at 1440×900. Background progress does not alter its bounds.
- Playback, replay, next subtitle, meaning and phrase saving have visible, consistent controls. Only one auxiliary study panel opens at a time, following a user action.
- AI shows scope/model/cost beside one Start action. Editing or quoting sends no generation request. Queued work is distinct from an uncertain network outcome.
- Valid settings and existing-card text edits save automatically after 500 ms idle or blur. Incomplete/invalid input survives navigation. Acknowledged durable drafts survive restart. Delayed responses never overwrite newer edits.
- File selection/drop starts import. Subtitle replacement keeps a restorable edition. Routine navigation has no confirmation. Destructive deletion and whole-library restore have one meaningful execution screen.
- Library, import, study, subtitle management, phrases, review and settings share these conventions.
- Learning restore cannot roll back spending. Card text edits cannot alter audio, review history or scheduling.

## Evidence

Subsystem decisions and results are written alongside this document as work proceeds. Each result must identify its environment, command/scenario and whether it is measured, inspected or still unverified. A failed or unavailable check stays visible; it is not recorded as passed.

| Record | What it establishes |
| --- | --- |
| [Implementation and acceptance status](acceptance.md) | Consolidated final source checks, delivered behavior and physical-device validation boundaries |
| [Interaction](interaction.md) | Screen hierarchy, fixed learning controls, automatic persistence and confirmation policy |
| [Rendering](rendering.md) | HWND, HTML video and GPU composition trials; hardware decoding; actual Windows/IME and installer evidence |
| [Monitor fitting](window-fitting.md) | Workarea-derived window minimums and compact-height behavior at physical 200% scaling |
| [FFmpeg runtime](ffmpeg-native.md) / [FFmpeg CLI](ffmpeg-cli.md) | Matched latest-stable codec/audio comparisons, adopted runtime/source identities, and external-tool compatibility |
| [Frontend](frontend.md) | Current/Base UI/React Aria/Radix prototypes, selected primitives and compiler/build-tool comparison |
| [Storage](storage.md) | Single ownership of budgets, revision checks, restart/restore and recovery of conflicting input |
| [Synchronization](synchronization.md) | Resource events, recovery checkpoints, generated IPC contracts and request-count measurements |
| [AI and learning](ai.md) | Native queue, staged preparation, local/provider comparison, pricing limitations and FSRS replay |
| [Performance](performance.md) | Matched card-list scaling and subtitle measurements, including their limits |
| [Toolchain and distribution](toolchain.md) | Verified Rust update, pinned sources, license checks and normal installer validation boundaries |

The baseline and intermediate failed runs remain documented as historical evidence. After the user opened Windows Display Settings, actual 125%, 150% and 200% tests exercised native video geometry and movement to the second 100% monitor and back. The initial 200% minimum-window overflow was corrected with monitor-aware fitting and compact-height layout. The installed geometry candidate passed fresh startup, live scale changes and mixed-monitor movement, with primary controls, video, unfinished Japanese input, selection and focus preserved. Both monitors were restored to their original 100% settings after testing. See acceptance for the exact candidate/final-package identities and evidence limits.

Native acceptance includes real GPU playback and audio, multiple tracks, H.264/HEVC/AV1, 1080p/4K, speed/seek/repeat, DPI changes, long media, lifecycle and installer migration. Browser acceptance covers interaction, geometry, focus, IME and both languages/themes. Restore, revision races and exactly-once accounting require native/database tests.

## Delivery order

Comparison and decisions → persistence/synchronization/scheduling → study surface → remaining screens → native/package acceptance → remove superseded code and update documentation.

## Adoption summary

| Scope | Decision | Reason and migration |
| --- | --- | --- |
| Video presentation | Replace blanket video hiding with stable native bounds and opaque popup exclusions; retain Tauri/mpv | Actual hardware playback and learning operations pass. HTML video lost pictures for supported files. GPU composition was implemented and measured, but its decoder copy path and separate host still require production integration/device testing. See rendering. |
| UI primitives | Replace custom modal focus/dismissal with React Aria Components 1.22.1 | Current, Base UI, React Aria and Radix have runnable comparison entries. Selection uses interaction evidence and equal-entry bundle sizes; native comparisons are recorded separately. Existing forms, data and layout stay compatible. |
| Frontend tools | Update Vite 8.3.4, React plugin 6.1.2, TypeScript 7.0.2 and Vitest 5.0.3 | The same source/tests were compiled before migration. React, Router, Query and Virtual remain, with changed subscriptions and large-list rendering. Remove unnecessary geometric modal animation rather than attributing application problems to Motion without evidence. |
| Persistence | Retain SQLite and committed preference JSON; replace volatile editor state with revisioned durable drafts | A separate local workspace store preserves incomplete input. The spending ledger exclusively owns budget values. Restore invalidates old content revisions without applying stale drafts. |
| Synchronization | Replace broad timed refreshes with resource/entity/revision events | Shared recovery checkpoints handle missing events. Generated command contracts replace arbitrary caller-selected IPC result types. |
| AI preparation and sending | Adopt bounded staged encoding and one native priority queue; remove unconditional ten-second pacing | Measured preparation and dispatch comparisons support the changes. Server cooldowns, immutable approvals, budgets and unknown-outcome holds remain. Provider/local comparison does not justify silently replacing the current Vertex adapter. |
| Speech and review | Retain the checked Silero model, ONNX Runtime 1.29 and FSRS 6.6.2 | Latest-model hashes, an actual runtime comparison and schedule replay are recorded. Card text editing preserves audio and review history. Local whisper remains an evaluated candidate, not an untested shipping provider. |
| Native build/distribution | Update Rust 1.99 and FFmpeg 9.0.2; retain mpv 0.41 and the checked NSIS workflow | Actual codec/audio/build comparisons precede adoption. Corresponding sources and notices match bundled binaries. Fresh install, overwrite, restart and data-retaining uninstall use isolated profiles. |
