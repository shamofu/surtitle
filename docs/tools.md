# CLI tools

`surtitle-tools` owns discovery, validation, literal command arguments and the
private managed-tool directory. Native libmpv and ONNX Runtime loading are
separate: this module does not search PATH for DLLs.

## Selection and use

Each of FFmpeg/ffprobe, yt-dlp and Deno has an independent `ToolSelection`:
`Managed` or `External { path }`. FFmpeg and ffprobe come from the same package
directory. A local media job can call `lease_tools` with only FFmpeg; YouTube jobs
lease all three. Direct HTTP media downloads need no CLI tools.
`begin_job(&ToolSelections)` is the convenience form for a three-tool job.

`discover_path(&OsStr)` reads fixed executable names without running anything.
Startup caches this read-only discovery for Settings; rescanning is also
read-only. Candidates are marked unverified and do not change tool selections.
Selecting a candidate resolves it, then the caller invokes `probe` with a
cancellation token. On Windows, native `.exe` candidates and simple Scoop
`path = ...` shims are supported. Shell scripts, aliases and shims requiring
arguments, environment expansion, cwd changes or elevation are not reinterpreted.
Select their underlying executable instead. The original shim path is retained
in settings; the target and junctions are re-resolved for every new job.

`JobLease::get` returns the snapshot for a tool. `ToolSnapshot::verify` detects
changed or removed executables before each process starts. `CommandSpec::run`
performs this check, uses literal argv without a shell, bounds output, enforces
a deadline and handles cancellation. Windows uses a kill-on-close Job Object;
Unix uses a process group. A Windows job is attached immediately after spawn,
so this is process lifecycle management, not a sandbox for hostile executables.
Never expose a generic `CommandSpec` execution command through frontend IPC.

Before a native job starts, `probe_and_record` stores the observed version,
capabilities and diagnostics in each snapshot and rechecks the executable
hashes. FFmpeg snapshots also include the observed ffprobe version. The native
job receipt is written to `prepared/tools-<id>.json`, retaining both the selected
path and the resolved executable. A YouTube download persists `toolReceiptId`
in its download history before starting extraction, so its exact tool receipt
remains identifiable after interruption. Older snapshots with no recorded probe
keep that field absent; loading them never invents a version or changes their
serialized identity.

`build_ytdlp_command` supplies the selected Deno and FFmpeg paths explicitly and
ignores user yt-dlp configurations/plugins. `probe_ytdlp_environment` performs
metadata-only extraction against a caller-provided URL. Standalone Windows
yt-dlp includes EJS; external pip installations may not. Missing runtime/EJS
produces an actionable error without installing into the user's environment.
Remote access failures are not translated automatically into version rollback.
Playlist/live/access-policy approval belongs to the caller before downloading.

`ffmpeg_extract_audio` creates a mono 16 kHz WAV/FLAC span, refuses overwrites,
and uses output seeking for accurate transcoding. Its required stream index is
an absolute FFmpeg index, passed as `-map 0:<index>`; it is neither an audio-only
ordinal nor an mpv track ID. The caller fingerprints the
input and validates the resulting media duration before authorizing AI upload.

## Managed updates

`ToolManager::update` resolves each upstream independently on every explicit
invocation. A background worker checks at startup and wakes every 15 minutes;
successful metadata checks for installed managed CLI tools are cached for 24
hours. The Settings **Check updates** action bypasses that success cache and
refreshes update information without installing or activating anything. Both
paths skip external selections and missing managed tools. yt-dlp metadata is
keyed by its saved nightly/stable channel and bound to the observed installed
identity, so another channel's or an older installation's result cannot appear
as current. Late responses are discarded after an installation/provider/channel
change. Save a changed channel before checking it. Downloads,
installation and applying an update remain explicit actions; discovery never
automatically applies an update. There is no release catalog or exact-version
allowlist:

| Tool | Channel/provider | Verification |
| --- | --- | --- |
| yt-dlp | Official nightly by default; stable selectable | OpenPGP signed checksum manifest, then SHA-256 of the executable |
| Deno | Official latest stable Windows x64 release | Official HTTPS asset and its SHA-256 file |
| FFmpeg/ffprobe | gyan.dev latest release essentials Windows x64 package | Provider HTTPS package and SHA-256 |

The yt-dlp public trust key is embedded in `crates/tools/src/ytdlp-public.asc`; its fingerprint
is `AC0CBBE6848D6A873464AF4E57CF65933B5A7581`. A changed signing key fails closed
until a trust-key migration is implemented. The signed checksum fixture in this
crate is from nightly `2026.08.30.232658` and only tests verification; it does not
restrict production versions. Deno's Windows checksum files currently use
PowerShell `Get-FileHash` list formatting, which is verified alongside GNU-style
checksum files. Same-provider HTTPS hashes are not independent signatures.

Downloads use bounded temporary storage and restricted HTTPS redirect hosts.
ZIP extraction rejects traversal, duplicate entries, symlinks and excessive
sizes. Capabilities are probed before the active pointer changes. Failed or
cancelled attempts leave the previous active version intact. Partial downloads
are discarded; byte-range resume is not yet implemented. Managed packages are
currently Windows x64 only; Linux development/CI can select installed tools.

Updates retain old immutable version directories. Running jobs keep shared
storage leases and their exact executable snapshots. `rollback` changes the
managed pointer for subsequent jobs. `prune_unused` explicitly removes versions
other than active/previous and refuses while any process holds a lease. An
external package manager can delete an external version during a job; the next
spawn reports that change instead of silently selecting another tool.

External tools are never updated, copied into managed storage, overwritten or
deleted. A user's external FFmpeg can report `--enable-nonfree`; this is recorded
as a diagnostic and does not become a redistributed Surtitle component. Managed
FFmpeg packages using that configuration are rejected. Download receipts retain
provider, license declaration, archive hash, executable hashes and probe results;
these are provenance records, not a substitute for distribution license review.

## Verification

The default test suite is offline. It covers path/shim ambiguity, snapshots,
literal arguments, ZIP traversal, signature tampering, activation, rollback and
job leases. Opt-in tests exercise real operations:

```powershell
$env:SURTITLE_TEST_FFMPEG = 'C:\path\ffmpeg.exe'
$env:SURTITLE_TEST_YTDLP = 'C:\path\yt-dlp.exe'
$env:SURTITLE_TEST_DENO = 'C:\path\deno.exe'
pnpm rust test -p surtitle-tools --locked installed_tools_probe_and_extract '--' --ignored

# Uses only SURTITLE_TEST_FFMPEG; distinguishes two generated audio frequencies.
pnpm rust test -p surtitle-tools --locked multitrack_extraction_preserves_selected_stream '--' --ignored

$env:SURTITLE_TEST_UPDATE = 'yt-dlp' # or deno / ffmpeg
pnpm rust test -p surtitle-tools --locked live_rolling_update '--' --ignored
```

The installed-tools test probes selected tools and verifies an actual 16 kHz
mono extraction using a generated fixture. The stream-selection test verifies
that each absolute audio index produces its corresponding generated frequency.
The rolling-update test downloads, verifies, probes, activates and reuses a
current package from the configured upstream provider inside temporary app-owned storage.
