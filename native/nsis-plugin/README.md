# Locked Tauri NSIS plugin build

The plugin source is the unmodified upstream 0.5.3 commit named in `inputs.json`.
`Cargo.lock` fixes all registry dependencies. This recipe does not install a Rust
target globally or replace the user's Tauri/NSIS cache.

Use Windows x64, Python 3.12 or newer, Rust 1.98.0 for x86_64 MSVC, and the Visual
Studio C++ build tools/Windows SDK. The usual Rust toolchain installation is a
prerequisite; the script itself adds no global components.

```powershell
pwsh -NoProfile -File scripts/nsis-plugin-build.ps1 -WorkDirectory work/nsis-plugin-build
```

The build directory must be a fresh child of this repository's `work` directory.
It acquires hash-pinned source/standard-library archives, verifies the installed
x86_64 standard library against the official release component, and prepares an
i686 sysroot only inside the build directory. Cargo acquires the locked dependencies
into a private Cargo home; compilation runs with `--frozen`. Source code is not
downloaded during compilation. No host network interface is disabled.

The actual i686 DLL smoke uses 32-bit PowerShell to load the exact DLL, verify its
required exports, and test semantic version comparisons plus multilingual string
replacement. Process-management functions are checked for existence only. No
installer is executed. Upstream's exported DllMain can produce linker warning
LNK4216; load and function tests still must pass.

`output/` contains the DLL, `build-evidence.json`, `nsis-plugin-source.tar.gz`,
dependency notices, and reusable `rust-runtime-notices/`,
`rust-runtime-evidence.json`, and `rust-runtime-source.tar.gz`. The latter retain
the exact Rust source component, official runtime copyright report, complete
compiler-builtins license, and referenced license texts. They cover this Rust
release's standard library, including core/alloc and x86_64 host runtime; they
do not assert that every listed standard-library component is linked into every
application.

The plugin source package retains the original archive, prepared source, Cargo.lock,
vendored dependency source/checksums, recipe, metadata, logs, notices, and Rust
runtime source package. Build-tool binaries, standard-library binaries, dependency
caches and global configuration are excluded. To rebuild without fetching crate
sources, use the vendored source and Cargo's source replacement configuration;
the pinned compiler, official target standard-library component, MSVC linker and
Windows SDK remain build prerequisites.

The receipt does not approve publication. Installer integration must stage the
verified plugin through the private NSIS tools/template route, then rebuild and
check the actual extracted plugin hash, packaged notices and corresponding source.
