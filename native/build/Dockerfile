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
COPY native/build/native-source-inputs.py native/build/native_source_manifest.py /workspace/native/build/
RUN python3 native/build/native-source-inputs.py /workspace /build/sources /build/source-cache --download --download-only

FROM libmpv-sources AS libmpv-build
COPY native/build/cross-win64.ini native/build/toolchain-win64.cmake native/build/Dockerfile /workspace/native/build/
COPY native/build/native-build.sh native/build/native-build-evidence.py native/build/native_source_archive.py /workspace/native/build/
RUN --network=none bash native/build/native-build.sh /workspace /build \
    && python3 native/build/native-build-evidence.py /workspace /build /out/native-build \
    && rm -rf /build /out/native-build/logs /out/native-build/toolchain-notices

FROM toolchain AS ort-sources
COPY native/build/onnxruntime-sources.json /workspace/native/build/onnxruntime-sources.json
COPY native/upstream-evidence/onnxruntime-overlay-ports/ /workspace/native/upstream-evidence/onnxruntime-overlay-ports/
COPY native/build/native-ort-source-inputs.py /workspace/native/build/
RUN --mount=type=secret,id=github_token,env=SURTITLE_NATIVE_GITHUB_TOKEN \
    python3 native/build/native-ort-source-inputs.py /workspace /build/ort-corresponding \
    && rm -rf /build/ort-corresponding/registry

FROM ort-sources AS ort-package
COPY native/runtime-windows-x64.json /workspace/native/runtime-windows-x64.json
COPY native/onnxruntime-LICENSE native/onnxruntime-ThirdPartyNotices.txt /workspace/native/
COPY native/build/native-ort-package.py native/build/native_source_archive.py /workspace/native/build/
RUN --network=none python3 native/build/native-ort-package.py /workspace /build/ort-corresponding /out/ort \
    && rm -rf /out/ort/notices

FROM toolchain AS native-artifact
WORKDIR /out
COPY --from=libmpv-build /out/native-build/runtime/mpv-2.dll ./mpv-2.dll
COPY --from=libmpv-build /out/native-build/libmpv-candidate-source.tar.gz ./libmpv-source.tar.gz
COPY --from=libmpv-build /out/native-build/build-evidence.json ./libmpv-build-evidence.json
COPY --from=ort-package /out/ort/onnxruntime-source.tar.gz ./onnxruntime-source.tar.gz
COPY --from=ort-package /out/ort/source-package-inventory.json ./onnxruntime-source-inventory.json

FROM scratch AS export
COPY --from=native-artifact /out/ /
