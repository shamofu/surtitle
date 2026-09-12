# Draft study verification — 12 September 2026

This record covers local verification of the [draft study workflow](draft-study.md)
and the frozen [ten-task replay set](draft-study-task-set.json). Run timestamps
are UTC on 12 September; evidence collation continued on 13 September in Japan.
The repository remains on `main`, with no commits, pushes or release publication.

The checks establish local selection, playback transport, card persistence and
accounting behavior. They do not establish human listening, semantic correctness,
editing effort or improved recognition quality. Evidence paths below refer to
retained, Git-ignored workspace files; they are not distributed test results.

## Recorded test results

| Check | Recorded result | Evidence |
| --- | --- | --- |
| Windows full native E2E, earlier candidate | 40 passed, 1 optional AV1 case skipped; 7/7 specs passed | `work/draft-study-20260912/windows/native-e2e.log`, `native-result.json` |
| Windows current native draft-study unit tests | 8/8 passed | `work/draft-study-20260912/windows-current/native-study-unit.log` |
| Windows current focused draft-study E2E | 10/10 passed; auxiliary ledger-wrapper failure independently reconciled below | `work/draft-study-20260912/windows-current/fixed-draft-v1/native-e2e.log`, `verified-result.json` |
| Windows current saved-response replay | 11/11 passed | `work/draft-study-20260912/windows-current/saved-responses-e2e.log`, `saved-responses-result.json` |
| Windows current saved-response visual capture rerun | 11/11 passed | `work/draft-study-20260912/windows-current/saved-responses-visual-e2e.log`, `saved-responses-visual-result.json` |
| Windows current final layout diagnostic | 1/1 passed | `work/draft-study-20260912/windows-current/saved-layout-final-e2e.log`, `saved-layout-final-result.json` |
| Linux full verification: renderer | 103/103 passed in 17 files | `work/draft-study-20260912/linux-full-verification.log` |
| Linux full verification: Rust workspace, all features | Native 60, AI 184, validation CLI 18, core 38, tools 19 passed; 319 total | Same full log |
| Linux additional Rust configurations | AI without default features: 157 passed; explicit installed-FFmpeg checks: 2 passed | Same full log; these overlap workspace coverage |
| Linux Node contracts and evaluation tools | 131 passed across groups of 5, 15, 15, 20 and 76 | Same full log |
| Linux full native E2E | 24 passed, 6 failed, 11 skipped; 6/7 specs passed | Same full log; this run failed |
| Linux final focused draft-study rerun | 10/10 passed; 1/1 spec passed | `work/draft-study-20260912/linux-draft-agent.log` |

Formatting, workspace Clippy, dependency-license checks, the frontend build and
the Linux E2E executable build passed before the full Linux E2E failure. Ignored
platform/integration tests are not counted as successes. The Node total above
does not include a separate workflow test invocation.

The earlier Windows full run used WebView2 `152.0.4191.66` and executable SHA-256
`dce43e36486f39b1986cadcf8fae21d7bc08f8d7aba49c264627316691d05a22`.
It finished in 14 minutes 53 seconds. Recoverable click-interception diagnostics
are retained in its log; all ten draft-study cases ultimately passed. It preceded
the final source-binding fixes and is not presented as a full-suite test of the
current executable.

The current saved-response runs used E2E executable SHA-256
`b27bd87aab517e43905ce0203e26457bfd82b219002058e67605a991a570571e`.
Their 11 cases comprise ten fixed replay tasks and one restart/preservation check.
The final layout diagnostic confirms the DOM scroll reaches the editor without
moving the sidebar off-screen. Its screenshot was inspected for visible sidebar,
player and editor controls; that visual check does not measure learning usability
or establish human listening. No product CSS change was needed for this diagnostic.

A fresh Windows focused draft-study run against this current executable passed
all ten cases in 97.1 seconds. Its auxiliary wrapper initially reported failure:
the ledger comparison used `deepStrictEqual` between SQLite rows with a null
prototype and ordinary objects parsed from JSON. The retained before/after JSON
files were byte-identical; this was not a changed ledger or a failed E2E case.

The initial `result.json`, log and comparison code remain untouched. The separate
`work/draft-study-20260912/windows-current/fixed-draft-v1/verified-result.json`
records an independent comparison of both retained JSON snapshots and a read-only
current database snapshot. All three have row SHA-256
`719a48e455286e6d5be4186efc07abdd05e3796b13423144c5ff7c2ac01c052b`.
The three offline attempts, three jobs and five requests remained unchanged,
with zero reserves, charges, dispatches or approvals. No application rerun was
needed for that reconciliation. The original wrapper failure is not relabeled
as a successful first-pass wrapper run.

## Linux failure and focused correction

The full Linux run failed in the draft-study spec. Its first failing operation
was finding an edited bookmark after restart; subsequent card-dependent cases
failed because that operation had not completed. The original full log and the
failed focused logs remain available:

- `work/draft-study-20260912/linux-full-verification.log`
- `work/draft-study-20260912/linux-draft-rerun-final.log`
- `work/draft-study-20260912/linux-draft-agent-diagnostic.log`

The diagnostic captured the bookmark's exact DOM text as `Hello, local learner.`
while WebKit's rendered `getText()` returned an empty string. The bookmark was
below the viewport in the panel's own scroll container. The installed WebDriver
helper's wheel scroll did not move that container.

