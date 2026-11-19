FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake perl curl ca-certificates pkg-config python3 clang libfontconfig1-dev libfreetype6-dev libxkbcommon-x11-dev \
    libwayland-dev libx11-xcb-dev libxcb-shape0-dev libxcb-xfixes0-dev \
    libvulkan-dev mesa-vulkan-drivers libssl-dev xvfb dbus-x11 ffmpeg libmpv-dev \
    fonts-noto-cjk unzip zip && rm -rf /var/lib/apt/lists/*
USER vscode
COPY rust-toolchain.toml /tmp/surtitle-rust-toolchain.toml
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    --default-toolchain "$(python3 -c 'import tomllib; print(tomllib.load(open("/tmp/surtitle-rust-toolchain.toml", "rb"))["toolchain"]["channel"])')"
ENV PATH="/home/vscode/.cargo/bin:${PATH}"
RUN rustup component add rustfmt clippy
RUN cargo install cargo-deny --version 0.20.2 --locked \
    && cargo install cargo-nextest --version 0.9.148 --locked
WORKDIR /workspaces/surtitle
