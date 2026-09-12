#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Focused rerun after the Dev Container's full verification has built fixtures.
set -euo pipefail
cd /workspaces/surtitle
unset GOOGLE_APPLICATION_CREDENTIALS
export CARGO_TARGET_DIR=/opt/surtitle-build/target
export WEBKIT_DISABLE_COMPOSITING_MODE=1
task_profile=$(mktemp -d "$PWD/work/e2e-draft-rerun.XXXXXXXX")
"$CARGO_TARGET_DIR/debug/examples/seed_fixture" "$task_profile" "$PWD/test-results/fixtures/日本語 & sample.mp4"
export SURTITLE_E2E_DATA_DIR="$task_profile"
export SURTITLE_E2E_BINARY="$CARGO_TARGET_DIR/debug/surtitle"
export SURTITLE_E2E_AI_RECOVERY=translation
export SURTITLE_E2E_TRANSCRIPT_REVIEW=boundary
dbus-run-session -- xvfb-run -a pnpm test:e2e --spec ./e2e/native/draft-study.e2e.js
