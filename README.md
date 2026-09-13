# Surtitle

A Windows 11 x64 desktop application for learning languages from video and audio. Read synchronized subtitles, save expressions with source audio, and review them using spaced repetition. Built with Tauri 2, React, TypeScript, Rust, SQLite, and TanStack Router, Query, and Virtual. The application supports Japanese and English interfaces and light and dark themes.

This is a development build. Local learning and optional Vertex AI workflows are implemented; model quality and release verification are recorded separately in [implementation status](docs/status.md). Publication requires the final source/notices/SBOM audit and isolated installer tests to pass.

The latest [completion follow-up](docs/completion-followup-2026-09-12.md) records reference preparation, the portable-learning workflow, restore integrity fixes, and the rebuilt local installer. See [credential-based verification](docs/vertex-verification.md) to try the normal application with an explicitly approved AI scope.

The subsequent [Transcribe English dialogue comparison](docs/transcribe-en-dialogue-2026-09-12.md) records six successful requests, recognition and boundary limitations, and retained cost accounting. Model quality qualification remains incomplete.

[Study a draft](docs/draft-study.md) allows learning from available transcript ranges before the full track is ready: bookmark an excerpt, review its text and source audio, then save an immutable card. Untimed text remains a source block until the learner specifies a range. Original responses, unresolved warnings and unknown cost reservations are retained.

## Development

Windows development requires Windows 11 x64, Visual Studio C++ Build Tools, WebView2 Runtime, Node.js 24.21.0 LTS (specified in `.node-version`), pnpm 12.3.4, Rust 1.98, PowerShell 7, and 7-Zip.

The Ubuntu 24.04 [Dev Container](.devcontainer/README.md) supports frontend development, common Rust tests, and real Linux Tauri E2E tests. Windows rendering, DPAPI, and installers require Windows verification.

Repository source and lockfiles are shared read/write with the host. Dependencies, caches, and build outputs stay inside the container; source-relative output directories are masked with `tmpfs`. No named volumes are used. Temporary mounts are lost when the container stops, and container-layer caches are lost when it is removed. The container guide includes runtime mount inspection and bidirectional source/output isolation checks. Keep service-account keys outside the repository and container.

Development documentation and inline comments are written in English. Localized application strings and language-learning fixtures retain their intended languages.

## Run and test

Run from the repository root on Windows. First obtain the native build artifact for the checked-out commit or build the recorded native recipe; see [native runtime management](docs/native-runtime.md). Native preparation consumes the reviewed source-built libmpv artifact and downloads the fixed official CPU ONNX Runtime archive. It stops if the required build or source evidence is missing.

```powershell
pnpm install --frozen-lockfile
pwsh scripts/native-prepare.ps1
pwsh scripts/native-smoke.ps1
pnpm tauri dev
```

```powershell
pnpm test
pnpm build
cargo test --workspace --all-features --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
node scripts/check-production-features.mjs
```

`pnpm test` runs both Vitest projects: React tests in jsdom and script/container contract tests in Node. Use `pnpm test:ui` or `pnpm test:scripts` to run one project, and `pnpm test:watch` to watch both. Native WebDriver and Playwright tests keep their separate commands.

See the [E2E guide](e2e/README.md) for native test setup. Basic playback and metadata use libmpv without FFmpeg. Bundled DLLs are never resolved through PATH; their hashes, dependency closure, licenses, and source are checked separately. See [native runtime management](docs/native-runtime.md).

## Learning and storage

Local video/audio, external SRT/VTT, embedded text subtitles, direct media URLs, and public single-video YouTube VOD imports are supported. URL imports finish downloading before analysis. Subtitle editing, translation, selected-range playback, repeat, optional caption-group pauses, source-track selection, audio cards, FSRS review, and learning-data export/restore share a Rust core.

Windows data is stored under `%LOCALAPPDATA%\app.surtitle.desktop`. Original local media is referenced. Downloaded media, SQLite databases, and independent card audio use the application data directory. Cards retain their source text, meaning, translation, explanation, and audio when subtitles change.

Exports include CSV/TSV, source/translated SRT/VTT, JSON, and JSON with audio in ZIP. Restore validates the archive and creates a backup before replacing learning data. It does not import credentials, cost ledgers, paid jobs, execution approvals, or executable selections.

