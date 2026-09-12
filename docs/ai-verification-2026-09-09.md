# Live-service verification of AI features (2026-09-09)

The implemented AI features were tested with the user's service account and an authorized **USD 10** allowance that included the preceding test. One initial vocabulary request, 14 initial all-feature requests, and four subsequently approved rechecks were sent sequentially to Vertex AI in `global`, for 19 requests in total. A dedicated CLI and dedicated SQLite databases were used without changing the normal application's data or budget settings. No commits, pushes, or publication were performed.

This is a historical record of the Flash Lite / Flash 3.5 and Transcribe Preview selections and the implementation used for that run, rather than the current model-selection policy. See the note in the final section.

## Initial test results

| Feature | Input and model | Result |
| --- | --- | --- |
| English vocabulary extraction | Two English sentences, Flash Lite | Generated three vocabulary items with Japanese explanations. Sources and context were checked. Resending the completed job was also rejected. |
| Japanese vocabulary extraction | 20 Japanese subtitles, Flash Lite | Generated 14 candidates. Reference IDs and examples matched the source. However, one item changed the intransitive expression `白紙に戻った` into the transitive dictionary form `白紙に戻す`; the semantic review required correction. |
| Explanation of a selected expression | 20 English subtitles, A2 / C1, Flash Lite | Both requests were rejected for a case where `look forward to` spanned two subtitles. The saved C1 response cited only one of the two subtitle IDs. Usage was charged, and the invalid candidates were not adopted. |
| Selected Japanese expression | 20 Japanese subtitles, `生きている`, B1, Flash Lite | Generated an English explanation and example reflecting the context that a plan remained valid. |
| Ordinary subtitle translation | 20 English-to-Japanese and 20 Japanese-to-English subtitles, Flash Lite | Saved all 20 IDs and translations in each direction. Principal distinctions involving numbers, negation, and times were retained. |
| Material containing quoted instructions and HTML | 20 subtitles in each language, Flash Lite | Returned translations without executing the instructions. However, Japanese-to-English output mistranslated the quoted phrase `鍵を明かせ` and changed Japanese strings inside a URL and a script. Other literal-preservation concerns, including translation of `APPROVED` inside an instruction, were recorded. |
| English transcription | 7.060 seconds of human narration, Transcribe Preview / Gemini Flash | Both methods matched the upstream 21-word reference after normalization (WER 0). Transcribe also returned timestamps for the 21 words. |
| Japanese transcription | 1.272 seconds of human speech, Transcribe Preview / Gemini Flash | Both methods returned responses that were parsed and converted into subtitles. For the reference `えっ嘘でしょ。`, they produced `え、嘘でしょ。` and `え、うそでしょ？`. Differences in orthography and the small `っ` mean this is not treated as a verbatim-quality pass. |
| Silence transcription | Two seconds of deterministic digital silence, Transcribe Preview | A STOP response had empty content and omitted the output-token count. The old implementation could not establish usage, retained the entire reservation, and stopped. |
| Silence transcription | The same two seconds of silence, Gemini Flash | **Invented the nonexistent speech “They want to be here.” Quality failure.** Protocol success is distinct from the quality judgment. |

