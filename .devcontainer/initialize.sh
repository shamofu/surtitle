#!/usr/bin/env bash
set -euo pipefail
node .devcontainer/runtime-preflight.mjs
mkdir -p /opt/surtitle-build/{target,tmp,pnpm-store,npm-cache,playwright,cache}
mkdir -p node_modules/.cache src-tauri/resources/native src-tauri/resources/notices
cp /opt/surtitle-notices-seed/README.txt src-tauri/resources/notices/README.txt
