# Development container

The optional Ubuntu 24.04 environment supports shared Rust and GPUI compilation. It installs the Rust toolchain from `rust-toolchain.toml` along with `cargo-nextest` and `cargo-deny`. Windows libmpv rendering, DPAPI, native input, and NSIS packaging require Windows.

## Open the workspace

Install the VS Code Dev Containers extension, open this repository and run **Dev Containers: Reopen in Container**. Use **Dev Containers: Rebuild Container** after changing the image or configuration.

Choose the container engine in local tooling. The shared configuration supports Docker-compatible engines, including wslc. To use wslc in VS Code, set `"dev.containers.dockerPath": "wslc"` in **User** settings. Follow the container-operation rules for the current machine; this setting does not belong in shared configuration.

## Storage and sharing

The checkout is shared read/write at `/workspaces/surtitle`. Source, configuration, Git and lockfile edits appear on the host. Untracked files outside volume paths are also shared, including a root `.env` if present. `.gitignore` does not restrict sharing; `.dockerignore` filters image build inputs.

A named volume scoped to `${devcontainerId}` keeps build outputs separate from host `work/` and retains them across restarts and rebuilds:

| Volume suffix | Workspace path | Contents |
| --- | --- | --- |
| `work` | `work` | Cargo builds, prepared resources, working data and test results |

`work/resources` uses the existing `work` volume. Generated resources do not need a separate volume or tracked placeholder mounts. Source sharing still permits writes to host source and Git; this volume isolates outputs rather than arbitrary writes elsewhere in the checkout.

The container sets `CARGO_TARGET_DIR=/workspaces/surtitle/work/target` and `SURTITLE_RESOURCE_DIR=/workspaces/surtitle/work/resources`. Explicit output overrides can bypass isolation.

The mount requests `volume-nocopy`. The current wslc backend does not support this option, and Dev Containers omits it when translating mounts. Keep the volume destination empty in the image: Rust tools are installed under `/home/vscode/.cargo/bin`.

Dev Containers handles Linux UID/GID alignment. Initialization repairs `work` directory ownership without copying or migrating previous outputs. Use the selected engine's volume management when intentionally resetting generated data.

## Development

Run the commands in the [test guide](../docs/testing.md). The image includes X11/Wayland headers and Vulkan libraries for compiling the pinned GPUI dependency and running shared service/component tests. The product desktop entry point currently supports Windows only.

Linux compilation and fake-platform tests do not verify Windows graphics, playback, IME or GPU efficiency. Use **Dev Containers: Reopen Folder Locally** for Windows desktop verification.
