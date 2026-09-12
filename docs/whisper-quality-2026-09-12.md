# Local Whisper subtitle timing evaluation

The bounded experiment completed, but **did not meet the acceptance criteria**. The tested multilingual base model must not be integrated as an automatic subtitle timing repair on the strength of this result. No model or parameter tuning, inference retry, cloud request, ledger change, or product integration followed the failed evaluation.

## Method and provenance

The experiment used the complete, unmodified recognition and word-timestamp path from faster-whisper 1.2.1, CTranslate2 4.8.2, and the multilingual `Systran/faster-whisper-base` model at commit `a80717a3a48b1b28aa687bca146cb7301feae1b1`. The model file SHA-256 was `d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9`.

Settings were CPU float32, two computation threads, one concurrent window, temperature zero, beam size five, word timestamps enabled, previous-text conditioning disabled, and VAD filtering disabled. No provider transcript, reference text, reference timestamp, initial prompt, prefix, or hotword entered recognition. Upstream default decoding thresholds and word-timestamp postprocessing were retained. There was one temperature, with no fallback-temperature retry.

The input consisted of 37 English windows around the original saved Flash 3.8 cues, ten Japanese boundary-left windows containing 28 saved Transcribe cues, and four controls. Every window was at most 30 seconds. The English windows retained the previous experiment's provider-derived search ranges; recognition itself received only the audio and language. Each language had a ten-second digital-zero control and a ten-second deterministic non-speech tone control. Two unrelated-text mapping controls reused recognized speech and required no additional inference.

Japanese provider results came from valid earlier `gemini-3.5-transcribe-preview` boundary requests. The missing Japanese long-clip Flash candidate was not replaced or counted as evaluated. These different provider sources prevent a direct English/Japanese provider model comparison.

The recognizer output was frozen before reference scoring. Its SHA-256 is `6376e9c7af933e5e64635284580105fc92d2d48fc1e6dbf761b4e13f0081f8f8`; the audio-only input plan SHA-256 is `9a062873eec00b40a4f2a64fa8b082b39597a8c34509777dcfbfe1e12d452fb1`.

After recognition, a saved provider cue was eligible for a proposed time only when its complete lexical sequence occurred exactly once in the recognized window. Comparison applied NFKC normalization and lower case, with English lexical tokens and Japanese letter/number characters. Punctuation was ignored for matching; the original provider text remained byte-for-byte unchanged in every proposal. No spelling repair, kana/kanji substitution, semantic matching, interpolation, or reference-guided time selection was permitted. Cue edges inside a recognized word, absent or zero-width word anchors, and non-monotonic or out-of-range times were rejected.

## Results

| Measure | English, original Flash cues | Japanese, original Transcribe cues |
| --- | ---: | ---: |
| Provider cues | 37 | 28 |
| Exact-text proposals | 22 | 8 |
| Proposal coverage; required at least 80% | 59.5%, fail | 28.6%, fail |
| Expected reference endpoints | 74 | 56 |
| Unavailable reference endpoints | 1 | 36 |
| Mapped reference endpoints without a proposal | 29 | 16 |
| Scored proposed endpoints | 44 | 4 |
| Proposed absolute timing error, median | 148 ms | 100 ms |
| Proposed absolute timing error, p95 | 555 ms, fail | 240 ms on four endpoints only |
| Original provider error on the same scored subset, median / p95 | 1,052.5 / 5,725 ms | 45 / 60 ms |

All 35 non-proposals resulted from full-text mismatch. Recognition and mapping did improve the English timing estimate on the subset that matched exactly, but coverage and the English p95 still failed. The four scored Japanese endpoints are insufficient for a general timing claim, and were worse than their original provider times. Unavailable references and unmatched cues remain explicit in the report and denominator.

Both digital-zero controls produced invented lexical text. Both deterministic tone controls produced empty text. Both unrelated-text mapping controls were correctly rejected. The failed silence controls independently prevent acceptance; a successful recognition call or exact-text correspondence is not proof that speech occurred.

