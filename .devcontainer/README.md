# Development container

Use Ubuntu 24.04, Node 24.21.0 LTS from `.node-version` and Rust 1.98.0 for React, shared Rust and real Tauri Linux E2E tests. Windows libmpv rendering, DPAPI and NSIS require separate Windows verification.

The repository is a read/write bind mount at `/workspaces/surtitle`. Source, `.git` and lockfile edits are immediately visible on the host. Do not add host credentials, SSH agents, Docker sockets or GUI sockets to this container.

On native Linux, the launcher starts with the non-root host UID and primary GID, then aligns the `vscode` account before running source-write probes. Only `/home/vscode` and `/opt/surtitle-build` ownership changes inside the container; source permissions and ownership stay unchanged. An existing target group is reused, while a UID owned by another account is rejected. Launch as a non-root host user. Windows and `--wsl` keep the image's named account, and `updateRemoteUserUID` remains disabled because the launcher performs Linux alignment explicitly.

Dependencies and generated outputs never use host binds or named volumes. Temporary filesystems mask `node_modules`, `target`, `dist`, `work`, `artifacts`, `test-results`, `playwright-report`, `src-tauri/gen`, `src-tauri/resources/native` and `src-tauri/resources/notices`. Existing Windows dependencies at those host paths are hidden. Large Cargo outputs and caches use the container writable layer at `/opt/surtitle-build`. Tmpfs data disappears when the container stops or restarts; writable-layer caches disappear when the container is removed. Initialize and install dependencies again after restarting. Ordinary Docker image layers remain cached. [Docker tmpfs documentation](https://docs.docker.com/engine/storage/tmpfs/)

## Verified launch path

From the repository root, with Node and the Docker CLI/engine available on the host:

```sh
node .devcontainer/container.mjs build
node .devcontainer/container.mjs start surtitle-dev
node .devcontainer/container.mjs verify surtitle-dev
```

On Windows, add `--wsl` to each command to use Docker in the existing WSL distribution named `Ubuntu`. This invokes Docker as WSL root and requires an environment where Docker administration is authorized. The helper does not install Docker, change OS configuration or alter user groups.

`start`, `check` and `verify` inspect actual runtime mounts and reject extra host binds or volumes. They also create uniquely named temporary probes to verify both directions of source sharing and confirm that writes under all ten output masks do not appear on the host. Only these probe files are removed.

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

The full check sequence is `.devcontainer/verify.sh`. The launcher announces build, startup, account alignment and isolation checks. Verification streams stdout and stderr live, with UTC timestamps identifying each major step, while retaining the same output in `/opt/surtitle-build/verification.log`. A failed command or log write still fails verification. Isolation evidence is written to both temporary `artifacts/container-isolation.json` and writable-layer `/opt/surtitle-build/evidence/container-isolation.json`. To follow the log from another terminal, use `docker exec surtitle-dev tail -f /opt/surtitle-build/verification.log`. The helper never automatically copies dependency trees, executables or build outputs to the host. CI separately exports only selected JSON reports, the verification log and native E2E screenshots for artifact retention.

The image includes the pinned `cargo-deny` license-audit tool so Docker image caching also retains its installation. Verification installs that version only when using an older image where the tool is absent.

During headless E2E, `AT-SPI ... org.a11y.Bus` reports that the optional accessibility bus is absent; WebDriver tests do not verify screen-reader integration. `libEGL ... DRI3` reports an unavailable accelerated rendering path in the virtual display; Mesa can fall back to software rendering. These messages alone do not mean the E2E suite failed, and a passing Linux run does not certify GPU rendering. See the [AT-SPI bus description](https://github.com/GNOME/at-spi2-core/blob/main/bus/README.md) and [Mesa EGL fallback documentation](https://docs.mesa3d.org/egl.html).

Check the final spec results and process exit code. WebDriver command errors need separate investigation: an interaction error may recover after WebdriverIO waits for the element, but an expected application rejection must assert the actual application error. Capture that rejection inside the webview and serialize it explicitly so a driver transport error cannot accidentally satisfy the test.

`pnpm test` runs both the Vitest UI and Node script projects. Select `pnpm test:ui` or `pnpm test:scripts` for focused checks; `pnpm test:watch` watches both. CI builds this image with Buildx and a dedicated GitHub Actions layer cache, then uses the same `start` and `verify` commands above. The native toolchain image has a separate cache scope. These image caches do not persist runtime pnpm/Cargo stores or build directories, and do not add container mounts.

Every full verification allocates a fresh `work/e2e-linux.XXXXXXXX` profile with
`mktemp`. The SQLite seeder and Tauri E2E process use that same directory, so
previous review decisions and recovery receipts cannot affect the next run.
Earlier profiles are not deleted; they remain under the container-only `work`
tmpfs until the container stops or restarts. Export selected logs before another
run if their previous contents must be retained.

## Editor attachment

Create the container with the helper, then use VS Code **Dev Containers: Attach to Running Container...** and open `/workspaces/surtitle`. Run `container.mjs check` from the host again after attaching. Editor attachment itself has not yet been exercised on this workstation. [VS Code attachment documentation](https://code.visualstudio.com/docs/devcontainers/attach-container)

**Reopen in Container** can inject client-managed mounts such as a `/vscode` volume or GUI sockets. The repository configuration cannot guarantee that every client disables its own additional mounts, so that path does not share the verified helper's guarantee. The kernel mount check in `initialize.sh` rejects unexpected mounts before installing project dependencies. To satisfy the no-named-volume requirement, use explicit creation followed by attachment to that existing container. [Dev Container configuration specification](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainerjson-reference.md)

Tmpfs requires `exec` for esbuild and native Node modules; `nosuid,nodev` remain enabled and privileged containers are rejected. Since source is intentionally shared, this configuration does not prevent arbitrary programs from writing to other unmasked source paths. Add any new tool's output location to the masks and contract tests before using it.

## Local verification record

On 2026-09-09, the shared-source helper completed the full sequence against a
fresh disposable profile: 66 UI tests, 89 Node contract tests including the
separate workflow check, Rust workspace all-feature tests, formatting, Clippy,
Rust/JavaScript license checks, and all five real Linux Tauri E2E spec files
(16 passing cases; eight Windows-only cases skipped). Before/after probes
confirmed bidirectional source sharing, all ten temporary output masks, zero
host probe-output writes and zero named volumes. Selected logs and JSON reports
were explicitly exported to `artifacts/devcontainer/final-20260909-0639/`;
dependency and build trees remained inside the container. The subsequent
fresh-profile allocation change was checked separately with two distinct paths
under the same work mask; the full application suite was not repeated for that
harness-only change. This record does not certify a VS Code editor launch or
Windows rendering.
