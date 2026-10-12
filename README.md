# Surtitle

A Windows 11 x64 desktop app for learning languages from video and audio. Read and edit subtitles, replay selected ranges, save expressions with their source audio, and review cards with spaced repetition. Built with Tauri, React, TypeScript, Rust and SQLite; Japanese/English interfaces and light/dark themes are supported.

## Learning and AI

Import local media, SRT/VTT, embedded text subtitles, direct media URLs or public single-video YouTube VODs. File selection or drop starts import; an existing material with the same learning and explanation languages is reused. Basic playback uses bundled libmpv. Extraction, conversion and YouTube downloads use independently managed or external [command-line tools](docs/tools.md).

Study keeps video, the current subtitle and playback/learning controls together. Open the **Transcript** panel to read subtitles, prepare transcription, inspect progress or request vocabulary suggestions. Selecting a phrase pauses playback for inspection, replay and card creation. Background progress stays inside existing panels. Settings and existing-card text edits save automatically; unfinished input survives navigation and acknowledged drafts survive restart. New phrases and subtitle corrections keep explicit Save actions. See [architecture and editing behavior](docs/architecture.md).

Motion adapts [Motion Reference](https://motion-reference.takayustudio.jp/) recipes: press feedback (80/180ms), stretching tab indicators (280ms), directional tab slides (220ms), companion reveal (280ms open / 200ms close), automatic-height disclosure (240/180ms), snap entrances, filter reflow, review mask wipes (260ms), spring toast stacks and check-stroke confirmation (180ms). Reference IDs and timings live in the shared motion tokens. Motion owns spatial and state transitions; CSS handles hover colors. Filter reflow is limited to non-virtualized lists of at most 40 items. Subtitle text, live status and numeric values update immediately. Live inputs, selection and focus survive interruptions. Native video and opaque dialog shells remain fixed; desktop companion reveal reserves space, waits for native placement acknowledgement, then slides. System/application reduced motion, hiding or resizing settles effects to the latest state; loaders stop while hidden.

Optional Vertex AI uses your service-account key, protected by Rust and Windows DPAPI. Models start unset; budget limits start at zero, meaning unlimited. Each generation job requires explicit approval of its source, model, scope and estimate. Opening a panel or preparing audio sends no generation request. New transcription jobs publish received text progressively; unusable word timings retain readable **Audio range** text. Approved HTTP 429 retries are bounded, and unknown outcomes are never automatically retried. See [AI behavior](docs/ai.md) and [Vertex setup](docs/vertex-verification.md).

Data lives under `%LOCALAPPDATA%\app.surtitle.desktop`. Local media is referenced, and saved cards retain their source text and audio when subtitles change. [Learning backups](docs/data-transfer.md) include saved audio and portable learning drafts; they exclude original media, credentials, paid jobs, approvals, charge ledgers and device-local workspace drafts. Window size, position and maximization use a separate device-local `window-state.json`. Removing a library item preserves its original file, saved cards and review history.

## Development

Windows requires Visual Studio C++ Build Tools, WebView2 Runtime, Node.js from `.node-version`, pnpm from `package.json`, Rust from `rust-toolchain.toml`, PowerShell 7 and 7-Zip. Install Rust before pnpm dependencies. Run commands from the repository root.

```powershell
pnpm install --frozen-lockfile
# Obtain and consume the native build output as described in docs/native-runtime.md.
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
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
| `pnpm test:structure` | UI structure, state and layout contracts; also included in `pnpm test:browser` |
| `pnpm package:app` | Standard Tauri NSIS build |

`pnpm install --frozen-lockfile` acquires JavaScript and Rust dependencies using both lockfiles. Use `pnpm rust <subcommand> ...` for other Cargo operations. In PowerShell quote a forwarded separator as `'--'`.

### Build storage

Development and test builds use limited debug information (`debug = 1`) while retaining local incremental compilation. To inspect types and variables in a debugger, set `CARGO_PROFILE_DEV_DEBUG=2` for the development command, or `CARGO_PROFILE_TEST_DEBUG=2` for tests. Release settings are unchanged.

Keep the build cache while iterating. After finishing a task, run `cargo clean` from that worktree to remove Cargo output; `cargo clean --dry-run` previews the operation. Cargo honors `CARGO_TARGET_DIR` and Cargo configuration, so check any custom target location before cleaning. Source, lockfiles, downloaded Cargo dependencies and application learning data are retained. A worktree separates source and its local outputs; user-wide package caches and toolchains remain shared.

For the optional Dev Container, export any needed logs first, then use `docker stop surtitle-dev` followed by `docker rm surtitle-dev`. This removes the container build layer while keeping Docker image and shared build caches. See the [container guide](.devcontainer/README.md) for WSL commands. No project cleanup wrapper is needed.

## Documentation

| Topic | Guide |
| --- | --- |
| Application structure and data boundaries | [Architecture](docs/architecture.md) |
| AI requests, spending and transcript review | [AI behavior](docs/ai.md), [response evidence](docs/transcript-evidence.md), [Vertex setup and verification](docs/vertex-verification.md) |
| Earlier excerpt bookmarks and recovery | [Draft study](docs/draft-study.md) |
| Backups and portable learning data | [Export and restore](docs/data-transfer.md) |
| External and managed command-line tools | [Tool management](docs/tools.md) |
| Development checks | [Testing](docs/testing.md), [E2E setup](e2e/README.md), [script reference](scripts/README.md) |
| Native dependencies and distribution | [Build and packaging](docs/native-runtime.md), [dependency updates](docs/native-dependencies.md), [source rebuild](native/SOURCE-REBUILD.md) |

The dated [redesign evidence index](docs/redesign/acceptance.md) preserves prior measurements and their limits; the guides above describe current behavior.

## CI and releases

Direct pushes to `main` are allowed. PRs are optional; Squash merge is recommended when using a PR, and merged branches are deleted automatically. PR approval, resolved review conversations and a successful `ci` check are not required before updating `main`. CI continues to run after pushes and for PRs. Linear history is required, force pushes and deletion are blocked, and there are no bypass actors. There is no release branch.

The **Test and release** workflow runs for pushes and PRs to `main`, and pushes of `v*` tags. The initial `validate` job checks version consistency before builds. The aggregate `ci` check succeeds only when `validate`, browser, native build, Linux, Windows and package verification all succeed; failures, cancellations and skipped jobs do not pass. The browser job checks behavior, UI structure, state and layout in a pinned Linux container. Screenshots and traces help diagnose failures; pixel equality is not a CI requirement. Native dependency builds use Docker caching. Application tests and installer lifecycle checks run for each source revision.

Only a stable `vX.Y.Z` tag push can publish a release, after that tag's CI succeeds. The tag must match the application's version, have no leading zeroes and point to a commit in `main` history. The release uses artifacts from the same workflow run. Only repository owner `shamofu` can create `v*` tags; updates and deletion are blocked even for the owner. Published versions and assets are never replaced. Windows installers are unsigned. See [native packaging](docs/native-runtime.md) for source/notices and disposable installer tests.

Each GitHub Release uploads three assets: the Windows installer (`.exe`), `surtitle-source.zip` containing corresponding source, and `SHA256SUMS.txt` with the SHA-256 hashes of those two files. Download the installer to install Surtitle; use the checksum file to verify your download. Maintainers can find the manifests, dependency/SBOM and installer smoke results in the same Actions run's `release-<commit SHA>` artifact, with additional diagnostics in `package-evidence-<commit SHA>`. Actions artifacts are subject to the repository's retention policy.

Runtime DLLs are loaded without a pinned-hash or review-evidence gate, including in CI and distribution. Native preparation stages files under ignored output directories and does not rewrite the tracked runtime manifest. DLL loading, initialization, playback, VAD and installer lifecycle tests remain in place.

### Releasing a version

Release notes are generated in English and list each commit since the previous published stable release in the selected commit's history, with commit links and a comparison link. The initial release lists its complete commit history. Unpublished tags and draft releases are not used as the comparison baseline.

1. On `main` or a work branch, explicitly set the same stable version in `package.json`, `[workspace.package].version` in `Cargo.toml`, and `src-tauri/tauri.conf.json`. Run `pnpm rust update --workspace --offline` to update workspace package entries in `Cargo.lock`, then `node scripts/check-version.mjs`. Commit the lockfile changes with the version changes. Keep independently versioned crates, including `surtitle-ai`, unchanged unless they need their own version change. Dependency changes and prereleases are outside this procedure.
2. Push the changes directly to `main` or merge a PR into `main` (Squash merge recommended), then wait for that commit's `main` push CI to succeed before creating a release tag.
3. As `shamofu`, use the following PowerShell commands from the repository root with authenticated Git and GitHub CLI. They select the current remote `main` commit, verify its latest push workflow succeeded, derive the tag from that commit's version, and push only that annotated tag. A previously tested commit in `main` history can also be released by setting `$releaseCommit` to its full SHA before checking its ancestry, run and version, provided it includes this tag-triggered workflow. Commits from before this migration do not support tag-triggered releases, even if their main CI succeeded.

```powershell
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch main.' }
$releaseCommit = git rev-parse origin/main
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve main.' }
git merge-base --is-ancestor $releaseCommit origin/main
if ($LASTEXITCODE -ne 0) { throw 'The selected commit must be in main history.' }
$releaseRunJson = gh run list --workflow ci.yml --branch main --commit $releaseCommit --event push --limit 1 --json status,conclusion
if ($LASTEXITCODE -ne 0) { throw 'Could not read the main CI run.' }
$releaseRuns = @($releaseRunJson | ConvertFrom-Json)
if ($releaseRuns.Count -ne 1 -or $releaseRuns[0].status -ne 'completed' -or $releaseRuns[0].conclusion -ne 'success') {
    throw 'The selected main commit must have a successful completed CI run.'
}
$releasePackageJson = git show "${releaseCommit}:package.json"
if ($LASTEXITCODE -ne 0) { throw 'Could not read the selected version.' }
$releaseVersion = ($releasePackageJson | ConvertFrom-Json).version
if ($releaseVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'A stable version without leading zeroes is required.'
}
$releaseTag = "v$releaseVersion"
git tag --annotate $releaseTag $releaseCommit --message "Surtitle $releaseTag"
if ($LASTEXITCODE -ne 0) { throw 'Could not create the version tag.' }
git push origin "refs/tags/$releaseTag"
if ($LASTEXITCODE -ne 0) { throw 'Could not push the version tag.' }
```

The tag workflow validates, builds and publishes automatically; both annotated and lightweight tags are accepted by CI, but the procedure above uses annotated tags. For a transient failure, rerun the same tag's workflow. If an incomplete draft release remains, manually delete only that draft, preserve the tag, then rerun. Code fixes or a tag created for the wrong version/commit require a new version and tag; do not move or delete the existing tag.

## License

Surtitle is GPL-3.0-or-later. Third-party components retain their own terms. Distribution includes the required notices and corresponding source for the bundled components.
