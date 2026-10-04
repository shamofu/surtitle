# SPDX-License-Identifier: GPL-3.0-or-later
# One rendering environment for CI and baseline updates on any host OS.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
WORKDIR /app

COPY .node-version package.json ./
COPY native/installer-inputs.json ./native/installer-inputs.json
RUN set -eu; \
    version="$(tr -d '\r\n' < .node-version)"; \
    case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 1 ;; esac; \
    archive="node-v${version}-linux-${arch}.tar.gz"; \
    curl -fsSLO "https://nodejs.org/dist/v${version}/${archive}"; \
    curl -fsSLO "https://nodejs.org/dist/v${version}/SHASUMS256.txt"; \
    grep "  ${archive}$" SHASUMS256.txt | sha256sum -c -; \
    tar -xzf "$archive" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "$archive" SHASUMS256.txt; \
    npm install -g "$(node -p 'require("./package.json").packageManager')"
# pnpm's enabled Cargo integration also materializes the locked Rust graph.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --profile minimal \
      --default-toolchain "$(node -p 'require("./native/installer-inputs.json").rust.version')" \
    && rm /tmp/rustup-init.sh
ENV PATH="/root/.cargo/bin:${PATH}"

# .dockerignore supplies source only: no host dependencies, outputs or credentials.
COPY . .
RUN pnpm install --frozen-lockfile \
    && test "$(node -p 'require("@playwright/test/package.json").version')" = 1.63.0
ENV SURTITLE_VISUAL_ENV=playwright-1.63.0-noble CI=1
CMD ["sh", "-c", "pnpm test:browser && pnpm test:visual"]
