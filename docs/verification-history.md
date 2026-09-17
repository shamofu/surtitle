# Implementation verification history

These are local observations from September 2026, not a claim that today's source has passed the same checks. Candidate identity and full-versus-focused scope matter. Current commands are in the [test guide](ai-test-plan.md), [E2E guide](../e2e/README.md) and [native runtime guide](native-runtime.md); current unresolved work is in [status](status.md).

Original reports are recoverable from [source commit d2b0b80a](https://github.com/shamofu/surtitle/tree/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0). Evidence paths refer to retained Git-ignored workspace files. The native packaging implementation has since been simplified; historical custom-installer audits below do not describe the current packaging procedure.

## Six-hour preparation — 8 September 2026

A Windows x64 preparation test processed 21,600 seconds of mono 16 kHz silent FLAC through FFmpeg, Silero, chunk encoding and receipt creation, with no cloud requests.

| Measurement | Recorded value |
| --- | --- |
| Wall time | 122.2166538 seconds |
| Chunks | 180 |
| Core samples | 345,600,000, contiguous and counted once |
| Submitted samples with context | 362,784,000 |
| Added context | 1,074 seconds |
| Rust process peak working set | 51,228,672 bytes |
| Final audio and receipt | 5,850,165 bytes |
| Temporary PCM | Removed |

The memory value excludes FFmpeg and OS cache. Silence does not measure recognition quality, arbitrary-codec speed or audible output. Test-only optimization was sha2/surtitle-tools level 3 and surtitle-ai level 1. The original report is in `work/ai-six-hour-acceptance/`; current acceptance assertions live in the Rust test.

## Development container

The 2026-09-09 local run passed 66 UI tests, 89 Node tests, Rust workspace tests with all features, formatting, Clippy, license checks and five Linux Tauri E2E spec files (16 passed, eight Windows-only cases skipped). Source-sharing probes checked both directions, ten output masks, zero host output writes and zero named volumes. Evidence was explicitly exported to `artifacts/devcontainer/final-20260909-0639/`; dependency/build trees remained in the container.

The later fresh-profile allocation change was checked with two distinct paths under the work mask without another full application run. This historical local check does not certify editor attachment, Windows rendering or the current host-based CI.

## Transcript and audio corrections — 12 September 2026

Bounded response evidence, explicit local reparsing, playback context and frozen explanation bodies were added without rewriting historical provider results. Native replay tests exposed a card extraction defect: a 3.000–3.750 second AAC selection contained 11,930 rather than 12,000 samples, with an eight-millisecond start displacement. Extraction was corrected to preserve the source clock before trimming; WAV length alone was insufficient.

The focused real-FFmpeg tests then passed 36 extraction comparisons across PCM/AAC/MP3, 44.1/48 kHz, source beginnings/tails, delayed audio, a six-hour position and a nonzero origin. One Windows run took 194.14 seconds. Failed or incomplete outputs left no card file. The integrated Linux run preceded this correction; the post-correction native tests were focused. Twenty-seven mandatory Windows E2E cases had passing evidence across several runs, not a single complete final rerun.

Evidence: `artifacts/quality-integrated-linux-20260912/` and `work/quality-implementation-20260912/verification-final.json`. Corrected Windows E2E executable SHA-256: `d1e3b3211e9c688548629a4c8e59a9de6b3482d4558c6685f8140720633689bc`. The final offline snapshot preserved 119 historical attempts under hash `3452305411f79936999cfe8e70c1fc49bb2e122276af9c653f6507f08d19817c`. Earlier selector/input-helper failures remain in the evidence.

## Range recovery and learning restore — 12 September 2026

Manual range revisions added explicit no-speech confirmation, stale-edit protection and local adoption with unknown holds retained. The recovery-stage Linux run passed 83 UI tests, 289 Rust tests and 19 native E2E cases. Its normal Windows binaries were built, but the old installer was not rebuilt at that stage.

The later completion work added full learning export/restore coverage and corrected an archive replacement race using a private bounded snapshot, single-use preview tokens and cancellation/startup cleanup. Its final Linux run passed 86 UI tests, 296 Rust workspace tests, 150 additional feature-disabled AI tests, explicit FFmpeg checks and 20 native E2E cases (11 Windows-only skips). Final Windows E2E passed 30 cases with the optional AV1 case skipped, plus six focused restore regressions. Those configuration-specific totals overlap; they are not independent tests to sum.

Initial Linux transfer-helper and UI-timing failures were followed by a successful full fresh-profile run. Restored 700 ms card audio played through real libmpv. Fixture ledgers retained zero reservations, charges, approvals and dispatches; fixed offline records were not cloud attempts. Container source/output isolation checks found zero host output writes and no volumes.

Evidence root: `work/transcribe-production-20260912/completion-20260912/`, with `linux-initial/`, `linux-final/`, `linux-ui-race.log`, `windows/native-result.json`, `windows/ledger-result.json` and `windows/restore-unit-result.json`. E2E application hash: `42788a2bdec8138df0120600391065827c3077f4ca6e6f7d528e1030bb33e482`. The final package receipt is under `final-package/`; installer hash: `9c6b2ee127f8fc6c3981bc58303f88e8e41b0cc57f2b08ab6db989eb3a3f6e84`. It was extracted and audited, not installed or published.

The separately prepared 24-request Transcribe pilot and later six-request English run are documented in [AI evaluation history](ai-evaluation-history.md#references-and-unexecuted-preparation--12-september-2026). Local implementation checks did not approve that paid scope.

## Draft study — 12–13 September 2026

The next implementation enabled learning from incomplete transcripts, immutable selection-bound cards and preserved unresolved ranges. Run timestamps were UTC on September 12; evidence collation continued September 13 in Japan.

| Candidate and check | Recorded result | Evidence under `work/draft-study-20260912/` |
| --- | --- | --- |
| Earlier Windows complete E2E | 40 passed, 1 optional AV1 skip; before final source-binding fixes | `windows/native-e2e.log`, `native-result.json` |
| Current Windows native study units | 8/8 | `windows-current/native-study-unit.log` |
| Current Windows focused draft E2E | 10/10; wrapper reconciliation described below | `windows-current/fixed-draft-v1/` |
| Current Windows saved-response replay | 11/11 | `windows-current/saved-responses-result.json` |
| Current Windows saved-response visual rerun | 11/11 | `windows-current/saved-responses-visual-result.json` |
| Current Windows final layout diagnostic | 1/1 | `windows-current/saved-layout-final-result.json` |
| Linux common checks | UI 103, Rust workspace 319, AI without defaults 157, Node 131 passed | `linux-full-verification.log` |
| Linux complete native E2E | **24 passed, 6 failed, 11 skipped** | `linux-full-verification.log` |
| Linux corrected focused draft E2E | 10/10; **no later full rerun** | `linux-draft-agent.log` |

The earlier Windows complete run used E2E hash `dce43e36486f39b1986cadcf8fae21d7bc08f8d7aba49c264627316691d05a22`. The current focused/saved-response executable was `b27bd87aab517e43905ce0203e26457bfd82b219002058e67605a991a570571e`. The former is not complete-suite evidence for the latter.

The Windows focused E2E passed, but its auxiliary ledger wrapper compared null-prototype SQLite rows with ordinary JSON objects and reported failure. An independent comparison found the original before/after JSON and current read-only database snapshot identical, with row hash `719a48e455286e6d5be4186efc07abdd05e3796b13423144c5ff7c2ac01c052b`. Three offline attempts, three jobs and five requests were unchanged, with zero reserves, charges, dispatches or approvals. `fixed-draft-v1/verified-result.json` records this reconciliation; the original failed wrapper result was retained.

The Linux full failure began when WebKit's rendered `getText()` could not identify a bookmark below its nested viewport, causing subsequent card cases to fail. The helper was corrected to identify DOM text, scroll the actual element, perform a normal click and check the visible editor. A fresh focused run passed without rebuilding the app. It does not replace the failed full-run result. Initial diagnostics remain in `linux-draft-rerun-final.log` and `linux-draft-agent-diagnostic.log`.

Saved-response checks used the frozen [ten-task set](draft-study-task-set.json). They establish transport, persistence and visible layout. Human listening, semantic correctness and editing effort remain unmeasured. The dialogue WER 22.41%/18.46% and matched timing p95 570/600 ms are unchanged.

## Last recorded local package

The draft-study package receipt is `work/draft-study-20260912/final-package/installer-result.json`. The native and extracted-installer audits passed for all sixty bundled resources. Production feature checks excluded development validation and E2E fixtures.

| Artifact | SHA-256 |
| --- | --- |
| NSIS installer, 26,523,038 bytes | `b4416d4445eee09a7e250d61be7b6ed2aa26e3c335d7de635b2b95c636da0e8c` |
| Optimized original executable | `30af099a988368aaa520cb07f2a54d2eec7c0374921bd5620af190911003e689` |
| Executable embedded in NSIS | `cf5379597502ab9d56aff0199dba678ab211c5fe7f07ec2616cc59aca37a617d` |
| Normal debug executable | `9e6476a5b464e74aaaac3b44498d778252f0eda1563e494835ffc3c848c75953` |

The historical audit checked Tauri's three bundle-marker bytes, UNK to NSS, with remaining executable bytes identical. The installer was extracted, not executed. No install/overwrite/uninstall lifecycle, ordinary-profile launch, hosted same-commit CI or release publication is established by this record. Historical `releaseEligible` was a technical payload result.

## Original report index

The source commit above retains [quality-improvement-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/quality-improvement-2026-09-12.md), [transcribe-implementation-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/transcribe-implementation-2026-09-12.md), [completion-followup-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/completion-followup-2026-09-12.md) and [draft-study-verification-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/draft-study-verification-2026-09-12.md), including full intermediate logs, hashes and test counts. The accepted product rationale from [transcribe-product-reconsideration-2026-09-12.md](https://github.com/shamofu/surtitle/blob/d2b0b80a7bc8e4a8958b9c4078870ee3fc29aca0/docs/transcribe-product-reconsideration-2026-09-12.md) is summarized in [draft study](draft-study.md#product-rationale).
