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

Work on a short-lived branch and open a PR against `main`. The protected `main` branch requires an up-to-date PR, the GitHub Actions `ci` check and resolved review conversations; approvals are optional (0 required). Use Squash merge; merged branches are deleted automatically. Linear history is required, force pushes and deletion are blocked, and there are no bypass actors. There is no release branch.

The **Test and release** workflow runs for pushes and PRs to `main`, and pushes of `v*` tags. The initial `validate` job checks version consistency before builds. The aggregate `ci` check succeeds only when `validate`, native build, Linux, Windows and package verification all succeed; failures, cancellations and skipped jobs do not pass. Native dependency builds use Docker caching. Application tests and installer lifecycle checks run for each source revision.

Only a stable `vX.Y.Z` tag push can publish a release, after that tag's CI succeeds. The tag must match the application's version, have no leading zeroes and point to a commit in `main` history. The release uses artifacts from the same workflow run. Only repository owner `shamofu` can create `v*` tags; updates and deletion are blocked even for the owner. Published versions and assets are never replaced. Windows installers are unsigned. See [native packaging](docs/native-runtime.md) for source/notices, dependency audits and disposable installer checks.

### Releasing a version

1. In a work branch, explicitly set the same stable version in `package.json`, `[workspace.package].version` in `Cargo.toml`, and `src-tauri/tauri.conf.json`. Run `pnpm rust update --workspace --offline` to update workspace package entries in `Cargo.lock`, then `node scripts/check-version.mjs`. Include the lockfile changes in the PR. Keep independently versioned crates, including `surtitle-ai`, unchanged unless they need their own version change. Dependency changes and prereleases are outside this procedure.
2. Merge the PR into `main` and wait for its CI to succeed.
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
