FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake perl curl ca-certificates pkg-config libwebkit2gtk-4.1-dev \
    libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev \
    patchelf xvfb dbus-x11 webkit2gtk-driver ffmpeg libmpv-dev \
    fonts-noto-cjk unzip zip && rm -rf /var/lib/apt/lists/*
USER vscode
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.98.0
ENV PATH="/home/vscode/.cargo/bin:${PATH}"
RUN rustup component add rustfmt clippy
RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
COPY .node-version /tmp/surtitle-node-version
RUN bash -lc '. "$HOME/.nvm/nvm.sh" && nvm install "$(cat /tmp/surtitle-node-version)" && npm install -g pnpm@12.3.4 && mkdir -p /home/vscode/.local/bin && ln -s "$(which node)" /home/vscode/.local/bin/node && ln -s "$(which pnpm)" /home/vscode/.local/bin/pnpm'
ENV PATH="/home/vscode/.local/bin:${PATH}"
RUN cargo install tauri-driver --version 2.0.6 --locked
WORKDIR /workspaces/surtitle
USER root
RUN mkdir -p /opt/surtitle-build/tmp /opt/surtitle-notices-seed && chown -R vscode:vscode /opt/surtitle-build
COPY src-tauri/resources/notices/README.txt /opt/surtitle-notices-seed/README.txt
USER vscode
