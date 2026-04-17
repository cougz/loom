loom
====

> A self-hostable, multi-user, agentic-AI sandbox platform for you and your
> team — built entirely on the Cloudflare Developer Platform.

Three Cloudflare primitives come together to make an isolated
environment that is, for all practical purposes, capable of
everything:

| Primitive | What it gives the agent | Typical use |
|---|---|---|
| **Sandboxes / Containers** | A persistent Linux workspace per user | build projects, install packages, run servers, work with real files |
| **Dynamic Workers + Code Mode** | Fast, isolated, network-less JS execution at the edge | parse, transform, compose results, chain operations — all in one millisecond-scale call |
| **`/view` publishing** | An unguessable public URL (same hostname) for anything the agent produces | share reports, serve live dashboards, proxy dev servers |

**OpenCode is the engine. Cloudflare is the fuel.** Each user in your
team gets their own Sandbox container running OpenCode, reaches
through Code Mode when a task needs cheap composition, and publishes
to `/view` when something's worth sharing. Loom is what wires it all
together and makes it multi-user.

What you get
------------

- **Self-hosted.** Fork the repo, connect it to Workers Builds, point it
  at your Cloudflare account, deploy. No external services, no vendors.
- **Multi-user from day one.** Every R2 object, KV value, D1 row,
  Durable Object, and published view is partitioned per user.
  Ownership is enforced by a per-user registry DO.
- **Cloudflare Access authentication.** Both `/dash` (the React chrome)
  and `/mcp` (the MCP server) sit behind a single Access application.
  Your team members sign in with Google / Okta / GitHub / anything
  Access supports. No custom auth code to write.
- **Three-tier compute hierarchy.** The agent picks the cheapest
  primitive that fits: Code Mode for composition, Sandbox for real
  work, `/view` for sharing. See [`docs/CODE-MODE.md`](./docs/CODE-MODE.md).
- **`/view` publishing on the same hostname.** Anything the agent
  drops into `.publish/` becomes a live URL at
  `loom.yourcompany.com/view/<shortId>`, with per-file response
  metadata, revocation, and quotas. See [`docs/VIEW.md`](./docs/VIEW.md).
- **Primitives are framework, not tools.** R2, D1, KV, Workers AI,
  Browser Rendering, Worker Loader are wired into loom transparently
  — the agent never picks them from a menu.
- **Tools are a user artifact.** When the user likes what the agent
  built, they templatize it into a named, parameterised prompt
  (private by default, shareable to a team library). See
  [`docs/TOOLS.md`](./docs/TOOLS.md).
- **CI/CD via Workers Builds.** Push to `main`, Cloudflare builds and
  deploys. No GitHub Actions for deploy.

HTTP surfaces
-------------

One Worker, one hostname, three paths:

| Path | Auth | Purpose |
|---|---|---|
| `/dash/*` | Cloudflare Access | React UI. Chrome + iframe of OpenCode's web UI. |
| `/mcp` | Access **or** platform JWT | Minimal MCP surface: user tools, publication control, introspection. |
| `/view/<shortId>/...` | **None** — shortId entropy is the access control | Public publishing. |

Plus sandbox preview URLs at `*.loom.yourcompany.com` (Sandbox SDK
routing).

Architecture at a glance
------------------------

    ┌─────────────────────────────────────────────────────────────┐
    │  Browser                                                    │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ /dash  — loom chrome + iframe of OpenCode web UI      │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────────┬──────────────────┬──────────────────┬────────────┘
               │ Access JWT       │ Access JWT       │ no auth
               ▼                  ▼                  ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  loom Worker (single deployment)                            │
    │                                                             │
    │   /dash/*   ── TanStack Start + Kumo ── iframe ───────────▶ │
    │   /mcp      ── tools.* · view.* · meta.*                    │
    │   /view/*   ── Access bypass — static from R2 or proxy      │
    │   /__code   ── framework-internal: Code Mode / Worker Loader│
    │   proxyToSandbox() ── *.loom.yourcompany.com preview URLs   │
    └──┬────────────────┬─────────────────┬────────────────┬──────┘
       │                │                 │                │
   ┌───▼────────┐  ┌────▼──────┐  ┌───────▼──────┐  ┌──────▼─────┐
   │ Sandbox DO │  │ UserRegistry│  │ Worker     │  │ Bindings:  │
   │ + Container│  │ DO          │  │ Loader     │  │ AI, BROWSER│
   │ (OpenCode, │  │ (per user)  │  │ (Code Mode)│  │ R2 buckets,│
   │ sidecars,  │  │             │  │ isolates   │  │ PLATFORM_KV│
   │ loom-code) │  │             │  │ per call   │  │ PLATFORM_D1│
   └────────────┘  └─────────────┘  └────────────┘  └────────────┘

Quick start
-----------

Prerequisites:

- Cloudflare account on the Workers Paid plan with:
  - Browser Rendering enabled
  - A custom domain with wildcard DNS (e.g. `loom.yourcompany.com` and
    `*.loom.yourcompany.com`)
- Cloudflare Access configured on your account (free tier is fine)
- GitHub account (for Workers Builds to pull from)

Setup:

    # 1. Fork this repo to your GitHub account
    # 2. Clone it locally
    git clone git@github.com:<you>/loom.git && cd loom

    # 3. Run the bootstrap script — creates CF resources (R2 buckets,
    #    KV, D1) and prints a wrangler.jsonc fragment.
    ./scripts/setup

    # 4. Configure Cloudflare Access:
    #    - Create ONE Access application for `loom.yourcompany.com`
    #      — covers /dash and /mcp.
    #    - /view is on the same hostname; the Worker bypasses Access
    #      verification for /view/* paths in code.
    #    - Note the Team domain + Application AUD and set them:
    wrangler secret put CF_ACCESS_TEAM_DOMAIN
    wrangler secret put CF_ACCESS_AUD

    # 5. Connect Workers Builds:
    #    Dashboard → Workers → your-worker → Settings → Builds → Connect
    #    Build command: pnpm install && pnpm --filter @loom/web build
    #    Deploy command: pnpm --filter @loom/web deploy
    #    Push to main → Cloudflare builds & deploys automatically.

Repository layout
-----------------

    loom/
    ├── apps/
    │   └── web/          THE Worker — serves /dash, /mcp, /view, /__code
    ├── packages/
    │   └── shared-types/ types shared across the repo
    ├── docs/
    │   ├── SPEC.md            architecture + build order
    │   ├── CODE-MODE.md       Dynamic Workers / Worker Loader integration
    │   ├── TOOLS.md           user-created, shareable tools
    │   ├── VIEW.md            the /view publishing surface
    │   ├── MULTI-TENANCY.md   how isolation actually works
    │   ├── DEPLOYMENT.md      Workers Builds setup + secrets
    │   └── AGENTS.md          instructions for coding agents
    ├── Dockerfile        sandbox container (OpenCode + sidecars)
    └── scripts/          setup / start / deploy

License
-------

MIT — see [`LICENSE`](./LICENSE). Fork it, modify it, run it for your
team, contribute back if you'd like.
