# Surtitle

A Windows 11 x64 desktop app for learning languages from video and audio. Read and edit subtitles, replay selected ranges, save expressions with their source audio, and review cards with spaced repetition. Built with Tauri, React, TypeScript, Rust and SQLite; Japanese/English interfaces and light/dark themes are supported.

This is a development build. See [current status](docs/status.md) for remaining quality and release verification. [Draft study](docs/draft-study.md) lets you use available transcript ranges without waiting for an entire recording to be ready.

## Development

Windows requires Visual Studio C++ Build Tools, WebView2 Runtime, Node.js from `.node-version`, pnpm from `package.json`, Rust 1.98, PowerShell 7 and 7-Zip. Install Rust before pnpm dependencies. Run commands from the repository root.

```powershell
pnpm install --frozen-lockfile
# Obtain and consume the native build output as described in docs/native-runtime.md.
pwsh -File scripts/native-prepare.ps1
pwsh -File scripts/native-smoke.ps1
pnpm tauri dev
```

The optional [Dev Container](.devcontainer/README.md) supports Linux development with shared source and isolated dependencies/build output. Linux CI runs directly on Ubuntu; Windows remains the supported desktop platform.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Browser-only UI preview |
| `pnpm build` | Type-check and build the frontend |
| `pnpm test` | UI and maintained script tests |
| `pnpm test:rust` | Rust workspace tests with all features |
| `pnpm test:rust:no-default-features` | AI tests without development features |
| `pnpm test:rust:required <suite>` | Explicit FFmpeg/native integration tests |
| `pnpm lint:rust` / `pnpm fmt:rust:check` | Rust lint and formatting checks |
| `pnpm test:browser` / `pnpm test:e2e` | Browser preview / real Tauri tests |
| `pnpm package:app` | Standard Tauri NSIS build |

`pnpm install --frozen-lockfile` acquires JavaScript and Rust dependencies using both lockfiles. Use `pnpm rust <subcommand> ...` for other Cargo operations. In PowerShell quote a forwarded separator as `'--'`. See the [test guide](docs/ai-test-plan.md), [E2E setup](e2e/README.md) and [native build/package guide](docs/native-runtime.md).

## Learning and AI

Import local media, SRT/VTT, embedded text subtitles, direct media URLs or public single-video YouTube VODs. Basic playback uses bundled libmpv. FFmpeg/ffprobe, yt-dlp and Deno can be managed by the app or explicitly selected from existing installations; see [tool management](docs/tools.md).

Data lives under `%LOCALAPPDATA%\app.surtitle.desktop`. Original local media is referenced. Saved cards keep independent source text and audio when subtitles change. [Learning export/restore](docs/data-transfer.md) supports CSV/TSV, subtitles, JSON and ZIP with audio; it excludes credentials, paid jobs, approvals and charge ledgers.

Optional Vertex AI uses your service-account key, protected by Rust and Windows DPAPI. Models start unset and budgets start at zero. Each job needs explicit approval of its source, model, settings and scope. Unpriced requests require separate acknowledgement; unknown outcomes keep their reservations and are never automatically retried. Normal CI makes no Vertex requests. See [AI behavior](docs/ai.md) and [credential-based verification](docs/vertex-verification.md).

Model-quality conclusions and old implementation checks are retained in [AI evaluation history](docs/ai-evaluation-history.md) and [verification history](docs/verification-history.md). The old model-scoring and research-campaign scripts are no longer part of this repository's maintained test flow.

## CI and releases

Development stays on `main`; create commits only with the owner's approval.

CI runs the full Linux, Windows and package verification flow for pushes to `main`/`release` and PRs targeting them. Native build inputs have their own Docker cache, including completed build outputs; application changes reuse those layers. App tests, package checks and installer lifecycle still run. The optional Dev Container has no CI orchestration role.

A release-branch push publishes only after the required jobs pass. Versions are changed explicitly; existing published versions are not replaced. Initial Windows installers are unsigned. See [native packaging](docs/native-runtime.md) for source/notices, dependency audit and disposable installer checks.

## License

Surtitle is GPL-3.0-or-later. Third-party components retain their own terms. Distribution includes the required notices and corresponding source for the actual bundled components.
