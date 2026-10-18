# Development container

The optional Ubuntu 24.04 environment supports React, shared Rust and native Tauri Linux E2E tests. It uses Node from `.node-version`, Rust from `native/installer-inputs.json`, and pnpm and Rust tools from `package.json`. Windows libmpv rendering, DPAPI and NSIS still require Windows verification.

## Open the workspace

Install the VS Code Dev Containers extension, open this repository and run **Dev Containers: Reopen in Container**. Creation installs locked JavaScript and Rust dependencies with `pnpm install --frozen-lockfile`. Use **Dev Containers: Rebuild Container** after changing the image or configuration.

Choose the container engine in your local tooling. The shared configuration supports Docker-compatible engines, including wslc. To use wslc in VS Code, set `"dev.containers.dockerPath": "wslc"` in your **User** settings. Follow the container-operation rules for your machine; this setting does not belong in the shared workspace configuration.

## Storage and sharing

The checkout is shared read/write at `/workspaces/surtitle`. Source, configuration, Git and lockfile edits appear on the host. Untracked files outside the volume paths are also shared, including a root `.env` if present. `.gitignore` does not restrict sharing; `.dockerignore` only filters image build inputs.

Six named volumes scoped to `${devcontainerId}` cover these paths. Their contents are separate from the host directories with the same names and persist across container restarts and rebuilds:

| Volume suffix | Workspace path | Contents |
| --- | --- | --- |
| `pnpm` | `.pnpm` | pnpm-managed dependencies |
| `cargo` | `.cargo` | Generated Cargo configuration |
| `node-modules` | `node_modules` | JavaScript dependencies and caches |
| `work` | `work` | Builds, working data, distribution output and reports |
| `tauri-gen` | `src-tauri/gen` | Generated Tauri schemas |
| `resources` | `src-tauri/resources` | Generated native resources and notices |

The tracked source files `resources/native/.gitkeep` and `resources/notices/README.txt` remain individually shared read/write. Empty mount-point directories can appear on the host, but generated contents stay in the volumes. Source sharing still permits writes to host source and Git files; this isolates dependency and output storage, not arbitrary writes elsewhere in the checkout.

All environments use `work/target`, `work/dist`, `work/artifacts`, `work/test-results` and `work/playwright-report`. The container sets `CARGO_TARGET_DIR` to `/workspaces/surtitle/work/target`; pnpm supplies the corresponding default for host commands. Explicit output overrides can bypass isolation. Other home caches survive restarts but are recreated with the container.

All volume mounts request `volume-nocopy`. The current wslc backend does not support this option, and Dev Containers omits it when translating mounts for wslc. Keep the image's volume destinations empty: tools are installed under the container user's home and pnpm is bootstrapped under `/tmp`, so fresh volumes start without copying image or host dependencies and outputs. The explicit no-copy option itself is not enforced on wslc.

Dev Containers handles Linux UID/GID alignment. Initialization repairs dependency ownership, then changes only the output roots and the two resource subdirectories, without traversing the shared resource files. Rebuild the container to apply mount changes. No startup step copies or migrates previous outputs. Use your chosen engine's volume management when intentionally resetting generated data.

Read reports inside the container or explicitly export the files you need. Windows native dependency exports and CI report collection remain explicit transfers; they do not make the Dev Container's output volumes shared.

## Development

Run the ordinary commands in the [test guide](../docs/testing.md), including [native E2E](../docs/testing.md#native-e2e), from the container terminal. For a private virtual display:

```sh
dbus-run-session -- xvfb-run -a pnpm tauri dev
```

Linux headless checks do not verify Windows rendering or GPU acceleration. Use **Dev Containers: Reopen Folder Locally** when returning to host development.
