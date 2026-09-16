# AI, audio preparation, and spending

The Rust AI crate owns credentials, immutable inputs, requests, usage accounting, and transcript review. No IPC returns service-account JSON or access tokens. Live test results are evidence about the tested inputs, not a guarantee of general model quality; see [status](status.md) and the [test plan](ai-test-plan.md).

## Model selection

There is no local model catalog or version allowlist. Settings contain separate, initially unset preferences for transcription, vocabulary, explanations, and translation. Each job can explicitly override its preference. Google publisher discovery supplies suggestions; a syntactically valid Gemini ID can also be entered directly. Discovery does not establish that the user's project has access.

ExecutionConfig freezes the model ID, location, output limit, thinking configuration, and optional price snapshot. PreparedJob also freezes request bodies, media/source revision, settings digest, project, and credential identity. Changing these inputs requires a new quote. No running job changes model automatically.

The transcription API mode is explicit: Transcribe uses VERBATIM with word timestamps; the general audio adapter requests structured subtitle cues. An adapter is a wire-format choice, not a promise that every entered model supports it. Unsupported modes or settings fail visibly. The initial comparison targets are gemini-3.5-transcribe-preview and gemini-3.8-flash; they are evaluation inputs, not an execution allowlist.

Quality review does not unlock models through a hidden catalog. Users explicitly acknowledge the scope and the need to review generated content. Product completeness still requires evidence that the intended workflows meet the quality criteria.

## Credentials and dispatch

1. A native file dialog supplies the service-account JSON path to CredentialVault. Rust validates the format and fixed OAuth endpoint, then uses per-user Windows DPAPI. Plaintext fallback is not supported.
2. The data directory has an exclusive process lock. Startup recovers interrupted dispatches as unknown outcomes and revokes stale execution approval. Unsent work requires renewed approval after restart.
3. Preparation hashes immutable inputs and body templates. Equivalent plans reuse the same job. A quote is valid for approval for 30 minutes; that is not a 30-minute execution limit for an already approved immutable plan.
4. SQLite reserves one request before dispatch. The ledger permits only one active request at a time. After authentication and input checks, dispatch validation rechecks approval, digest, cancellation, current limits, and the reservation before sending.
5. A valid response is saved and settled once. Completed requests cannot be resent. Pause and cancellation stop subsequent requests; they cannot revoke a request already being processed by Google.
6. Timeouts, interrupted connections, and unresolvable usage retain the appropriate hold and stop automatic progress. Acknowledging an unknown outcome does not refund it. Retrying requires a reviewed quote and separate approval.

The production transport uses fixed Google HTTPS endpoints with bounded responses, no redirects, and no automatic retries. Test authentication, transport, and clocks are private test-only interfaces, not application IPC features.

## Prices and limits

Google Billing metadata is queried on request. Matching is conservative: ambiguous or incomplete prices remain unset. Users may enter their own input/output rates, including explicit zero rates. A snapshot records its source, observation time, and integer micro-USD rates. Changing the model or location in the editor clears the previous price for review. There is no built-in dated model/price catalog.

For priced jobs, per-job, daily, and monthly budgets start at zero and must cover the reservation. Input reservations use conservative byte/audio bounds; the configured output limit includes generated reasoning tokens. Usage settlement rounds upward in integer micro-USD. Cached input is conservatively counted at the supplied input rate. Prices and limits are an application accounting policy, not a provider-backed invoice cap.

For unpriced jobs, the user must explicitly approve the complete request count, submitted audio duration, and generation settings. A dollar ceiling cannot be calculated or guaranteed. Successful unpriced requests retain usage and a distinct uncalculated-cost state; they are not unknown network outcomes and are never represented as zero cost. The UI shows the calculated subtotal and the count of unpriced attempts separately.

Unknown priced reservations remain counted across UTC day/month boundaries. Known usage is attributed to the dispatch date. Costs from another device/application, taxes, future price changes, and billing adjustments are not controlled by this ledger. Reference: [Google pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).

## Local audio preparation

