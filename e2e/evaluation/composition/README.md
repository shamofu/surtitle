# Native GPU composition experiment

This Windows-only, standalone host evaluates an actual shared GPU surface:

`libmpv OpenGL render API → WGL_NV_DX_interop2 stable D3D11 texture → GPU CopyResource → composition swapchain → DirectComposition`

A transparent WebView2 composition controller sits above the video visual. The
example includes translucent HTML, an animated overlay, a button, and an IME
input. The shared rendered target is not read back to CPU memory or passed through
JavaScript. The observed decoder uses `d3d11va-copy`: decoding includes copy-back
and subsequent GL upload. Presentation also performs one GPU texture copy per
frame. This is not an end-to-end zero-copy pipeline. Registering the rotating
swapchain backbuffer directly produced black output on the tested driver; the
stable interop texture and GPU copy fix that presentation failure.

This is evaluation code, not the application window backend. It creates a fresh
WebView profile below the chosen output directory and does not access Surtitle's
database, credentials, settings, or production application profile.

## Reproduce

From the repository root, on Windows with the pinned Rust toolchain, Docker, and
a hardware OpenGL implementation supporting `WGL_NV_DX_interop2`:

```powershell
python e2e/evaluation/composition/prepare-gl-candidate.py
docker build --target libmpv-build -t surtitle-redesign-rendering-gl -f work/rendering-evaluation/gl-context/native/build/Dockerfile work/rendering-evaluation/gl-context
docker create --name surtitle-rendering-gl-export surtitle-redesign-rendering-gl
docker cp surtitle-rendering-gl-export:/out/native-build work/rendering-evaluation/gl-candidate
docker rm surtitle-rendering-gl-export
cargo build --locked --manifest-path e2e/evaluation/composition/Cargo.toml
e2e/evaluation/composition/target/debug/surtitle-composition-evaluation.exe work/rendering-evaluation/gl-candidate/runtime/mpv-2.dll path/to/local-fixture.mp4 work/rendering-evaluation/composition-run 120
```

To reproduce the bounded workflow test, build with
`--target-dir work/rendering-evaluation/composition-host/target`, set
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444` only in the
evaluation host's process environment, and launch that binary with a fresh output
directory. In a second shell run:

```powershell
node e2e/evaluation/composition/workflow.mjs work/rendering-evaluation/composition-run
```

This sends real DOM input over CDP, waits for native acknowledgements, reads back
the saved file, checks advancing playback after resume, and physically resizes
the owned HWND using the repository's native-window test helper. CDP does not
prove OS mouse forwarding, and Unicode fill does not prove real IME composition.

Use a new output directory for a separate run. The preparation script copies the
repository's build recipe and this experiment's hash-pinned `comparison-sources.json`
(mpv 0.41.0 / FFmpeg 8.1.2), enables `gl` **and** `gl-win32` (required
because auto features are disabled), and separates the dependency build for
iteration. It produces a corresponding-source archive, build evidence, and a
candidate DLL. It never replaces the production resource or runtime manifest.
The selected production runtime's later FFmpeg 9.0.2 adoption is separate; this
snapshot keeps the renderer comparison reproducible without silently changing
its codec dependency.

The repository's `scripts/redesign-rendering-native.py` generates/uses local
fixtures for the HWND comparison; do not fetch private or remote media for this
experiment. Run the same fixture and duration when comparing paths.

Inspect `result.json` and `mpv.log`. `framesPresented` counts successful DXGI
present calls, not unique decoded frames. Verify visible moving video with a
native window capture; a running playback clock alone cannot prove output.

An optional final `capture-target` argument reads back one rendered frame to
`render-target.ppm` and records `optionalTargetDiagnostic.cpuReadback=true`.
This diagnostic changes timing and is excluded from comparative measurements.
It can distinguish a black rendered target from a downstream composition/capture
problem; it is not a screenshot of the composed HTML and video. The regular
presentation loop does not use this readback.

Alternatively `capture-window` uses public Windows.Graphics.Capture to capture
only the host's own HWND to `composed-window.ppm`. This verified decoded video
through translucent HTML after the stable-texture fix. No desktop or other
application is captured. It intentionally reads back a screenshot for evaluation
and is excluded from latency/performance measurements. `PrintWindow` and the
generic computer-use capture wrapper were insufficient to diagnose this route.

## Deliberate limits

- Hardware-only D3D11; software GL is rejected. Other GPU vendors and hybrid-GPU
  configurations require their own runs. This extension is not universal.
- Resize rebuilds the shared target. Device loss/recreation, HDR, mixed-DPI,
  accessibility providers, cursor negotiation, drag/drop, wheel/touch/pen input,
  and full application lifecycle are not production-complete.
- Mouse forwarding and focus are implemented only for this small HTML example.
  IME and click results are recorded in `webMessages` when exercised. Play, pause,
  subtitle selection, meaning, save, and resume go through actual native handlers;
  save writes a separate `saved-phrase.json`. This is a fixture workflow, not the
  production application's IPC, SQLite persistence, or review scheduling.
- `ao=null` makes these tests inaudible; they do not establish audio sync.
- Tauri's current Wry WebView2 backend creates a windowed controller. Adopting
  this route requires an evaluated backend extension/fork or custom runtime,
  including input routing and device-loss recovery. `with_webview` or CSS alone
  does not replace its controller.

See [the rendering decision record](../../../docs/redesign/rendering.md) for
actual hardware results and what remains unmeasured.

## Primary references

- [Khronos WGL_NV_DX_interop2](https://registry.khronos.org/OpenGL/extensions/NV/WGL_NV_DX_interop2.txt)
- [Microsoft WebView2 windowed and visual hosting](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/windowed-vs-visual-hosting)
- [mpv render API](https://github.com/mpv-player/mpv/blob/v0.41.0/include/mpv/render.h)
