# Application test guide

Product checks use Rust unit/integration tests, GPUI fake-platform component tests, native DLL smoke checks, and explicitly selected real-media Rust integration suites.

Ordinary tests use authored fixtures and disposable data without paid provider requests. AI integration tests exercise approval, execution, accounting and result application against real SQLite databases with offline transport. Provider coverage includes transactional v2→v3 migration, legacy plan/hash preservation, separate caps and unknown holds, global dispatch serialization, quota exhaustion, token/duration settlement, and switching during execution. They do not measure generated-language quality; live Vertex or OpenAI verification requires separate approval of the exact input and spending limit. The [Vertex verification guide](vertex-verification.md) describes the existing live CLI.

Audio regressions cover whole-file preparation for both services, OpenAI's 25,000,000-byte upload and 24-hour operational bounds, and Vertex's frozen mode-specific duration and JSON transport bounds. Sustained-pause tests cover two-second non-speech evidence, 250 ms inward guards, pauses crossing the duration limit, unequal compression, measured backtracking, and forced-cut review when no adequate pause fits. Real-media native tests encode a 360-second selection as one FLAC for each service, exercise both byte ceilings on a 900-second varying-compression fixture, and check exactly 15 minutes, longer inputs, and subtitle-mode whole files. Decoding verifies exact PCM coverage. Previous profiles and absent-policy legacy JSON/digests remain covered for saved-job compatibility. Offline transport tests inspect expanded Vertex JSON and OpenAI multipart requests, including immutable policy, reopen/resume and legacy hashes. App/UI tests cover obsolete preparation rejection without receipt changes, long-file listing/quotes, selected-mode propagation, mode-specific reuse and delayed roundtrip responses. Source/audio tampering and frozen provider history remain covered. These checks do not establish live transcription accuracy.

## State and UI verification boundaries

| Contract | Implementation evidence |
| --- | --- |
| Claim, dispatch, evidence, holds, retry and recovery | [dispatch.rs](../crates/ai/src/ledger/dispatch.rs), [vertex.rs](../crates/ai/src/vertex.rs), and offline worker/SQLite ledger tests |
| Boundary replay across authorization, retry, unknown holds and provider isolation | [model_boundary_replay.rs](../crates/ai/src/vertex/fault_tests/model_boundary_replay.rs) (actual worker plus SQLite, cancellation, durable evidence with failed settlement, 429/unknown holds through reapproval, stale completion and raw recovery settlement) |
| Manual edits and publication ownership | [transcript_publication_order_tests.rs](../crates/core/src/store/transcript_publication_order_tests.rs): 1,260 real Store histories, two jobs/three initial cues, precise/source-block intervals, disjoint/touching/overlap/containment, edits/deletes/moves, partial/duplicate results, restart and detachment |
| Change epochs and delayed reads | [ui/session.rs](../crates/desktop/src/ui/session.rs) validates before/after change checkpoints and retries snapshots invalidated during a read; [ui/tests.rs](../crates/desktop/src/ui/tests.rs) drives actual GPUI components through delayed autosave, navigation and combined flush/drain boundaries on the fake platform |
| Stable controls and wheel input | [UI component tests](../crates/desktop/src/ui/tests) compare Japanese/English control bounds through playback, validation, autosave, count and progress changes. Wheel tests cover direction, limits, focus and delayed command ordering; Windows libmpv cases run in the ignored `study_wheel::applied` suite with hidden owned windows and disposable media |
| Raw input, persistence and restore | [controller/editing.rs](../crates/desktop/src/controller/editing.rs) and its tests cover late commit/refresh responses, newer raw input and restore invalidation; [editor lifecycle tests](../crates/desktop/src/ui/editors/tests.rs) and [source editor worker/tests](../crates/desktop/src/ui/source_editors/worker.rs) cover generation changes, in-flight drain, immediate close during load, newer-input flush and exact saved-draft reopening |

Fake-platform checks do not establish native D3D11/DirectComposition rendering, real Windows IME, measured audio output, multi-DPI transitions, or live-provider behavior.

## Routine checks

Install Rust from [rust-toolchain.toml](../rust-toolchain.toml), `cargo-nextest`, and `cargo-deny`, then run from the repository root (`.cargo/config.toml` directs Cargo output to `work/target`):

```sh
cargo build --locked --package surtitle
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo nextest run --workspace --all-features --locked --profile ci --no-tests fail
cargo nextest run -p surtitle-ai --no-default-features --locked --profile ci-no-default --no-tests fail
cargo test --workspace --all-features --locked --doc
cargo test -p surtitle-ai --no-default-features --locked --doc
cargo deny check licenses bans sources
```

