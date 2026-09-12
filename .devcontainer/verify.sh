#!/usr/bin/env bash
set -euo pipefail
cd /workspaces/surtitle
bash .devcontainer/initialize.sh
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/opt/surtitle-build/target}
export WEBKIT_DISABLE_COMPOSITING_MODE=1
pnpm install --frozen-lockfile --store-dir /opt/surtitle-build/pnpm-store
node scripts/check-version.mjs
node --test .devcontainer/isolation.test.mjs
node .devcontainer/isolation.mjs
node --test scripts/release-contract.test.mjs
node --test scripts/native-ci-contract.test.mjs
node --test scripts/native-installer-audit.test.mjs scripts/package-production-smoke.test.mjs
node --test scripts/check-production-features.test.mjs scripts/ai-tests/*.test.mjs
node scripts/check-production-features.mjs
pnpm test
pnpm build
cargo fmt --all -- --check
cargo test --workspace --all-features --locked
cargo test -p surtitle-ai --no-default-features --locked
SURTITLE_TEST_FFMPEG="$(command -v ffmpeg)" cargo test -p surtitle --lib --features e2e-test --locked installed_ffmpeg_preserves_ -- --ignored
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
if ! command -v cargo-deny >/dev/null; then cargo install cargo-deny --locked --version 0.20.2; fi
cargo deny check licenses bans sources
node scripts/audit-js-licenses.mjs
cargo build -p surtitle --features e2e-test,custom-protocol --locked
pnpm test:fixtures
e2e_data_dir="$(mktemp -d "$PWD/work/e2e-linux.XXXXXXXX")"
cargo run -p surtitle-core --example seed_fixture -- "$e2e_data_dir" "$PWD/test-results/fixtures/日本語 & sample.mp4"
export SURTITLE_E2E_BINARY="$CARGO_TARGET_DIR/debug/surtitle"
export SURTITLE_E2E_DATA_DIR="$e2e_data_dir"
export SURTITLE_E2E_AI_RECOVERY=translation
export SURTITLE_E2E_TRANSCRIPT_REVIEW=boundary
dbus-run-session -- xvfb-run -a pnpm test:e2e