The first explicit preparation downloads the pinned Silero model into app data, verifies its size and SHA-256, and uses the bundled CPU ONNX Runtime. This does not send media to Google. Tool leases retain the selected FFmpeg/ffprobe pair; executable hashes are checked before processing.

The chosen absolute audio-stream index is used for extraction. FFmpeg decodes the selected range once into mono 16 kHz PCM. Silero processes 512-sample windows with context and recurrent state. The same stream is written to temporary PCM, then exact sample ranges are encoded to FLAC. Memory does not grow with the complete audio length. Temporary PCM is removed after successful preparation; cancellation and errors terminate and reap child processes.

Chunks target 120 seconds, normally selecting pauses within 90–150 seconds and never exceeding 180 seconds. Pauses of at least 500 ms are preferred, then 200 ms pauses; forced boundaries remain possible. Each submission adds up to three seconds of context on either side. VAD does not delete audio or compress the timeline. Core intervals cover the original samples once, while send intervals deliberately overlap and are all counted in estimates.

The receipt binds sample intervals, source/stream identity, tools, VAD model, and generated audio hashes. Saved immutable audio can be reused without regenerating it. Changing the execution model can create a new quote for those inputs; changing source audio, selected stream, or prepared bytes invalidates reuse. Regenerated inputs require a new estimate.

## Transcript review and learning content

The review engine rebases saved responses onto the source timeline. It retains originals, pending ranges, and conflicting boundaries. Only matching text at matching times is deduplicated; repetition elsewhere remains intact. A disagreement retains both alternatives for explicit selection or editing. Missing responses are pending, not silence. Provider validation state remains separate from the effective source selected for each range: a provider result, a locally reparsed candidate, a manual revision, or an unresolved range.

An invalid or missing range can be recovered locally by listening and entering subtitle text with positive-width times inside its prepared audio interval, including overlap. Manual times are authored subtitle intervals, never provider word timestamps. Empty rows are rejected unless the user explicitly confirms no speech for the complete range. The immutable revision binds the job and preparation, source hash and subtitle revision, ordinal, request interval, prepared audio hash, and frozen request hash. Returning to the previous non-manual result or reselecting a saved correction changes the selection version without deleting its history. Later provider results remain inspectable and do not overwrite a selected manual correction.

When VAD detects no speech in a submitted range but the selected result contains subtitles, the draft carries a warning and remains unadoptable until explicitly reviewed. This also applies to manually authored text. Acknowledgement changes the digest and preserves the original result. It is not evidence that the model output was correct and does not silently remove hallucinated text.

New local preparations also retain sustained low-posterior pauses within otherwise spoken chunks. These use the same Silero inference frames, with posterior below 0.35 throughout at least two seconds; each end receives a 250 ms inward guard. A selected cue wholly inside such a guarded interval requires explicit review. The evidence binds the policy, model/runtime hashes and original PCM sample ranges. It estimates a pause, rather than proving silence, and never deletes words, changes timestamps or supplies missing output. Whole-chunk no-speech warnings retain priority to avoid duplicate acknowledgements.

Every range must have an effective validated result or an explicit manual revision, including confirmed no speech, and required boundary and VAD reviews must be complete before adoption. Provider results may therefore remain invalid or missing while a separately authored correction supplies the reviewed preview. Changing a selected revision or its version rebuilds affected boundary alternatives and warnings; only decisions whose complete content and provenance identity still matches survive. Old adoption digests cannot become valid again merely by returning to an earlier selection.

Manual saving requires an inactive job and no in-flight reservation for that job. Pause stops subsequent sends; a dispatched request must finish or become an unknown outcome before editing. An unknown cost hold does not prevent local correction or adoption, but remains reserved and is never refunded, settled, acknowledged, or retried by editing. The user separately acknowledges the complete subtitle replacement. Applying subtitles and recording adoption use one SQLite transaction; stale source revisions, old digests, and partial replacement of an existing cue are rejected. Adoption never resumes sending, and the native approval path blocks further execution of an adopted job. Reopening an adopted result does not overwrite later subtitle edits or saved cards.

Manual revision history and selections are device-local operational data, excluded from portable learning exports and cleared by learning restore. They cannot recreate an execution approval. Provider evidence and the cost ledger remain separate; see [transcript evidence](transcript-evidence.md).

