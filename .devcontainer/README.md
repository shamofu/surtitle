# Development container

The optional Ubuntu 24.04 environment supports shared Rust, GPUI compilation, build/test helpers and bounded formal verification. It uses Node from `.node-version`, Rust from `native/installer-inputs.json`, and pnpm/Rust tools from `package.json`. Windows libmpv rendering, DPAPI, native input and NSIS lifecycle checks require Windows.

## Open the workspace

Install the VS Code Dev Containers extension, open this repository and run **Dev Containers: Reopen in Container**. Creation installs locked JavaScript tooling and Rust dependencies with `pnpm install --frozen-lockfile`. Use **Dev Containers: Rebuild Container** after changing the image or configuration.

Choose the container engine in local tooling. The shared configuration supports Docker-compatible engines, including wslc. To use wslc in VS Code, set `"dev.containers.dockerPath": "wslc"` in **User** settings. Follow the container-operation rules for the current machine; this setting does not belong in shared configuration.

## Storage and sharing

The checkout is shared read/write at `/workspaces/surtitle`. Source, configuration, Git and lockfile edits appear on the host. Untracked files outside volume paths are also shared, including a root `.env` if present. `.gitignore` does not restrict sharing; `.dockerignore` filters image build inputs.

Four named volumes scoped to `${devcontainerId}` keep generated contents separate from the host directories and retain them across restarts and rebuilds:

| Volume suffix | Workspace path | Contents |
| --- | --- | --- |
| `pnpm` | `.pnpm` | pnpm-managed dependencies |
| `cargo` | `.cargo` | Generated Cargo configuration |
| `node-modules` | `node_modules` | JavaScript helper dependencies and caches |
| `work` | `work` | Cargo builds, prepared resources, working data and reports |

`work/resources` uses the existing work volume. Generated resources do not need a separate volume or tracked placeholder mounts. Source sharing still permits writes to host source and Git; these volumes isolate outputs rather than arbitrary writes elsewhere in the checkout.

The container sets `CARGO_TARGET_DIR=/workspaces/surtitle/work/target` and `SURTITLE_RESOURCE_DIR=/workspaces/surtitle/work/resources`. pnpm supplies the corresponding Cargo output default on hosts. Explicit output overrides can bypass isolation. Other home caches survive restarts but are recreated with the container.

All mounts request `volume-nocopy`. The current wslc backend does not support this option, and Dev Containers omits it when translating mounts. Keep volume destinations empty in the image: tools are installed under the container user's home and pnpm is bootstrapped under `/tmp`. The explicit no-copy option itself is not enforced on wslc.

Dev Containers handles Linux UID/GID alignment. Initialization repairs dependency ownership and the work root. No startup step copies or migrates previous outputs. Use the selected engine's volume management when intentionally resetting generated data.

Read reports inside the container or explicitly export needed files. Native dependency exports and CI report collection remain explicit transfers; they do not make container outputs shared.

## Development

Run the commands in the [test guide](../docs/testing.md). The image includes X11/Wayland headers and Vulkan libraries for compiling the pinned GPUI dependency and running shared service/component tests. The product desktop entry point currently supports Windows only.

Linux compilation and fake-platform tests do not verify Windows graphics, playback, IME or GPU efficiency. Use **Dev Containers: Reopen Folder Locally** for Windows desktop verification.
