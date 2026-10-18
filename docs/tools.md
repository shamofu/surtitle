# CLI tools

`surtitle-tools` owns executable discovery, validation, bounded processes and private managed storage. Native libmpv and ONNX Runtime loading are separate and never search PATH for DLLs.

## Selection and use

FFmpeg/ffprobe has a managed or external selection. FFmpeg and ffprobe must come from the same package directory. Local audio extraction and embedded subtitle inspection use this pair.

Startup discovery and rescanning read fixed executable names without running candidates or changing selections. Selecting a candidate resolves and probes it. Windows supports native `.exe` files and simple Scoop `path = ...` shims. Shell scripts, aliases and shims needing arguments, environment expansion, cwd changes or elevation are not interpreted; select the underlying executable. Saved shim paths and junctions are resolved again for each job.

Each job holds exact executable snapshots and verifies their hashes before every process starts. Processes use literal arguments without a shell, bounded output, deadlines and cancellation. Windows Job Objects and Unix process groups clean up child processes; they are not a sandbox for hostile executables. The frontend has no generic process-execution IPC.

Receipts retain selected/resolved paths, hashes, observed versions and capabilities, including ffprobe.

Audio extraction refuses overwrites and produces mono 16 kHz WAV/FLAC. Its selected stream is an absolute FFmpeg index (`-map 0:<index>`), not an audio-only ordinal or mpv track ID. The source fingerprint and output duration are checked before AI upload.

## Managed updates

Background checks wake every 15 minutes and cache successful installed-tool metadata for 24 hours. **Check updates** bypasses that cache but does not install or activate anything. Checks skip external selections and missing managed tools; stale responses are discarded after provider or installation changes. Downloading and applying updates require explicit actions.

| Tool | Source | Verification |
| --- | --- | --- |
| FFmpeg/ffprobe | gyan.dev latest release essentials Windows x64 package | Provider HTTPS package and SHA-256 |

Same-provider HTTPS hashes are not independent signatures. There is no production exact-version allowlist.

Downloads use bounded temporary storage and restricted HTTPS redirects. Extraction rejects traversal, duplicate entries, symlinks and excessive sizes. Capabilities are checked before activation; failure or cancellation preserves the previous active version. Partial downloads are discarded without byte-range resume.

Old versions remain immutable. Running jobs retain their selected versions through storage leases; rollback affects subsequent jobs. Explicit pruning preserves active/previous versions and refuses while a lease exists. If an external package manager changes a selected executable, the next spawn reports the change rather than silently switching tools.

Managed packages are Windows x64 only; Linux development/CI selects installed tools. External tools are never updated, copied into managed storage or deleted. An external FFmpeg `--enable-nonfree` flag is recorded as a diagnostic; managed packages with that flag are rejected. Receipts record provenance and license declarations but do not replace distribution license review.

## Verification

The [routine tests](testing.md#routine-checks) cover discovery, snapshot changes, literal arguments, archive/hash validation and update lifecycle offline. Required native suites also run real FFmpeg extraction against generated inputs:

```powershell
$env:SURTITLE_TEST_FFMPEG = 'C:\path\ffmpeg.exe'
pnpm test:rust:required windows-native
```

Linux selects `pnpm test:rust:required linux-ffmpeg`. The stream-selection regression checks that each absolute audio index produces its expected frequency. These checks use explicit local executables and generated media, without depending on live releases; see [testing](testing.md) for setup.