Boundary repair prepares at most 30 seconds as a separate job bound to the parent boundary and current draft digest. It inherits the parent's execution configuration unless explicitly overridden. It requires its own quote/approval. Received repair text is retained as an alternative and never automatically replaces the originals.

Vocabulary and explanation requests validate source cue IDs and selected text. Dictionary forms must preserve the same lexeme and semantic roles. A2/B1/C1 affect the frozen explanation request. Translation validates every source ID and checks source text, timing, language, and status again before local application. Quoted instructions remain translation data; URLs, code, JSON, and placeholders are preserved.

Cards use a consistent snapshot of the cited source text, complete source translation when available, and audio spanning the cited adjacent cues. A generated alternative example is labeled separately. Card audio and source snapshots are independent of later subtitle or media-cache edits.

## Validation CLI and regression tests

The development-only validation binary uses a separate data root and is excluded from application distribution. Every preparation explicitly supplies a model, location, and output cap. Audio requires a complete mono 16 kHz PCM16 WAV and an explicit maximum duration from 1 to 240 seconds. Each job contains one request; cumulative ceilings are 120 attempts, 90 minutes of audio, and the explicitly configured monetary budget for priced jobs.

The offline review-audio utility checks prepared audio hashes and saved results, rebases them, and runs the production stitching/review engine. It needs no credential or ledger and never sends a request. See [CLI instructions](vertex-verification.md) and [evaluation tools](../scripts/ai-tests/README.md).

Fixed tests cover zero budgets, unpriced approval, immutable body/digest binding, changed settings, concurrent reservations, cancellation during authentication, crash recovery, double settlement, replay rejection, DPAPI, malformed usage, invalid structured output, and transcript warnings. A valid usage record can settle a response whose content is rejected; malformed content is not made usable merely because it was charged.

Transcribe's STOP response may omit output-token count only when explicit input and total counts agree and other related counts are absent or zero. This narrow compatibility rule does not convert arbitrary missing/invalid usage to zero, nor turn unknown content into silence.

## Six-hour local processing evidence

A Windows x64 test processed a real 21,600-second mono 16 kHz silent FLAC through FFmpeg, Silero, FLAC encoding, hashing, and receipt creation on 2026-09-08. It sent zero cloud requests.

| Measurement | Observed value |
| --- | --- |
| Preparation elapsed time | 122.2166538 seconds |
| Chunks | 180 |
| Core samples | 345,600,000; no gaps or duplicate core coverage |
| Submitted samples including context | 362,784,000 |
| Additional context | 1,074 seconds |
| Rust test process peak working set | 51,228,672 bytes |
| Finished audio and receipt | 5,850,165 bytes |
| Temporary PCM | Removed on successful completion |

This synthetic silence test measures local processing, not speech accuracy, sentence boundaries, general codec speed, or total application memory. The working set excludes external FFmpeg processes and OS cache. Test-only optimization enabled sha2/surtitle-tools at level 3 and surtitle-ai at level 1 without disabling hashing. A 360-second watchdog requests cancellation; it does not guarantee termination by that deadline.

```powershell
pwsh -File scripts/native-prepare.ps1 -WithDevModel
$env:SURTITLE_TEST_FFMPEG = 'C:\Tools\ffmpeg\ffmpeg.exe' # Select an existing executable.
$env:SURTITLE_LONG_AUDIO_FILE = Join-Path (Get-Location) 'work/native-fixtures/six-hour-silence.flac'
pnpm rust test -p surtitle-ai --locked six_hour_streaming_acceptance --offline `
  --config 'profile.test.package.sha2.opt-level=3' `
  --config 'profile.test.package.surtitle-tools.opt-level=3' `
  --config 'profile.test.package.surtitle-ai.opt-level=1' `
  '--' --ignored --nocapture
```

Generate the specified silent fixture first if it does not exist. The original report is under the ignored work/ai-six-hour-acceptance directory. Native manifests and each receipt record actual DLL/model/tool hashes. Development model placement is not included in the application bundle.
