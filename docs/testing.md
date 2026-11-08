# Application test guide

Current product checks use Rust service tests, GPUI fake-platform component tests and production Windows UIAutomation. Vitest covers build/process/distribution helpers. The final `ci` job requires version validation, native build, Linux, Windows and automated package verification to succeed. Comprehensive manual-evidence validation is an explicit opt-in.

Ordinary tests use authored fixtures and disposable data without paid provider requests. AI integration tests exercise approval, execution, accounting and result application against real SQLite databases with offline transport. Provider coverage includes transactional v2→v3 migration, legacy plan/hash preservation, separate caps and unknown holds, global dispatch serialization, quota exhaustion, token/duration settlement, and switching during execution. They do not measure generated-language quality; live Vertex or OpenAI verification requires separate approval of the exact input and spending limit. The [Vertex verification guide](vertex-verification.md) describes the existing live CLI.

Audio regressions cover whole-file preparation for both services, OpenAI's 25,000,000-byte upload and 24-hour operational bounds, and Vertex's frozen mode-specific duration and JSON transport bounds. Sustained-pause tests cover two-second non-speech evidence, 250 ms inward guards, pauses crossing the duration limit, unequal compression, measured backtracking, and forced-cut review when no adequate pause fits. Required native tests encode a 360-second selection as one FLAC for each service, exercise both byte ceilings on a 900-second varying-compression fixture, and check exactly 15 minutes, longer inputs, and subtitle-mode whole files. Decoding verifies exact PCM coverage. Previous profiles and absent-policy legacy JSON/digests remain covered for saved-job compatibility. Offline transport tests inspect expanded Vertex JSON and OpenAI multipart requests, including immutable policy, reopen/resume and legacy hashes. App/UI tests cover obsolete preparation rejection without receipt changes, long-file listing/quotes, selected-mode propagation, mode-specific reuse and delayed roundtrip responses. Source/audio tampering and frozen provider history remain covered. These checks do not establish live transcription accuracy.

## Bounded formal and operation-order checks

The Dev Container includes the Java major version in [verification/toolchain.json](../verification/toolchain.json). The same manifest pins the TLC release, download digest, heap and total time limit. On another machine, install that Java version, then run:

```sh
pnpm setup:formal
pnpm test:formal
```

Setup reuses a verified local JAR or downloads and verifies it. Checking requires that JAR and makes no network requests. Linux CI runs both commands. Each positive model must finish exploring its entire finite reachable graph; a timeout, nonempty exploration queue, parse failure or missing result fails the check. Each negative control must fail its named invariant with TLC's normal invariant-violation exit. One worker uses at most a 4 GiB Java heap; the combined model run has a ten-minute deadline. These are bounded checks, not a proof of arbitrary executions or external service behavior.

| Model configuration | Finite scope |
| --- | --- |
| `ClaimSafety` | Two jobs, one request each, one send per approval; competing claims, pause/cancel/source changes, reapproval and one restart |
| `RetrySafety` | One job, two requests, up to three sends per request and approval; 429 retries, evidence/settlement failures and completed-request protection |
| `PacingSharedSafety`, `PacingSeparateSafety` | Two jobs, one request each, one retry each; shared or separate project/model/location keys, pause and reapproval |
| `PacingStopSafety`, `PacingRestartSafety` | Complementary two-job retry scenarios with terminal stops/source invalidation or crash/reopen and reapproval |
| `HealthyProgress` | Eventual completion under weak fairness, successful external operations and no permanent pause, unknown result, budget or excess-cost block |
| `MissingGenerationGuard`, `UnknownRefund`, `RetryFloorIgnored` | Deliberate model faults detected respectively by `NoStaleAuthority`, `UnknownHoldPreserved`, `RetryFloorRespected` |
| `ProviderScopeSafety` | Four frozen jobs (three Vertex, one OpenAI), two service profiles, one attempt per job, arbitrary active-service switches, one global lane, independent budgets, holds/charges and pacing |
| `ProviderActiveAccounting`, `ProviderSeparateOutbound`, `ProviderUnknownIgnored`, `ProviderActiveBudget` | Deliberate faults detected respectively by `ProviderAccounting`, `OneOutbound`, `ProviderUnknownGuard`, `ProviderBudgetAdmission` |

