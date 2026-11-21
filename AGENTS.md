# Repository instructions

## Repository simplicity

- Prefer standard Dev Containers and tool capabilities for startup, initialization, validation, and publishing. Add custom scripts only for necessary project-specific behavior that those tools do not provide.
- Keep shared container configuration compatible with developers choosing Docker or wslc. Select the backend locally and follow the explicit container-operation instructions for the current PC.
- Use a single authoritative definition for versions and dependency inputs. Reuse already acquired upstream sources instead of adding duplicate copies or unnecessary transfer steps.
- Test product behavior and meaningful build and distribution requirements. Avoid tests that merely restate implementation or configuration, and avoid independently judging the same test results twice.
- Before removing files or processes, check their current purpose and consumers. Preserve required functionality and update affected code, configuration, tests, and documentation together. Reducing file counts is not a goal in itself.

## Documentation

- Prefer updating existing documentation over creating new files.
- Create a new document only when it has a clear ongoing audience and purpose, or the user explicitly requests it.
- Keep maintained documentation concise, consistent with the implementation, and free of duplicated explanations. Focus on usage, maintenance, specifications, and the reasons for important decisions.
- By default, keep routine plans, progress updates, and completion reports in the chat or pull request rather than creating repository documents.
- Keep routine logs, screenshots, and validation reports out of version control; write them to ignored local directories or CI artifacts.
- Retain regression test inputs and expected results, necessary reproduction materials, corresponding sources, and license documents where they have a concrete ongoing purpose. Honor explicitly requested deliverables.

## Git operations

- Before creating any commit, tag, or pull request, present its proposed content as a draft and obtain the user's explicit approval for that specific creation. Repeat this for every creation; approval for an earlier creation does not carry over.
- Close, reopen, or merge a pull request only when the user explicitly requests that specific action.
- Requests to implement changes, fix CI, or check whether a PR was requested do not authorize pull-request actions. Do not infer permission to change a PR's state as a way to correct an earlier unrequested action.
- Follow Conventional Commits for commit messages.

## Architecture and runtime guardrails

- Maintain crate boundaries ([docs/architecture.md](docs/architecture.md)): `surtitle` (`crates/desktop`, GPUI views, controllers, and native host), `surtitle-core` (SQLite learning data, subtitle parsing, FSRS scheduling, and portable archives), `surtitle-tools` (executable discovery, bounded processes, and managed updates), `surtitle-ai` (request/approval lifecycle, Vertex and OpenAI adapters, DPAPI credentials, charge accounting, and local audio preparation), and `surtitle-ai-validation` (development-only validation CLI, excluded from distribution).
- Keep the production desktop dependency graph (`surtitle` built with `--no-default-features`) free of Electron, Tauri, WebView, and browser runtimes, and free of development or test features (`development-validation`, `e2e-fixtures`, `e2e-test`, `test-support`), as enforced by CI and `native/windows/package.ps1`.
- Keep GPUI entities and native window lifetimes on the GUI thread, and run blocking or asynchronous work on the explicit Tokio runtime. UI-facing methods receive typed state and credential status only, never saved API keys, service-account JSON, or access tokens.
- Preserve the Windows video composition architecture: `mpv-2.dll` windowless `gpu-next` D3D11 composition swapchain transferred via the private owned-COM bridge (`native/build/patches/mpv-owned-composition-swapchain.patch`) and published with UI pixels in one DirectComposition transaction. Never use mpv's borrowed `display-swapchain` property, and never copy video frames through CPU buffers into GPUI. Review and preserve the scoped GPUI patches in `patches/gpui-pre` and `patches/gpui-pre-windows` when updating GPUI.

## Data, persistence, and subtitle timing guardrails

- Respect store authority boundaries ([docs/architecture.md](docs/architecture.md), [docs/data-transfer.md](docs/data-transfer.md)):
  - `learning.sqlite`: cards, subtitles, review history, and portable phrase/subtitle drafts.
  - `workspace.sqlite`: device-local, revisioned raw input for settings, existing-card edits, and import.
  - `preferences.json`: committed non-budget preferences and the active credential identifier.
  - `charges.sqlite`: AI budget limits, reservations, and settled usage.
- Exclude credentials, cost ledgers, paid jobs, execution approvals, external-tool selections, and device-local operational state from portable learning backups (JSON/ZIP).
- Keep text validity and word timing independent ([docs/ai.md](docs/ai.md)): untimed transcript text remains a `source_block` (**Audio range**) bounded only by its submitted audio interval. Never invent, interpolate, or clamp word or cue timestamps, and omit `source_block` rows from synchronized captions and SRT/VTT exports unless confirmed or authored timing exists.
- Protect user edits and newer raw input revisions from being overwritten by delayed AI responses, stale reads, or callbacks across restore and source-generation boundaries.

