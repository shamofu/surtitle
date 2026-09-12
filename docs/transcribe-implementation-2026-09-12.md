# Transcribe recovery implementation and validation readiness

Date: 2026-09-12. Development remains on uncommitted `main`. No paid request,
commit, push, tag, publication, or installation was performed for this work.

The later [completion follow-up](completion-followup-2026-09-12.md) records
reference preparation, portable-learning E2E, the restore-snapshot correction and
the rebuilt installer. The observations below retain this earlier run's scope.

## Implemented behavior

The application can recover a missing or invalid transcription range locally.
Its editor provides original-response inspection, source audio playback, cue
addition/removal, text/time editing, and explicit confirmation of no speech.
Copying text from a structurally unambiguous provider response leaves timing
fields empty; it does not interpolate invalid word times. An empty editor alone
does not establish silence. Even a structurally valid empty provider result needs
an explicit local no-speech confirmation for that range before adoption.

Immutable manual revisions and the selected source are stored separately from
provider responses, word timestamps, requests, approvals and reservations. Native
commands bind edits to the job, original source, prepared input, request range and
current edit version. Stale writes fail. A late response does not replace a
selected manual revision. Neighboring boundaries and warnings are rebuilt; only
still-identical review decisions survive. Selection and revisions persist after
restart and are excluded from portable learning restore.

An active job must be paused and its outgoing request must finish before editing.
Unknown outcomes retain their full reservations while local recovery remains
available. Saving or selecting a revision performs no generation, retry or cost
settlement. Complete-preview adoption requires valid effective ranges or explicit
no-speech decisions and all necessary reviews. It freezes that job against further
sending and preserves previously saved cards.

Vocabulary and explanations are labeled experimental. Model discovery and arbitrary
model IDs remain available; there is no application catalog or automatic fallback.
The provider's `gemini-3.5-transcribe-preview` remains Preview. The new
[`surtitle-transcribe-review-assisted-v1` policy](transcribe-production.md) keeps
the 90% automatic-join figure as an improvement target without rewriting previous
quality results.

## Local verification

| Check | Evidence from this work |
| --- | --- |
| Frontend | 83 tests passed; production UI build passed |
| Linux Rust workspace | Native 44, AI 177, validation CLI 18, core 31, tools 19 tests passed; platform/external-resource tests retain their explicit ignored status |
| Additional Rust checks | AI without development features: 150 passed; both installed-FFmpeg sample-clock/tail tests passed; preparation example: 4 passed, including malformed RIFF rejection and exact padded-chunk slicing |
| Empty-result adoption | Eleven native transcript-command tests passed after adding the explicit no-speech gate; provider results and ledger rows remain unchanged |
| Static and distribution checks | Format, Clippy, Rust/JavaScript license checks, production-feature exclusion and reviewed native-input checks passed |
| Offline AI evaluation | 62 tests passed, including 22 review-assisted policy tests; historical evaluation code remains unchanged |
| Real Linux Tauri | Final full run: 19 passing cases across six specs; eleven Windows-only cases skipped. Includes manual range recovery, stale-write rejection, restart persistence, adoption, PATH FFmpeg audio card, FSRS review and unchanged ledger |
| Real Windows Tauri | Final fresh run: all 29 executed cases passed across six specs in 11 min 33 s, including all eight transcript cases and actual libmpv source-interval playback. The optional AV1 fixture was skipped |
| Windows native unit/integration | Eleven transcript-command tests and both installed-FFmpeg regressions passed; application and tool hashes remained unchanged |
| Container isolation | Shared source verified in both directions; ten temporary output masks; zero host output writes and zero named/anonymous volumes |

Complete Linux logs and mount reports are retained under
`artifacts/transcribe-production-20260912/linux/`. These are selected reports and
a UI screenshot, not exported dependencies or build trees. Native test
and Windows build evidence is recorded separately below. Existing
lower-level ZIP/restore tests do not establish native file-dialog automation.
The final CI filter now explicitly executes both installed-FFmpeg regressions;
its 20 contract/isolation checks and the two selected real FFmpeg tests passed.
Only the two reviewed verifier/workflow hash entries were refreshed after
reviewing those test-selection changes; native recipe and payload entries stayed
unchanged.

The first extended learning-chain run exposed two harness assumptions. Linux's
mock player reports a six-hour duration for an eight-second WAV, so a contextual
range past the real EOF was correctly rejected. The repaired test cue now ends
well before the physical EOF and still verifies the exact PCM sample count.
Windows failed with a script timeout after session recreation; the readiness
helper now reapplies the explicit 180-second limit on every restart. The failed logs are
retained. The extraction validator was not relaxed and no silence padding was
introduced.

## Normal Windows builds

Both ordinary `custom-protocol` builds succeeded. The optimized application is
`target/release/surtitle.exe` (SHA-256
`3e1343e237c9e66a160e07d5ecdda091af36c72ba4636e3e1fa387d56db05dbe`).
The normal debug executable is `target/debug/surtitle.exe` (SHA-256
`29c68bfb5eb6d17703a05b7d3150561547831dd9293e869d545071529ead7e8a`).
The production dependency graph excludes development validation permissions and
fixed E2E fixtures. Native payloads remain unchanged.