The `AiLedger` models use at most two approval generations. Time is represented by finite expired/backoff/server-floor classes; precise UTC boundaries and monetary values belong to the implementation tests. Priced success may exceed its reservation. Acknowledging an unknown result and locally reusing evidence preserve financial holds. This is a single-process worker model under the application lock: a crash destroys workers, while a delayed completion in a live process remains a separate transition. Final authorization and HTTP start are separate, so cancellation after authorization may still allow that send. SQLite transaction internals remain atomic. The model covers the worker settlement path; the Store API's explicit settlement of a recovered unknown attempt is tested separately. `ProviderLedger` is a separate finite refinement of service isolation and the shared lane; it excludes approval generations, retries and restart, which remain covered by `AiLedger` and implementation tests.

| Contract | Model/action and implementation evidence |
| --- | --- |
| Claim and dispatch authority | `Reserve`, `Authorize`, `Start`; [dispatch.rs](../crates/ai/src/ledger/dispatch.rs), [vertex.rs](../crates/ai/src/vertex.rs) and offline worker tests |
| Evidence, holds, retry and recovery | `SaveEvidence`, `Settle`, `Reject429`, `Acknowledge`, `Crash`, `Reopen`; ledger settlement/retries/initialize/accounting and their SQLite tests |
| Model-to-worker boundaries | [model_boundary_replay.rs](../crates/ai/src/vertex/fault_tests/model_boundary_replay.rs): actual worker plus SQLite, authorization-to-send cancellation, durable evidence with failed settlement, 429/unknown holds through reapproval, stale completion and raw recovery settlement; existing AI tests cover exact UTC, costs, per-key pacing and three-send exhaustion |
| Manual edits and publication ownership | [transcript_publication_order_tests.rs](../crates/core/src/store/transcript_publication_order_tests.rs): 1,260 real Store histories, two jobs/three initial cues, precise/source-block intervals, disjoint/touching/overlap/containment, edits/deletes/moves, partial/duplicate results, restart and detachment |
| Change epochs and delayed reads | [ui/session.rs](../crates/desktop/src/ui/session.rs) validates before/after change checkpoints and retries snapshots invalidated during a read; [ui/tests.rs](../crates/desktop/src/ui/tests.rs) drives actual GPUI components through delayed autosave, navigation and combined flush/drain boundaries on the fake platform |
| Stable controls and wheel input | [UI component tests](../crates/desktop/src/ui/tests) compare Japanese/English control bounds through playback, validation, autosave, count and progress changes. Wheel tests cover direction, limits, focus and delayed command ordering; Windows libmpv cases run in the required native suite with hidden owned windows and disposable media |
| Raw input, persistence and restore | [controller/editing.rs](../crates/desktop/src/controller/editing.rs) and its tests cover late commit/refresh responses, newer raw input and restore invalidation; [editor lifecycle tests](../crates/desktop/src/ui/editors/tests.rs) and [source editor worker/tests](../crates/desktop/src/ui/source_editors/worker.rs) cover generation changes, in-flight drain, immediate close during load, newer-input flush and exact saved-draft reopening |

Current Rust controller/service and fake-GPUI checks run in `pnpm test:rust`. Existing rollback and committed-restore warning tests remain authoritative. Identical-source restore compatibility applies to plain source-snapshot card creation; checked existing-card edits include the learning generation and phrase drafts detach. Model and fake-platform checks do not establish native rendering, Windows input or live-provider behavior.

## Routine checks

