# Completion follow-up, 12 September 2026

This record continues the [Transcribe implementation](transcribe-implementation-2026-09-12.md).
Development remains on uncommitted `main`. Local builds are not a published release
or a completed speech-quality qualification.

The quoted English partial pilot was subsequently authorized and executed. Its
[separate result report](transcribe-en-dialogue-2026-09-12.md) records six settled
requests, USD 0.040962 of new calculated usage and the remaining quality gaps.
The unapproved quote below is preserved as the scope originally presented.

## Reference preparation

The offline verifier now checks original AMI XML, retained JSON extraction, source
identity and every prepared request sample. Established upstream human annotation
is distinguished from new acoustic review. Complete independent text can be used
without inventing a fresh listening event; numeric timing and playback requirements
are unchanged.

Three annotated recordings produced twelve original-pilot drafts with 959 complete
English word anchors and 166 Japanese utterance anchors, including duplicated
context across profiles. The original four-minute AMI selection cuts three words
at its outer endpoints. Japanese text-level ambiguity and absent word timings
remain explicit. See [the reference report](transcribe-references.md).

A separate AMI candidate covers 62.72–302.72 seconds. It retains 477 complete
human-annotated words and separates 9.29 seconds of annotated speaker overlap.
The production VAD/planner prepared two current-profile requests (246 seconds) and
four short-profile requests (258 seconds): six requests and 504 seconds including
context. Every sample matches the source; each profile covers every reference
word. Internal context-edge partials are not missing words in the joined selection.
The original frozen inputs and historical reports remain unchanged.

The five missing original references were investigated further. Exact captions for
alternative MIT lectures were found with separate license restrictions; NICT
archive requests returned maintenance HTML. These were not silently substituted.
Details and retained source evidence are in [reference discovery](transcribe-reference-discovery-2026-09-12.md).

## Export and restore

The real native learning test now extends manual transcript recovery through card
audio, review history, ZIP export, restore preview, explicit confirmation, backup,
restored audio and application restart. Only the native file-picker selection is
substituted in the compile-time E2E build. It selects one fixed file in a verified
isolated fixture directory, accepts no webview path and is absent from the normal
application. Operating-system file-dialog interaction remains separate coverage.

Review of that path identified a pre-existing archive replacement race: the JSON
could be parsed from one file version and audio later reopened from another. The
fix creates a bounded owned copy before parsing the preview and uses that same
copy for audio materialization. Original-path changes still invalidate approval.
Preview tokens are single-use, new previews replace old ones, cancellation drops
owned copies, and startup removes only this module's abandoned files after taking
the profile instance lock. A preview that arrives after its UI has unmounted is
also discarded.

The regression replaces a ZIP with one containing the same audio entry names and
different bytes. It verifies restoration uses the reviewed copy. Separate checks
cover changed files, size limits, stale tokens, cancellation, crash leftovers and
unchanged unrelated files. Learning replacement preserves the cost ledger, paid
jobs, credentials and tool selections.

## Installer inspection

The package audit now requires the exact extraction-root inventory, native
manifest resources, three generated application notice files, and every installer
notice required by original source/build evidence. A self-consistent receipt
cannot omit a required notice. Extra executables or models in native resources,
alongside notices or at the extraction root are rejected. The directory placeholder
is restricted to empty content or a newline. Links and nonregular paths are rejected.

Twenty installer/probe regression tests passed during development. The two changed
installer-audit inputs were reviewed and their recorded hashes updated; the
source/recipe/packaging preflight matched. The initial rebuilt installer passed
the sixty-resource inspection, but predates the restore-snapshot fix and is
retained as earlier evidence rather than the final candidate.

The final normal release and unsigned NSIS build completed after the snapshot fix.
The normal dependency graph excludes E2E fixtures and development validation.
The extracted installer passed all sixty resource hashes, the source-backed plugin
and notice checks, and the sole expected Tauri bundle-marker transformation.

| Final local file | SHA-256 |
| --- | --- |
| `target/release/surtitle.exe` | `e4e642b28a9689647cd011de0b472392cacaa1ed0b775660d83da827a45a2c57` |
| `target/debug/surtitle.exe` | `e44f27a9bd7376235001092cc686698414bf23e277cee9376c82057096a9d239` |
| `target/release/bundle/nsis/Surtitle_0.1.0_x64-setup.exe` | `9c6b2ee127f8fc6c3981bc58303f88e8e41b0cc57f2b08ab6db989eb3a3f6e84` |

The installer is 26,312,559 bytes. Its embedded application hash is
`e732313a93ac0571bb444a7b2858cc8a5c2377ba24568c6453347d70ed49ecf6`.
Both earlier and final build/audit records are retained under
`work/transcribe-production-20260912/completion-20260912/`, with the latter in
`final-package/`. Neither installer was executed or published.

## Verification record

