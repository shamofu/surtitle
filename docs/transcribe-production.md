# Transcribe validation for a review-assisted workflow

Policy: `surtitle-transcribe-review-assisted-v1`.

This policy evaluates the explicitly selected timed Transcribe configuration. It
does not create a model catalog, change the historical evaluation policy, authorize
Vertex requests, or qualify a model automatically. The initial product permits
local correction of uncertain ranges. Automatic joining of 90% of boundaries is
an improvement target; preservation and explicit review remain requirements.

## Bounded campaign

| Stage | Source selections | Chunk profiles |
| --- | --- | --- |
| Pilot | EN/JA × lecture/dialogue; four continuous four-minute recordings | Both profiles on identical source sample ranges |
| Confirmation | The same four conditions; four unused continuous eight-minute ranges | One profile selected after the pilot and frozen before confirmation |
| Supplemental confirmation stress | At most twelve predeclared adjacent pairs from unused natural audio, if needed to reach twenty distinct confirmation boundaries | Explicit profile, cut, and stress reason; short stress cores may be below the normal minimum |
| Fixed confirmation repeats | One already selected request per language, declared before outputs | Same immutable bytes and execution settings; a repeat is an additional paid request |

| Profile | Minimum / target / search end / hard maximum | Context |
| --- | --- | --- |
| `current120` | 90 / 120 / 150 / 180 seconds | Up to three seconds on each side |
| `short60` | 45 / 60 / 75 / 90 seconds | Up to three seconds on each side |

Both profiles use the existing Silero VAD and Rust `plan_chunks` implementation.
No audio is removed or compacted. A remainder fitting the hard maximum becomes a
single final chunk, so target-duration division does not determine request counts.
Freeze actual source and send sample ranges before estimating. Count a boundary
by decoded source hash and source-clock cut sample; changing profiles, repeating a
request, or relabeling the same location does not create independent coverage.
Pilot boundaries do not fill a deficit in held-out confirmation coverage.

The pilot reports comparison completeness separately from confirmation coverage.
Recommend `short60` only when all paired clear-speech recognition observations and
independent references are complete, recognition is no worse in each of English
and Japanese, and the unioned source-audio duration requiring correction is
strictly lower. Equal correction duration, a regression in either language, or
more correction audio keeps `current120`. Missing observations or unmatched source
coverage leave the recommendation undecided. The recommendation changes no
application setting. Twenty distinct boundaries and 100 playback observations are
confirmation requirements, not prerequisites for comparing the pilot profiles.
Pilot evaluation gates require a complete profile comparison; both stages require
complete correction-duration measurements. Accurate partial observations cannot
produce an evaluation-gates-passed report.

Select stress conditions before inspecting outputs: strong/weak pauses, a cut
through ongoing speech, repetition across a cut, and fractional-millisecond tails.
Do not add favorable cases after failures. BGM and simultaneous speakers have
separate condition labels and reports; their measurements do not silently become
clear lecture/dialogue measurements.

Confirmation requires different recordings; use different speakers where available.
Disjoint ranges from the same recording are a temporal holdout and do not satisfy
the confirmation contract. Never replace
natural conversation with concatenated read speech while retaining the natural
speech label. The selected source must have documented evaluation rights and
preserved attribution; acquiring a file does not establish a verbatim reference.

## Preparation and immutable inputs

`crates/ai/examples/transcribe_prepare.rs` is a local helper for the production VAD
and chunk planner. Its input uses absolute paths and contains:

```json
{
  "sourceId": "source-id",
  "audioPath": "ABSOLUTE_MONO_PCM16_WAV",
  "audioSha256": "ACTUAL_WAV_SHA256",
  "assets": {
    "runtime_path": "ABSOLUTE_ONNX_RUNTIME",
    "runtime_sha256": "ACTUAL_RUNTIME_SHA256",
    "model_path": "ABSOLUTE_SILERO_MODEL",
    "model_sha256": "ACTUAL_MODEL_SHA256"
  },
  "startSample": 0,
  "endSample": 3840000,
  "profiles": ["current120", "short60"]
}
```

Run it in the isolated development container with an unused output directory under
`/opt/surtitle-build`. It verifies the source before and after preparation, uses
the original 16 kHz sample clock, and writes exact PCM slices and a receipt. Models,
runtime dependencies and generated container outputs stay in the container's
writable layer. Export selected scripts, JSON and reports, not dependency or build
trees. No credential or cost ledger is needed by this helper.

