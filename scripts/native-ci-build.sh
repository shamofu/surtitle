#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
destination=work/native-ci-artifact
[[ ! -L work && ( ! -e work || -d work ) && ! -e "$destination" && ! -L "$destination" ]] || {
  echo 'Native output must have regular ancestry and a fresh path' >&2; exit 1;
}
secrets=()
if [[ -n ${SURTITLE_NATIVE_GITHUB_TOKEN:-} ]]; then
  secrets=(--secret id=github_token,env=SURTITLE_NATIVE_GITHUB_TOKEN)
fi
docker buildx build --file native/build/Dockerfile --target export --provenance=false \
  --output "type=local,dest=$destination" "${secrets[@]}" "$@" .
node scripts/native-ci-artifact.mjs verify "$destination"
