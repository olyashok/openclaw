FROM node:22-bookworm

# Basic tools: Python 3, sqlite3 (CLI + lib), plus any extra apt packages
RUN apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  python3 \
  python3-pip \
  python3-venv \
  sqlite3 \
  jq \
  curl \
  libsqlite3-0 \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
  apt-get update && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
  fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Marker CLI: Python deps (marker repo mounted at runtime at /home/node/marker)
RUN python3 -m pip install --no-cache-dir --break-system-packages click requests rich 'pydantic>=2.0.0' && chown -R node:node /usr/local/lib/python3.*/dist-packages /usr/local/bin 2>/dev/null || true

# Bun + qmd wrapper for node user (Bun install is in /root, not readable by node)
RUN cp -a /root/.bun /app/.bun && chown -R node:node /app/.bun
RUN mkdir -p /app/bin \
  && printf '%s\n' '#!/bin/sh' 'exec /app/.bun/bin/bun /home/node/qmd-remote/src/qmd.ts "$@"' > /app/bin/qmd \
  && printf '%s\n' '#!/bin/sh' 'exec python3 -m marker_cli.cli "$@"' > /app/bin/marker \
  && (echo '#!/bin/sh'; echo 'export PYTHONPATH=/home/node/marker/src'; echo 'exec python3 -m marker_cli.cli "$@"') > /app/bin/marker.tmp && mv /app/bin/marker.tmp /app/bin/marker \
  && chmod +x /app/bin/qmd /app/bin/marker && chown node:node /app/bin/qmd /app/bin/marker
ENV PATH="/app/bin:/app/.bun/bin:${PATH}"
# Persist PATH for login shells (docker exec bash -l, interactive sessions)
RUN echo 'export PATH="/app/bin:/app/.bun/bin:${PATH}"' > /etc/profile.d/openclaw-path.sh

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# For container platforms requiring external health checks:
#   1. Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","openclaw.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
