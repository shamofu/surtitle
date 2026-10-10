# Opt-in live transcription

`full-transcription.e2e.js` exercises the actual Tauri audio preparation, quote,
UI approval, Vertex worker, progressive subtitle publication and final application.
It is outside the ordinary `e2e/native/**/*.e2e.js` test glob. Run it only for
audio and API spending explicitly authorized by the user.

Use a fresh, isolated `SURTITLE_E2E_DATA_DIR` and the current native binary built
with `e2e-test,custom-protocol`. Keep `SURTITLE_E2E_AI_RECOVERY` and
`SURTITLE_E2E_TRANSCRIPT_REVIEW` unset. Follow the [native setup](../README.md#native-setup)
for the runtime and drivers. The profile needs its own settings and protected
credential storage; do not point this test at the installed application's data.
The existing runner requires a `fixture.json` marker in the isolated profile.

Set `SURTITLE_LIVE_MANIFEST` to an absolute path to a JSON file with these fields:

| Field | Meaning |
| --- | --- |
| `format` | `surtitle.live-transcription.v1` |
| `dataDir`, `sourcePath` | Absolute isolated profile and authorized original video paths |
| `sourceSha256`, `durationMs` | Verified whole-video identity and container duration; only up to 2ms of audio sample rounding is accepted |
| `learningLanguage`, `explanationLanguage` | Language codes matching the imported media |
| `modelId`, `location` | Reviewed transcription model and Vertex location |
| `inputMicrousdPerMillion`, `outputMicrousdPerMillion` | Verified prices matching the profile's model configuration |
| `expectedChunks`, `maxRequests` | Reviewed full-video chunk count and maximum sends, including two retries per chunk |
| `maxCostMicrousd` | Remaining authorized total API budget, in microdollars |
| `timeoutMs` | Optional observation limit; defaults to 90 minutes |
| `localPreparationTimeoutMs` | Optional local preparation limit; defaults to 15 minutes |

For this investigation the total API budget is $10, with $0.001166 already spent,
so `maxCostMicrousd` is `9998834` ($9.998834). The spec refuses a higher amount.
It applies this remaining amount to all three isolated ledger limits and verifies
their stored integers before approving. The worst-case quote must fit the cap;
unpriced requests cannot start. Manifest files and artifacts must not contain
plaintext credentials.

Run the selected spec without `SURTITLE_LIVE_EXECUTE` first:

```powershell
pnpm test:e2e --spec ./e2e/live/full-transcription.e2e.js
```

This verifies the original source, prepares its full audio locally, opens the
rendered quote and saves `live-quote.json` and `live-quote.png`, without a paid
request. A uniquely matching native preparation is reused after an interrupted
local check. The quote stage is tied to the manifest's exact bytes.

After inspecting that quote within the user's authorization, run the same command
with `SURTITLE_LIVE_EXECUTE=1`. The spec checks the quote again and clicks the
rendered **Start transcription** button once. `live-execution-started.json` is
created exclusively before that click; its presence prevents any repeat execution
of this profile. The spec never reapproves, acknowledges unknown outcomes, or
resumes through a separate CLI. On failure it pauses a running job and retains
the evidence for inspection; do not delete the marker to bypass this safeguard.

`live-evidence.jsonl` records changing progress, counts and costs.
`live-partial.png` captures published subtitle rows before completion.
`live-result.json` and the final screenshot record completion or failure. Success
requires every chunk to settle and the subtitles to be applied, not merely the
provider's last response. A successful run without HTTP 429 does not itself
demonstrate live throttling; deterministic offline tests cover that failure path.
