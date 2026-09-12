# Preparing independently sourced transcript references

`scripts/ai-tests/transcribe-references.mjs` verifies retained upstream annotation
files and creates source-bound reference drafts. It performs no recognition,
provider requests, quotation, credential access or ledger operations. It neither
changes an existing preparation nor authorizes submission.

Run it against explicit frozen inputs and a new output directory:

```sh
node scripts/ai-tests/transcribe-references.mjs \
  --plan work/transcribe-production-20260912/pilot-validation-plan.json \
  --sources work/transcribe-production-20260912/source-materials/source-manifest-independent.json \
  --output work/transcribe-production-20260912/references-v2
node --test scripts/ai-tests/*.test.mjs
```

The illustrated output directory already exists. A new run must choose another
directory; existing outputs are never overwritten. Annotation and audio artifacts
remain under ignored `work/`, with their source licenses and attributions. They are
not added to the application bundle or relabeled as GPL source code.

## What is verified

- AMI manual NXT XML is checked against every word, speaker, attribute and original
  file hash in the retained extracted JSON. The narrow XML reader rejects DTDs,
  external entities, unsupported nesting, duplicate IDs and malformed input.
  Supported XML text encoding and entities are decoded explicitly.
- Decimal coordinates are converted exactly to the 16 kHz sample clock. A
  non-integral sample coordinate is rejected; it is never silently rounded.
- Original recording hashes, decoded source hashes and actual RIFF sample counts
  are checked. Every sample in each frozen request WAV is compared against its
  declared source interval. Source files are streamed in bounded buffers.
- Both retained AMI original recordings are byte-identical to their decoded
  sources. Koniwa's original MP3 identity and retained decoding provenance are
  recorded separately: exact decoded slices do not establish fresh acoustic
  calibration of compressed-source annotation timing.
- Repeated words, speaker overlap, point punctuation, laughter and disfluency
  markers remain visible. Original defective annotation times remain defective;
  they are not repaired to satisfy the verifier.

The full source audits retain original annotation records. Each chunk draft keeps
source and request clocks, original IDs, full original text, partial-edge flags,
overlap pairs and core-boundary intersections. `wordTimestampReference` contains
only positive-duration, fully contained, exact-millisecond word anchors;
`utteranceTimestampReference` contains utterance anchors and never invented words.
`completeReferenceSegments` also retains exact sample coordinates. An annotation
that cannot be represented in integer milliseconds is excluded from that timing
projection with an explicit ID, without altering its source coordinates.

These arrays can supply a later evaluator's explicitly matched reference IDs.
Their presence does not claim complete-request coverage: an accurate subset must
not hide missing or clipped words. `candidateText` deliberately preserves complete
original annotations that intersect a cut and is **not** a scored full-request
transcript when `recognitionReferenceComplete` is false. Provider output must not
be used to manufacture the missing reference portions.

## Provenance and readiness are separate

An established human corpus annotation does not require every word to be listened
to again merely to become an independent reference. The preparation policy now
reports these distinct dimensions:

- `upstreamMechanicalVerificationReady`: attributable upstream human annotation,
  original-file hashes, verified conversion, source identity and cut verification.
- `recognitionReferenceReady`: complete declared text coverage, supported by that
  provenance or a separately recorded actual acoustic reference review.
- `upstreamTimingReferenceReady`: usable upstream word or utterance anchors, with
  the original timing level stated explicitly.
- `additionalAcousticReviewVerified` and `additionalListeningPerformed`: separate
  review claims requiring their own attributable evidence. Mechanical verification
  sets neither to true.

A complete verified upstream reference can satisfy preparation/reference
provenance checks without new listening. This changes no recognition threshold,
timestamp error threshold, required matching coverage, digital-silence check,
correction-duration evidence or real-player observation requirement. In
particular, Japanese utterance anchors cannot satisfy a word-timing requirement.
Preparation readiness still does not authorize a paid request or qualify a model.

## Actual retained pilot findings, 12 September 2026

