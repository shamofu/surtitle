# AI, audio preparation, and spending

Rust services own credentials, immutable requests, usage accounting and transcript review. UI-facing methods never return saved API keys, service-account JSON or access tokens. Generated content is labeled for comparison with the source. [Vertex setup](vertex-verification.md) covers Vertex application and development CLI configuration.

## Selecting a service and OpenAI setup

Settings selects **Vertex AI** or **OpenAI API** for new transcription, translation, explanation and vocabulary jobs. Existing settings migrate to Vertex and Vertex remains the initial selection. Switching retains both profiles and refreshes unapproved estimates; approved jobs, retries and saved results keep their original service. Each estimate and history entry names that service. Editing either budget does not switch the active service.

For OpenAI, register an API key in Settings. Rust encrypts it with Windows DPAPI; the password input clears after saving. Keys can be replaced or removed, cannot be read back, and are excluded from settings files, logs and learning backups. Changing the same service's credential stops its later sends; changing the other service does not.

OpenAI text models start unset. Fetch model IDs or enter an ID for each purpose; availability in the inventory does not prove Structured Outputs support. The transcription setup candidate is `gpt-transcribe`. Text requests use Responses with strict Structured Outputs and `store: false`. Streaming previews cannot be applied until the complete response passes existing content and source-reference checks.

