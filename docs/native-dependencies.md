# Updating native dependencies

Select inputs in the catalogs below. Consumers read them directly; only Rust's
Silero constants (`OUT_DIR`) and two NSIS display constants
(`work/installer-prerequisite.nsh`) are generated. Neither is committed.

| Input | Authoritative definition | Consumers |
| --- | --- | --- |
| mpv, FFmpeg, dav1d and other libmpv sources | `native/build/sources.json`: repo, ref, commit, SHA-256, child parent / destination | `native_source_manifest.py` derives URLs, archive names and parent submodule records for acquisition and packaging. SPIRV-Cross's separate C API pkg-config version also lives here. |
| Official ORT DLLs, notices and selected libmpv artifact | `native/runtime-windows-x64.json`, `components` | Windows preparation, audits, artifact consumption and ORT packaging. libmpv `sourceId` refers to the source catalog; its `version` identifies the reviewed DLL candidate, not a second source tag. |
| ORT upstream source, vcpkg baseline, historical port selection | `native/build/onnxruntime-sources.json` | ORT acquisition, evidence collection and packaging; URLs / filenames derive from repository + commit. |
| ORT dependency sources / patches | Vendored `native/upstream-evidence/onnxruntime-overlay-ports/`; otherwise selected vcpkg baseline / historical port | Upstream `vcpkg.json` / `portfile.cmake` supply version, repository and SHA-512. Protoc's version comes from the selected protobuf metadata. |
| Silero model | Runtime manifest, `models` | Rust build script and Windows development preparation; existing first-use download and cache naming are preserved. |
| VC Runtime minimum, URL, required DLLs | Runtime manifest, `prerequisites` | Helper, native audit and installer preparation. Installer audit verifies the embedded manifest's hash. |
| NSIS, official Tauri plugin, source crates, Rust source / notices | `native/installer-inputs.json` | Installer preparation / audit; CI and Dev Container also read `rust.version`. Cargo's `rust-version` remains the minimum supported version. |

`native/reviews/` and the other `native/upstream-evidence/` files record observed
DLL/PDB/source identities and review results. They are not version selectors.
The overlay directory above is the exception: it contains actual vendored
upstream recipes used for reconstruction. Never bulk-replace versions in old
evidence or notices. New dependency bytes need new comparison/review evidence;
existing source/notice and binary checks deliberately reject stale evidence.

## Representative updates

- **FFmpeg / mpv:** edit its `ref`, fixed `commit` and archive `sha256` in
  `sources.json`; update child entries if submodules change. URLs, filenames and
  parent submodule commits follow automatically. When adopting a newly reviewed
  libmpv DLL, update its candidate identity / review references in the runtime
  manifest; artifact consumption records the output hashes.
- **ORT:** edit the official version, URL, DLL/archive/notice hashes and archive
  member paths in the runtime manifest; edit matching source commit / archive
  hash and, if changed, vcpkg baseline in `onnxruntime-sources.json`. Refresh
  upstream recipes and matching DLL/PDB evidence. No Docker/Python release paths
  need manual synchronization.
- **Silero:** edit model version, commit, URL, model and notice hashes in the
  runtime manifest. Cargo regenerates all constants automatically.
- **VC Runtime:** edit its minimum / URL / required files in the runtime
  manifest and run installer preparation. Updating the version no longer edits
  the helper, hook, translated messages or their hashes.
- **Installer / Rust:** edit source and notice pins in `installer-inputs.json`.
  CI / Dev Container follow the Rust pin. Tauri owns the standard installer
  tooling; choose matching source records when updating Tauri. Existing audits
  reject an unexpected official plugin or Rust toolchain.

## Build and verify

Use a fresh working copy (the wrapper requires a fresh output directory). After
collecting the required new evidence, build using the existing entry:

```sh
bash scripts/native-ci-build.sh
```

Then on Windows:

```powershell
node scripts/native-ci-artifact.mjs consume work/native-ci-artifact
pwsh -File scripts/native-prepare.ps1
pwsh -File scripts/native-smoke.ps1
python scripts/native-installer-prepare.py
pnpm test:scripts
```

Finish the standard Tauri build and `package-verify.ps1` checks in
[native runtime and packaging](native-runtime.md), using a disposable Windows
profile for lifecycle checks. Cached artifacts still need current application
playback and installation validation.

Docker separates libmpv and ORT acquisition inputs. Runtime / notice / comparison
changes rerun ORT packaging while reusing acquisition. The runtime manifest is
copied whole, so a Silero / VC edit also invalidates ORT packaging. App, Cargo
lockfile and frontend edits do not enter native stages. No separate cache-key
tool or generated dependency lockfile is needed.

This removes 67 redundant fields from the 20-entry libmpv source catalog (URLs,
filenames, submodule records, commit-as-ref duplicates). Definition locations
drop from three files to one for Silero, four to one for VC conditions, three
Python scripts to one JSON for ORT source pins, and four files to one for the
Rust toolchain pin. Both versioned Docker paths are now stable paths. Historical
evidence retains its original values.
