#!/usr/bin/env bash
set -euo pipefail
step() {
  printf '\n[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1"
}
cd /workspaces/surtitle
step 'Initializing container directories and runtime checks'
bash .devcontainer/initialize.sh
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/opt/surtitle-build/target}
export WEBKIT_DISABLE_COMPOSITING_MODE=1
step 'Installing locked JavaScript and Rust dependencies'
pnpm install --frozen-lockfile --store-dir /opt/surtitle-build/pnpm-store
step 'Checking application version, container isolation and production features'
node scripts/check-version.mjs
node .devcontainer/isolation.mjs
node scripts/check-production-features.mjs
step 'Running JavaScript UI and script tests'
pnpm test
step 'Building the frontend'
pnpm build
step 'Checking Rust formatting'
pnpm fmt:rust:check
step 'Running Rust workspace tests with all features'
pnpm test:rust
step 'Testing AI accounting without default features'
pnpm test:rust:no-default-features
step 'Running the three required FFmpeg waveform and stream regressions'
SURTITLE_TEST_FFMPEG="$(command -v ffmpeg)" pnpm test:rust:required linux-ffmpeg
step 'Running Rust Clippy checks'
pnpm lint:rust
if ! command -v cargo-deny >/dev/null; then
  step 'Installing cargo-deny for an older development image'
  pnpm rust install cargo-deny --locked --version 0.20.2
fi
step 'Auditing Rust licenses, dependencies and sources'
pnpm audit:rust
step 'Generating JavaScript license and dependency evidence'
node scripts/audit-js-licenses.mjs
step 'Building the native Linux E2E application'
pnpm build:native:e2e
step 'Generating E2E media fixtures'
pnpm test:fixtures
step 'Seeding a fresh E2E application profile'
e2e_data_dir="$(mktemp -d "$PWD/work/e2e-linux.XXXXXXXX")"
pnpm seed:fixtures "$e2e_data_dir" "$PWD/test-results/fixtures/日本語 & sample.mp4"
export SURTITLE_E2E_BINARY="$CARGO_TARGET_DIR/debug/surtitle"
export SURTITLE_E2E_DATA_DIR="$e2e_data_dir"
export SURTITLE_E2E_AI_RECOVERY=translation
export SURTITLE_E2E_TRANSCRIPT_REVIEW=boundary
step 'Running WebKitGTK and native Tauri E2E tests'
dbus-run-session -- xvfb-run -a pnpm test:e2e
step 'All Linux verification steps passed'