The build result and isolated executable copies are retained in
`work/transcribe-production-20260912/windows-verification-20260912-final/`.
The normal application was not launched into the user's configured profile during
this work. A disposable Windows known-folder profile was unavailable, so the
production probe guard was retained. An optimized build is not evidence of a
production-profile launch, installer lifecycle, real speaker output or completed
model qualification. Native WebDriver results use the separate fixture-enabled
executable and disposable data directory.
The existing NSIS artifact under `target/release/bundle/` predates these changes
and was not rebuilt for this work.

The final Windows E2E executable SHA-256 is
`02849c9c9305ebfd327ec3c796c3fc87f337fdd06596be07b7f9298b27e4b841`.
`run-summary.json` and `manual-chain-result.json` in that verification directory
record successful source replay, a retained 7,050–7,750 ms PCM card clip with
11,200 samples, a persisted FSRS rating, and unchanged zero-cost fixture records.
The earlier 28-pass/one-failure run remains in its separate directory. Both native
test application and driver processes exited after verification. No result here
counts synthetic silence or silent audio output as a heard speech segment.
The Windows unit receipts are in
`work/transcribe-production-20260912/windows-native-unit/result.json`.

## Exact local pilot preparation

The local Rust helper ran the production Silero VAD and chunk planner on all four
pilot selections, using the reviewed Windows CPU ONNX Runtime and Silero model.
Both profiles preserve the same continuous source samples with up to three seconds
of context on either side. The final remainder behavior is unchanged.

| Profile | Requests | Submitted duration including overlap |
| --- | --- | --- |
| Current: 90/120/150/180 seconds | 8 | 984 seconds (16 min 24 s) |
| Short: 45/60/75/90 seconds | 16 | 1,032 seconds (17 min 12 s) |
| Paired pilot total | 24 | 2,016 seconds (33 min 36 s), 32,256,000 PCM samples |

There are fourteen distinct source-clock cuts in this pilot. They do not count
toward the twenty-boundary independent confirmation requirement. Every generated
request hash and its exact source PCM slice passed offline verification.

The frozen execution settings are `gemini-3.5-transcribe-preview`, `global`,
verbatim mode, word timestamps, one candidate, no diarization, omitted thinking,
and 8,192 output tokens per request. These are proposed evaluation settings, not
an approval to submit. The exact receipt and blocked preparation report are in
`work/transcribe-production-20260912/pilot-preparations/` and
`work/transcribe-production-20260912/pilot-validation-preparation.json`.

## Materials and missing references

Eight continuous recordings were acquired and their licenses, attribution,
conversion arguments, hashes and exact sample slices retained. The four pilot
selections total sixteen minutes; independent confirmation selections total
thirty-two minutes. The recordings are different across stages.

| Condition | Four-minute pilot | Separate eight-minute confirmation |
| --- | --- | --- |
| English dialogue | AMI ES2002a | AMI ES2004a |
| English lecture | Frank Schulenburg, Wiki Academy 2011 | Yochai Benkler, Wikimania 2011 |
| Japanese lecture | DBCLS/TogoTV, 2010-05-25 | DBCLS/TogoTV, 2013-01-31 |
| Japanese dialogue | Amagasaki radio, 2011-04-20 | Amagasaki radio, 2015-08-27 |

Three recordings have upstream manual references; five lack verbatim references.
None has been independently checked against these selected audio ranges. Language,
genre and speaker descriptions currently follow publisher metadata. This is not
new listening evidence. AMI supplies original word annotations; the required
independent Japanese word-timing reference is incomplete.

`source-materials/source-manifest-independent.json` is the separate-recording
manifest. Its SHA-256 is
`601cf815842624d2bc57ee70eacd884cd219433203a7e517590f71b011313107`.
Its neighboring README retains item-level credits and license links. An optional
J-WAVE recording is excluded; its original rightsholder specifies CC BY-SA 3.0,
which must not be replaced by the less restrictive collection header.

## Work still required for quality qualification

1. Independently establish verbatim references and acoustic timing before viewing
   Transcribe outputs. Preserve negation, numbers, corrections and repetitions.
   Current preparation correctly reports `readyForQuotePreparation: false`.
2. Produce exact immutable priced jobs from the verified inputs, review current
   prices and cumulative reservations, and obtain approval of the concrete scope.
   No new quote, key access or provider submission occurred in this work.
3. Run the paired comparison, select the profile using both recognition error and
   repair-required audio duration, then freeze the independent stage. Do not
   select a profile solely from its request count or submission duration.
4. Run independent confirmation, predefined repeats and supplemental boundaries;
   report difficult conditions separately. No new WER, CER, timestamp error or
   repair-required percentage is available yet.
5. Freeze and assess 100 real-player speech ranges. Synthetic fixtures and silent
   audio output do not count as listening. Native learning export/restore dialogs
   and the disposable Windows installer lifecycle remain separate acceptance work.

Existing cumulative charged/held accounting remains USD 1.272194, including the
retained USD 0.044729 HTTP 429 hold from the prior diagnosis. This work added
USD 0. The remaining numerical headroom under USD 10 is not a new authorization.
Historical results are preserved in [status](status.md) and the
[September 12 diagnosis](ai-diagnosis-2026-09-12.md).

For the normal application workflow, credential import, exact model settings,
local preparation, explicit paid approval and local correction, use the
[credential-based verification guide](vertex-verification.md#application-workflow).
