# Sandbox container for loom.
#
# Runs inside Cloudflare Containers, one instance per user, fronted by the
# Sandbox Durable Object. Hosts:
#   • OpenCode CLI + web UI (the agent)
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

FROM docker.io/cloudflare/sandbox:0.8.9

ENV DEBIAN_FRONTEND=noninteractive
ENV LOOM_WORKSPACE=/home/user/workspace
ENV OPENCODE_DIR=/home/user/.opencode
ENV LOOM_PUBLISH_DIR=/home/user/workspace/.publish

# Base CLI tooling so the agent doesn't waste turns installing it
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl wget jq ripgrep fd-find unzip zip \
      build-essential ca-certificates \
      python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Node 22 + pnpm
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@latest

# Zero Trust root CA (optional).
# If zero_trust_cert.pem at the repo root is non-empty, it is installed as a
# trusted CA so OpenCode's fetch() to model providers trusts Cloudflare-
# terminated egress. Leave the file empty when ZT inspection is not in use.
COPY zero_trust_cert.pem /tmp/zt.pem
RUN if [ -s /tmp/zt.pem ]; then \
      cp /tmp/zt.pem /usr/local/share/ca-certificates/cloudflare-zt.crt \
      && update-ca-certificates; \
    fi \
    && echo 'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt' \
         >> /etc/profile.d/node-ca.sh \
    && rm -f /tmp/zt.pem

# OpenCode install
RUN curl -fsSL https://opencode.ai/install | bash \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode

# Workspace + OpenCode config dirs owned by the sandbox user
RUN mkdir -p ${LOOM_WORKSPACE} ${OPENCODE_DIR} \
    && chown -R user:user ${LOOM_WORKSPACE} ${OPENCODE_DIR}

# Default OpenCode config — points to loom's MCP server and sets provider
# defaults. Overridable by the user via the loom UI (writes here at runtime).
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
USER user

# Init git so OpenCode's change tracking works
RUN git init -q ${LOOM_WORKSPACE} \
    && git -C ${LOOM_WORKSPACE} config user.email "agent@loom.local" \
    && git -C ${LOOM_WORKSPACE} config user.name  "loom agent"

# The Sandbox SDK manages process lifecycle — we don't start OpenCode
# or the sidecar here. On first user interaction the Worker calls:
#   sandbox.startProcess("opencode serve --port 4096")
#   sandbox.startProcess("loom-publish --watch /home/user/workspace/.publish")
# `loom-code`, `loom-ai`, and `loom-render` are short-lived CLIs — the
# agent invokes them per call, no long-running process.
