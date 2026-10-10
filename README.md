# Surtitle

A Windows 11 x64 desktop app for learning languages from video and audio. Read and edit subtitles, replay selected ranges, save expressions with their source audio, and review cards with spaced repetition. Built with Tauri, React, TypeScript, Rust and SQLite; Japanese/English interfaces and light/dark themes are supported.

## Learning and AI

Import local media, SRT/VTT, embedded text subtitles, direct media URLs or public single-video YouTube VODs. Basic playback uses bundled libmpv. FFmpeg/ffprobe, yt-dlp and Deno can be managed by the app or selected from existing installations; see [tool management](docs/tools.md).

Drop video or audio files onto the library or import dialog, then review the files and languages before adding them. You can add or remove files and retry individual failures. A file already added with the same learning and explanation languages opens its existing material. Folders and subtitle files are not accepted by this media drop target.

The study screen keeps the video and current subtitle in view. Select a phrase to pause and inspect it, replay its source audio, or save it with a meaning and audio as a review card. **Return to watching** resumes from where you started inspecting. **Previous subtitle** and **Next subtitle** preserve the playback pause state; **Listen again** replays the current subtitle with your configured context.

Use **Transcribe** to start creating subtitles in the transcript panel. **More → Prepare subtitles** also provides embedded text subtitles, subtitle-file import and previous editions; its transcription action opens the same panel. A unique embedded text track matching the learning language is selected for you. Playback tracks and caption-group pause are under **More → Playback settings**; **Use these captions for study** opens the subtitle setup with the playback track selected.

Open **Transcript** for the subtitle list and the **Transcription** and **Suggestions** tabs. The transcription tab holds setup, estimates, detailed progress and history; opening the tab alone does not create a request. Received text appears in the subtitle list with a compact progress link while remaining audio is processed. Translations start concealed. Switching tabs, inspecting a phrase or closing the panel preserves unfinished transcription input and estimates; returning from inspection also preserves transcript search and scroll position. Phrase and subtitle edits are saved automatically as drafts and can be resumed after restarting the app. Choose **Continue later** to keep a draft or **Discard draft** to remove it. If its source changes or a backup is restored, reconnect the draft to current subtitles explicitly before saving it as learning content. Earlier excerpt bookmarks remain available through [draft study](docs/draft-study.md) in transcription history.

Settings and existing phrase edits use explicit saves. Leaving with unsaved changes offers save, discard or continue editing; a failed save keeps the input. **Review errors** in settings opens and focuses the first invalid field, including fields inside advanced options. Saving disables competing edits and dismissal. Dialog notifications remain visible inside the frontmost dialog, and Escape closes only that dialog before returning focus to its opener.

Long operations show their current stage near the action. Open **Activity** in the top bar to follow downloads, tool setup, audio preparation, AI jobs and data transfers across pages. Percentages appear only when the total is known; YouTube downloads show stored size instead. Downloading a tool is followed by verification and installation before it is ready. The activity list retains the latest 20 finished operations from the current app session. Closing it does not stop work; use the existing cancel actions when needed.

Data lives under `%LOCALAPPDATA%\app.surtitle.desktop`. Original local media is referenced. Saved cards retain their source text and audio when subtitles change. [Learning export/restore](docs/data-transfer.md) supports CSV/TSV, subtitles, JSON and ZIP with audio; backups exclude original media, credentials, paid jobs, approvals and charge ledgers.

Optional Vertex AI uses your service-account key, protected by Rust and Windows DPAPI. Models start unset; batch setup assigns Transcribe to transcription and Flash to vocabulary, explanations and translation. Budgets start at zero, meaning no limit for each per-job, daily and monthly ceiling. Positive limits still apply. Each job needs explicit approval of its source, model, settings and scope. For a priced transcription, **Start transcription** is the approval action. New transcription approvals include up to two automatic retries per chunk for HTTP 429, with the maximum sends and reservation shown before starting. Progress shows retry waits and stopping reasons. Unpriced requests require separate acknowledgement; unknown outcomes keep their reservations and are never automatically retried. Local preparation and opening a learning panel send no generation request.

Transcription defaults to the whole recording and a single Transcribe VERBATIM request with word timestamps per prepared audio chunk. Opening transcription starts local preparation and produces one estimate; review the scope and price, then start. New full-recording, selected-range and re-transcription jobs apply received parts automatically without a separate adoption step. Existing subtitles in unreceived regions and edits made during processing are preserved. Text with unusable word times remains readable as an **Audio range**, with its actual submitted audio bounds; it is excluded from synchronized captions and SRT/VTT. Quality review and correction are optional. Older saved jobs can be recovered locally through their history without another generation request. Setup and unfinished estimates retain their inputs; see [AI behavior](docs/ai.md) and [Vertex setup and verification](docs/vertex-verification.md).

## Development

Windows requires Visual Studio C++ Build Tools, WebView2 Runtime, Node.js from `.node-version`, pnpm from `package.json`, Rust 1.98, PowerShell 7 and 7-Zip. Install Rust before pnpm dependencies. Run commands from the repository root.

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
| `pnpm test:visual` | Six screenshot comparisons in the pinned Linux container; see [E2E setup](e2e/README.md) |
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
| Learning from incomplete transcripts | [Draft study](docs/draft-study.md) |
| Backups and portable learning data | [Export and restore](docs/data-transfer.md) |
| External and managed command-line tools | [Tool management](docs/tools.md) |
| Development checks | [Testing](docs/testing.md), [E2E setup](e2e/README.md), [script reference](scripts/README.md) |
| Native dependencies and distribution | [Build and packaging](docs/native-runtime.md), [dependency updates](docs/native-dependencies.md), [source rebuild](native/SOURCE-REBUILD.md) |

## CI and releases

Direct pushes to `main` are allowed. PRs are optional; Squash merge is recommended when using a PR, and merged branches are deleted automatically. PR approval, resolved review conversations and a successful `ci` check are not required before updating `main`. CI continues to run after pushes and for PRs. Linear history is required, force pushes and deletion are blocked, and there are no bypass actors. There is no release branch.

The **Test and release** workflow runs for pushes and PRs to `main`, and pushes of `v*` tags. The initial `validate` job checks version consistency before builds. The aggregate `ci` check succeeds only when `validate`, browser, native build, Linux, Windows and package verification all succeed; failures, cancellations and skipped jobs do not pass. The browser job runs functional checks and six visual comparisons in a pinned Linux container. Native dependency builds use Docker caching. Application tests and installer lifecycle checks run for each source revision.

Only a stable `vX.Y.Z` tag push can publish a release, after that tag's CI succeeds. The tag must match the application's version, have no leading zeroes and point to a commit in `main` history. The release uses artifacts from the same workflow run. Only repository owner `shamofu` can create `v*` tags; updates and deletion are blocked even for the owner. Published versions and assets are never replaced. Windows installers are unsigned. See [native packaging](docs/native-runtime.md) for source/notices, dependency audits and disposable installer checks.

Each GitHub Release uploads three assets: the Windows installer (`.exe`), `surtitle-source.zip` containing corresponding source, and `SHA256SUMS.txt` with the SHA-256 hashes of those two files. Download the installer to install Surtitle; use the checksum file to verify your download. Maintainers can find the complete manifests, dependency/SBOM and installer audit/smoke evidence in the same Actions run's `release-<commit SHA>` artifact, with additional diagnostics in `package-evidence-<commit SHA>`. Actions artifacts are subject to the repository's retention policy.

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
