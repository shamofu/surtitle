# Development container

This optional local environment uses Ubuntu 24.04, Node from `.node-version` and Rust from `native/installer-inputs.json` for React, shared Rust and real Tauri Linux E2E tests. CI reads the same pins and runs those checks directly on its Ubuntu host. Windows libmpv rendering, DPAPI and NSIS require separate Windows verification.

The repository is a read/write bind mount at `/workspaces/surtitle`. Source, `.git` and lockfile edits are immediately visible on the host. Do not add host credentials, SSH agents, Docker sockets or GUI sockets to this container.

On native Linux, launch as a non-root host user. The launcher aligns the `vscode` account with the host UID and primary GID without changing source ownership. A UID owned by another account is rejected. Windows and `--wsl` use the image's named account. `updateRemoteUserUID` stays disabled because the launcher handles account alignment.

Dependencies and generated outputs never use host binds or named volumes. Temporary filesystems mask `.pnpm`, `.cargo`, `node_modules`, `target`, `dist`, `work`, `artifacts`, `test-results`, `playwright-report`, `src-tauri/gen`, `src-tauri/resources/native` and `src-tauri/resources/notices`. Existing Windows dependencies at those host paths are hidden. Large Cargo outputs and caches use the container writable layer at `/opt/surtitle-build`. Tmpfs data disappears when the container stops or restarts; writable-layer caches disappear when the container is removed. Initialize and install dependencies again after restarting. Ordinary Docker image layers remain cached. [Docker tmpfs documentation](https://docs.docker.com/engine/storage/tmpfs/)

## Launch

From the repository root, with Node and the Docker CLI/engine available on the host:

```sh
node .devcontainer/container.mjs build
node .devcontainer/container.mjs start surtitle-dev
node .devcontainer/container.mjs verify surtitle-dev
```

On Windows, add `--wsl` to each command to use Docker in the existing WSL distribution named `Ubuntu`. This invokes Docker as WSL root and requires an environment where Docker administration is authorized. The helper does not install Docker, change OS configuration or alter user groups.

`start`, `check` and `verify` reject extra host binds or volumes and use temporary probes to check source sharing and output isolation.

```sh
node .devcontainer/container.mjs check surtitle-dev
# Then attach a terminal for individual development commands:
docker exec -it --user vscode --workdir /workspaces/surtitle surtitle-dev bash
bash .devcontainer/initialize.sh
pnpm install --frozen-lockfile --store-dir /opt/surtitle-build/pnpm-store
dbus-run-session -- xvfb-run -a pnpm tauri dev
```

This starts Tauri against a private virtual display. The container deliberately
has no shared host GUI socket, so plain `pnpm tauri dev` has no display to open.
Use the native E2E suite for headless interaction; visible Windows playback
development remains on the Windows host.

The full check sequence is `.devcontainer/verify.sh`. Output streams to the terminal and `/opt/surtitle-build/verification.log`. Isolation results are written to `artifacts/container-isolation.json` and `/opt/surtitle-build/evidence/container-isolation.json`. Follow the log with `docker exec surtitle-dev tail -f /opt/surtitle-build/verification.log`. Export needed logs and screenshots before removing the container.

The image installs the pnpm version declared by `package.json` and the tools from `pnpm setup:rust-tools`. Verification uses `pnpm install --frozen-lockfile` for JavaScript and Rust dependencies. Generated `.pnpm` crate sources and `.cargo` source configuration stay in the temporary masks.

During headless E2E, `AT-SPI ... org.a11y.Bus` reports that the optional accessibility bus is absent; WebDriver tests do not verify screen-reader integration. `libEGL ... DRI3` reports an unavailable accelerated rendering path in the virtual display; Mesa can fall back to software rendering. These messages alone do not mean the E2E suite failed, and a passing Linux run does not certify GPU rendering. See the [AT-SPI bus description](https://github.com/GNOME/at-spi2-core/blob/main/bus/README.md) and [Mesa EGL fallback documentation](https://docs.mesa3d.org/egl.html).

See the [test guide](../docs/testing.md) for individual checks. CI runs directly on Ubuntu. The separate [native dependency build](../docs/native-runtime.md) uses its own Docker image and build inputs.

Every full verification uses a fresh `work/e2e-linux.XXXXXXXX` profile. Earlier
profiles remain under the container-only `work` tmpfs until the container stops
or restarts.

## Editor attachment

Create the container with the helper, then use VS Code **Dev Containers: Attach to Running Container...** and open `/workspaces/surtitle`. Run `container.mjs check` from the host again after attaching. [VS Code attachment documentation](https://code.visualstudio.com/docs/devcontainers/attach-container)

**Reopen in Container** can inject client-managed mounts such as a `/vscode` volume or GUI sockets, which `initialize.sh` rejects. Create the container with the helper and attach to it to retain the configured mount isolation. [Dev Container configuration specification](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainerjson-reference.md)

Tmpfs requires `exec` for esbuild and native Node modules; `nosuid,nodev` remain enabled and privileged containers are rejected. Since source is intentionally shared, this configuration does not prevent arbitrary programs from writing to other unmasked source paths. Add any new tool's output location to the masks and mount checks before using it.
