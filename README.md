# Surtitle

A Windows 11 x64 desktop app for learning languages from video and audio. Read and edit subtitles, replay selected ranges, save expressions with their source audio, and review cards with spaced repetition. Built with Tauri, React, TypeScript, Rust and SQLite; Japanese/English interfaces and light/dark themes are supported.

## Learning and AI

Import local media, SRT/VTT, embedded text subtitles, direct media URLs or public single-video YouTube VODs. Basic playback uses bundled libmpv. FFmpeg/ffprobe, yt-dlp and Deno can be managed by the app or selected from existing installations; see [tool management](docs/tools.md).

Drop video or audio files onto the library or import dialog, then review the files and languages before adding them. You can add or remove files and retry individual failures. A file already added with the same learning and explanation languages opens its existing material. Folders and subtitle files are not accepted by this media drop target.

The study screen keeps the video and current subtitle in view. Select a phrase to pause and inspect it, replay its source audio, or save it with a meaning and audio as a review card. **Return to watching** resumes from where you started inspecting. **Previous subtitle** and **Next subtitle** preserve the playback pause state; **Listen again** replays the current subtitle with your configured context.

Open **Transcript** for the full subtitle list, saved AI suggestions, or [draft study](docs/draft-study.md) using available ranges of an incomplete transcript. Playback tracks and caption-group pause are under **More → Playback settings**. Translations start concealed. Returning from phrase inspection preserves transcript search and scroll position. **Unfinished phrases** retains edited forms while the material is open; leaving or closing the app asks before discarding them. These forms do not survive an app restart.

Data lives under `%LOCALAPPDATA%\app.surtitle.desktop`. Original local media is referenced. Saved cards retain their source text and audio when subtitles change. [Learning export/restore](docs/data-transfer.md) supports CSV/TSV, subtitles, JSON and ZIP with audio; backups exclude original media, credentials, paid jobs, approvals and charge ledgers.

Optional Vertex AI uses your service-account key, protected by Rust and Windows DPAPI. Models start unset and budgets start at zero. Each job needs explicit approval of its source, model, settings and scope. Unpriced requests require separate acknowledgement; unknown outcomes keep their reservations and are never automatically retried. Opening a learning panel sends no AI request. Review generated text and timing against the source before adopting it; see [AI behavior](docs/ai.md) and [Vertex setup and verification](docs/vertex-verification.md).

## Development

Windows requires Visual Studio C++ Build Tools, WebView2 Runtime, Node.js from `.node-version`, pnpm from `package.json`, Rust 1.98, PowerShell 7 and 7-Zip. Install Rust before pnpm dependencies. Run commands from the repository root.

```powershell
pnpm install --frozen-lockfile
# Obtain and consume the native build output as described in docs/native-runtime.md.
pwsh -File scripts/native-prepare.ps1
pwsh -File scripts/native-smoke.ps1
pnpm tauri dev
```

The optional [Dev Container](.devcontainer/README.md) supports Linux development with shared source and isolated dependencies/build output. Windows is the supported desktop platform.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Browser-only UI preview |
| `pnpm build` | Type-check and build the frontend |
| `pnpm test` | UI and script tests |
| `pnpm test:rust` | Rust workspace tests with all features |
| `pnpm test:rust:no-default-features` | AI tests without development features |
| `pnpm test:rust:required <suite>` | Explicit FFmpeg/native integration tests |
| `pnpm lint:rust` / `pnpm fmt:rust:check` | Rust lint and formatting checks |
| `pnpm test:browser` / `pnpm test:e2e` | Browser preview / real Tauri tests |
| `pnpm package:app` | Standard Tauri NSIS build |

`pnpm install --frozen-lockfile` acquires JavaScript and Rust dependencies using both lockfiles. Use `pnpm rust <subcommand> ...` for other Cargo operations. In PowerShell quote a forwarded separator as `'--'`.

## Documentation

| Topic | Guide |
| --- | --- |
| Application structure and data boundaries | [Architecture](docs/architecture.md) |
| AI requests, spending and transcript review | [AI behavior](docs/ai.md), [response evidence](docs/transcript-evidence.md), [Vertex setup and verification](docs/vertex-verification.md) |
| Learning from incomplete transcripts | [Draft study](docs/draft-study.md) |
| Backups and portable learning data | [Export and restore](docs/data-transfer.md) |
| External and managed command-line tools | [Tool management](docs/tools.md) |
| Development checks | [Testing](docs/testing.md), [E2E setup](e2e/README.md), [script reference](scripts/README.md) |
| Native dependencies and distribution | [Build and packaging](docs/native-runtime.md), [dependency updates](docs/native-dependencies.md), [source rebuild](native/SOURCE-REBUILD.md) |

## CI and releases

CI runs Linux, Windows and package verification for pushes to `main`/`release` and PRs targeting them. Native dependency builds use Docker caching. Application tests and installer lifecycle checks run for each source revision.

A release-branch push publishes after the required jobs pass. Versions are changed explicitly; existing published versions are not replaced. Windows installers are unsigned. See [native packaging](docs/native-runtime.md) for source/notices, dependency audits and disposable installer checks.

## License

Surtitle is GPL-3.0-or-later. Third-party components retain their own terms. Distribution includes the required notices and corresponding source for the bundled components.
