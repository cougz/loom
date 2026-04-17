loom-publish sidecar
=====================

Watches `/home/user/workspace/.publish/` inside the sandbox container
and syncs each subdirectory as a publication to R2 via the loom Worker
API. See `docs/VIEW.md` for the design.

M7.5 will replace this placeholder with the actual sidecar (planned as
a small static binary — Go or Rust — so it starts fast and doesn't pull
a Node runtime into the container image).

Until then the build skips the `COPY` step by mounting a shim:

    #!/usr/bin/env bash
    echo "[loom-publish] stub — sidecar not yet implemented (M7.5)"
    exec sleep infinity

Build the real binary with a separate, Dockerfile-based build chain;
publish to R2 as `sidecar-bin/<version>` and pull during `wrangler
containers build`.