Verify the production dependency graph (`surtitle --no-default-features`) excludes browser runtimes and development-only features (`development-validation`, `e2e-fixtures`, `e2e-test`, `test-support`) using `cargo tree --locked --package surtitle --no-default-features --edges normal,build --prefix none --format "{p}|{f}"` (automated in CI and [package.ps1](../native/windows/package.ps1)).

Before publishing platform-dependent Rust changes, run the build, workspace tests and strict Clippy on both Windows and Linux; the [Dev Container](../.devcontainer/README.md) provides the Linux environment. On Windows, also run `cargo test -p gpui-pre-windows --lib --locked` (excluded from the default workspace member list).

## Isolated native development checks

Fixture-enabled development builds (`cargo build -p surtitle --features e2e-test --locked`) require an explicit absolute `SURTITLE_E2E_DATA_DIR` and refuse startup without it. Never point a fixture build or `cargo run -p surtitle-core --example seed_fixture` at normal `%LOCALAPPDATA%\app.surtitle.desktop` learning data.

Motion regressions in `ui/tests/*motion.rs` use the fake clock to inspect intermediate geometry, interrupted navigation, reveal reversal, fixed button hit regions, list reordering, current-only review input and reduced-motion settling. `ui/tests/native_aperture.rs` checks ordered apertures, clipping and cached replay at 100/125/150% fake DPI. The Windows renderer's hidden GPU test reads alpha and later-overlay pixels through both ClearView and the forced overwrite fallback. A native HWND regression checks the GDI-backed opaque parent after child movement and resize. Accessibility assertions use an activated AccessKit tree, not the test observer's static element-role metadata. Dialog tests cover guarded close, reactivation and handoff ordering; `gpui-pre-windows` tests distinguish a skipped draw from a submitted first frame.

The Windows backend's `composition_video_tests` uses an isolated inactive window and Desktop Duplication, copying only its owned client crop to CPU memory. A deliberately split submission must first produce a detectable video/UI marker mismatch; shared production submissions then exercise reversals and check marker alignment, aspect, clipping and black backing in acquired compositor frames. A separate GPU test covers published ownership through detach, lease invalidation and target retirement. The ignored desktop `composition_tests` require `SURTITLE_RESOURCE_DIR` with the patched DLL and local D3D11 support.

## Explicit Rust integration suites

Real-media and native DLL tests are marked `#[ignore]` and run explicitly when external prerequisites are present:

- **FFmpeg integration tests**: Set `SURTITLE_TEST_FFMPEG` to an absolute `ffmpeg` executable paired with `ffprobe` in the same directory:
  - `surtitle` (`--features e2e-test`): `application::media_tools::card_audio::tests::installed_ffmpeg_preserves_native_rate_wav_tail_without_padding` and `installed_ffmpeg_preserves_source_clock_and_cleans_failed_outputs`
  - `surtitle-tools`: `command::tests::multitrack_extraction_preserves_selected_stream`
  - `surtitle-ai` (`--no-default-features`): `prepare::encoding::file_tests::openai_file_real_encoding_splits_only_oversized_files_and_preserves_pcm`
- **Windows native DLL & D3D11 tests** (require `pwsh -File native/windows/native-prepare.ps1 -WithDevModel` and `SURTITLE_RESOURCE_DIR` pointing to `work/resources`):
  - `surtitle` (`--features e2e-test`): `player::subtitle_tests::real_mpv_load_restores_position_and_maps_audio_stream`, `player::native::composition_tests::*`, `application::transfer::restore_tests::real_mpv_restore_reconciles_resume_audio_subtitles_and_stale_ticks`, and `ui::tests::study_wheel::applied::*`
  - `surtitle-ai` (`--no-default-features`, plus `SURTITLE_TEST_FFMPEG`): `prepare::tests::real_silero_and_ffmpeg_preserve_selection_time` and `prepare::tests::real_preparation_failures_remove_receipts_and_temporary_files`
  - Optional speech test (`prepare::spoken_pause_test::real_spoken_audio_and_interior_pause_require_only_local_warning_review`): also requires `SURTITLE_SPOKEN_FIXTURES` containing LibriSpeech test-clean `1089-134686-0001.wav` and `1089-134686-0003.wav`.

Run individual suites with `cargo nextest run ... --profile required --run-ignored only --ignore-default-filter --no-tests fail -E '...'` (matching [.github/workflows/ci.yml](../.github/workflows/ci.yml)). Nextest JUnit outputs live under `work/test-results/nextest/`, and generated test/packaging outputs stay under ignored `work/`. See [fixed AI responses](../crates/ai/tests/fixtures/README.md) for offline fixture maintenance.