OpenAI uploads prepared FLAC files to `/v1/audio/transcriptions`. The whole selected range is sent as one file when it fits the upload limit; progress advances after each request. Untimed text remains an **Audio range** for reading and learning, with no invented word times; synchronized captions and SRT/VTT omit it. Local evidence reanalysis and result application require no additional API request. See the [transcription specification](https://developers.openai.com/api/docs/guides/transcription).

New `gpt-transcribe` quotes send a selected language through `languages[]`; automatic language detection omits the hint. This format is frozen in the plan. Older plans retain their original singular `language` field and hashes when resumed, rather than silently changing an approved request.

An audio plan can explicitly freeze OpenAI's server chunking option or recording-context prompt. New ordinary jobs omit both. Requests retain their saved presence, absence and exact prompt after restart; changing these options requires a new quote. A prompt or server option does not prove complete recognition or replace local sample coverage checks.

Enter OpenAI prices from the [official pricing table](https://developers.openai.com/api/docs/pricing): USD per million input/output tokens for text, or USD per minute for audio. An unset price requires explicit unpriced approval and cannot guarantee a monetary cap. Promotional credits are not subtracted from recorded usage; balance retrieval is not supported. `credit_balance_exhausted` and `insufficient_quota` stop without automatic retries. Unconfirmed usage retains its hold; resolve funding, acknowledge the unknown outcome, then review a new estimate and approve it. See [API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits).

## Model selection

Each service has separate model preferences for transcription, vocabulary, explanations and translation. Vertex's **Set up the recommended combination** assigns Transcribe to transcription and Flash to the other purposes; replacing existing settings requires explicit selection. Publisher suggestions and manually entered Gemini IDs do not prove project access. Provider, model, location and credential changes invalidate pending suggestions and new estimates, including switching away and back.

Each quote freezes the model, location, output limit, thinking/response settings, optional price, credential identity, source and request bodies. Changing these inputs requires a new quote. Standard output limits are application presets; custom values are retained, but neither guarantees model compatibility or a complete response. Existing approved jobs retain their original response and failure policies. Running jobs never switch models automatically.

**How to create subtitles** selects the transcription mode. The standard Transcribe path makes one VERBATIM request with word timestamps per prepared chunk through `generateContent`. General Gemini audio jobs can generate timed cues through `streamGenerateContent`. Unsupported combinations fail visibly. Timing failure or VAD disagreement never starts a second paid request or model fallback.

## Application workflow

Open **Transcript → Create subtitles from audio**, or **Add or switch subtitles → Transcribe full media**. Transcription defaults to the whole recording. Once duration and configured credentials/model are available, opening the workspace prepares audio and a quote locally; it sends no generation request. **Change range or model** and **Update estimate** revise the scope. Ranges expand to include the full existing subtitles they intersect; the estimate shows the actual range.

Review the quote and press **Start transcription** once to approve its scope and reservation, including any price-unknown notice. Details show chunks, maximum sends, submitted audio and output tokens, including approved retries. New whole-recording, range and re-transcription jobs publish received text into the ordinary subtitle list while execution continues. Learning does not require whole-transcript adoption, boundary review or VAD acknowledgement. **Suggestions → Explore words with AI** opens vocabulary and expression requests.

**Set up and return** preserves inputs through Settings. **Open estimate** reopens approval; expired estimates or changed settings need fresh review. **Resume remaining work** prepares a new approval for unsent or explicitly retried work, retaining received results. **Retry applying saved results** retries local publication without another provider request.

## Runtime progress and independent vocabulary batches

Study and Activity show progress/history. New vocabulary, explanation, translation and general Gemini audio jobs can preview non-thought answer fields while receiving SSE; provisional text cannot be saved or applied. Transcribe's synchronous API progresses by completed chunk, without token streaming or automatic Transcribe Live substitution. Opening or closing a view never restarts a request.

Progress stays in existing panels without opening them or covering/resizing playback. History persists separately from learning backups; provisional text stays in memory. Missed UI updates can recover without accepting an old attempt's output.

New vocabulary jobs, including single-term explanations, can continue untouched batches after a fully received, usage-settled output rejection. They report succeeded/rejected counts and complete, partial or all-failed outcomes. Source changes, authentication/budget/storage failures, unknown usage and cancellation still stop dispatch. Retrying failed batches requires a new estimate and approval; successful results and their charges remain. Other tasks retain their own failure policy.

## Credentials and dispatch

1. A native file dialog supplies the service-account JSON path. Rust validates the credential and fixed OAuth endpoint and protects it with per-user Windows DPAPI; there is no plaintext fallback. Import takes effect immediately, while cancellation leaves the credential unchanged. The project ID is read-only; changing projects requires another key.
2. An exclusive data-directory lock prevents concurrent application processes. Startup records interrupted dispatches as unknown outcomes and revokes stale execution approval. Remaining work needs renewed approval after restart.
3. Quotes bind immutable inputs and request templates. Equivalent plans reuse the same job. A quote can be approved for 30 minutes; this is not an execution time limit for an already approved plan.
4. SQLite reserves each request before dispatch. Only one request can be active. Authentication and final dispatch checks revalidate approval, source, request digest, cancellation, current limits and reservation before sending.
5. A valid response is saved and settled once. Completed requests cannot be resent. Pause and cancel stop later requests; they cannot revoke work already being processed by the provider.
6. Timeouts, interrupted connections and unresolvable usage stop automatic progress and retain the hold. Acknowledging an unknown outcome does not refund it. Retrying requires a reviewed quote and separate approval.

The native scheduler shares a single HTTP lane between both services and between interactive and bulk work. A known in-flight request queues other work; an unknown outcome blocks only its own service. Waiting for pacing releases the lane, but never bypasses approval or accounting checks.

Production transport uses fixed Google or OpenAI HTTPS endpoints, bounded responses, no redirects and no hidden transport retries. Only the transcription worker performs the explicitly approved transient HTTP 429 retries below. Other AI operations and the development validation CLI keep single-attempt approval behavior.

### Transcription rate limits and retries

New transcription approvals permit at most two automatic retries per chunk for HTTP 429: three sends total. They reuse the same prepared audio and context, never resend completed chunks, and recheck approval, source and limits before each send. Older approvals do not gain retries. Timeouts, disconnections, invalid usage and other HTTP errors are never automatically retried.

Congestion pacing persists per service/project/model/location across reapproval and restart. The latest retry-backoff, cooldown or valid `Retry-After` deadline controls sending; server waits are never shortened. A wait longer than five minutes or a third 429 stops for review. Progress shows chunk, retry count and wait, with pause/cancel available. Restart needs fresh approval; UI countdowns do not dispatch requests.

A 429 is distinct from an unknown connection outcome, but does not prove that the rejected request was free. Its reservation or unpriced attempt remains counted; each retry creates another reservation. Priced approval covers all permitted sends. Unpriced approval covers their maximum request count, audio duration and output limit without promising a dollar cap. Older unknown-outcome records still require acknowledgement before fresh approval. No retry changes the model or restores revoked approval.

Valid usage can settle a response even when its content is rejected. Transcribe's STOP response can omit output-token count only when explicit input/total counts agree and related counts are absent or zero; other missing or invalid usage retains the hold.

## Prices and limits

Billing metadata is queried on request. Ambiguous or incomplete prices remain unset; users may enter input/output rates, including explicit zero. Each quote retains its price snapshot. Changing the model or location clears the edited price for review. There is no dated model/price catalog.

Per-job, daily and monthly budgets are independent for each service and use zero to mean unlimited, including OpenAI's initial limits. Positive limits still apply and all usage remains recorded. Daily/per-job settings follow monthly changes only while they match, preserving overrides. Calendar periods use UTC. Known usage belongs to dispatch date; unknown priced holds remain counted across provider switches and day/month boundaries. The transactional v2→v3 migration attributes existing jobs, charges, holds and limits to Vertex without rewriting saved plan JSON, hashes, approvals or evidence.

Text reservations conservatively cover input and the output ceiling, including reasoning tokens. OpenAI audio reservations cover submitted duration, including overlap and approved retries, and settle from verified duration usage. Missing or invalid duration retains the hold. Settlement rounds upward in micro-USD and counts cached input at the supplied rate. Application limits cannot cap provider invoices or control other applications/devices, taxes, later prices or billing adjustments.

Unpriced jobs require explicit approval of the full request count, submitted audio and generation settings. Successful unpriced attempts retain usage as uncalculated cost; they are neither zero-cost requests nor unknown network outcomes. The UI separates calculated subtotals from unpriced-attempt counts.

## Local audio preparation

Preparation downloads the pinned streaming Silero model on first use, verifies size and SHA-256, and uses bundled CPU ONNX Runtime. This sends no media to either provider. The selected FFmpeg/ffprobe pair is retained for the operation and verified before use.

FFmpeg decodes the selected stream/range once to mono 16 kHz PCM. Streaming VAD and bounded encoders produce exact FLAC ranges without memory growth proportional to recording length. Complete coverage is verified before a receipt; an early file is not a complete estimate or approval. Cancellation, source changes and errors stop owned processes and remove incomplete output; success removes temporary PCM.

New OpenAI preparations encode the entire selection first and measure the FLAC file. A file of at most 25,000,000 bytes remains one request, including recordings longer than four minutes. Oversized files use sustained low-speech-probability intervals of at least two seconds, with cuts at least 250 ms inside their edges. Candidates are sought across the available range near a size-based estimate, then encoded and measured; oversized candidates move back to earlier pauses. Only an actual file within the byte limit is accepted. If no sufficiently long pause fits, a forced cut within the limit remains marked for review. VAD indicates non-speech probability, not literal silence or a sentence boundary. No silence is removed and no overlapping context is added: submitted intervals cover the selected samples exactly once.

New Vertex preparations follow the same whole-selection and sustained-pause policy. The selected transcription mode determines the duration bound: 15 minutes for [Vertex Transcribe with word timestamps](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe), or 30,240 seconds (about 8.4 hours) for supported [Gemini audio-understanding models](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/audio-understanding) in subtitle mode. These are request bounds, not quality-based chunk targets. Model IDs remain user-selected; a custom model may impose stricter limits. If duration or measured size exceeds the bound, use a guarded sustained pause within both bounds, or a marked forced cut when none fits. There is no overlap or silence removal.

Vertex inline audio uses a conservative application transport ceiling of 20,000,000 bytes for the serialized JSON request, including Base64. Preparation reserves 64 KiB for JSON and derives the FLAC allowance from the remainder; quote validation and sending also check the complete expanded body. This is an application limit, not a claimed universal Standard PayGo or Transcribe API file limit: the explicit [20 MB documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo) concerns Flex PayGo. This application uses its existing inline Standard PayGo transport.

OpenAI selections are bounded to 24 hours by the application's existing usage-validation limit. Both services retain the existing 300-second HTTP timeout; Vertex also retains the configured output-token bound and rejects truncated results. Whole-file input does not guarantee complete recognition or sufficient output capacity. Older duration profiles and Vertex's legacy 12 MiB/240-second attachment checks remain valid for frozen jobs; boundary repair remains a separately approved request of at most 30 seconds.

Whole-file recognition can still omit or misrecognize speech, including repetitions. The application preserves the received text and evidence without filling gaps from guesses. Estimates show the actual submitted duration and approved sends, and no quality check starts an unapproved paid fallback.

Receipts bind source/stream identity, tools, VAD model, generated audio and the selected profile. The sustained-pause profiles are `openai_file_silence`, `vertex_transcribe_file_silence` and `vertex_audio_file_silence`; obsolete preparations require fresh preparation for a new quote. New receipts also record the service and AI configuration generation captured before preparation. A new quote reuses audio only when this context and the selected mode's profile are compatible; a settings or mode change during preparation cannot turn its stale result into a new approval. Existing approved jobs and explicit resumes retain their frozen audio and execution plan. Source, stream or byte changes still invalidate reuse.

## Transcript review and learning content

Text validity and word timing are independent. Usable word anchors produce timed cues. Missing, reversed, out-of-range or unaligned anchors retain the original text as a `source_block`, displayed as **Audio range**, with the exact submitted interval including context. These bounds identify source audio, not sentence/word timing. Source blocks support reading, translation, explanations and cards; synchronized captions, caption-group pause and SRT/VTT omit them. A card may use an explicit audio subrange of at most 180 seconds within the block.

Very long source blocks remain subject to the existing text limits: transcription text is bounded near 1 MiB, AI source requests to 100 KB, and editor/draft fields to 64 KiB. Accepting a long audio file does not remove these learning-action limits. Word alignment, if added separately, would locate supplied text in audio; it would not recover words omitted by recognition.

Only shared word anchors inside overlapping submissions are deduplicated; repetitions elsewhere remain. Conflicts choose a deterministic candidate while retaining alternatives in history. Missing responses remain pending; a valid empty response counts as received coverage without a no-speech confirmation. VAD observations remain inspectable, but neither suppress provider text nor block learning. Normal corrections use the subtitle editor; **Retranscribe** creates a separate quote.

Quality-profile receipts retain exact boundary samples, kind and supporting pause through review. A forced boundary offers playback around the cut and an explicit review acknowledgement, even when requests have no overlap. It marks a possible split utterance, not a claim of silence, and never deletes the original response. Sample coordinates determine whether acoustic overlap exists; millisecond rounding alone cannot create a conflict or justify removing repeated text. Older receipts and review digests remain readable without adding this metadata.

Each new quote captures the current subtitle rows, and approval activates a device-local publication session. Subtitle changes and the session record commit together. Only unchanged rows in fully received coverage can be replaced; cues crossing an unreceived boundary stay whole. Text/translation edits, added or deleted rows and moved-cue intervals are protected from later results, which remain available in the session. A newer approved request claims its interval from an older job. The previous complete edition is saved once; job completion does not replace the whole list again.

Subtitle edits do not invalidate frozen audio or stop later audio requests. Source, track and language checks remain separate, and selections beyond the current media duration cannot publish. Restoring an edition or importing another subtitle source detaches automatic publication and stops remaining requests before dispatch. Learning restore clears publication authority. Reopening settled results or retrying local application never resends completed requests or changes saved cards.

Vocabulary/explanations validate cited IDs and selected text; dictionary forms preserve the lexeme and semantic roles, and A2/B1/C1 affects the frozen request. Translation rechecks text, timing, language and status before application; quoted instructions remain data and structured content is preserved. Cards retain source/translation snapshots and independent audio; alternative examples are labeled and later transcript/cache edits do not change saved sources.

## Saved responses and local recovery

Audio responses retain bounded, allowlisted evidence in the paid-work database before settlement, bound to the immutable request and parser revision. Evidence includes usable non-thought text, timing/completion information and usage; it excludes credentials, authorization, thought text, tool calls and arbitrary diagnostics. Provider text is rendered as plain text. Oversized values are omitted whole, and malformed JSON retains only a fixed rejection state; incomplete evidence cannot be reparsed. Persistence failure prevents settlement and provider-derived publication. Settlement failure leaves evidence inspectable and the hold intact.

**Transcription history** can locally reparse complete evidence and recover usable settled text, including source blocks. **Use saved results** explicitly applies an eligible complete result; opening history does not replace subtitles. Reparse is idempotent for a parser revision and neither reads audio, uses credentials, sends HTTP nor changes original responses, approvals or charges. Invalid/incomplete candidates and unresolved attempts cannot supply a selected provider reparse result.

The advanced range editor permits manual recovery after pausing the old job and waiting for its in-flight request. Listen to the prepared audio, enter text with positive-width times within its submitted interval, and explicitly confirm no speech if deleting every row. Copied provider text still needs authored times; invalid anchors are never clamped, interpolated or relabeled as valid. Manual revisions remain separate from original evidence, survive later provider responses and reject stale or competing edits.

An unknown cost hold permits local authored correction while remaining reserved. Saving or applying it does not settle, refund, acknowledge or resend that attempt. Applying a complete older result requires a validated effective result or manual revision for every range and rechecks the source and current revision. VAD/boundary reviews are optional; a valid empty provider response needs no extra no-speech decision. Application uses the publication mechanism, records adoption and blocks further sending from that old job. Saved cards and original accounting remain unchanged.

Advanced boundary repair remains a separate, explicitly quoted request of at most 30 seconds, with a comparison alternative. It never runs as an automatic paid fallback.

## Earlier draft bookmarks

Earlier excerpt bookmarks remain available through **Transcript → Transcription history → Open earlier drafts**:

1. Select contiguous received cues, or open the original source block when timing or a response is unavailable.
2. Save a bookmark, edit its text and positive audio range within the source bounds, listen and explicitly confirm the excerpt. Editing text or time requires confirmation again.
3. Enter a term and meaning to save a card with independent text, audio and provenance. Optional explanation requests require a separate estimate/approval; suggestions open a reviewable card form and never save automatically.

Confirmation records a local authored excerpt, not approval of the original timestamps or full track. Warnings remain visible, and untimed text retains only its submitted audio bounds. Replay is marked accepted only after native playback accepts it; the user still must listen and confirm. Caption-group pause is disabled during draft study so unrelated adopted cues do not stop replay.

Source identity/revisions are rechecked, including full hashes at confirmation, card extraction and cloud preparation/approval. Stale editors cannot authorize cards or requests. Editing an excerpt invalidates its unsent quote; received output remains if the source disappears. Bookmark editing, confirmation, card creation and export are local and leave API outcomes/reservations unchanged.

Excerpt JSON identifies selected-range-only coverage. SRT/VTT requires current confirmed cues or authored timing and adds a uniquely named coverage receipt. Enclosing source-block bounds are not exported as synchronized cues, and missing ranges never acquire invented speech.

## Learning backups and operational state

[JSON/ZIP learning backups](data-transfer.md) preserve cards and their source snapshots, phrase/subtitle editor drafts, applied subtitles with timing precision, and earlier bookmarks. ZIP also includes saved card audio. Export/restore removes old source bindings and confirmation authority from portable drafts/bookmarks; restored bookmarks need a new source selection before confirmation or card creation.

Transcript-review revisions, selections and publication sessions are device-local operational data: portable exports omit them and learning restore clears them. Paid jobs, approvals, provider evidence and charge ledgers remain separate and are not transferred as learning data. Restoring learning content cannot revive a job's approval or publication authority.

## Development verification

The application supports Vertex and OpenAI; local recognition models and alternate runtimes are not automatically substituted. The development-only [Vertex validation CLI](vertex-verification.md#build-and-initialize-the-cli) uses a separate data root, supports explicitly approved requests and offline saved-response review, and is excluded from application distribution. The [test guide](testing.md) covers offline regressions, isolated live evaluation, and real FFmpeg, libmpv and Silero checks. Ordinary CI sends no paid provider requests.
