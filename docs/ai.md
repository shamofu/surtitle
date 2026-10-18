# AI, audio preparation, and spending

Rust owns credentials, immutable requests, usage accounting and transcript review. No IPC returns service-account JSON or access tokens. Generated content is labeled for comparison with the source. [Vertex setup](vertex-verification.md) covers application and development CLI configuration.

## Model selection

Transcription, vocabulary, explanations and translation have separate, initially unset model preferences. **Set up the recommended combination** assigns Transcribe to transcription and Flash to the other purposes; replacing existing settings requires explicit selection. Publisher suggestions and manually entered Gemini IDs do not prove project access. Location or credential changes invalidate suggestions.

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
5. A valid response is saved and settled once. Completed requests cannot be resent. Pause and cancel stop later requests; they cannot revoke work already being processed by Google.
6. Timeouts, interrupted connections and unresolvable usage stop automatic progress and retain the hold. Acknowledging an unknown outcome does not refund it. Retrying requires a reviewed quote and separate approval.

The native scheduler shares request turns between interactive and bulk work. A known in-flight request queues other work; an unknown outcome blocks sending. Waiting for pacing releases the lane, but never bypasses approval or accounting checks.

Production transport uses fixed Google HTTPS endpoints, bounded responses, no redirects and no hidden transport retries. Only the transcription worker performs the explicitly approved HTTP 429 retries below. Other AI operations and the development validation CLI keep single-attempt approval behavior.

### Transcription rate limits and retries

New transcription approvals permit at most two automatic retries per chunk for HTTP 429: three sends total. They reuse the same prepared audio and context, never resend completed chunks, and recheck approval, source and limits before each send. Older approvals do not gain retries. Timeouts, disconnections, invalid usage and other HTTP errors are never automatically retried.

Congestion pacing persists per project/model/location across reapproval and restart. The latest retry-backoff, cooldown or valid `Retry-After` deadline controls sending; server waits are never shortened. A wait longer than five minutes or a third 429 stops for review. Progress shows chunk, retry count and wait, with pause/cancel available. Restart needs fresh approval; UI countdowns do not dispatch requests.

A 429 is distinct from an unknown connection outcome, but does not prove that the rejected request was free. Its reservation or unpriced attempt remains counted; each retry creates another reservation. Priced approval covers all permitted sends. Unpriced approval covers their maximum request count, audio duration and output limit without promising a dollar cap. Older unknown-outcome records still require acknowledgement before fresh approval. No retry changes the model or restores revoked approval.

Valid usage can settle a response even when its content is rejected. Transcribe's STOP response can omit output-token count only when explicit input/total counts agree and related counts are absent or zero; other missing or invalid usage retains the hold.

## Prices and limits

Billing metadata is queried on request. Ambiguous or incomplete prices remain unset; users may enter input/output rates, including explicit zero. Each quote retains its price snapshot. Changing the model or location clears the edited price for review. There is no dated model/price catalog.

Per-job, daily and monthly budgets independently use zero to mean unlimited; positive limits still apply and all usage remains recorded. Daily/per-job settings follow monthly changes only while they match, preserving overrides. Calendar periods use UTC. Known usage belongs to dispatch date; unknown priced holds remain counted across day/month boundaries.

Reservations conservatively cover input/audio and the output ceiling, including reasoning tokens. Settlement rounds upward in micro-USD and counts cached input at the supplied rate. Application limits cannot cap provider invoices or control other applications/devices, taxes, later prices or billing adjustments.

Unpriced jobs require explicit approval of the full request count, submitted audio and generation settings. Successful unpriced attempts retain usage as uncalculated cost; they are neither zero-cost requests nor unknown network outcomes. The UI separates calculated subtotals from unpriced-attempt counts.

## Local audio preparation

Preparation downloads the pinned streaming Silero model on first use, verifies size and SHA-256, and uses bundled CPU ONNX Runtime. This sends no media to Google. The selected FFmpeg/ffprobe pair is retained for the operation and verified before use.

FFmpeg decodes the selected stream/range once to mono 16 kHz PCM. Streaming VAD and bounded encoders produce exact FLAC ranges without memory growth proportional to recording length. Complete coverage is verified before a receipt; an early file is not a complete estimate or approval. Cancellation, source changes and errors stop owned processes and remove incomplete output; success removes temporary PCM.

Chunks follow nearby pauses where possible and add overlapping context. VAD never deletes audio or compresses its timeline: core intervals cover the original samples once, and all submitted overlap counts toward estimates. Receipts bind source/stream identity, tools, VAD model and generated audio. Immutable audio may be reused for a new model quote, but source, stream or byte changes invalidate reuse and require a new estimate.

## Transcript review and learning content

Text validity and word timing are independent. Usable word anchors produce timed cues. Missing, reversed, out-of-range or unaligned anchors retain the original text as a `source_block`, displayed as **Audio range**, with the exact submitted interval including context. These bounds identify source audio, not sentence/word timing. Source blocks support reading, translation, explanations and cards; synchronized captions, caption-group pause and SRT/VTT omit them. A card may use an explicit audio subrange of at most 180 seconds within the block.

Only shared word anchors inside overlapping submissions are deduplicated; repetitions elsewhere remain. Conflicts choose a deterministic candidate while retaining alternatives in history. Missing responses remain pending; a valid empty response counts as received coverage without a no-speech confirmation. VAD observations remain inspectable, but neither suppress provider text nor block learning. Normal corrections use the subtitle editor; **Retranscribe** creates a separate quote.

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

Vertex is the production provider; local recognition models and alternate runtimes are not automatically substituted. The development-only [validation CLI](vertex-verification.md#build-and-initialize-the-cli) uses a separate data root, supports explicitly approved requests and offline saved-response review, and is excluded from application distribution. The [test guide](testing.md) covers offline regressions and real FFmpeg, libmpv and Silero checks. Ordinary CI sends no Vertex requests.