## AI, credentials, and financial guardrails

- Protect Vertex service-account keys and OpenAI API keys with per-user Windows DPAPI ([docs/ai.md](docs/ai.md), [docs/vertex-verification.md](docs/vertex-verification.md)). Never allow a plaintext fallback, and never pass credentials in command arguments, logs, or evidence files.
- Keep local audio preparation (FFmpeg mono 16 kHz PCM extraction, pinned Silero VAD via bundled CPU ONNX Runtime, and bounded FLAC encoding) strictly offline with zero provider requests. Spawn external tools with literal arguments, no shell interpretation, verified executable hashes, and bounded output ([docs/tools.md](docs/tools.md)).
- Require an explicit user-reviewed quote and immutable approval before any paid provider request. Reserve budget in `charges.sqlite` before dispatch, serialize outbound requests through the single shared HTTP lane across Vertex and OpenAI, and keep per-service budgets independent (`0` means unlimited).
- Never introduce automatic model switching/fallback, unapproved paid retries, or automatic release/refund of genuinely unknown outcomes (timeouts, dropped connections, 3xx/5xx responses, or malformed HTTP 200 streams). Definitive pre-generation HTTP client rejections (`400`, `401`, `403`, `404`, `409`, `422`) and `429` rate-limit responses release their pre-dispatch monetary hold (`charged_microusd = 0`) because no generation occurred. Approved jobs perform bounded transient HTTP 429 retries (at most two retries / three sends total per request, honoring server `Retry-After` and persistent pacing).
- When modifying AI claim, dispatch, retry, pacing, hold, or provider-isolation logic, keep the boundary replay tests (`crates/ai/src/vertex/fault_tests/model_boundary_replay.rs`) and ledger/provider isolation tests consistent.

## Authoritative inputs and workspace layout

- Use the single authoritative source for each version and dependency pin ([docs/native-runtime.md](docs/native-runtime.md), [.devcontainer/README.md](.devcontainer/README.md)):
  - Application version: `[workspace.package].version` in `Cargo.toml`.
  - Rust toolchain: `rust-toolchain.toml` and `[workspace.package].rust-version` in `Cargo.toml`.
  - Native runtime DLLs, Silero VAD model, and VC Runtime prerequisite: `native/runtime-windows-x64.json` and `native/build/sources.json`.
  - License allowlists: `deny.toml` and `about.toml`.
- Keep all build outputs, staged resources, test results, and packaging artifacts under ignored `work/` (`work/target`, `work/resources`, `work/artifacts`, `work/test-results`), as configured by `.cargo/config.toml`.

## Verification and evidence honesty

- Keep ordinary unit and integration checks offline with zero paid provider requests ([docs/testing.md](docs/testing.md)).
- When changing platform-dependent Rust code (`cfg(windows)` / `cfg(unix)`), verify compilation, tests, and Clippy on both Windows and Linux (Dev Container), and explicitly report any CI or platform checks that were not run locally.
- Never claim physical D3D11/DirectComposition rendering, real Japanese IME, measured audio output, multi-DPI/monitor transitions, or GPU performance from Linux builds, fake-platform GPUI tests, or guard-only checks. Leave unmeasured hardware or manual checks unclaimed.
- Never point development, validation CLI, or fixture runs at a normal `%LOCALAPPDATA%\app.surtitle.desktop` profile.

## Specification map

| Area | Authoritative document |
| --- | --- |
| Overview, development commands, and release flow | [README.md](README.md) |
| Crate architecture, stores, GPUI rendering, and behavioral contracts | [docs/architecture.md](docs/architecture.md) |
| AI services, quotes/approvals, audio preparation, retries, and recovery | [docs/ai.md](docs/ai.md) |
| Live Vertex CLI setup and bounded evaluation | [docs/vertex-verification.md](docs/vertex-verification.md) |
| Learning backups (JSON/ZIP), exports, and restore semantics | [docs/data-transfer.md](docs/data-transfer.md) |
| External and managed CLI tool discovery, execution, and updates | [docs/tools.md](docs/tools.md) |
| Routine checks and native Rust integration suites | [docs/testing.md](docs/testing.md) |
| Native libmpv/ORT build, staging, prerequisites, and NSIS packaging | [docs/native-runtime.md](docs/native-runtime.md) |
| Linux Dev Container environment and volume isolation | [.devcontainer/README.md](.devcontainer/README.md) |