Combine those receipts into a stage preparation manifest with these fields:

- `schemaVersion: 1`, `policyId`, `stage: "pilot" | "confirmation"`,
  `plannerCodeSha256`, and the exact `execution` model, `global` location, output
  token limit, omitted thinking, and reviewed price snapshot.
- `adapter: "transcribe"`, `mode: "VERBATIM"`, `wordTimestamp: true`,
  `candidateCount: 1`, and `diarization: false`. Keep output limits constant across
  the paired profiles; a cost target is not a reason to introduce truncation.
- `sources`: `id`, decoded WAV `path` and `sha256`, `sampleRate: 16000`, `samples`, `language`,
  `genre`, `naturalSpeech: true`, `sourceUrl`, `license`, `provenance`, and
  `recordingId`. Keep original encoded-file and decoded-PCM hashes separately when
  applicable. Retain known speaker IDs.
- `source.reference`, when available: `path`, `sha256`, `method`,
  `independentOfProviderOutput`, `verifiedAgainstAudio`, `reviewer`, `reviewedAt`.
  Methods are `upstream-transcript`, `automatic-alignment`, or
  `independent-audio-review`. Established human corpus annotations can become
  usable independent references through attributable source, annotation and cut
  verification, without claiming a new listening review. The explicit provenance
  and readiness dimensions are described in [reference preparation](transcribe-references.md).
  `verifiedAgainstAudio` still denotes separately recorded acoustic review, not
  copying a transcript or checking file hashes. Missing references remain missing.
- `selections`: the helper's `id`, `sourceId`, `profileId`, `startSample`,
  `endSample`, `options`, and `chunks`; add `purpose: "primary"` or
  `"supplemental-boundary"`. Supplemental pairs also need `stressReason`.
  Each chunk retains `id`, `index`, core/send sample bounds, boundary kind,
  `audioPath`, and `audioSha256`. The exact serialized Rust options are checked.
- Confirmation additionally includes `selectedProfileId`, `pilotManifestSha256`,
  `pilotRanges` with recording IDs, source hashes and sample bounds, and two `repeatRequestIds`,
  one per language. Pilot has no repeats.

```sh
node scripts/ai-tests/transcribe-production.mjs prepare \
  --manifest PLAN.json --output VERIFIED-PREPARATION.json
```

The offline command checks exact core coverage, bounded context, profile options,
request WAV hashes/format/sample counts, source WAV hashes, every request's exact
PCM slice against the declared source-clock range, and reference-file hashes.
Large source hashing and slice checks use bounded buffers. Relative paths
resolve against the plan file. It reports actual request counts, repeated samples,
duplicate-inclusive duration, unique cuts, recording independence and missing evidence.
Unmeasured audio, unreviewed references, or fewer than twenty confirmation
boundaries cannot produce `readyForQuotePreparation: true`. A malformed or changed
file fails before an output is published. Existing output files are never replaced.

The report does not compute a substitute monetary quote. Create immutable priced
jobs through the existing native validation CLI, then review its exact campaign
quote and obtain approval of that concrete scope. Historical charges and unresolved
holds remain in the same ledger and the cumulative ceiling remains USD 10.
Hypothetical stage budgets do not override exact quotes. A prepared or quoted job
is not permission to send it; failed requests and fixed repeats stay distinct.

## Reference and result review

Keep source references independent of Transcribe output, including fillers,
self-corrections, numbers, negation and genuine repetitions. Edited lecture/radio
transcripts need adjudication against audio before verbatim scoring. Upstream
automatic alignments remain timing estimates; do not call them human annotation.
Japanese utterance endpoints cannot substitute for independent Japanese word
anchors. An absent reference or unperformed review remains incomplete.

Use the existing schema-v2 `evaluationPlan` to freeze every expected request and
its exact execution settings. One execution configuration is allowed per stage.
Keep the ordinary reference cases, provider report and hash-bound review rubric.
Add `transcribeProduction` to the reference manifest:

- `policyId`, `stage`, and `caseBindings`: every case's `sourceId`, source WAV
  `sourceSha256`, language, genre, profile, condition and independently reviewed
  `reference` metadata. Conditions are `clear`, `bgm`, `overlapping-speech`,
  `silence`, or `non-speech`; controls may use genre `control`.
