FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential cmake meson ninja-build pkg-config python3 \
    python3-jinja2 nasm git xz-utils zip unzip patch \
    gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends llvm-18 \
    && rm -rf /var/lib/apt/lists/*
COPY native/build/ /workspace/native/build/
COPY scripts/native-build.sh scripts/native-source-inputs.py scripts/native-build-evidence.py /workspace/scripts/
