# Sandbox container for loom.
#
# Runs inside Cloudflare Containers, one instance per user, fronted by the
# Sandbox Durable Object. Hosts:
#   • OpenCode CLI + serve process (the agent)
#   • Git, Node, Python, and common CLI tools the agent uses
#   • An optional Zero Trust root CA so OpenCode's outbound traffic to model
#     providers flows through Cloudflare's network.
#
# Ports:
#   4096  → OpenCode (API + web UI)
#   5173, 3000, 8000, 8080 → common ports agent-built apps expose via the
#                            Sandbox SDK's exposePort() (preview URLs)
#
# Build context: repo root (wrangler.jsonc "image": "../../Dockerfile").
# All COPY paths are relative to the repo root.
#
# v1 runs OpenCode as root. The Sandbox SDK manages container lifecycle
# regardless of the Unix user, and running as root side-steps the permission
# problems with OpenCode's installer writing to /root/.opencode/ (chmod 700).
# M3 dropped the binary copy + `USER user` directive in favour of exporting
# /root/.opencode/bin on PATH.

FROM docker.io/cloudflare/sandbox:0.8.9

ENV DEBIAN_FRONTEND=noninteractive
ENV LOOM_WORKSPACE=/home/user/workspace
ENV OPENCODE_DIR=/root/.opencode
ENV LOOM_PUBLISH_DIR=/home/user/workspace/.publish
ENV PATH="/root/.opencode/bin:/usr/local/bin:$PATH"

# Base CLI tooling so the agent doesn't waste turns installing it
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl wget jq ripgrep fd-find unzip zip \
      build-essential ca-certificates \
      python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Zero Trust root CA — installed BEFORE any curl/apt calls that go over the
# network, so TLS inspection doesn't break subsequent downloads.
# Leave zero_trust_cert.pem empty if ZT inspection is not in use.
COPY zero_trust_cert.pem /tmp/zt.pem
RUN if [ -s /tmp/zt.pem ]; then \
      cp /tmp/zt.pem /usr/local/share/ca-certificates/cloudflare-zt.crt \
      && update-ca-certificates; \
    fi \
    && echo 'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt' \
         >> /etc/profile.d/node-ca.sh \
    && rm -f /tmp/zt.pem

# Node 22 + pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@latest

# OpenCode install — the installer drops a binary in /root/.opencode/bin,
# which is already on PATH via ENV above. No copy / symlink / user juggling
# required since v1 runs as root.
RUN curl -fsSL https://opencode.ai/install | bash && opencode --version

# Workspace + OpenCode config dirs
RUN mkdir -p ${LOOM_WORKSPACE} ${OPENCODE_DIR}

# Default OpenCode config — points to loom's MCP server and sets provider
# defaults. Overlaid at container start by the Worker with per-user values
# (platform JWT, MCP URL) written into ${OPENCODE_DIR}/opencode.jsonc.
COPY apps/web/src/sandbox-app/opencode.jsonc ${OPENCODE_DIR}/opencode.jsonc
COPY apps/web/src/sandbox-app/tui.jsonc      ${OPENCODE_DIR}/tui.jsonc

# /view publishing sidecar — watches LOOM_PUBLISH_DIR and syncs to R2
# via the loom Worker API. See docs/VIEW.md.
COPY apps/web/src/sandbox-app/loom-publish-sidecar/loom-publish /usr/local/bin/loom-publish
RUN chmod +x /usr/local/bin/loom-publish

# loom-code — the agent's primary tool for cheap composition. POSTs a JS
# snippet to the Worker, which runs it in a Worker Loader isolate
# (no network, 30s timeout, loom.* namespace only). See docs/CODE-MODE.md.
COPY apps/web/src/sandbox-app/loom-code/loom-code /usr/local/bin/loom-code
RUN chmod +x /usr/local/bin/loom-code

# loom-ai, loom-render — CLI wrappers over Workers AI and Browser
# Rendering. Each is a thin HTTP client to the Worker's framework
# endpoints (not /mcp) authenticated with the platform JWT.
COPY apps/web/src/sandbox-app/loom-ai/loom-ai     /usr/local/bin/loom-ai
COPY apps/web/src/sandbox-app/loom-render/loom-render /usr/local/bin/loom-render
RUN chmod +x /usr/local/bin/loom-ai /usr/local/bin/loom-render

# Ports OpenCode + common preview servers use
EXPOSE 4096 5173 3000 8000 8080

WORKDIR ${LOOM_WORKSPACE}

# Init git so OpenCode's change tracking works
RUN git init -q ${LOOM_WORKSPACE} \
    && git -C ${LOOM_WORKSPACE} config user.email "agent@loom.local" \
    && git -C ${LOOM_WORKSPACE} config user.name  "loom agent"

# The Sandbox SDK manages process lifecycle — we don't start OpenCode
# or the sidecar here. On first user interaction the Worker calls:
#   sandbox.startProcess("opencode serve --port 4096 --hostname 0.0.0.0")
#   sandbox.startProcess("loom-publish --watch /home/user/workspace/.publish")
# `loom-code`, `loom-ai`, and `loom-render` are short-lived CLIs — the
# agent invokes them per call, no long-running process.
