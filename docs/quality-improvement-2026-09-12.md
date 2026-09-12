# Subtitle and explanation quality improvement

The local product changes and bounded Whisper experiment are implemented. They
do not establish that the cloud subtitle or explanation quality gates now pass.
Historical provider outputs, failed scores, cost records, and unknown holds remain
the baseline. No new cloud request is authorized by preparing this work.

## Implemented behavior

- Production transcript responses retain bounded, allowlisted evidence before
  settlement, bound to the attempt, immutable audio, frozen request, task, model,
  and parser revision. Review distinguishes missing, invalid, valid empty, and
  valid subtitle results. One response can be inspected as plain text through
  a separate detail request. See [transcript evidence](transcript-evidence.md).
- Explicit local reparsing creates a separate candidate without regenerating
  audio, contacting a provider, changing the original attempt, or settling its
  cost. Selecting a candidate for the preview and adopting subtitles are separate
  actions. Incomplete evidence, invalid output, stale bindings, and unresolved
  settlement prevent selection. Persistence and settlement fault tests preserve
  the reservation and prohibit an automatic retry.
- Source playback, interval repetition, and newly saved card audio use configurable
  context on each side: 150 ms by default, from 0 to 1,000 ms. The actual extracted
  card-audio interval is stored separately. Subtitle/source timestamps and existing
  card audio are preserved; this playback aid is not scored as better alignment.
- Explanation prompts focus A2 on concrete meaning and usable patterns, B1/B2 on
  construction and contextual use, and C1/C2 on useful nuance and usage limits.
  They no longer require a synonym contrast merely to demonstrate proficiency.
  Unsupported motives, causes, agency, necessity, and subsequent events are
  prohibited. Vocabulary instructions preserve the same lexeme and semantic roles
  without embedding the old evaluation answers as examples. Already frozen
  requests retain their original bodies.
- Development-only untimed Transcribe diagnostics use `wordTimestamp=false` and
  return an `UntimedTranscript`, never timed cues. They require a development
  execution scope even when Cargo features are unified. Malformed transcription
  structures and completion flags are rejected; ordinary subtitle adoption does
  not accept this output type.

## Local Whisper result

The complete faster-whisper recognition and word-timestamp path was evaluated
with the existing multilingual base model on 51 CPU windows, each at most
30 seconds. Recognition received audio and language without reference text or
the provider transcript. Exact full-text matching was performed afterward.

The experiment **failed acceptance**: proposal coverage was 59.5% for English
and 28.6% for Japanese, below 80%; English timing p95 was 555 ms, above 400 ms;
both digital-silence controls produced invented words. Only four Japanese
reference endpoints could be scored, so their timing cannot support a broader
claim. The model is not integrated as an automatic repair. See the
[experiment report](whisper-quality-2026-09-12.md) for immutable evidence hashes,
excluded endpoints, performance, provenance, licenses, and test settings.

All acquired packages, models, and generated audio stayed in the existing
container's private filesystem. Only selected authored scripts and evidence
records were exported. There were no recognition reruns or cloud calls during
this experiment.

## Evaluation stages and approval

The first diagnostic stage contains at most 20 requests: six explanation cases,
six audio conditions through each of Transcribe and Flash 3.8, and two untimed
Transcribe controls. The audio manifest contains four existing speech clips,
digital silence, and deterministic non-speech tones. Its proposed fourteen audio
requests total 112.125 seconds including duplication. All clips are shorter than
24 seconds; their whole-file request ranges require no added context.

Actual sending requires a fresh, digest-bound campaign quote and explicit approval
of its exact models, input hashes, request count, audio duration, reservation, and
expiry. The quote alone authorizes nothing. A campaign appends scope in the same
validation database and never resets its legacy 120-request pool or cumulative
money limit. The historical recorded USD 1.195718, including its unknown hold,
continues to count against USD 10. These values describe application accounting,
not a Google invoice.

Approval, reservation, and dispatch reject an evaluation database opened through
an ordinary `AiStore`, including builds without the development feature. Campaign
membership and limits are rechecked at each paid boundary. A diagnostic task also
cannot use a fresh ordinary database to avoid its development scope.

After diagnosis and any justified local changes, the planned independent stages
are 60 explanation requests on previously unused expressions and 80 audio
requests covering 20 previously unused boundaries through both models. Each stage
requires its own prepared inputs, estimates, and approval. Failure does not trigger
an automatic rerun, a different model, or lowered acceptance thresholds.

The historical [text review](ai-quality-2026-09-09.md),
[audio review](ai-audio-quality-2026-09-09.md), and
[boundary review](ai-boundary-quality-2026-09-09.md) retain their original failures.
The [subsequent diagnostic run](ai-diagnosis-2026-09-12.md) measures the revised
prompts on the prepared development cases; independent final evaluation remains
outstanding. Automatic aligner references
and AI grading remain identified as such and do not substitute for human listening.

The first twenty immutable jobs have been prepared without sending. Their added
reservation ceiling is USD 0.966557; the cumulative prior amount plus that ceiling
is USD 2.162275. The private scope review is
`work/quality-diagnostics-20260912/review.md`. A separate source-extraction audit
checks all twenty task/reference bindings and the duplicated 112.125 seconds of
audio. That quote was initially unapproved. The user subsequently authorized this
stage, and separately acknowledged its HTTP 429 hold before the fourteen unsent
audio jobs continued. All twenty jobs were attempted once; the
[diagnostic report](ai-diagnosis-2026-09-12.md) records the results and remaining
failures. No later stage was included.

