# Explicit public-download acceptance test

`public-download.e2e.js` runs the actual Windows Tauri application against a public, completed, single YouTube video. It is outside the normal `e2e/native` spec glob and never runs in ordinary offline CI. Network availability, site restrictions, and upstream extractor changes are real outcomes, not reasons to silently retry, use cookies, or update a selected external installation.

Prepare a fresh directory with `surtitle-core`'s `seed_fixture` example and a build with `e2e-test,custom-protocol`. Do not point the test at an existing user profile. Clear `SURTITLE_E2E_AI_RECOVERY` and `SURTITLE_E2E_TRANSCRIPT_REVIEW`; this test requires absent credentials, no AI jobs or attempts, and zero budgets. It also verifies the exact seeded media/card and the explicitly selected external executable hashes before mutation.

Supply `SURTITLE_PUBLIC_DOWNLOAD_MANIFEST` as an absolute path to an explicitly reviewed JSON file:

```json
{
  "schemaVersion": 1,
  "networkApproved": true,
  "verifiedPublic": true,
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "videoId": "VIDEO_ID",
  "expectedDurationMs": 12000,
  "maxStoredBytes": 134217728,
  "attribution": "Title, author, source and license attribution",
  "licenseUrl": "https://example.org/license",
  "sourceEvidenceUrl": "https://example.org/source",
  "tools": [
    {
      "id": "ffmpeg",
      "selectedPath": "C:\\Tools\\ffmpeg.exe",
      "executable": "C:\\Tools\\ffmpeg.exe",
      "sha256": "EXACT_EXECUTABLE_SHA256",
      "companion": { "path": "C:\\Tools\\ffprobe.exe", "sha256": "EXACT_COMPANION_SHA256" }
    },
    {
      "id": "yt-dlp",
      "selectedPath": "C:\\Tools\\yt-dlp.exe",
      "executable": "C:\\Tools\\yt-dlp.exe",
      "sha256": "EXACT_EXECUTABLE_SHA256"
    },
    {
      "id": "deno",
      "selectedPath": "C:\\Tools\\deno.exe",
      "executable": "C:\\Tools\\deno.exe",
      "sha256": "EXACT_EXECUTABLE_SHA256"
    }
  ]
}
```

`selectedPath` must match the chosen PATH candidate. For a simple Scoop shim, retain the shim path there and use its canonical target in `executable`. Use `realpathSync.native` and SHA-256 of the actual files when preparing the manifest. These hashes bind one test execution; they are not application version restrictions. The expected duration is limited to ten minutes, the observed storage cancellation threshold to at most 256 MiB, and the download wait to three minutes. Storage is polled every 500 ms, so the threshold is not a filesystem quota. The test cancels an unfinished or oversized job instead of retrying.

Set the usual WebDriver binary/data-directory variables, then run:

```powershell
pnpm exec wdio run wdio.conf.js --spec e2e/upstream/public-download.e2e.js
```

The test explicitly selects each external tool, starts one download, verifies the persisted per-job tool receipt (selected path, resolved executable, version and hashes), then checks native playback, interval stop and seeking from the saved file. The final hook removes only the uniquely owned library registration and verifies unchanged AI accounting and external executables. Downloaded media remains private in the disposable test directory and is not bundled. `public-download-result.json` retains metadata, hashes, limits, attribution and receipt evidence there.

An available public source used by upstream yt-dlp tests is Blender Foundation's *Big Buck Bunny*. Its source project is licensed under CC BY 3.0; retain the credit “(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org” if retaining or sharing the footage. The app does not gain rights to arbitrary media from this test. [Upstream extractor tests](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py), [Blender project attribution](https://peach.blender.org/about/), [Creative Commons project record](https://wiki.creativecommons.org/wiki/Big_Buck_Bunny).
