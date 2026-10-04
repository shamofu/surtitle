# Verify Vertex AI with your credentials

Use Windows 11 x64. The application and development CLI share [approval and accounting rules](ai.md). Local preparation sends no generation request; execution requires explicit approval. The CLI uses a separate validation data directory and is not bundled with the application.

## Google Cloud setup

Use a billing-enabled test project with the Vertex AI API enabled and an appropriately authorized service account, such as Vertex AI User for the model project. Check organization restrictions and the current model/location availability. See Google's [getting-started guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start) and [access control](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/access-control).

Keep the JSON key outside the repository, container, chat, and public CI. Import it through the native file dialog or CLI. Rust stores a Windows DPAPI-protected copy; the UI never receives key contents. See [Google's key instructions](https://docs.cloud.google.com/iam/docs/keys-create-delete).

## Application workflow

Launch an installed build, or build the app using the [native runtime guide](native-runtime.md).

1. Open Settings and import the service-account JSON. The read-only project ID comes from this key; check it and choose the location. Import another JSON key to change the project.
2. Fetch Google suggestions once and use them for transcription, vocabulary, explanations, and translation, or enter exact Gemini model IDs directly. Each purpose has a separate, initially unset selection. Discovery is not proof of access.
3. Choose **How to create subtitles** and keep the recommended standard output limit for typical requests. Detailed output/thinking settings must be supported by the selected model.
4. Fetch a price or enter independently verified rates. A failed or ambiguous lookup leaves pricing unset. An unpriced job needs explicit scope approval and cannot promise a dollar cap. For priced jobs, set a small nonzero **Monthly AI budget** and adjust daily/per-job limits in detailed settings if needed. All limits initially start at zero; any zero limit blocks priced jobs. Save the settings.
5. Import a short source and select the exact range. Review the resulting model, location, request count, submitted audio including overlap, output limits, price, and immutable quote before approving.
6. Inspect the result before saving a card or applying subtitles. Review, adoption, and applying an already received translation are local operations with no generation charge.

Local audio preparation uses the selected source audio track and saves the split plan and immutable audio without a generation charge. It can be reused after restart. Model selection does not regenerate unchanged prepared audio.

Transcript review shows pending chunks, original responses, boundary alternatives, and VAD no-speech warnings. Resolve required reviews and separately acknowledge adoption. A stale source revision or digest prevents application. Repair prepares at most 30 seconds and requires its own approval; it does not overwrite a boundary automatically.

## Correct a transcript

Open the saved transcription review after execution. For an invalid or missing range, select **Audio range to correct**, listen to the original, and enter subtitle text and positive-width times. **Add text from saved response** copies only text and requires new timing entries. Deleting all rows requires a separate confirmation that the complete range contains no speech. Save the correction, resolve affected boundaries and warnings, then acknowledge and adopt the complete preview.

**Return to previous result** deselects the manual correction and restores the provider result or explicitly selected local reparse. Original responses remain inspectable, and saved cards remain unchanged.

Even a valid empty provider response requires explicit no-speech confirmation in its range editor before adoption. Pause an active job and wait for its in-flight request before saving a correction. An unknown cost hold permits local editing while remaining fully reserved. Adoption prevents further sending from that job. See [transcript evidence and local review](transcript-evidence.md) for recovery rules, or [draft study](draft-study.md) to learn from an excerpt before the complete transcript is ready.

## Build and initialize the CLI

Run from the repository root. Select a new validation directory rather than normal application data.

```powershell
pnpm rust build -p surtitle-ai-validation --locked
$validator = Join-Path (Get-Location) 'target\debug\surtitle-ai-validation.exe'
$validationRoot = Join-Path (Get-Location) 'work\vertex-validation'
New-Item -ItemType Directory -Path (Split-Path $validationRoot) -Force | Out-Null
& $validator init --data-root $validationRoot --total-usd 5 --per-job-usd 2 --daily-usd 5 --monthly-usd 5
& $validator import-key --data-root $validationRoot --key-file 'C:\Keys\surtitle-validation.json'
$credentialId = 'COPY_THE_RETURNED_CREDENTIAL_ID'
& $validator check-key --data-root $validationRoot --credential-id $credentialId
```

Choose monetary limits before execution; the values above are examples. An existing root cannot be reinitialized to reset usage.

Google discovery and price lookup perform OAuth/metadata requests, not generation:

```powershell
& $validator list-models --data-root $validationRoot --credential-id $credentialId --location global
& $validator lookup-price --data-root $validationRoot --credential-id $credentialId --location global --model-id EXPLICIT_MODEL_ID
```

Replace `EXPLICIT_MODEL_ID` with the selected model. A price lookup may fail because the metadata API is unavailable or permission is missing, even if generation works. Review a public/manual rate or explicitly choose unpriced scope.

## Prepare one text request

Every prepare command requires the exact model ID, location, and output cap. Replace the model placeholder and use thinking settings supported by that model. For explanation or translation, substitute the corresponding example task JSON and a different case ID.

```powershell
& $validator prepare --data-root $validationRoot --credential-id $credentialId `
  --case-id quick-vocabulary --task-file (Join-Path (Get-Location) 'docs\examples\vertex-vocabulary.json') `
  --model-id EXPLICIT_MODEL_ID --location global --max-output-tokens 4096 --thinking-level LOW
```

This example leaves pricing unset. To use monetary reservations, add a verified price file through --price-file with an absolute path. Its JSON fields are id, source, observed_at_ms, input_microusd_per_million, and output_microusd_per_million. Rates are integer micro-USD per million tokens; observation time is Unix milliseconds. Do not copy a dated rate without checking its applicability.

Inspect quote.id, quote.digest, execution settings, source identity, remaining limits, and approveChargeUsd. Preparing never grants execution permission.

## Approve and run

Copy the values only after reviewing the quote. Priced execution requires the exact displayed reservation, up to six fractional USD digits:

```powershell
$jobId = 'REVIEWED_JOB_ID'
$digest = 'REVIEWED_DIGEST'
$approvedUsd = 'EXACT_DISPLAYED_RESERVATION'
& $validator show --data-root $validationRoot --job-id $jobId
& $validator run --data-root $validationRoot --job-id $jobId --digest $digest `
  --acknowledge-unqualified --approve-charge-usd $approvedUsd
```

For an unpriced job, replace `--approve-charge-usd` and its value with `--approve-unpriced`. This acknowledges the bounded scope and the absence of a dollar guarantee. `--acknowledge-unqualified` confirms that generated content requires review even when schema validation succeeds.

The worker sends once, records bounded evidence, and settles valid usage. Inspect semantic quality separately. An invalid output can be charged yet rejected. Unknown outcomes retain their hold; no automatic retry occurs.

To consider a retry, first inspect and acknowledge the specific unknown attempt if applicable, refresh its quote, then review and explicitly run with --retry. Acknowledgement alone does not resend or release a hold.

```powershell
& $validator acknowledge-unknown --data-root $validationRoot --attempt-id 'REVIEWED_ATTEMPT_ID'
& $validator refresh-quote --data-root $validationRoot --job-id $jobId
```

The default validation scope permits at most 120 attempts and 90 minutes of audio per root, in addition to priced monetary limits. An explicitly quoted and approved scope extension preserves the root's lifetime monetary ceiling and previous charges/holds. Lifetime limits persist across restarts and UTC day/month boundaries.

## Prepare a short audio request

Use audio you have permission to send to the provider. Begin with a clearly spoken 10–15-second sample. The CLI measures a complete mono 16 kHz PCM16 WAV and requires an explicit maximum from 1 to 240 seconds.

```powershell
ffmpeg -nostdin -hide_banner -n -ss 0 -i 'C:\Media\owned-speech.mp4' `
  -t 15 -vn -ar 16000 -ac 1 -c:a pcm_s16le (Join-Path $validationRoot 'speech-15s.wav')
& $validator prepare --data-root $validationRoot --credential-id $credentialId `
  --case-id speech-en-01 --audio-file (Join-Path $validationRoot 'speech-15s.wav') `
  --adapter transcribe --language en --max-audio-seconds 15 `
  --model-id EXPLICIT_TRANSCRIBE_MODEL_ID --location global --max-output-tokens 4096
```

Replace the model placeholder and review the audio, hash, location, measured duration and price state before approval. Each job contains one request. Failures never trigger automatic model switching.

## Preserve and inspect evidence

```powershell
& $validator report --data-root $validationRoot --output (Join-Path $validationRoot 'report-001.json')
```

Reports refuse to overwrite existing files; use a fresh filename. Reports include usage, cost state, holds, timestamps, parsed output, and bounded non-thought generated text/word timing. They exclude credentials, tokens, thought text, and arbitrary provider diagnostics. Generated text may contain the supplied material, so review it before sharing.

Use the application for subtitle playback and export.

The offline review-audio command verifies prepared WAVs and a saved report, then runs the same rebasing/stitching engine as the application. It requires no data root, key, or network:

```powershell
& $validator review-audio --review-manifest 'C:\Evaluation\review-manifest.json' `
  --results 'C:\Evaluation\report.json' --output 'C:\Evaluation\stitched-review.json'
```

See the [test guide](testing.md) for offline regressions and native integration checks. These tests verify application behavior; generated text and timing still require review against the source audio.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Key import/decryption failure | JSON format, file presence, original Windows user; never fall back to plaintext |
| Authentication failure / 401 | Key/service-account status and system clock |
| 403 | Relevant API, billing/project permissions, organization restrictions; metadata permissions can differ from generation |
| 404 / unsupported model | Exact model ID, location, project availability, and Preview terms |
| Unsupported thinking or adapter | Explicit settings against the selected model's contract; prepare a new reviewed configuration |
| 429 / server error / disconnect | Stop and inspect the recorded attempt/hold before separately approving any retry |
| Missing or ambiguous price | Verify a manual rate or explicitly approve unpriced scope; do not treat it as zero |
| Invalid content or timestamps | Preserve the response, inspect against source audio, and reject unusable output even if usage was settled |
