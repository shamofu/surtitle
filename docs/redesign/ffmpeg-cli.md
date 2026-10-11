# FFmpeg CLI evaluation — 2026-10-11

Gyan FFmpeg 9.0.2 passed the production audio preparation and card extraction checks used here. The six-minute fixture reached prepared audio in a mean 11.01 s with the candidate versus 13.37 s with the current custom 9.0.1 CLI. This is an observed 17.65% reduction for these binaries and this fixture, not an isolated measurement of the FFmpeg patch version: compiler, configuration, file size, run order, and host load also differ.

No installed profile, production executable, native DLL, or dependency manifest was changed. The existing managed updater already resolves Gyan's current release dynamically; it is not pinned to 9.0.1. Keep that resolver. The custom 9.0.1 binary remains external and user managed.

## Provenance

[FFmpeg's download page](https://ffmpeg.org/download.html) lists 9.0.2, released September 18, 2026, as its latest stable release and links Gyan as a third-party Windows builder. [Gyan's release page](https://www.gyan.dev/ffmpeg/builds/) lists the September 19 build. FFmpeg itself provides source releases, not these Windows binaries.

The isolated candidate was `ffmpeg-9.0.2-essentials_build.zip`, 114,768,076 bytes, downloaded from the versioned Gyan package URL. Its SHA-256 matched the [provider's checksum](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256):

```text
60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba
```

This is a checksum from the same HTTPS provider, not an independent publisher signature. It matches the application's existing `HttpsSha256` verification semantics. The package retains its GPL v3 `LICENSE` and `README.txt`, whose hashes are in the evidence. The README identifies [FFmpeg source commit 946fcce07b](https://github.com/FFmpeg/FFmpeg/commit/946fcce07b).

| Executable | Current | Candidate |
| --- | --- | --- |
| Version | n9.0.1 custom build | 9.0.2 Gyan essentials |
| Compiler | GCC 10.2.0 | GCC 16.2.0 |
| FFmpeg size | 117,566,464 B | 105,423,872 B |
| Nonfree configuration | Enabled; external only | Absent |
| FLAC and PCM16 encoders | Present | Present |

## Results

Both CLIs ran the same existing Rust 1.99 `redesign_preparation` executable. Each invocation runs three alternating serial/staged pairs on one six-minute synthesized English fixture, plus real cancellation and source-replacement cleanup checks. Across CLI versions, the current tool ran before the candidate. All executable hashes, configuration strings, and individual measurements are in [the JSON evidence](evidence/ffmpeg-cli-2026-10-11.json).

| Check | Current 9.0.1 | Candidate 9.0.2 |
| --- | --- | --- |
| Mean staged preparation | 13.3666 s | 11.0073 s |
| Mean first completed FLAC | 7.7216 s | 6.4145 s |
| Cancellation/source-change cleanup | Passed | Passed |
| Native-rate WAV tail, no EOF padding | Passed | Passed |
| Source clock and failed-output cleanup | Passed | Passed |
| Selected stream in multitrack media | Passed | Passed |

The source-clock test covers 44.1/48 kHz WAV, AAC, MP3, multiple short ranges, tail ranges, nonzero container origin, and delayed audio with a six-hour timestamp offset. The offset case is not a six-hour media-duration benchmark. These are the exact ignored native tests registered in the required FFmpeg suite; each reported one pass and zero skips for each binary.

The three chunk boundaries, VAD pause evidence, source identity, and every decoded PCM byte matched across versions. FLAC container hashes differ; encoder metadata reads `Lavf63.1.101` and `Lavf63.1.102`. The immutable preparation settings digest also correctly differs because it includes the exact FFmpeg tool snapshot. A receipt or approval for the old tool cannot be reused as evidence for the candidate. The evaluator checks unchanged source scope and changed tool-bound settings separately.

This evaluation used no credentials, cloud requests, recognition provider, or installed user data. It does not establish recognition quality or general performance across codecs and hardware.

## Reproduction

Use PowerShell 7 from the repository root. Keep the FFmpeg/ffprobe pair from each package together. Verify the downloaded archive before extracting it. The candidate remains under `work/ffmpeg-cli-evaluation/extracted/ffmpeg-9.0.2-essentials_build` with its notices.

The recorded run reused the existing compiled preparation example and exact native test binaries to avoid changing build conditions between candidates:

```powershell
$repo = (Get-Location).Path
$ffmpegEvaluationArgs = @{
  BaselineFfmpeg = 'C:/Users/shamo/ffmpeg/ffmpeg.exe'
  CandidateFfmpeg = "$repo/work/ffmpeg-cli-evaluation/extracted/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe"
  Source = "$repo/work/ai-evaluation/speech-six-minutes.flac"
  Model = "$repo/work/native-fixtures/silero_vad.onnx"
  Runtime = "$repo/src-tauri/resources/native/onnxruntime.dll"
  PreparationExecutable = "$repo/work/rust-1.99-target/debug/examples/redesign_preparation.exe"
  AppTestExecutable = "$repo/work/rust-1.99-target/debug/deps/surtitle_app-f75e56dd3f5d2c79.exe"
  ToolsTestExecutable = "$repo/work/rust-1.99-target/debug/deps/surtitle_tools-e542d526888b12f7.exe"
  OutputDirectory = "$repo/work/ffmpeg-cli-evaluation/repeat"
}
./e2e/evaluation/ffmpeg-cli.ps1 @ffmpegEvaluationArgs
```

For a clean checkout, build `surtitle-ai --example redesign_preparation --all-features` and the `surtitle`/`surtitle-tools` library tests with Rust 1.99 (`surtitle` requires `--features e2e-test`). Supply the resulting executable paths; their hashes will be recorded. Test binary suffixes can change. Use a fresh output directory for a new run. `-SummarizeOnly` rechecks retained `baseline.json`/`candidate.json` reports without launching another native process.