The versioned `references-v2/report.json` audits three annotated recordings and
produces twelve drafts for the already frozen pilot inputs. All prior source
manifests, requests and evaluation reports remain unchanged. The earlier
`references-v1` mechanical draft is retained; version 2 supplies explicit complete
anchor projections and byte-level artifact hashes.

| Source | Verified upstream records | Usable current pilot material | Remaining reference gaps |
| --- | --- | --- | --- |
| AMI ES2002a | 2,600 words, 505 punctuation records, 113 other events | Six chunks, 959 fully contained word anchors across both profiles, including repeated overlap coverage | Every request has one to three partially clipped words at its edges; complete-request WER remains unready |
| AMI ES2004a | 2,614 words, 521 punctuation records, 123 other events | Full source annotation verified for a future independent confirmation preparation | No confirmation chunks were prepared by this command |
| Koniwa Amagasaki 2011-04-20 | 150 timed utterances | Six chunks, 166 fully contained utterance anchors across both profiles | Two partial utterances per request; unresolved `text_level0` versus `text_level2` verbatim policy; no word anchors |

For example, the original AMI pilot starts at 60 seconds inside `project`
(58.69–60.35). Its 300-second end intersects `you` (298.88–300.92) and `again`
(299.90–300.20). These are concrete coverage deficits, not a blanket requirement
for a fresh listener. AMI event `ES2002a.B.words1587` also has reversed upstream
laughter times, 1109.39–1107.09 seconds. It is preserved as a source issue outside
the pilot range.

An unapplied local alternative shifts the outer AMI selection to
62.72–302.72 seconds while retaining exactly four minutes. Neither endpoint lies
inside a word according to the original annotation. This is not proof of acoustic
silence, and internal request edges may still cut words. Adopting the alternative
requires a new Rust chunk plan and new immutable input preparation; the current
plan is untouched.

The separate `candidate-native-preparation-v1` now contains an actual local Rust
preparation for that 62.72–302.72-second alternative. It was created with:

```sh
node work/transcribe-production-20260912/prepare-candidate-native.mjs
```

The unchanged previously reviewed Windows helper was reused. Its executable hash
still matches the frozen pilot, and the recorded source hash is reproduced by
removing only the later explanatory receipt field and regression-test additions.
The planner, VAD implementation and dependency lock file are unchanged. The
matching source snapshot, executable hash, existing Silero/ONNX asset hashes and
command output are retained with the new preparation. No Cargo build, installation
or container artifact export was needed. The earlier helper's selection-relative
VAD clock is explicitly labeled by `vadSourceStartSample: 1003520` in the new
verification record; the native chunk coordinates are absolute source samples.

| Profile | Actual requests | Source duration | Submitted duration including context | Added context | Internal boundaries |
| --- | --- | --- | --- | --- | --- |
| `current120` | 2 | 240 s | 246 s | 6 s | 1 |
| `short60` | 4 | 240 s | 258 s | 18 s | 3 |

The six request WAVs contain 8,064,000 samples in total, or 504 seconds across
both alternative profiles. Every request sample was checked against the original
decoded source, and the word-reference artifact hash was verified. Each profile
fully covers all 477 words in the joined source selection. Individual context
edges still intersect annotations, but every such word is fully present in another
request of the same profile. The retained `word-coverage-verification.json` records
the exact IDs: these context-only partials do not invalidate source-level WER
reference coverage.

This preparation is explicitly unapplied to the product and evaluation campaign.
It establishes local input and annotation coverage, not provider recognition,
joining quality, acoustic calibration or a model-quality result. No quote or
provider request was created; all original pilot inputs remain unchanged.

Koniwa's pinned schema defines the text fields but not an authoritative verbatim
fallback rule. Some `text_level2` entries add fillers absent from `text_level0`;
all variants and notes are preserved. See
[reference discovery](transcribe-reference-discovery-2026-09-12.md) for the pinned
schema and the five sources whose references remain unavailable. No undocumented
text-level choice, new listening, full-request quality pass or provider capability
is claimed by these artifacts.
