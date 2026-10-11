# Updating native dependencies

Select inputs in the catalogs below. Consumers read them directly; only Rust's
Silero constants (`OUT_DIR`) and two NSIS display constants
(`work/installer-prerequisite.nsh`) are generated. Neither is committed.

| Input | Authoritative definition | Consumers |
| --- | --- | --- |
| mpv, FFmpeg, dav1d and other libmpv sources | `native/build/sources.json`: repo, ref, commit, SHA-256, child parent / destination | `native_source_manifest.py` derives URLs, archive names and parent submodule records for acquisition and packaging. SPIRV-Cross's separate C API pkg-config version also lives here. |
| Official ORT DLLs, notices and selected libmpv artifact | `native/runtime-windows-x64.json`, `components` | Windows preparation and ORT packaging. libmpv `sourceId` refers to the source catalog; its `version` describes the DLL candidate, not a second source tag. Consumption stages artifacts at fixed ignored paths without rewriting this catalog. |
| ORT upstream source, vcpkg baseline, historical port selection | `native/build/onnxruntime-sources.json` | ORT acquisition, evidence collection and packaging; URLs / filenames derive from repository + commit. |
| ORT dependency sources / patches | Vendored `native/upstream-evidence/onnxruntime-overlay-ports/`; otherwise selected vcpkg baseline / historical port | Upstream `vcpkg.json` / `portfile.cmake` supply version, repository and SHA-512. Protoc's version comes from the selected protobuf metadata. |
| Silero model | Runtime manifest, `models` | Rust build script, Windows development preparation, first-use download and cache naming. |
| VC Runtime minimum, URL, required DLLs | Runtime manifest, `prerequisites` | Prerequisite helper and installer preparation. |
| NSIS, official Tauri plugin, source crates, Rust source / notices | `native/installer-inputs.json` | Installer source preparation; CI and Dev Container also read `rust.version`. Cargo's `rust-version` remains the minimum supported version. |

`native/reviews/` and the other `native/upstream-evidence/` files record observed
DLL/PDB/source identities and review results. They are not version selectors.
The overlay directory above is the exception: it contains actual vendored
upstream recipes used for reconstruction. Never bulk-replace versions in old
evidence or notices. Historical reports do not gate runtime preparation, loading
or distribution. Source archive pins still identify dependency download inputs.

## Dependency updates

- **FFmpeg / mpv:** edit its `ref`, fixed `commit` and archive `sha256` in
  `sources.json`; update child entries if submodules change. URLs, filenames and
  parent submodule commits follow automatically. Stage the built libmpv DLL at
  `work/native-ci-artifact/mpv-2.dll`; no output hash is recorded in Git.
- **ORT:** edit the official version, URL and archive
  member paths in the runtime manifest; edit matching source commit / archive
  hash and, if changed, vcpkg baseline in `onnxruntime-sources.json`. Refresh
  upstream recipes when required. Runtime DLL/archive/notice hashes are not pinned.
- **Silero:** edit model version, commit, URL, model and notice hashes in the
  runtime manifest. Cargo regenerates all constants automatically.
- **VC Runtime:** edit its minimum / URL / required files in the runtime
  manifest and run installer preparation.
- **Installer / Rust:** edit source and notice pins in `installer-inputs.json`.
  CI / Dev Container follow the Rust pin. Tauri owns the standard installer
  tooling; choose matching source records when updating Tauri.

## Build and test

Use a fresh `work/native-ci-artifact/` directory with regular, non-symlink
ancestors. Build with:

```sh
docker buildx build --file native/build/Dockerfile --target export --provenance=false --output type=local,dest=work/native-ci-artifact .
```

Then on Windows:

```powershell
node native/build/native-ci-artifact.mjs consume work/native-ci-artifact
pwsh -File native/windows/native-prepare.ps1
pwsh -File native/windows/native-smoke.ps1
python native/windows/native-installer-prepare.py
pnpm test:scripts
```

Finish the standard Tauri build and `package-verify.ps1` checks in
[native runtime and packaging](native-runtime.md), using a disposable Windows
profile for lifecycle checks. Cached artifacts still need current application
playback and installation validation.

Docker separates libmpv and ORT acquisition inputs. Runtime / notice / packaging
changes rerun ORT packaging while reusing acquisition. The runtime manifest is
copied whole, so a Silero / VC edit also invalidates ORT packaging. App, Cargo
lockfile and frontend edits do not enter native stages.