All 51 windows completed under the 120-second per-process watchdog and 2 GiB resident-memory ceiling. Recorded model-loading and recognition time totaled 144.030 seconds, with a maximum of 7.512 seconds per window; these recorded durations exclude interpreter/import startup. The highest observed process resident-memory peak was 785,346,560 bytes. The watchdog includes process startup. These are measurements from the local Linux container, not Windows release-performance guarantees.

The mapper passed eleven targeted checks covering unchanged cue text, incomplete matches, ambiguous repetition, zero/missing/negative anchors, non-monotonic and out-of-range words, Japanese interior word edges, and the prohibition on kana/kanji substitutions. The verification also checked the actual recorded options for all 51 outputs. There were no inference reruns.

## Evidence limits and handling

The corpus is development material already used for earlier evaluation, not held-out acceptance data. English reference times are independently generated MFA word alignments. Japanese references provide independently generated Julius first/last speech-phone endpoints for complete utterances; no word-level Japanese ground truth was invented for partial cues. These automatic references do not replace human timing annotation or listening tests.

All downloaded packages, model files, copied audio, and generated audio remained under the existing container's private `/opt/surtitle-build` directory. Incremental downloads, including package metadata, totaled 73,066,801 bytes against a 500 MiB cap. Official PyPI wheel SHA-256 values were checked before extraction, and dependency version/hash/license receipts were retained. The existing model and runtime assets were reused. No Torch or GPU package was acquired.

The primary components are MIT licensed; dependency license texts and the pinned model receipt are retained with the private experiment. PyAV and its included native components are experiment dependencies only. They were not added to the application distribution or its native payload. JSUT source audio remains subject to its personal-use/redistribution restrictions and was not exported or shipped. The experiment is not a redistribution approval for these assets.

Selected authored scripts, JSON reports, hashes, and license receipts were explicitly exported to the ignored `work/whisper-quality-20260912` directory. No model, wheel, generated audio, or build output was exported. `final-evidence.json` records the hashes of the selected evidence files. `recognition.json` preserves the actual upstream outputs, `evaluation.json` preserves every cue mapping and endpoint exclusion, and `validation.json` records the mapping/runtime checks.

## Proposed cloud diagnostic inputs

The six-case diagnostic manifest is prepared, but does not authorize sending it. Four unchanged existing speech fixtures are paired with the same deterministic silence and tone recipes. All files are shorter than 24 seconds, so their full-file core and request ranges need no added context or trimming.

| Case | Duration | Source |
| --- | ---: | --- |
| English 1 | 10.435 s | LibriSpeech `1089-134686-0000` |
| English 2 | 10.725 s | LibriSpeech `1188-133604-0000` |
| Japanese 1 | 3.190 s | JSUT `BASIC5000_0001` |
| Japanese 2 | 4.900 s | JSUT `BASIC5000_0002` |
| Digital silence | 10.000 s | Locally authored zero samples |
| Non-speech tones | 10.000 s | Locally authored deterministic signal |

Unique audio totals 49.250 seconds. Sending each case to both evaluation models would use twelve requests and 98.500 seconds of audio. Adding one untimed Transcribe comparison for English 1 and Japanese 1 would produce fourteen audio requests and 112.125 seconds including duplication. This excludes the separate six explanation requests in the proposed diagnostic stage.

`diagnostic-manifest.json` has SHA-256 `471306f6d1dd7cee38ee5cb5519c8a4736fb714af3b7f996778971ad2d6aa029`. It records exact WAV and PCM hashes, durations, source URLs, license notes, existing host speech paths, container paths, and control-generation recipes. Generated controls remain inside the container. Any independently reconstructed input must match the manifest's hashes before an actual quote is prepared. Fresh digest-bound quotes and the additional evaluation campaign approval are still required before any cloud send.
