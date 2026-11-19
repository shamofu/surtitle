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
COPY native/build/cross-win64.ini native/build/toolchain-win64.cmake native/build/Dockerfile native/build/native-build.sh /workspace/native/build/
COPY native/build/patches/ /workspace/native/build/patches/
RUN --network=none bash native/build/native-build.sh /workspace /build \
    && tar -czf /out/libmpv-source.tar.gz -C /build source-cache -C /workspace native/build \
    && rm -rf /build

FROM scratch AS export
COPY --from=libmpv-build /out/ /