## AI and spending

Use your own Vertex AI project and service-account JSON key. Rust imports the key through a native file dialog and protects it with Windows DPAPI. The frontend does not receive the key or access token.

There is no application-owned model catalog. Discover models from Google or enter a Gemini model ID directly. Defaults start unset and can be configured separately for transcription, vocabulary, explanations, and translation, with explicit per-job overrides. Discovery does not prove project access or quality. Unknown models can be tried after reviewing the job scope.

Monetary budgets start at zero. A priced job requires approval of its immutable model, input, request count, audio duration, output settings, and reservation. A job without a price requires explicit unpriced-scope approval and cannot promise a dollar ceiling. Unpriced requests are never displayed as free. Unknown outcomes retain their reservations and are not automatically retried. Normal CI does not call Vertex.

Transcribe review supports local correction of invalid or missing ranges, explicit confirmation of no speech, and returning to the result selected before manual correction. Corrections preserve provider evidence and unknown cost reservations; saving does not send or adopt anything automatically. Vocabulary and explanations remain experimental. The review-assisted [Transcribe evaluation policy](docs/transcribe-production.md) treats 90% automatic joining as an improvement target, while recognition, timing coverage, audio preservation and playback remain separately measured requirements. The evaluated provider model is Preview; short diagnostic success does not qualify long lectures or conversations. See the [recovery implementation and validation readiness](docs/transcribe-implementation-2026-09-12.md) for the latest evidence and incomplete requirements.

See the [AI design](docs/ai.md), [test plan](docs/ai-test-plan.md), and [credential-based verification guide](docs/vertex-verification.md). The [initial live results](docs/ai-verification-2026-09-09.md) record successful paths and failures; current evaluation is tracked in [status](docs/status.md). The [quality improvements](docs/quality-improvement-2026-09-12.md) describe transcript evidence, local reparsing, playback context, and the remaining evaluation stages.

## External tools

FFmpeg/ffprobe, yt-dlp, and Deno can each use an application-managed installation or an explicitly selected existing executable. Mixed configurations are supported. Managed CLI versions update independently from the application. Surtitle never updates, overwrites, or deletes PATH-derived tools. See [architecture](docs/architecture.md) and [tool management](docs/tools.md).

## Branches and releases

Development stays on main; do not commit until the owner permits it. GitHub Actions checks pushes to main and release, and PRs targeting either branch. A push to release publishes only artifacts whose required checks passed for the same SHA. Versions are changed explicitly on main; CI does not create commits or replace published artifacts.

CI queues runs for each branch or PR without canceling the active run (`queue: max`, up to 100 pending runs). Jobs execute in order: Linux checks, native build, Windows 2025 checks, packaging, then release-branch publication. Docker environment layers use separate development/native caches; host pnpm stores and job-specific Rust dependency outputs are also cached. Native builds reuse checksum-verified source downloads and matching C/C++ compiler results through ccache, with no host mounts. Configuration, linking, source audits and final artifact generation run for every commit. Each native payload is verified for its commit and transferred as an artifact from the same run. Cache hits never skip required tests or artifact validation.

Windows WebDriver runs with restricted medium integrity, including the installed production smoke test. [WebView2 ignores environment overrides in high-integrity hosts](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags), which otherwise prevents EdgeDriver from opening its debugging connection on administrator CI runners. Before starting the child, the test launcher verifies medium integrity, Administrators and Power Users absent or deny-only, only allowlisted user privileges, and the same user and session. It preserves the runner's profile, environment and working directory and owns a Windows job that cleans up the driver and application processes. UAC-disabled runners can retain their elevation flag after permission restriction; diagnostics report that flag separately from the verified effective permissions. Runtime/driver versions and runner elevation are retained with CI evidence.

The initial Windows NSIS installer is unsigned. Application auto-update and distribution for other operating systems are outside the initial scope.

## License

Surtitle is **GPL-3.0-or-later**. Third-party components retain their own terms. The source license alone does not establish permission to redistribute downloaded native binaries. A distributable release requires an audit of the actual bundled files, notices, corresponding source, and SBOM.
