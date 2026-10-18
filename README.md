# Surtitle

A Windows 11 x64 desktop app for learning languages from video and audio. Read and edit subtitles, replay selected ranges, save expressions with their source audio, and review cards with spaced repetition. Built with Tauri, React, TypeScript, Rust and SQLite, with Japanese/English interfaces and light/dark themes.

Import local video and audio files, SRT/VTT, and embedded text subtitles. Playback uses bundled libmpv; extraction and conversion use independently managed or external [command-line tools](docs/tools.md). Study keeps video, subtitles and learning controls together. Settings and existing-card edits save automatically; new phrases and subtitle corrections have explicit Save actions.

Optional Vertex AI requires your service-account key and explicit approval of each job's source, model, scope and estimate. Models start unset; budget limits start at zero, meaning unlimited. Local audio preparation sends no generation request. Transcription publishes received text progressively, retains readable **Audio range** text when word timings are unusable, and protects subtitle edits from later results. See [AI behavior](docs/ai.md) for approvals, spending and recovery.

Data lives under `%LOCALAPPDATA%\app.surtitle.desktop`. Local media is referenced; removing a library item preserves its original file, saved cards and review history. [Learning backups](docs/data-transfer.md) retain portable learning data and saved audio, while credentials, paid jobs, approvals, charge ledgers and device-local workspace state stay separate.

## Development

Windows requires Visual Studio C++ Build Tools, WebView2 Runtime, Node.js from `.node-version`, pnpm from `package.json`, Rust from `rust-toolchain.toml`, PowerShell 7 and 7-Zip. Install Rust before pnpm dependencies. From the repository root:

```powershell
pnpm install --frozen-lockfile
# First build or obtain native output at work/native-ci-artifact (see the native guide).
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
pnpm tauri dev
```

The [native guide](docs/native-runtime.md) covers building dependencies with wslc or Docker Buildx and preparing Windows resources. The optional [Dev Container](.devcontainer/README.md) supports Linux development; Windows is the supported desktop platform.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Browser-only UI preview |
| `pnpm build` | Type-check and build the frontend |
| `pnpm test` | UI and script tests |
| `pnpm test:rust` | Rust workspace tests with all features |
| `pnpm test:rust:no-default-features` | AI tests without development features |
| `pnpm test:rust:required <suite>` | Explicit FFmpeg/native integration tests |
| `pnpm lint:rust` / `pnpm fmt:rust:check` | Rust lint and formatting |
| `pnpm test:browser` / `pnpm test:e2e` | Browser preview / real Tauri tests |
| `pnpm test:structure` | UI state and layout contracts, also included in browser tests |
| `pnpm package:app` | Standard Tauri NSIS build |

`pnpm install --frozen-lockfile` acquires JavaScript and Rust dependencies using both lockfiles. Build output and reports live under `work/`: Cargo uses `work/target`, the frontend uses `work/dist`, and distribution output uses `work/artifacts`. Use `pnpm rust <subcommand> ...` for other Cargo operations; in PowerShell quote a forwarded separator as `'--'`. pnpm supplies the Cargo output default while respecting explicit `CARGO_TARGET_DIR` or `CARGO_BUILD_TARGET_DIR` settings. When invoking Cargo directly outside the Dev Container or CI, set its target directory yourself. See [testing](docs/testing.md) for preparation, required suites and validation limits.

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

## CI and releases

The **Test and release** workflow runs for pushes and PRs to `main` and pushes of `v*` tags. Its aggregate `ci` check requires version validation, browser, native build, Linux, Windows and package verification to succeed. Installer tests cover installation, installed-app execution, overwrite, uninstall and learning-data retention.

Only a stable `vX.Y.Z` tag matching the application version and a commit in `main` history can publish, after that tag's required CI jobs succeed. Publication uses artifacts from the same workflow run and verifies the remote tag still identifies the tested commit. Release notes use GitHub CLI's standard generated notes. Published versions and assets are not replaced; Windows installers are unsigned.

To release:

1. Set the same stable version in `package.json`, `[workspace.package].version` in `Cargo.toml`, and `src-tauri/tauri.conf.json`. Run `pnpm rust update --workspace --offline` and `node scripts/check-release.mjs --version-only`. Include the workspace lockfile changes; independently versioned crates change only when needed.
2. Follow the repository's approval rules for commits, tags and PRs. Put the version change on `main` and wait for its CI to pass, then create and push the matching version tag at that tested commit.
3. The tag workflow validates, builds and publishes. Rerun the same workflow for a transient failure. If an incomplete draft release remains, remove only that draft before rerunning. Code fixes or a tag pointing to the wrong version/commit require a new version and tag.

Each release contains the Windows installer, `surtitle-source.zip` with corresponding source, and `SHA256SUMS.txt` for those two downloads. The same Actions run retains manifests, dependency inventories and smoke results in its release and package-evidence artifacts. See the [native guide](docs/native-runtime.md) for distribution requirements and [source rebuild instructions](native/SOURCE-REBUILD.md).

## License

Surtitle is GPL-3.0-or-later. Third-party components retain their own terms. Distribution includes required notices and corresponding source for bundled components.
