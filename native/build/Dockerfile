# syntax=docker/dockerfile:1
FROM ubuntu:24.04 AS toolchain
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates build-essential cmake meson ninja-build pkg-config python3 \
    python3-jinja2 nasm git xz-utils patch \
    gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

FROM toolchain AS libmpv-sources
COPY native/build/sources.json /workspace/native/build/sources.json
COPY scripts/native-source-inputs.py scripts/native_source_manifest.py /workspace/scripts/
RUN python3 scripts/native-source-inputs.py /workspace /build/sources /build/source-cache --download --download-only

FROM libmpv-sources AS libmpv-build
COPY native/build/cross-win64.ini native/build/toolchain-win64.cmake native/build/Dockerfile /workspace/native/build/
COPY native/reviews/libmpv-dependencies.json /workspace/native/reviews/libmpv-dependencies.json
COPY scripts/native-build.sh scripts/native-build-evidence.py scripts/native-source-archive-check.py /workspace/scripts/
RUN --network=none bash scripts/native-build.sh /workspace /build \
    && python3 scripts/native-build-evidence.py /workspace /build /out/native-build \
    && rm -rf /build /out/native-build/logs /out/native-build/toolchain-notices

FROM toolchain AS ort-sources
COPY native/build/onnxruntime-sources.json /workspace/native/build/onnxruntime-sources.json
COPY native/upstream-evidence/onnxruntime-overlay-ports/ /workspace/native/upstream-evidence/onnxruntime-overlay-ports/
COPY scripts/native-ort-source-inputs.py /workspace/scripts/
RUN --mount=type=secret,id=github_token,env=SURTITLE_NATIVE_GITHUB_TOKEN \
    python3 scripts/native-ort-source-inputs.py /workspace /build/ort-corresponding \
    && rm -rf /build/ort-corresponding/registry

FROM ort-sources AS ort-package
COPY native/runtime-windows-x64.json /workspace/native/runtime-windows-x64.json
COPY native/upstream-evidence/onnxruntime-*.json native/upstream-evidence/onnxruntime-*.txt native/upstream-evidence/onnxruntime-*.cmake /workspace/native/upstream-evidence/
COPY native/reviews/onnxruntime-dependencies.json /workspace/native/reviews/onnxruntime-dependencies.json
COPY native/onnxruntime-LICENSE native/onnxruntime-ThirdPartyNotices.txt /workspace/native/
COPY scripts/native-ort-compare.py scripts/native-ort-generated.py scripts/native-ort-package.py scripts/native-ort-evidence.py scripts/native-source-archive-check.py /workspace/scripts/
RUN --network=none python3 scripts/native-ort-compare.py /workspace /build/ort-corresponding \
    && cmake -S /build/ort-corresponding/comparison-sources/protobuf/source/cmake \
       -B /build/ort-corresponding/protoc-build -G Ninja -DCMAKE_BUILD_TYPE=Release \
       -Dprotobuf_BUILD_TESTS=OFF -Dprotobuf_BUILD_SHARED_LIBS=OFF -Dprotobuf_WITH_ZLIB=OFF \
       > /build/ort-corresponding/protoc-build.log 2>&1 \
    && cmake --build /build/ort-corresponding/protoc-build --target protoc --parallel 4 \
       >> /build/ort-corresponding/protoc-build.log 2>&1 \
    && python3 scripts/native-ort-generated.py /build/ort-corresponding \
    && python3 scripts/native-ort-package.py /workspace /build/ort-corresponding /out/ort \
    && rm -rf /build/ort-corresponding/comparison-sources /build/ort-corresponding/protoc-build \
       /build/ort-corresponding/generated-header-evidence /out/ort/notices

FROM toolchain AS native-artifact
WORKDIR /out
COPY --from=libmpv-build /out/native-build/runtime/mpv-2.dll ./mpv-2.dll
COPY --from=libmpv-build /out/native-build/libmpv-candidate-source.tar.gz ./libmpv-source.tar.gz
COPY --from=libmpv-build /out/native-build/build-evidence.json ./libmpv-build-evidence.json
COPY --from=ort-package /out/ort/onnxruntime-source.tar.gz ./onnxruntime-source.tar.gz
COPY --from=ort-package /out/ort/source-package-inventory.json ./onnxruntime-source-inventory.json
RUN sha256sum mpv-2.dll libmpv-source.tar.gz onnxruntime-source.tar.gz \
    libmpv-build-evidence.json onnxruntime-source-inventory.json > SHA256SUMS.txt

FROM scratch AS export
COPY --from=native-artifact /out/ /