Install the [development prerequisites](../README.md#development), then run:

```sh
pnpm install --frozen-lockfile
pnpm setup:nextest
pnpm test
pnpm build
pnpm fmt:rust:check
pnpm test:rust
pnpm test:rust:no-default-features
pnpm test:rust:doc
pnpm lint:rust
pnpm audit:rust
node scripts/audit-js-licenses.mjs
node scripts/check-release.mjs --version-only
node scripts/check-production-features.mjs
```

`pnpm test` and `pnpm test:scripts` run build, process and distribution helper regressions with `scripts/vitest.config.mjs`; `pnpm test:watch` watches that suite. Nextest uses separate workspace and no-default-feature profiles; doctests remain a Cargo invocation. Rust and native E2E retries are disabled.

Before publishing platform-dependent Rust changes, run the build, workspace tests and strict Clippy on both Windows and Linux; the [Dev Container](../.devcontainer/README.md) provides the Linux environment. Each target compiles different `cfg` branches. Run the complete helper suite as well, and record any CI jobs that remain unverified separately from local results.

## Required GPUI Windows acceptance

`pnpm test:e2e` runs `native/windows/native-acceptance.ps1`; `pnpm test:native:production` runs the narrower production playback smoke. Both require explicit executable/profile/fixture/build-receipt paths. Neither invokes WDIO or a browser. Native validation may use explicitly isolated application data or a test Windows account. These installed-production runners target Windows known-folder paths, so their existing hosted-runner/disposable-account guards remain; do not bypass those guards to use a normal profile. Syntax, compilation and pure guard tests cannot establish native acceptance; each completed case needs actual observations.

The behavioral checklist and comprehensive report format are in [packaging/native-acceptance.json](../packaging/native-acceptance.json). Automated acceptance uses the ordinary installed binary, the existing restricted-medium process job and native window helpers, and UIAutomation controls. It measures native resize/minimum/maximize/restart placement, fullscreen, owned-dialog blocking/focus, and unfinished input across a clean process restart. Both workers verify the authored short video's pixels at two distinct paused positions in the accessible physical viewport. They try FFmpeg Desktop Duplication first; only unavailable D3D11VA capture initialization permits GDI desktop capture. Both paths must pass the same pixel, aspect-fit and stale-frame checks. Evidence records the selected method, any initial capture error and hashes of retained PNG crops.

The workers require a fully visible, unobscured foreground app on one active primary monitor and fail closed otherwise. The external DPI/monitor matrix remains separate. This static probe and the metadata/progress/pause/seek checks do not establish motion quality, audio output or A/V synchronization; motion validation continues to use Desktop Duplication frame sequences. Fake GPUI tests remain part of `pnpm test:rust`; they do not inspect native pixels or exercise Windows IME.

Rendering/composition, real Japanese IME, measured audio output, interval/sentence auto-stop, real long media, multi-DPI/monitor transitions, real keyboard/clipboard/screen-reader operations and current-build GPU/performance remain `not_run` in the automated worker. Unperformed cases must remain unclaimed. The comprehensive evidence gate is opt-in; missing manual measurements do not block the default automated package/release workflow. Manual pause and synthetic subtitle counts are insufficient. Audio evidence must distinguish measured signal/output and timed stop from direct listening; record `directListeningPerformed` accurately. Performance evidence must identify hardware, workload, metrics and acceptance criteria. Unperformed measurements and listening must remain explicitly unclaimed.

Supply `-ExternalEvidence PATH` to the native runner or `-NativeExternalEvidence PATH` to `package-verify.ps1`. An external JSON report uses `schemaVersion: 1`, `suite: "gpui-windows-external"`, `normalBuild: true`, `paidRequests: 0`, and the exact `executableSha256`, `installerSha256` and `sourceRevision` from the build receipt. Each genuinely completed case supplies its inventory `id` and `method`, `status: "passed"`, `source: {kind: "manual" or "external-probe", operator, observedAt}` (ISO timestamp), `observations: {summary, measurements}` with actual structured measurements, and `evidence: [{path, sha256}]`. Paths are relative to the external report and must identify nonempty unlinked files. Audio measurements require `outputDevice`, `captureMethod`, numeric `signalRmsDbfs`, `measuredDurationMs`, `stopExpectedMs`, `stopObservedMs`, `stopToleranceMs`, and the boolean `directListeningPerformed`. GPU/performance measurements require `hardware`, `measurementMethod`, `criteria` and `workloads`. Both inventory workloads (1920×1080 at 60 fps and 3840×2160 at 30 fps) need a `current` record identifying the candidate executable hash, actual `assetSha256`, physical `displaySize`, and numeric `requiredMetrics`: CPU/GPU load, dropped frames, measured A/V offset and a positive sample window. Identify the observed drop counter or capture layer and A/V measurement method, including their limitations. Source-file frame counts and estimated playback frame indices cannot substitute for measured drops. Memory usage, input latency and decoded-frame counts are optional supplementary metrics. A generic performance summary cannot substitute for these measurements. Old-version comparisons are outside this scope. A boolean-only measurement object is rejected. Include explicit `limitations`. Do not mark unperformed cases passed or substitute booleans for measurements.

The `dpi-monitor-transitions` measurements need `dpiSamples` at every inventory scale (100%, 125%, 150%), each with `scalePercent`, actual `windowDpi`, monitor identity and physical `viewportBounds`, `nativeVideoBounds`, `workArea` (`x`, `y`, `width`, `height`). For composition video, `nativeVideoBounds` identifies the rendered image measured from captured pixels, rather than a placeholder HWND. `monitorMoves` must record distinct `fromMonitor`/`toMonitor`, actual before/after DPI and viewport/video bounds. The automated observed-DPI check does not satisfy this matrix.

The `keyboard-clipboard-accessibility` measurements identify `keyboardInputMethod` (`physical-keyboard` or `windows-sendinput`), recorded `keyboardOperations` from the inventory (`operation`, actual `keys`, `observedResult`), and a real `CF_UNICODETEXT` clipboard round trip (`format`, `copiedText`, `pastedText`). `screenReader` identifies `product`, `version`, `outputCaptureMethod` and each required principal operation with `operation`, `controlRole`, `controlName`, emitted `spokenText`, and `observedResult`. A speech-log capture must be distinguished from direct listening. UIA role queries or ValuePattern edits alone do not satisfy this case.

Other external cases also require concrete records: `rendered-composition` identifies the GPU/window `captureMethod` and normal/wide `layouts` with logical client sizes, total frames and observed video/dialog/transition frame counts. `real-japanese-ime` records `languageTag: "ja-JP"`, engine/version, actual preedit/candidate/committed/restored text, candidate/work-area physical bounds, window DPI and the observed result. `interval-auto-stop` records both inventory stop kinds with requested-start, expected-stop, observed-stop and tolerance clocks plus the clock source/result. `long-media` identifies the actual source SHA256/duration and criteria, at least two observed seeks, distinct before/after process IDs and resumed position, and attributed transcript-scroll cue/latency observations. No quantitative long-duration pass threshold is invented; record the actual source and criteria.

The runner verifies and copies external artifacts, refuses external overrides of automated cases, and writes one `gpui-native-acceptance.json` combined report. Missing/failed cases, wrong binary/installer/revision, changed artifacts or unsuccessful final profile audits fail closed with the case names. Passing `-RequireNativeAcceptance` to package verification or installer smoke requires this complete report. Supplying `-NativeExternalEvidence` also enables the gate. The package manifest carries this requirement into publication; `node scripts/release.mjs --require-native-acceptance` can require it explicitly too. A supplied comprehensive report is always validated, even without the flag. Default package/release checks retain automated installer/production smoke, artifact integrity and exact source revision checks. Source assembly/publication require a clean build of the exact tested revision.

CI preserves `package-candidate-<SHA>` before desktop acceptance. To reuse the exact measured installer and its matching native dependency artifact, supply the producing run ID as workflow-dispatch `native_candidate_run_id`. Supply a run containing `gpui-native-external-<SHA>/report.json` plus its referenced artifacts as `native_evidence_run_id`. For push/tag runs, the corresponding explicit repository variables are `SURTITLE_NATIVE_CANDIDATE_RUN_ID` and `SURTITLE_NATIVE_EVIDENCE_RUN_ID`; stale SHA/hash evidence is rejected. To produce the external artifact, dispatch [Native measurement intake](../.github/workflows/native-evidence-intake.yml) at the candidate commit with its producing run ID, an HTTPS ZIP URL, and the expected ZIP SHA256. The ZIP must contain `report.json` at its root and its referenced files with visible filenames (dotfile/dot-directory paths are rejected to match artifact upload); limits are 128 MiB compressed, 512 MiB expanded and 512 entries. Intake validates paths/links/duplicates, the actual candidate installer hash, all required measured external cases and the selected revision before uploading `gpui-native-external-<SHA>`. It never executes included files or launches the product. Then pass that intake run ID to the package workflow. The optional `require_native_acceptance` workflow input (or `SURTITLE_REQUIRE_NATIVE_ACCEPTANCE=true`) requires the full report even when no external run is supplied. Providing an external evidence run also opts in; invalid or incomplete supplied evidence is rejected. Leaving both unset keeps ordinary CI independent of manual evidence.

## Isolated native development checks

Build a separate fixture-enabled executable with `pnpm build:native:e2e`. It requires an explicit absolute `SURTITLE_E2E_DATA_DIR` and refuses startup without it. Generate authored media with `pnpm test:fixtures` and seed a disposable profile with `pnpm build:fixtures` / `pnpm seed:fixtures`. Never reseed a running profile or point a fixture build at normal learning data.

Fixture builds default to software rendering and null audio. Set `SURTITLE_E2E_REAL_RENDERER=1` for the normal D3D11/automatic decoding path; audio remains muted. Visible pixels establish rendering only: they do not prove real Japanese IME, audio output, mixed-DPI behavior or perceptual A/V synchronization. Ordinary builds ignore E2E profile overrides and contain no test RPC.

Motion regressions in `ui/tests/*motion.rs` use the fake clock to inspect intermediate geometry, interrupted navigation, reveal reversal, fixed button hit regions, list reordering, current-only review input and reduced-motion settling. `ui/tests/native_aperture.rs` checks ordered apertures, clipping and cached replay at 100/125/150% fake DPI. The Windows renderer's hidden GPU test reads alpha and later-overlay pixels through both ClearView and the forced overwrite fallback. A native HWND regression checks the GDI-backed opaque parent after child movement and resize. Accessibility assertions use an activated AccessKit tree, not the test observer's static element-role metadata. Dialog tests cover guarded close, reactivation and handoff ordering; `gpui-pre-windows` tests distinguish a skipped draw from a submitted first frame. These checks do not establish visual quality. Record real frame sequences during playback for normal/wide layouts, dialog entry/exit and manual movement; use Desktop Duplication for composed-frame evidence because GDI capture can mix native surfaces from different moments. Report actual capture cadence and DPI, leaving unmeasured 100/125/150% or monitor cases unclaimed. Check titlebar/content alignment, gaps, duplicate text, video clipping, video aspect and desktop exposure separately from final-state correctness and idle frame requests. Keep recordings confined to the isolated app and discard unrelated foreground intervals.

The retained Windows helpers provide hosted desktop/input preflights, restricted-medium process jobs, and native window inspection. Desktop-setting changes remain restricted to hosted CI. Local verification must use explicitly isolated data and preserve the user's other windows and settings.

The Windows backend's `composition_video_tests` uses an isolated inactive window and Desktop Duplication, copying only its owned client crop to CPU memory. A deliberately split submission must first produce a detectable video/UI marker mismatch; shared production submissions then exercise reversals and check marker alignment, aspect, clipping and black backing in acquired compositor frames. A separate GPU test covers published ownership through detach, lease invalidation and target retirement. The ignored desktop `composition_tests` require `SURTITLE_RESOURCE_DIR` with the patched DLL. Local Y4M/WAV inputs check owned COM references through stop, VO reconfiguration and player destruction; cached geometry without native queries; rotation, PAR and crop changes; loops, audio-only clearing, event ordering and overflow repair. These focused tests do not establish real media playback quality, audio timing, mixed-DPI behavior or monitor transitions; retain actual application captures for those claims.

## Explicit Rust integration suites

Some real-media tests are ignored in ordinary unit runs and selected explicitly in CI:

| Command | Required inputs and checks |
| --- | --- |
| `pnpm test:rust:required linux-ffmpeg` | Linux FFmpeg/ffprobe; source-clock PCM, selected audio-stream extraction and measured OpenAI/Vertex file splitting |
| `pnpm test:rust:required windows-native` | Windows FFmpeg/ffprobe, prepared DLLs and development Silero model; extraction, mpv load/restore, VAD, whole-file preparation, byte-bound splitting, chunk continuity, failure cleanup and video/overlay input ownership |

Set `SURTITLE_TEST_FFMPEG` to an absolute FFmpeg executable with matching ffprobe. Windows speech tests also need the pinned, hash-checked fixtures:

```powershell
$env:SURTITLE_TEST_FFMPEG = 'C:\Tools\ffmpeg\ffmpeg.exe'
python e2e/support/acquire-spoken-fixtures.py
$env:SURTITLE_SPOKEN_FIXTURES = "$PWD/work/spoken-fixtures"
pnpm test:rust:required windows-native
```

The runner validates nextest discovery against exact package/test names before serial execution. The Windows suite includes `composition_video_clicks_and_moving_overlay_use_gpui_hitboxes`: prepared-media playback with fake GPUI pointer events checks an intermediate panel inside the old wider video bounds, one video click with focus handoff, and wheel seeking. It does not establish physical HWND hit testing or composition. Missing inputs, changed discovery and failed or unexecuted groups fail the command. Update the registry in [run-required-rust-tests.mjs](../e2e/support/run-required-rust-tests.mjs) when moving an integration test. Ordinary workspace tests invoke their own crash helpers; do not register those helpers as standalone integrations.

## Live provider evaluation

Paid validation requires separate approval of the exact input, destination and spending limit. Keep campaign profiles, source audio, references, rubric, hashes and response evidence under ignored `work/`; preserve the original spending ledger across dates and restarts. Do not send reference answers or the quality rubric to the model.

The retained [budget guard](../e2e/support/live-api-budget.mjs) checks unpriced or stale work, unknown outcomes, overlapping approvals and approved scope against the original SQLite ledger. It does not provide a GPUI automation transport or permission to send requests. Credentials must never appear in command arguments, logs or evidence files.

Record source linkage and semantic accuracy separately from request completion. Offline fixtures and null-audio runs do not establish live service quality. Verify saved-result reuse, pause/restart, provider switching and local learning/export behavior against the same ledger; do not deliberately exhaust credits.

## Results and failure evidence

Runner exit codes determine test success; the final CI job requires every prerequisite job to succeed. Native startup, readiness, hook and cleanup failures also fail the run. Expected application rejection is a tested result; automation/transport errors remain failures. CI uploads diagnostics even after a failed test step.

| Evidence | Local path |
| --- | --- |
| Vitest JUnit | `work/test-results/vitest/` |
| TLC inputs, per-configuration logs and completion summary | `work/test-results/formal/<run>/` |
| Rust JUnit | `work/test-results/nextest/` |
| Required Rust discovery, execution and JUnit | `work/artifacts/required-rust-tests/<suite>/run-*/` |
| Native production/acceptance logs and observations | `work/artifacts/` |
| Installer/runtime smoke | `work/artifacts/` |

Required-suite reruns use unique directories; `--evidence-dir <directory>` changes their parent. Successful tests do not record screenshot sequences or videos. Reports and generated fixtures are ignored local outputs, not source-controlled acceptance records. See [native packaging](native-runtime.md#standard-nsis-installer) for production installer checks and [fixed AI responses](../crates/ai/tests/fixtures/README.md) for offline fixture maintenance.