The final Linux run passed on the frozen sources:

- 86 UI tests; 296 Rust workspace tests; 150 additional AI feature-disabled tests.
- Both explicit installed-FFmpeg waveform checks, formatting and Clippy.
- 73 AI script tests, three production-feature checks, twenty installer/probe
  tests, and the remaining container/release/native-artifact contract checks.
- Rust and JavaScript license checks and the normal production dependency graph.
- Twenty real Tauri E2E cases across six specs; eleven Windows-only cases skipped.
  All nine transcript/learning/transfer cases passed, including the complete ZIP
  restoration through native IPC and SQLite.
- Post-run source sharing and all ten output masks: zero host output writes and
  no named or anonymous volumes.

Selected final logs, isolation JSON and the restored-learning screenshot are in
`completion-20260912/linux-final/`. No dependency trees, executables or other
container build outputs were exported.

The final Windows run passed thirty native E2E cases across all six specs; the
optional AV1 case was skipped. All nine transcript/learning/transfer cases passed,
including playback of the restored 700 ms card clip through real libmpv. The
isolated fixture ledger retained zero reservations, charges, approved jobs and
dispatched attempts. Its four settled records are fixed offline fixtures.
Six focused Windows restore regressions also passed; a separate opt-in libmpv
unit test was skipped, with restored-audio playback covered by the native E2E run.

Windows results are in `completion-20260912/windows/native-result.json`,
`native-e2e.log`, `ledger-result.json` and `restore-unit-result.json`. The E2E
application SHA-256 is
`42788a2bdec8138df0120600391065827c3077f4ca6e6f7d528e1030bb33e482`.
It was built with `e2e-test` and `custom-protocol`; the separate normal binaries
above exclude fixtures. This run did not test audible speaker output, hardware
decoding, the ordinary production profile or the operating-system file picker.

The first Linux run passed its common checks and nineteen native E2E cases, then
failed the new transfer case because a WebdriverIO element collection was passed
to `Promise.all` without first awaiting it. The harness correction and snapshot
fix were covered by the successful fresh-profile run above. This failure is retained under
`work/transcribe-production-20260912/completion-20260912/linux-initial/`.
A later run exposed an existing UI-test timing assumption: the assertion inspected
loop clearing immediately after disabled controls appeared. The test now awaits
the settled active loop and the clearing command; `Study.tsx` was not changed.
That failure remains in `linux-ui-race.log`; the full final run above passed.

No installer has been executed in the user's ordinary Windows profile. The
disposable installer lifecycle, real speaker listening, independent four-condition
model comparison and one hundred speech-playback observations remain distinct
acceptance work. Containers share repository source only; dependencies and build
outputs remain in their writable layer or temporary masks, without volumes.

## Unapproved partial-pilot quote

A separate, current-source validation CLI prepared six immutable jobs for the
reference-complete English dialogue candidate. It did not approve or dispatch
them. The trusted Rust credential vault only bound configured metadata locally;
no credential contents were printed or copied, and no OAuth/provider request ran.
The initial restricted-token attempt could not unlock that metadata and created
no job; its failure receipt was preserved before the authorized local continuation.

| Profile | Requests | Audio including context | Proposed reservation |
| --- | --- | --- | --- |
| Current 120-second target | 2 | 246 seconds | USD 0.230298 |
| Short 60-second target | 4 | 258 seconds | USD 0.445152 |
| Partial pilot total | 6 | 504 seconds | USD 0.675450 |

Settings are `gemini-3.5-transcribe-preview`, global, verbatim mode, word timestamps,
omitted thinking and 8,192 output tokens per request. Google's public rates were
checked on 12 September: USD 2 per million audio-input tokens and USD 12 per million
text-output tokens. [Official pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)

Existing cumulative charges and holds remain USD 1.272194, including the unchanged
USD 0.044729 HTTP 429 hold and all 139 historical attempts. Adding the proposed
reservation would total USD 1.947644 under the cumulative USD 10 limit. There are
no new attempts or execution approvals. The campaign proposal expires at 21:17 JST
on 13 September 2026. Individual job review windows expire at 22:47 JST on
12 September and must be refreshed if execution starts later, preserving the same
input, request settings and campaign scope. Exact quote, source, waveform and CLI hashes are retained in
`work/transcribe-production-20260912/candidate-unapproved-quote-v1/review.md` and
its neighboring immutable JSON files.

An independent read-only review matched all six immutable audio snapshots to
their exact source samples, recomputed the request and campaign digests, and
verified all historical ledger rows and the unchanged hold. It found no scope,
authorization or accounting mismatch; it did not grant execution approval.

This is one English dialogue cell of the pilot, not the four-condition comparison
or independent confirmation. No profile is recommended yet. Explicit approval of
this scope is still required before sending; failures must stop without automatic
retry, and unknown reservations remain held.
