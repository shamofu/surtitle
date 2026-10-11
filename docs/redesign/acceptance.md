# Redesign implementation and acceptance status

Updated 2026-10-12. This record distinguishes implemented behavior, completed physical-device checks and the limits of the evidence. Subsystem records retain intermediate failures and the exact limits of each experiment.

## Implemented

- Study centers video and the current subtitle. Playback, replay, next, meaning and saving stay in fixed positions. Progress and management occupy an explicitly opened companion surface. New progress does not open panels or resize video.
- Library/drop import starts directly. Subtitle replacement retains restoration rather than asking for another checkbox. Phrase creation has one Save; existing cards and valid settings autosave. Review keeps its question, reveal and four ratings reachable at minimum size.
- Settings use six sections. Raw incomplete fields and conflicts remain recoverable across navigation/restart. Budget values have one ledger authority; card text edits do not rewrite audio or review state.
- Resource/revision notifications replace broad five-second polling. A common checkpoint handles missed updates. Playback ticks update the player independently of whole-study rendering.
- Native AI dispatch is serial, gives interactive work priority at chunk boundaries, and distinguishes queued work from unknown outcomes. Paid authority remains bound to the immutable request; queued source replacement is detected before dispatch. Unknown outcomes are never automatically resent.
- Closing waits for every registered save, detached draft, later input and newly registered task. Failed persistence retains the window and inputs. Ordinary navigation has no unsaved-input confirmation.

## Source checks after adaptive pacing, compact height and restore recovery

| Check | Result | Scope |
| --- | --- | --- |
| Whole UI suite | **479 passed**, zero failed/skipped | Actual React components in jsdom, including stale-read recovery and completed-restore warning handling |
| Whole browser suite | **192 passed**, zero failed/flaky/skipped | Frozen final source, one worker, 457.03 seconds; includes all five performance diagnostics after synchronization/restore changes |
| Final normal installed Windows package | **15 native cases passed**, one optional no-jobs case skipped; lifecycle passed | Exact final d payload: real rendering, Japanese layouts, immediate Escape, card/audio/history continuity, stale-write rejection, process restart, overwrite and data-retaining uninstall; [package identity and evidence](rendering.md) |
| Opt-in performance diagnostics | Passed in the whole suite | 100/1,000 phrases, 120/10,000 subtitles, event/IPC counts; controlled comparison measurements remain in [performance](performance.md) |
| Script suite | **125 passed** | Real temporary Git repositories, package validation and child processes; one worker rerun after shared-host process timeouts |
| Rust workspace, all features | **555 passed**, zero failed; 12 explicitly ignored | Application 182, AI 246, validation 19, core 86, tools 22; includes adaptive pacing, monitor fitting and post-commit restore failure; some ignored tests are subprocess helpers invoked by parent tests |
| Required native integrations, Rust 1.99 | **6 passed**, zero skipped | Actual mpv/FFmpeg/Silero, tracks, audio times, backup/restore/restart; [named results](evidence/native-acceptance-rust-1.99.json) |
| Final real-mpv restore integration | **1 passed**, zero skipped | Rerun after the restore-boundary fix: backup/transaction failure, restored resume/audio/subtitles, persisted playback ticks and restart; [evidence](evidence/restore-boundary-2026-10-11.json) |
| Real spoken-audio pause integration, Rust 1.99 | **1 passed**, zero skipped | Exact public LibriSpeech fixture hashes, unchanged PCM, preserved selection samples, localized pause warning and stale-acknowledgment rejection; [evidence](evidence/spoken-pause-2026-10-11.json) |
| Six-hour preparation | Passed separately on identified Rust 1.98 binary | Continuity, bounded chunks, cleanup and process memory; [evidence](evidence/native-acceptance-2026-10-11.json) |
| TypeScript / Clippy / Rust format / IPC generation | Passed | Clippy denies warnings; 101 command envelopes checked |
| Cargo dependency licenses/bans/sources | Passed | Does not substitute for native corresponding-source packaging checks |

Browser measurements do not prove native playback performance. The large-list p95 measurement improved from 1,514.2 ms to 96.5 ms at 1,000 phrases in the matched browser fixture; it is not a measured installed-app startup or native memory improvement.

## Native acceptance and remaining limits

Normal-feature installed Windows validation, physical GPU playback, composition comparison, exact package identity and lifecycle results are maintained in [rendering](rendering.md). The completed final d package includes the close/source-binding, adaptive pacing, monitor-fitting, synchronization and restore fixes. Its installed executable SHA-256 is `34af843982fe59203c57b54696c68b934657ff4f5289e885d79d3564149f5a65`, and its frontend entry is `index-CpKs70GE.js` with `index-CiNBTgCt.css`. Fresh install, normal startup, actual video/dialog checks, immediate close after Japanese card editing, restart, stale native writer rejection, unchanged audio/review state, same-version overwrite and data-retaining uninstall passed. An initial native test run used obsolete text-equality selectors after compact labels gained hidden full text; the two affected specs were rerun successfully using the unchanged accessible name on the exact same payload. This test-only correction did not rebuild or change the application. Earlier package hashes remain historical results.

Physical DPI tests measured actual HWND DPI 120/144/192 and WebView DPR 1.25/1.5/2, including movement to the second DPI-96 monitor and back. The first 200% pass exposed an oversized minimum window; monitor-aware fitting and compact-height layout corrected it. The normal installed c geometry candidate subsequently passed live 100% → 200% scaling, fresh startup at 200% before helper resizing, constrained minimum-size resizing, and mixed-monitor movement. Physical outer bounds and all primary controls fit the workarea; unfinished Japanese input, selection, focus, immediate Escape and visible video were preserved. The c geometry build precedes the independent restore fix and is recorded separately from final d package acceptance. Both monitors are back at their original 100%; the primary restoration was verified in Windows Settings after the final 200% run. See [monitor fitting](window-fitting.md). The earlier automatic Settings launch timeouts were overcome by the user opening that screen; they are historical automation failures, not a remaining hardware limitation.

Actual Windows IME candidate selection, cancellation and Japanese commit were exercised for all four UI candidates over the native video surface. All four preserved the observed IME workflow; the [frontend record](frontend.md) retains the differing synthetic-event behavior and the untrusted composition-end event limitation. Codec/long-media smoke tests do not establish perceptual A/V synchronization or all-device reliability. The public natural-speech trial and six-request pacing comparison in [AI and learning](ai.md) extend the earlier two clean TTS clips, but do not establish broad conversational transcription quality, sustained provider quotas or invoice-level cloud cost.

The planned Windows learning workflow, migration/recovery and restart checks are complete for the identified machine and fixtures. The limitations above remain explicit: broader speech quality, sustained cloud quotas, invoice cost, all-GPU reliability and perceptual A/V synchronization are not established by these bounded trials. Installed missed-event fault injection and Linux CI execution were not measured; protocol/browser recovery and actual Windows lifecycle were. No public release, deployment or replacement of the user's installed profile was performed.