The test harness now identifies the bookmark by DOM text, scrolls the actual
element into view and then uses a normal WebDriver click. It asserts the visible
editor's value after opening the bookmark. Success notifications are dismissed
with normal clicks. It does not bypass clicks through JavaScript, retry card
mutations blindly or change the application to make the test pass.

The corrected focused run used a fresh container-only profile,
`/workspaces/surtitle/work/e2e-draft-rerun.E68BzOsu`, and passed all ten cases in
9.4 seconds. The application was not rebuilt for this harness correction. A full
Linux suite was not rerun afterward, so the successful focused result does not
replace the failed full-run result.

## What the local checks exercise

The fixed native suite starts with an unresolved whole transcript and checks
that a learner can retain a cue, edit a local selection, reject stale versions,
confirm only that excerpt and save a manual card with audio extracted by the
selected PATH FFmpeg. It checks restart persistence, immutable saved card text
and audio, review scheduling, unchecked source-block bookmarks and card survival
after removing the originating bookmark. Some operations use the UI and others
use ordinary typed IPC; these are not ten manually performed learning tasks.

The fixture is an eight-second digital-silence WAV. Exact PCM extraction and
native playback state are transport evidence, not evidence of audible speech.
Windows uses real libmpv; the Linux test build uses its supported player fixture.
No audible-speaker or hardware-decoding qualification is claimed here.

The tests compare original response/evidence hashes, canonical subtitles and
ledger state before and after local work. The Windows ledger receipt records
four settled offline fixture attempts with zero reserved or charged microUSD,
zero dispatched attempts, zero approved jobs and all spending limits at zero:
`work/draft-study-20260912/windows/ledger-result.json`.

The saved-response replay uses the previously acquired six provider responses;
both receipts record zero provider and authorization requests. The frozen task
manifest SHA-256 is
`33f9bfdfa7c4634198147c35faa671157faf92e2f04de02715d78bbeea024289`.
Observations in
`work/surtitle-e2e-saved-study-20260912-v2/study-observations.json` retain
`humanListening: null`, `effort: null` and `acceptancePending: true`.

Core tests cover bookmark export/restore detachment of job identity, operational
source snapshots and confirmation authority. The separate transcript native spec
covers the existing ZIP/restore workflow. The ten-case draft-study spec does not
itself perform a full backup restore.

## Container isolation

The shared-source container preflight recorded bidirectional source visibility,
zero host-output writes and zero named volumes. It checked masks for
`node_modules`, `target`, `dist`, `work`, `artifacts`, `test-results`,
`playwright-report`, `src-tauri/gen`, `src-tauri/resources/native` and
`src-tauri/resources/notices`. The record is the first line of
`work/draft-study-20260912/linux-verification-complete.log`.

The full run stopped on its E2E failure; this record does not assert a subsequent
full-run isolation postcheck. The final focused rerun reused the existing
container and allocated a fresh profile within its output mask. Only the selected
92,019-byte `/opt/surtitle-build/verification.log` was exported as
`work/draft-study-20260912/linux-full-verification.log`; no container dependencies
or build trees were exported.

## Normal build and installer identity

The final package receipt is
`work/draft-study-20260912/final-package/installer-result.json`. The associated
native and extracted-installer audits passed, including all 60 bundled resources.
The optimized normal executable and normal debug executable were rebuilt, and
the production dependency-graph check excluded development validation and E2E
fixtures. These are distinct binaries from the E2E candidates above.

| Artifact | SHA-256 |
| --- | --- |
| NSIS installer, 26,523,038 bytes | `b4416d4445eee09a7e250d61be7b6ed2aa26e3c335d7de635b2b95c636da0e8c` |
| Optimized original executable | `30af099a988368aaa520cb07f2a54d2eec7c0374921bd5620af190911003e689` |
| Executable embedded in NSIS | `cf5379597502ab9d56aff0199dba678ab211c5fe7f07ec2616cc59aca37a617d` |
| Normal debug executable | `9e6476a5b464e74aaaac3b44498d778252f0eda1563e494835ffc3c848c75953` |

The installer audit proves the embedded executable differs only by Tauri's three
bundle-marker bytes, `UNK` to `NSS`; the remaining bytes are identical. The native
payload and source inventory remained unchanged. See the retained
`installer-audit.json`, `native-audit.json`, `installer-build.log` and
`production-features-after.log` in the same evidence directory.

The installer was extracted and audited, not installed. No install/overwrite/
uninstall lifecycle, hosted same-commit CI, ordinary-profile launch or release
publication is claimed by this package receipt. The local audit's
`releaseEligible` field is a technical payload result, not release authorization.
The remaining distribution conditions are described in [native runtime packaging](native-runtime.md).

## Unchanged quality limits

No new cloud request was sent for this local implementation or its tests. The
historical [English-dialogue pilot results](transcribe-en-dialogue-2026-09-12.md)
remain unchanged: provisional full-selection WER was 22.41% for the current
profile and 18.46% for the short candidate; matched-subset endpoint p95 was
570/600 ms. A useful local excerpt workflow does not turn those measurements into
a passed full-transcript, word-synchronization or contextual-listening gate.
Independent language/genre references and human listening/edit-effort evaluation
remain separate work. Execution details for reproducible local tests are in the
[E2E guide](../e2e/README.md).
