#!/usr/bin/env bash
# Compilation runs only after Docker disconnects the acquisition network.
set -euo pipefail
workspace=/workspace
build=/build
if [[ ${CCACHE_DISABLE+x} ]]; then
  printf 'Native compilation cache is disabled (CCACHE_DISABLE)\n'
else
  printf 'Native compilation cache is enabled\n'
fi
ccache --zero-stats
report_cache_stats() {
  local status=$?
  trap - EXIT
  printf '\nNative compilation cache statistics for this run:\n'
  ccache --show-stats || true
  exit "$status"
}
trap report_cache_stats EXIT
bash "$workspace/scripts/native-build.sh" "$workspace" "$build"
python3 "$workspace/scripts/native-build-evidence.py" "$workspace" "$build" /out/native-build
python3 "$workspace/scripts/native-ort-compare.py" "$workspace" "$build/ort-corresponding"
cmake -S "$build/ort-corresponding/comparison-sources/protobuf/protobuf-3.21.12/cmake" \
  -B "$build/ort-corresponding/protoc-build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
  -Dprotobuf_BUILD_TESTS=OFF -Dprotobuf_BUILD_SHARED_LIBS=OFF -Dprotobuf_WITH_ZLIB=OFF \
  > "$build/ort-corresponding/protoc-build.log" 2>&1
cmake --build "$build/ort-corresponding/protoc-build" --target protoc --parallel 4 \
  >> "$build/ort-corresponding/protoc-build.log" 2>&1
python3 "$workspace/scripts/native-ort-generated.py" "$build/ort-corresponding"
python3 "$workspace/scripts/native-ort-package.py" "$workspace" "$build/ort-corresponding" /out/ort-candidate
mkdir -p /out/ci-artifact
cp /out/native-build/runtime/mpv-2.dll /out/ci-artifact/mpv-2.dll
cp /out/native-build/libmpv-candidate-source.tar.gz /out/ci-artifact/libmpv-source.tar.gz
cp /out/native-build/build-evidence.json /out/ci-artifact/libmpv-build-evidence.json
cp /out/native-build/toolchain-packages.tsv /out/ci-artifact/toolchain-packages.tsv
cp /out/ort-candidate/onnxruntime-1.29.0-candidate-source.tar.gz /out/ci-artifact/onnxruntime-source.tar.gz
cp /out/ort-candidate/source-package-inventory.json /out/ci-artifact/onnxruntime-source-inventory.json