- Each clear-speech binding additionally needs `sourceRange`: `sampleRate: 16000`,
  `coreStartSample`, `coreEndSample`, `requestStartSample`, `requestEndSample`,
  `verifiedAgainstSource: true`, and `verificationSha256` identifying the independent
  source-to-request PCM verification. Freeze this metadata before results. The
  request interval must match the reference audio duration; the core supplies
  source coverage without counting repeated context twice. Missing source-clock
  verification leaves correction-duration measurements incomplete.
- `boundaries`: frozen IDs, source hashes and cut samples, profile IDs, and
  `leftCaseId`/`rightCaseId` pointing to the original provider cases.
- `boundaryComparisons`: cell/profile, independent `boundaryReference` and
  `interiorReference` text, and permitted `boundaryCaseIds`/`interiorCaseIds`.
- `playbackRanges`: exactly 100 distinct source ranges, 25 per language/genre
  cell, with 50 boundary and 50 interior ranges overall for confirmation. Record
  ID, source hash, start/end sample, language, genre, stratum, and intended speech
  before playback. Pilot may have an empty playback list.
- `digitalSilenceControls`: a nonempty, explicitly frozen list of digital-silence
  cases included in the ordinary request denominator. Each entry has `caseId`,
  exact WAV `audioSha256`, `sampleRate: 16000`, positive `samples`, and
  `verification: {method: "all-pcm-samples-zero", verifiedBeforeOutputs: true,
  sha256: "HASH_OF_THE_ZERO_PCM_AUDIT"}`. The audit must actually inspect every PCM
  sample before outputs are known; this metadata is a hash-bound assertion, not
  a new file inspection by the evaluator. References must explicitly classify
  these cases as silence with no expected cues. Their requests require the same
  separate quote and sending approval as speech inputs.

The separate assisted-review file binds the exact reference, provider-result and
rubric hashes. It declares `reviewMethod`, reviewer, time and reviewer model for
AI review. Its request-handling rows preserve original evidence and distinguish
available output, required review, and blocked/preserved invalid or missing output.
No automatic retry is acceptable. Its boundary observations include both original
parsed outputs, a disposition (`automatic`, `review-required`, `locally-resolved`),
preservation checks, an explicit assessment of stitching-introduced lexical change,
and concrete evidence. These are attributable review assertions, not automatically
proved semantic judgments or human confirmation.

`rangeCorrections` contains one full-range local assessment for each frozen
clear-speech case. A row uses `id` equal to the case ID, the actual `requestId`,
the source WAV `sourceSha256`, and matching `requestStartSample`/
`requestEndSample`. It requires `assessedEntireRequest: true`,
`reviewedLocally: true`, concrete `evidence`, and `requiredRanges`, an array of
`{startSample, endSample, evidence}` in the original 16 kHz source clock. Record
the regions that required correction even after resolving them. An empty array
means the complete range was assessed and needed no correction; an absent or
incomplete observation never means zero work.

The evaluator unions correction intervals by source hash for each profile/cell
and for each profile overall. Overlap, repeated requests and duplicate correction
annotations do not multiply the measured audio duration. It reports exact samples
and milliseconds separately from the number of boundaries requiring review.
Incomplete groups retain the known observed intervals as partial evidence and
publish a null total correction duration. Pilot profiles must cover identical
source intervals before their totals can be compared.

Boundary/interior observations select bounded raw cue groups as
`{requestId, startCue, endCue}` in `boundaryParts` and `interiorParts`. Cue indexes
are zero-based and end-exclusive. The evaluator extracts text from the bound
provider output instead of accepting a manually improved hypothesis string. Freeze
reference regions independently; do not select favorable cues after seeing errors.
This measures provider recognition near boundaries, separately from stitching
preservation and source-wide text quality.

Playback observations repeat the frozen source hash and sample bounds, identify
the actual player and assessment method, and record whether intended speech is
contained and either end clips speech. A synthetic test boolean is not real player
evidence. AI review is never described as human listening. Source-time numerical
checks alone do not establish the listening criterion.

```sh
node scripts/ai-tests/transcribe-production.mjs evaluate \
  --manifest REFERENCES.json --results PROVIDER.json --rubric RUBRIC.json \
  --review ASSISTED-REVIEW.json --output PRODUCTION-EVALUATION.json
```