The English clip was CC BY 4.0 LibriSpeech audio obtained from the official TorchAudio distribution: [OpenSLR audio license](https://www.openslr.org/12/) and [official sample description](https://docs.pytorch.org/audio/2.8.0/tutorials/asr_inference_with_ctc_decoder_tutorial.html). The Japanese clip was an [official ITA-Corpus-Rion sample](https://github.com/Rion-Dev/ita-corpus-Rion) used only for private technical validation. That source states a resale prohibition in addition to CC BY 4.0, so it was not treated as an unconditionally redistributable asset and is excluded from the application and public fixtures. Original files, conversion settings, hashes, and usage terms for both clips were recorded in `fixtures/PROVENANCE.md` within the validation directory.

Reference text came from the upstream publications. No independent human listening review or ground-truth word-timing annotation was performed. The mechanical Japanese CER was 1/6 for Transcribe and 2/6 for Flash, but this also counts kanji-versus-kana differences. A one-second sentence does not establish general English/Japanese accuracy or boundary quality. Subtitle timestamps were checked to remain inside the input range, and SRT/VTT output was verified.

## Changes made during this verification

1. **Citations for split expressions:** The instructions were made explicit that an expression crossing subtitles must cite every contributing adjacent subtitle ID. Validation continued to reject citations covering only one side.
2. **Literal preservation in translation:** Instructions were clarified to preserve URLs, code, JSON, and placeholders unchanged, and to translate quoted instructions without changing their meaning.
3. **Valid silence responses:** An omitted output count is established as zero only when explicit input and total token counts match, and other output, thinking, and tool-use counts are omitted or zero. Only a Transcribe STOP response with empty content is accepted as empty subtitles. Mismatches, nulls, fractional counts, and otherwise unknown usage continue to retain their reservations. This follows the [official usage-field definitions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse#UsageMetadata).
4. **Development diagnostics:** The validation CLI records non-thinking generated text and finish reasons. Storage is bounded to 128 KiB in total, eight candidates, and 32 parts per candidate, with truncation explicitly indicated. Keys, tokens, thinking text, and arbitrary diagnostic fields are excluded. Generated text discarded by earlier runs cannot be recovered.

Fixed-response tests passed after these changes. Automatic approval review rejected the first retry command, so it was not sent. After the user explicitly approved the rechecks, each of the following four requests was executed exactly once. The charge ledger was not rolled back, and failed requests were not resent by disguising them as different jobs.

## Results of the approved rechecks

| Target | Result | Ledger amount for this recheck (USD) |
| --- | --- | ---: |
| Split-expression explanation, A2 | Cited both subtitle IDs (19 and 20); meaning, explanation, and example passed validation and were saved. | 0.000607 |
| Split-expression explanation, C1 | Also cited both IDs and succeeded. However, the explanation mainly covered basic gerund grammar, so it does not sufficiently establish quality differentiation by proficiency level. | 0.000647 |
| Translation of three Japanese subtitles | Preserved the Japanese URL path and Japanese string inside the script. However, it still translated `鍵を明かせ` as “Unlock the key”; semantic quality failed. | 0.000369 |
| Silence, Transcribe | Completed successfully with empty subtitles, `cues: []`. Explicit input 52 and total 52 established the omitted output as zero, allowing settlement. The initial unknown reservation was retained. | 0.000104 |
| Total | Four requests; no additional automatic retries. | **0.001727** |

The live service confirmed improvements to incomplete citations and compatibility with valid silence responses. Literal preservation also improved for these three translation cues, but the quoted phrase's meaning remained wrong. The initial Gemini Flash hallucination on silence and the Japanese vocabulary transitivity error were not reclassified as passes.

## Charges and retained reservations

| Item | USD |
| --- | ---: |
| Usage-based ledger charges, including the preceding test and rechecks | 0.019505 |
| Unknown reservation retained for the original silence Transcribe attempt | 0.942212 |
| Total deducted from the authorized allowance | **0.961717** |
| Remaining amount from the USD 10 allowance | **9.038283** |

These are application ledger amounts calculated from API usage with upward rounding, not Google's final invoice. The unknown attempt remains an acknowledged hold; it was neither refunded nor treated as zero cost. Only the remaining, previously unexecuted initial tests were continued. The original validation ledger was retained. The cumulative limit in the new validation environment was set to USD 9.999296 after deducting the preceding USD 0.000704 charge.

The rechecks were approved with **additional reservations totaling USD 1.490071**: one A2 explanation and one C1 explanation (USD 0.175969 each), one silence Transcribe request (USD 0.942212), and one translation request for the three Japanese cues requiring correction (USD 0.195921). After execution, those new reservations were settled using the usage amounts above. The old unknown USD 0.942212 attempt was not refunded or marked settled; it remains in the ledger as `accepted_unknown`.

## Local and native verification

- The final AI core suite passed 111 tests, and the validation CLI passed seven. The shared worker verified valid settlement of omitted zero usage, full retention for invalid usage, and rejection of resending completed jobs. Clippy passed for both crates with all features and targets.
- The shared core's 12 tests, native unit suite's 14 tests, frontend's 27 tests, and evaluation/output tools' 26 tests were rerun successfully.
- Seventeen actual Windows WebView2/libmpv E2E tests and two browser-preview tests passed. They covered saved translation application and reapplication, rejection of adoption with missing ranges, boundary review, repair estimates within 30 seconds, process restarts, card audio, and a zero budget. No paid requests were made through the dedicated E2E SQLite database.
- A presentation issue was recorded: some backend notices remained Japanese in the English UI. The semantic review for this run was performed by AI; it does not count as an independent human evaluation.
- The normal application was rebuilt with `custom-protocol`, and the production dependency graph was checked to exclude development-validation features. The corrected native unit suite's 14 tests and Rustfmt also passed.

The initial live-service report is `work/ai-functional-20260909/validation/all-features-report.json`; the combined report after rechecks is `work/ai-functional-20260909/validation/all-features-after-recheck-report.json`. Content reviews are under `work/ai-functional-20260909/reviews/`, audio-reference comparisons and SRT/VTT outputs under `work/ai-functional-20260909/`, and native evidence under `work/ai-functional-20260909-native/`. All are excluded from Git, and credentials must not be included in published artifacts.

## Judgment and historical scope

Initial live API tests covered every implemented AI feature type, followed by the four approved rechecks. **This was not a quality pass for all features.** At the time of this verification, the normal application's submission gates for both audio model paths remained in place. Remaining work included evaluation of mistranslations and word senses, verbatim accuracy, word timestamps, repetition, long-recording sentence boundaries, and repaired results. This AI verification did not waive native redistribution audits or installer-publication requirements.

The current application has since moved to user-selected available Gemini models and explicit approval of each request scope, including separate acknowledgement when pricing is unknown. The historical audio-model gate described above is not the current selection policy. See [current status and remaining gates](status.md) for the present implementation. This policy change does not alter the historical results, charges, or retained unknown reservation recorded here.
