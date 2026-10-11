# FFmpeg native runtime comparison — 2026-10-11

FFmpeg 9.0.2 is adopted in the worktree's packaged-runtime inputs after building with the existing mpv 0.41.0 and production D3D11 configuration without compatibility patches. The latest maintained 8.1.3 release was also verified as a fallback, but a fallback build was unnecessary once 9.0.2 passed compilation and runtime checks. The previous 8.1.2 DLL and corresponding source remain under `work/rendering-evaluation/hardware-candidate/`; the installed application and external CLI were not changed.

[FFmpeg's release page](https://ffmpeg.org/download.html) identifies 9.0.2 (September 18) and 8.1.3 (September 21). Both exact tag objects in the official GitHub mirror report valid signatures. The candidate uses commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, archive SHA-256 `0aa2b1de2a5698b20a23e93d539a9a8e82ca0117496c5bdf05d198805f42bb3b`.

The major library versions change from libavcodec 62/libavutil 60 to 63/61. The [9.0.2 changelog](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/Changelog) includes decoder and container fixes; this evaluation does not claim that a specific upstream fix improved these synthetic fixtures. Compilation used fresh FFmpeg/mpv object directories and removed prior FFmpeg headers, static libraries and pkg-config files, so an obsolete installed API could not conceal incompatibility. Other pinned sources and production feature flags were unchanged. Windows DLL imports are unchanged, and all 49 source/toolchain notice files are covered by the current combined notice.

The current 8.1.2 DLL and candidate 9.0.2 DLL were tested sequentially on the same NVIDIA RTX 5070 Ti host. Each ran six synthetic eight-second fixtures: H.264, HEVC and AV1, each at 1080p and 4K, with two audio tracks.

| Check | 8.1.2 | 9.0.2 |
| --- | --- | --- |
| D3D11 hardware decode, no WARP | 6/6 | 6/6 |
| Playback, second audio track, A/B loops | 6/6 | 6/6 |
| Paused exact seek to 1.25 s | 1.266667 s at 30 fps | Same |
| WASAPI clock advances at 1×, 1.5× and after seek | 18/18 phases | 18/18 phases |
| Largest sampled absolute mpv `avsync` | 0.101 ms | 0.092 ms |

The A/V values are diagnostic observations, not a measured performance improvement or acoustic lip-sync claim. WASAPI remained active with volume zero. Each phase samples two seconds after a 250 ms settling interval. Hidden native windows do not verify WebView composition, visible overlays, or subjective audio quality; those are separate application checks.

The exact artifact identities, phase summaries and raw-report hashes are in [the evidence JSON](evidence/ffmpeg-native-2026-10-11.json). Full logs, raw samples, the candidate DLL and its corresponding-source archive remain under `work/ffmpeg-native-evaluation/`. The separate [CLI comparison](ffmpeg-cli.md) covers audio preparation, card boundaries and cleanup; the installed external CLI is a distinct 9.0.1 build.

Adoption verification passed: the standard `native/windows/native-prepare.ps1` populated the worktree resources, all 14 focused native preparation/source/build tests passed, and the selected DLL and staged corresponding source match the measured candidate hashes. The staged build evidence names `libmpv-source.tar.gz` and retains its original build-output filename. Final installer/application checks remain separate from this isolated runtime comparison.

To recreate the isolated build after fetching the exact signed-tag metadata and archive into `work/ffmpeg-native-evaluation/downloads`:

```powershell
python e2e/evaluation/composition/prepare-gl-candidate.py
python e2e/evaluation/prepare-ffmpeg-candidate.py 9.0.2
docker build --file work/ffmpeg-native-evaluation/context-9.0.2/Dockerfile.ffmpeg --target libmpv-build --tag surtitle-redesign-ffmpeg-9.0.2 work/ffmpeg-native-evaluation/context-9.0.2
```

The composition preparation helper supplies the reusable dependency-cache stage only. The FFmpeg evaluator restores the production `native-build.sh`; it does not select the GL experiment. Run `scripts/redesign-rendering-native.py` with `--audio-output wasapi` and the six `*-multi.mp4` fixtures against each DLL in a separate process, then run `e2e/evaluation/summarize-ffmpeg-native.py`. Neither evaluator promotes a runtime artifact into production.