The wrapper preserves the complete legacy evaluation and original gates. New
results report clear-speech WER/CER per language, genre and profile, ≤10%; matching
independent timing endpoints with median ≤150 ms/p95 ≤400 ms; all missing, changed
and unmatched timing IDs; and preservation through explicit review. Confirmation
also requires twenty distinct boundaries with no stitching-introduced lexical
loss/addition and at least 95 successful, unclipped ranges among all 100
real-player observations. The boundary/interior five-percentage-point comparison
is a separately labeled diagnostic with its own completeness flag; it is not an
additional release gate. Context duplicated across raw request
references remains in request-wise recognition totals and must not be presented
as a unique-source word count. Pilot recognition comparisons aggregate those
request-wise units by language; correction-audio comparisons use source unions.

No arbitrary timing-coverage percentage is introduced. Partial mappings remain
incomplete even when the matched subset is accurate. Uncertain, safely preserved
boundaries can pass the review-assisted preservation gate without being counted as
automatic joins. A frozen digital-silence test is mandatory for the control gate.
It requires empty parsed output and no nonempty allowlisted transcription text,
words or candidate text in any recorded attempt, including an earlier attempt
whose final parsed output was replaced or absent. Missing/truncated evidence and
unresolved attempts cannot pass. Silence, other non-speech, BGM and overlapping
speech retain separate presence, output and completeness reports. Absent optional
conditions are labeled untested; a request row without scored output is not a
completed quality test. Other non-speech failures remain visible limitations and
do not substitute for or add to the hard digital-silence gate. Neither an empty successful response nor a blocked
response is silently substituted for the other.
Exit 2 records incomplete or failed evidence; exit 1 indicates malformed inputs.
Every output retains `modelQualified: false` and never unlocks product features.

## Existing evidence and regression coverage

The earlier short LibriSpeech/JSUT diagnostics, constructed 20-boundary set,
94-second Japanese reversed timestamp, and English 15-ms input overrun remain
development regressions. They do not become held-out natural speech or new paid
requests. `transcribe-timestamp-contract-v1.json` uses authored replacement words
and only the numeric failure shapes; it redistributes neither corpus excerpts nor
provider responses. Quantized point anchors remain points.

Run `pnpm test:scripts scripts/ai-tests` in the development container. The new
tests cover exact sample accounting, identical paired input ranges, context/hash
tampering, reference deficits, rejected temporal holdouts, fixed repeats, preserved
historical gates, review-required boundaries, 95/100 playback, missing Japanese
word references, source-unioned correction duration, incomplete or tied pilot
comparisons, required silence evidence, all recorded control output, parser-failure
shapes and immutable reports. These authored
regressions make no live model or human-review claims. Normal CI remains free.

The local source-material preparation records upstream references separately and
keeps unresolved reference readiness false. No quality result should be published
for those new recordings until the independent reference work and separately
approved provider evaluation have actually occurred.

## Recorded local pilot preparation, September 12, 2026

The four natural-speech pilot selections were processed by the local Windows Rust
helper using the production ONNX Runtime and pinned Silero model. Both profiles
use the same selected source samples. The offline verifier checked all full source
WAV hashes, request WAV hashes, and PCM slices against the original sample clock.

| Profile | Requests | Submitted duration, including context |
| --- | ---: | ---: |
| `current120` | 8 | 984 seconds |
| `short60` | 16 | 1,032 seconds |
| Total | 24 | 2,016 seconds (33 minutes 36 seconds) |

The exact total is 32,256,000 submitted samples. There are fourteen distinct pilot
cut locations across the profiles; these do not contribute to held-out
confirmation's twenty-boundary requirement. No request audio failed verification.
All four source references remain missing or not independently audio-reviewed,
so `readyForQuotePreparation` is false. This is input-integrity evidence, not
recognition/timing quality, a monetary quote, or authorization to send audio.

Private artifacts are under `work/transcribe-production-20260912/`:

- `pilot-validation-plan.json`, SHA-256
  `797e3ffff5aabd122b808cb06b53ddb2f8fabccae31a21056fb0e9ce92a848f7`.
- `pilot-validation-preparation.json`, SHA-256
  `c31820d6dab42dc0d29f66c6f06cf6993addbd03efeac2d0288c599f8b43a333`.
- `assemble-pilot-validation.mjs` and the four original preparation receipts.

The plan records the source/code/lockfile inventory, helper executable, native
runtime/model and preparation-receipt hashes. The earlier material manifest is
used only for its unchanged pilot ranges; its temporal held-out selections are
excluded. The independent-recording manifest is separately hash-bound for later
confirmation preparation. No credential, cost ledger, quote or paid job was
opened or changed by this verification.
