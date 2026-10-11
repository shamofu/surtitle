# UI primitive evaluation

`main.tsx`, `smoke.py` and `bundle.mjs` compare the original dialog implementation,
Base UI, React Aria Components and Radix in Chromium. Bundle figures are isolated
per candidate. Those results alone do not prove native video interoperability.

`native.tsx` is an independent Tauri frontend with all four candidates in one
build. It uses the shipping `NativePlayer`, `SurfaceProvider`, clipping
acknowledgement/focus restoration, real playback IPC, `save_card`, SQLite and
FFmpeg source-audio extraction. The same opaque rectangular styling and surface
registration apply to all candidates. The original implementation already owns
its Surface registration; the other three use the common `RegisterSurface`
adapter. This entry is never imported by the shipping application.

The native fixture tests playback → select cue → inspect meaning → save → resume,
immediate Escape before any field interaction, focus restoration, Tab containment,
arrow tabs, Unicode input, synthetic composing Escape, native HWND region and
unchanged video geometry. Synthetic composition does **not** prove Windows IME.
This combined bundle is not a fair transfer-size comparison; use `bundle.mjs` for
that separate measurement. This is a native integration probe, not four complete
application migrations or four production installers.

Run from the repository root on Windows after native dependencies are prepared:

```powershell
node e2e/evaluation/ui-primitives/native-build.mjs
node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --features e2e-test,custom-protocol --config work/ui-evaluation/native/tauri.json -- --locked --target-dir work/ui-native-target
```

The CLI resolves a relative Cargo target against `src-tauri`; using an absolute
target path avoids ambiguity. `native-build.mjs` writes only
`work/ui-evaluation/native`, derives the evaluation version from asset hashes and
uses identity `app.surtitle.evaluation.uinative20261011`. Do not use a production
identity or production `dist` directory. Seed a new workspace-only profile using
`seed_fixture DATA_DIR MEDIA_PATH` under `run-windows-standard-user.ps1`, matching
the app's restricted token. Use the generated local media, never personal media.

Set `SURTITLE_E2E_BINARY` to this separately built executable,
`SURTITLE_E2E_DATA_DIR` to the seeded profile, `SURTITLE_TAURI_DRIVER` and
`SURTITLE_NATIVE_DRIVER` to the verified local drivers,
`SURTITLE_E2E_HARDWARE_RENDERING=1` (forbid WARP), and an unused
`SURTITLE_WEBDRIVER_PORT`. Add the verified FFmpeg directory to this process's
PATH. Then:

```powershell
node e2e/support/run-native-e2e.mjs --spec e2e/evaluation/ui-primitives/native.e2e.js
```

Native reports go to `work/ui-evaluation/native/results/results.json`; captures
go to `test-results/native/ui-candidate-{candidate}.png`. Coordinate desktop/GPU
ownership with other native tests and record the actual OS scale before running.

`native-ime.e2e.js` is a separate operator/Computer Use rendezvous for genuine OS
IME. It focuses the Meaning input, records trusted composition/key events, and
writes a fresh token to `work/ui-evaluation/native/ime/request.json`. In the exact
returned evaluation window, use physical Japanese IME keys, inspect the candidate
popup, cancel conversion once, commit 日本, restore the prior IME mode, and write
the matching token plus observations to `response.json`. The native test then
checks trusted composition start/update, observed end followed by a trusted
non-composing key, committed text, retained dialog and blocked playback shortcuts.
It reports `trustedCompositionEnd` separately: the measured Windows runs emitted
an untrusted end even at window capture. That event alone is not native-end proof;
the observed OS candidate popup, trusted Process/start/update events, cancellation,
commit and post-commit key evidence establish the exercised workflow. The origin
of the untrusted end was not established. A timeout or missing composition events is a failed/unmeasured
IME check, never a reason to substitute `type_text`, Unicode fill or mock events.

Set `SURTITLE_UI_NATIVE_IME_CANDIDATES` to a comma-separated subset to resume an
interrupted physical-input run; preserve earlier raw reports before doing so.
The October 11 native comparison completed all four save/resume workflows, with
two expected comparison assertions: the original dialog included one BODY focus
sample, and Radix closed on synthetic composing Escape. Base and React Aria passed
those checks. Actual Windows IME cancellation/commit succeeded for all four;
Radix's synthetic result must not be described as a real-IME failure.

This fixture measures tab selection and key handling. It does not validate a
complete retained-tab implementation: the React Aria force-mounted panels were
both visible in this evaluation stylesheet. This did not change the video bounds,
but means panel visibility/lifecycle parity is outside the native comparison.
The shipping adoption is Dialog only. Full reports and exact binary/asset hashes
are retained in `docs/redesign/evidence/ui-primitives-native*.json`.