Current reviewer guidance is
`crates/ai/tests/fixtures/evaluation/semantic-review-v2.json`. The earlier guidance
and historical judgments remain unchanged. A separate AI reviewer assessed all
fourteen authored calibration candidates: seven usable, three requiring correction,
and four with critical errors. Each dimension has a specific rationale, with
accessibility judged separately from advanced depth. The private calibration record
has SHA-256 `9839c3bb50efbb19bd5dd92956a4b2820200c5ec6b0ccd0d963e546fc6518802`.
This is an explicit review of a deliberately constructed set, not blinded
inter-rater calibration, measured reviewer sensitivity, or human comprehension.

## Verification and development constraints

The native replay regression exposed an independent card-audio defect: a requested
3.000–3.750 second AAC clip contained 11,930 samples instead of 12,000, and a naive
sample-count trim would have kept an eight-millisecond start displacement. Card
extraction now seeks to less than three seconds before the requested start, anchors
resampling on a source-clock integer second, and trims the resampled timestamps
before resetting the output clock. Zero-start extraction preserves decoder priming.
The implementation uses FFmpeg's documented
[timestamp-preserving input options](https://ffmpeg.org/ffmpeg.html) and
[audio timestamp trimming](https://ffmpeg.org/ffmpeg-filters.html#atrim).

Only complete mono 16 kHz PCM16 WAVs with the expected sample count are published;
failed processes and incomplete outputs leave no card-audio file. Local integration
tests compare nonperiodic source waveforms for PCM, AAC, and MP3 at 44.1 and 48 kHz,
including beginning/end clips, delayed audio, a six-hour timeline position, and a
nonzero container origin. Compressed-decoder noise after seeking is distinguished
from sample displacement. These tests qualify the tested stable timelines; the WAV
length check alone does not certify arbitrary timestamp gaps or resets that cancel
each other out. The application does not pad missing output or alter its stored range.

Focused offline checks cover evidence filtering and bounds, reversed timestamps,
malformed JSON, immutable bindings, concurrent local reparsing, persistence and
settlement failures, native review/adoption, escaped renderer content, and
feature-enabled/disabled scope enforcement.

The integrated Linux run passed 173 AI tests, 18 validation-CLI tests, 28 common-core
tests, 19 tool tests, 79 UI tests, and 40 evaluation-script tests. The separate
feature-disabled AI run passed 146 tests. Type checking, the UI production build,
formatting, and workspace Clippy with warnings denied passed. Real Tauri E2E under
Xvfb passed 17 cases across six specifications; eleven Windows-only or optional
cases were skipped. These integrated results precede the card-audio correction.
After that correction, the focused Linux native suite passed 39 tests, formatting
and native Clippy passed, and the explicit real-FFmpeg source-clock integration
passed. The integration remains ignored in the ordinary unit-test invocation and
is invoked explicitly by the Dev Container verification script and Windows CI.

On Windows, the feature-disabled AI suite passed 147 tests. The explicit source-clock
integration passed all 36 real extraction comparisons in 194.14 seconds using the
locally selected FFmpeg. No copy of that external binary is included in distribution
or exported from the container. Full logs and hashes are retained under
`artifacts/quality-integrated-linux-20260912/` and
`work/quality-implementation-20260912/`.

Windows WebView2/libmpv checks passed all three replay-context cases on a fresh
profile after the input-helper correction. The same corrected application passed
all five media-management cases, including existing-card retention and real audio
extraction. The four unaffected specifications retain their earlier passing evidence
for nineteen cases. Thus all 27 mandatory native cases have passing evidence across
these runs; the optional AV1 case was skipped. This is not a single rerun of the
entire suite after the final audio change. The corrected executable has SHA-256
`d1e3b3211e9c688548629a4c8e59a9de6b3482d4558c6685f8140720633689bc`.
The ordinary application executable and symbols were restored to their original
hashes after building the disposable test candidate.

Earlier failed checks remain in those records: the transcript E2E selector initially
matched the added evidence panel; the first WebdriverIO selector correction used an
incompatible chainable-array operation; the native card test exposed the PCM defect;
and a numeric-input helper appended to the existing value instead of clearing it.
The UI correctly rejected that out-of-range value. The input helper now uses actual
selection/deletion keys and verifies the field contents before saving.

The final offline implementation snapshot retained all 119 historical attempts byte-for-byte
under SHA-256 `3452305411f79936999cfe8e70c1fc49bb2e122276af9c653f6507f08d19817c`;
the twenty-request campaign was still unapproved at that snapshot. Its evidence index is
`work/quality-implementation-20260912/verification-final.json`. Container isolation
also passed after verification: bidirectional source sharing, all ten dependency
and output masks, zero host output writes, and zero named volumes. GitHub-hosted
CI and a new release package have not been run for this uncommitted source state.

Development remains on uncommitted `main`. Source is shared with the container;
container dependencies and build products are private, with no named or anonymous
volumes. No release, publication, credential export, or cloud-quality completion
claim follows from these local changes.
