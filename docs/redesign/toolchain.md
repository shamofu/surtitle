# Native toolchain and distribution decision

Reviewed on 2026-10-11 on Windows 11 x64. The frontend compiler and bundler comparison is in [frontend.md](frontend.md); rendering/runtime binaries are in [rendering.md](rendering.md).

## Rust: update the pinned compiler

The previous installer-source manifest pinned Rust 1.98.0. It must not remain the default simply because the application already builds with it: the official [Rust 1.98.1 release](https://blog.rust-lang.org/2026/09/03/Rust-1.98.1/) reports a fix for invalid vtable generation in 1.98.0. [Rust 1.99.0](https://blog.rust-lang.org/2026/10/01/Rust-1.99.0/) is the current stable candidate evaluated here. Its new language features are not presented as an application performance benefit.

Selected **Rust 1.99.0**, after compiling and running the actual workspace, rather than inferring compatibility from its version number:

- `cargo +1.99.0 test --workspace --all-features --locked --target-dir work/rust-1.99-target`: passed, including application, AI, storage, tools and documentation tests. Tests marked as requiring native fixtures remain separate from this command; their explicit runs are documented under AI/storage/rendering.
- `cargo +1.99.0 clippy --workspace --all-targets --all-features --locked --target-dir work/rust-1.99-target -- -D warnings`: passed.
- `cargo deny check licenses bans sources`: passed.
- The cold test build reported 1 minute 55 seconds; the first separate Clippy build reported 3 minutes 29 seconds. There is no matched cold 1.98 build under the same system load, so these are observed durations, not a compiler speedup claim.

The root `rust-toolchain.toml`, Cargo minimum Rust version, and `native/installer-inputs.json` now agree on 1.99. CI already reads that manifest. Installation was side by side and did not change the machine's global default. The installer preparation command downloaded and checked the official Rust source archive against SHA-256 `3f1f9b7ed48f4596fc87889b7b3c61747336a55c9c22db1ab0c697e0aadb77aa`; runtime notices come from the selected toolchain's installed documentation.

The intermediate native fixture and six-hour preparation evidence explicitly identifies its 1.98 build. The final normal-feature installer is rebuilt with 1.99; it is not relabeled evidence from an earlier binary. No learning schema or review algorithm changes because of this compiler update.

## Packaging and validation boundaries

Keep the current Tauri/NSIS distribution path while evaluating the rendering host. It already carries pinned corresponding sources, dependency/license notices, native DLL identity checks and an isolated installation smoke workflow. The redesign fixes the actual FFmpeg hardware-decoder build configuration rather than exchanging the installer to mask that problem.

The release, launcher and package scripts are tested with real temporary Git repositories and child processes. Browser tests are a separate layer from installed WebView2/mpv tests. Production packaging rejects `e2e-test` and uses the real executable; the acceptance installer uses an isolated evaluation application identifier to avoid replacing the user's installed profile. Details, executable hashes and lifecycle evidence belong to the rendering record.

The Linux CI image and workflow were inspected for Node/pnpm/Playwright/Rust consistency, but this session's successful Windows runs do not prove the Linux jobs pass. Keep that distinction in any release report. No CI release or public installer was published by this task.
