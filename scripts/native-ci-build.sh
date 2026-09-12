#!/usr/bin/env bash
# Repository sources are Docker build inputs; no dependency/output bind or volume.
set -euo pipefail
prebuilt_image=false
case "$#:${1:-}" in
  0:) ;;
  1:--prebuilt-image) prebuilt_image=true ;;
  *) echo 'Usage: bash scripts/native-ci-build.sh [--prebuilt-image]' >&2; exit 1 ;;
esac
sha=${GITHUB_SHA:?A tested Git commit SHA is required}
[[ "$sha" =~ ^[a-fA-F0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$sha" ]] || { echo 'Checkout differs from GITHUB_SHA' >&2; exit 1; }
node scripts/native-ci-artifact.mjs check-inputs
name="surtitle-native-ci-${sha:0:12}"
image="surtitle-native-ci:$sha"
destination=work/native-ci-artifact
[[ ! -L work && ( ! -e work || -d work ) && ! -e "$destination" && ! -L "$destination" ]] || { echo 'Native CI output must have regular ancestry and a fresh path' >&2; exit 1; }
cache_root=
cache_names=(compiler source-cache ort-archives)
cache_targets=(/build/compiler-cache /build/source-cache /build/ort-corresponding/archives)
validate_cache_tree() {
  local path=$1 unexpected
  [[ -d "$path" && ! -L "$path" ]] || { echo 'Native cache must be a regular directory: '"$path" >&2; exit 1; }
  unexpected=$(find "$path" ! -type d ! -type f -print -quit) || { echo 'Cannot inspect native cache: '"$path" >&2; exit 1; }
  [[ -z "$unexpected" ]] || { echo 'Native cache contains a symlink or special file: '"$path" >&2; exit 1; }
  unexpected=$(find "$path" -type f -links +1 -print -quit) || { echo 'Cannot inspect native cache: '"$path" >&2; exit 1; }
  [[ -z "$unexpected" ]] || { echo 'Native cache contains a hard-linked file: '"$path" >&2; exit 1; }
  unexpected=$(find "$path" -type f -name '*.partial' -print -quit) || { echo 'Cannot inspect native cache: '"$path" >&2; exit 1; }
  [[ -z "$unexpected" ]] || { echo 'Native cache contains an incomplete source download: '"$path" >&2; exit 1; }
}
if [[ -n ${SURTITLE_NATIVE_CACHE_DIR:-} ]]; then
  [[ -d "$SURTITLE_NATIVE_CACHE_DIR" && ! -L "$SURTITLE_NATIVE_CACHE_DIR" ]] || { echo 'Native cache root must already exist as a regular directory' >&2; exit 1; }
  cache_root=$(realpath "$SURTITLE_NATIVE_CACHE_DIR")
  [[ "$cache_root" != / && "$cache_root" == "$SURTITLE_NATIVE_CACHE_DIR" ]] || { echo 'Native cache root must be an absolute canonical path without symlink ancestors' >&2; exit 1; }
  for directory in "${cache_names[@]}"; do
    if [[ -e "$cache_root/$directory" || -L "$cache_root/$directory" ]]; then validate_cache_tree "$cache_root/$directory"; fi
    [[ ! -e "$cache_root/previous-$directory" && ! -L "$cache_root/previous-$directory" ]] || { echo 'Native cache staging must be fresh' >&2; exit 1; }
  done
fi
compiler_environment=()
if [[ ${CCACHE_DISABLE+x} ]]; then
  [[ "$CCACHE_DISABLE" == 1 ]] || { echo 'Use CCACHE_DISABLE=1 for a cache-disabled verification build' >&2; exit 1; }
  compiler_environment=(--env CCACHE_DISABLE=1)
fi
if [[ "$prebuilt_image" == true ]]; then
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$sha" ]] || { echo 'Prebuilt native image must match GITHUB_SHA' >&2; exit 1; }
else
  docker build -f native/build/Dockerfile -t "$image" --label "org.opencontainers.image.revision=$sha" .
fi
docker create --name "$name" "${compiler_environment[@]}" "$image" sleep infinity
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
if [[ -n "$cache_root" ]]; then
  for index in "${!cache_names[@]}"; do
    directory=${cache_names[$index]}
    target=${cache_targets[$index]}
    docker exec "$name" mkdir -p "$target"
    if [[ -d "$cache_root/$directory" ]]; then
      printf 'Restoring native cache: %s\n' "$directory"
      docker cp "$cache_root/$directory/." "$name:$target/"
    else
      printf 'Native cache miss: %s\n' "$directory"
    fi
  done
fi

docker exec "$name" python3 /workspace/scripts/native-ci-inputs.py /workspace /build
docker network disconnect bridge "$name"
docker exec "$name" bash /workspace/scripts/native-ci-build-inside.sh
mkdir -p "$destination"
# Explicitly export only the selected final payload, sources and evidence.
docker cp "$name:/out/ci-artifact/." "$destination/"
docker image inspect "$image" > "$destination/container-image.json"
node scripts/native-ci-artifact.mjs seal "$destination" "$sha"

# Save only reusable compiler data and verified download archives after sealing.
# Move restored trees aside so ccache eviction is reflected in the saved cache.
if [[ -n "$cache_root" ]]; then
  for index in "${!cache_names[@]}"; do
    directory=${cache_names[$index]}
    target=${cache_targets[$index]}
    if [[ -d "$cache_root/$directory" ]]; then
      mv -- "$cache_root/$directory" "$cache_root/previous-$directory"
    fi
    mkdir "$cache_root/$directory"
    docker cp "$name:$target/." "$cache_root/$directory/"
    validate_cache_tree "$cache_root/$directory"
    printf 'Prepared native cache for saving: %s\n' "$directory"
  done
fi
