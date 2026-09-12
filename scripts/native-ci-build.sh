#!/usr/bin/env bash
# Repository sources are Docker build inputs; no dependency/output bind or volume.
set -euo pipefail
sha=${GITHUB_SHA:?A tested Git commit SHA is required}
[[ "$sha" =~ ^[a-fA-F0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$sha" ]] || { echo 'Checkout differs from GITHUB_SHA' >&2; exit 1; }
node scripts/native-ci-artifact.mjs check-inputs
name="surtitle-native-ci-${sha:0:12}"
image="surtitle-native-ci:$sha"
destination=work/native-ci-artifact
[[ ! -L work && ( ! -e work || -d work ) && ! -e "$destination" && ! -L "$destination" ]] || { echo 'Native CI output must have regular ancestry and a fresh path' >&2; exit 1; }
docker build -f native/build/Dockerfile -t "$image" .
docker create --name "$name" "$image" sleep infinity
trap 'docker rm --force "$name" >/dev/null' EXIT
docker start "$name"
[[ "$(docker inspect --format '{{json .Mounts}}' "$name")" == '[]' ]] || { echo 'Native builder unexpectedly mounts host storage' >&2; exit 1; }
docker cp native/upstream-evidence "$name:/workspace/native/upstream-evidence"
for file in native/onnxruntime-LICENSE native/onnxruntime-ThirdPartyNotices.txt; do
  docker cp "$file" "$name:/workspace/$file"
done
for file in scripts/native-ort-*.py scripts/native-ci-inputs.py scripts/native-ci-build-inside.sh; do
  docker cp "$file" "$name:/workspace/$file"
done
docker exec "$name" python3 /workspace/scripts/native-ci-inputs.py /workspace /build
docker network disconnect bridge "$name"
docker exec "$name" bash /workspace/scripts/native-ci-build-inside.sh
mkdir -p "$destination"
# Explicitly export only the selected final payload, sources and evidence.
docker cp "$name:/out/ci-artifact/." "$destination/"
docker image inspect "$image" > "$destination/container-image.json"
node scripts/native-ci-artifact.mjs seal "$destination" "$sha"
