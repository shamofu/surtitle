# Surtitle

A Windows 11 x64 desktop app for learning languages from video and audio. Read and edit subtitles, replay selected ranges, save expressions with their source audio, and review cards with spaced repetition. Built with Rust, GPUI Kit and SQLite, with Japanese/English interfaces and light/dark themes.

Import local video and audio files, SRT/VTT (cleaning inline markup automatically on import), and embedded text subtitles. Playback uses bundled libmpv; extraction and conversion use independently managed or external [command-line tools](docs/tools.md). Study keeps video, subtitles and learning controls together. Settings and existing-card edits save automatically; new phrases and subtitle corrections use modal editors with in-modal audio preview, quick phrase fill from selected text or examples, `Ctrl+Enter` save, and explicit Save actions (while card editing also offers **Listen**).

In Study, scroll up/down over the video to seek ±5 seconds, and over the volume icon, slider or percentage to adjust volume ±5 percentage points while preserving keyboard focus. When a page surface has focus, Study supports `Space` (play/pause), `Left`/`Right` (seek ±5 s), `R` (replay cue), `P`/`N` (previous/next cue), `L` (loop), `T` (translation), `M` (Meaning), `S` (save phrase), `[`/`]` (speed ±0.05×), `F` (fullscreen), and `Esc` (exit fullscreen or return focus from child controls).

Review schedules phrases with FSRS, shows predicted intervals on rating buttons, supports language and media filtering (including from Phrases), optional audio autoplay in Settings, single-step undo, and `Space` (reveal), `1`–`4` (rate), `R` (listen), `E` (edit), and `Z` (undo) shortcuts.

Optional Vertex AI or OpenAI API requires your own credentials and explicit approval of each job's source, model, scope and estimate. Select the service in Settings; started jobs keep their original service. Each service retains its models and independent budgets, with zero meaning unlimited. Local audio preparation sends no generation request. Transcription publishes received text progressively, retains readable **Audio range** text when word timings are unavailable, and protects subtitle edits from later results. See [AI behavior](docs/ai.md) for setup, approvals, spending and recovery.

Data lives under `%LOCALAPPDATA%\app.surtitle.desktop`. Local media is referenced; removing a library item preserves its original file, saved cards and review history. [Learning backups](docs/data-transfer.md) retain portable learning data and saved audio, while credentials, paid jobs, approvals, charge ledgers and device-local workspace state stay separate.

## Development

Windows requires Visual Studio C++ Build Tools, Rust from [rust-toolchain.toml](rust-toolchain.toml), PowerShell 7, and 7-Zip. From the repository root:

```powershell
# First build or obtain native output at work/native-ci-artifact (see the native guide).
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
cargo run --locked --package surtitle
```

The [native guide](docs/native-runtime.md) covers building dependencies with wslc or Docker Buildx, preparing Windows resources, and packaging the NSIS installer. The optional [Dev Container](.devcontainer/README.md) supports Linux development; Windows is the supported desktop platform.

| Command | Purpose |
| --- | --- |
| `cargo run --locked --package surtitle` | Run the native GPUI desktop |
| `cargo build --locked --package surtitle` | Build the native desktop |
| `cargo nextest run --workspace --all-features --locked --profile ci` | Rust workspace tests with all features |
| `cargo nextest run -p surtitle-ai --no-default-features --locked --profile ci-no-default` | AI tests without development features |
| `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings` | Rust lint |
| `cargo fmt --all -- --check` | Rust formatting check |
| `cargo deny check licenses bans sources` | Dependency license and source audit |
| `pwsh -File native/windows/package.ps1` | Locked Cargo release and NSIS installer |

Build output and staged resources live under `work/` (`CARGO_TARGET_DIR = "work/target"` is configured in `.cargo/config.toml`; prepared resources use `work/resources`). See [testing](docs/testing.md) for preparation and native integration suites.

## Documentation

| Topic | Guide |
| --- | --- |
| Application structure and editing | [Architecture](docs/architecture.md) |
| AI requests, spending and recovery | [AI behavior](docs/ai.md) |
| Vertex application and CLI setup | [Vertex verification](docs/vertex-verification.md) |
| Backups and portable learning data | [Export and restore](docs/data-transfer.md) |
| External and managed command-line tools | [Tool management](docs/tools.md) |
| Development checks | [Testing](docs/testing.md) |
| Native dependencies and distribution | [Build and packaging](docs/native-runtime.md) |
| Repository rules and agent guardrails | [Repository instructions](AGENTS.md) |

## CI and releases

The **Test and release** workflow runs for pushes and PRs to `main` and pushes of `v*` tags. Its aggregate `ci` check requires native dependencies, Linux, Windows, and installer packaging to succeed.

Only a stable `vX.Y.Z` tag matching the application version and a commit in `main` history can publish, after that tag's required CI jobs succeed. Publication uses artifacts from the same workflow run and verifies the remote tag still identifies the tested commit. Release notes use GitHub CLI's standard generated notes. Published versions and assets are not replaced; Windows installers are unsigned.

To release:

1. Set the stable version in `[workspace.package].version` in `Cargo.toml`; installer and release metadata derive from it. Run `cargo update --workspace --offline` and commit the `Cargo.toml` / `Cargo.lock` changes.
2. Follow the repository's approval rules for commits, tags and PRs. Put the version change on `main` and wait for its CI to pass, then create and push the matching version tag at that tested commit.
3. The tag workflow validates, builds and publishes. Rerun the same workflow for a transient failure. If an incomplete draft release remains, remove only that draft before rerunning. Code fixes or a tag pointing to the wrong version/commit require a new version and tag.

Each release contains the Windows installer, `libmpv-source.tar.gz`, and `SHA256SUMS.txt`. See the [native guide](docs/native-runtime.md) for distribution requirements.

## License

Surtitle is GPL-3.0-or-later. Third-party components retain their own terms. Distribution includes required notices and libmpv corresponding source.
