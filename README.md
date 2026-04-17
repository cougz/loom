loom
====

> A self-hostable, multi-user, agentic-AI sandbox platform for you and your
> team — built entirely on the Cloudflare Developer Platform.

**OpenCode is the engine. Cloudflare is the fuel.** Each user in your
team gets their own isolated Linux sandbox running OpenCode. loom exposes
every Cloudflare primitive (Workers, Workers for Platforms, R2, KV, D1,
Durable Objects, Workers AI, Browser Rendering, DNS) as MCP tools that
OpenCode can call by name. The user types natural language, the agent
builds, deploys, visualises, and operates — at the edge, in seconds.

What you get
------------

- **Self-hosted.** Fork the repo, connect it to Workers Builds, point it
  at your Cloudflare account, deploy. No external services, no vendors.
- **Multi-user from day one.** Every R2 bucket, KV namespace, D1 database,
  Durable Object, and deployed skill is partitioned per user. Resources
  are prefixed and ownership is enforced by a per-user registry DO.
- **Cloudflare Access authentication.** Both `/dash` (the React chrome)
  and `/mcp` (the MCP server) sit behind a single Access application.
  Your team members sign in with Google/Okta/GitHub/anything Access
  supports. No custom auth code to write.
- **Unauthenticated `/view` for publishing.** The agent can publish
  anything — HTML reports, JSON endpoints, live dev servers, mini games
  — to `view.loom.yourcompany.com/<shortId>`, a dedicated origin with
  unguessable URLs, per-file response metadata, revocation, and quotas.
  See [`docs/VIEW.md`](./docs/VIEW.md).
- **OpenCode as the agent.** Proven, capable, MCP-native coding agent
  running inside a per-user Sandbox container. BYO provider key (stored
  per-user, never touched by the Worker).
- **Every Cloudflare primitive as a tool.** The agent can spin up a D1
  database, deploy a Worker to Workers for Platforms, render a chart
  with Browser Rendering, or publish a landing page to a custom domain —
  all from natural language.
- **CI/CD via Workers Builds.** Push to `main`, Cloudflare builds and
  deploys. No GitHub Actions for deploy.

HTTP surfaces
-------------

loom exposes exactly three public surfaces — same Worker, one
deployment:

| Path | Hostname | Auth | Purpose |
|---|---|---|---|
| `/dash/*` | `loom.yourcompany.com` | Cloudflare Access | The user-facing React UI. Chrome + iframe of OpenCode's web UI. |
| `/mcp` | `loom.yourcompany.com` | Access **or** platform JWT | The MCP server. OpenCode in the sandbox talks here. |
| `/view/<shortId>/...` | `view.loom.yourcompany.com` | **None** — shortId entropy is the access control | Public publishing surface. Serves anything the agent drops in `.publish/`. |

Plus sandbox preview URLs at `*.loom.yourcompany.com`, routed by the
Sandbox SDK.

Architecture at a glance
------------------------

    ┌─────────────────────────────────────────────────────────────┐
    │  Browser                                                    │
    │  ┌───────────────────────────────────────────────────────┐  │
    │  │ /dash  — loom chrome + iframe of OpenCode web UI      │  │
    │  └───────────────────────────────────────────────────────┘  │
    └──────────┬──────────────────┬───────────────────────────────┘
               │ Access JWT       │ Access JWT
               ▼                  ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  loom Worker (single deployment)                            │
    │                                                             │
    │   /dash/*  ──── TanStack Start + Kumo ──── iframe ─────────▶│
    │   /mcp     ──── MCP tools (Workers / R2 / KV / D1 / AI /   │
    │                 Browser / DNS / Workers for Platforms)      │
    │   /view/*  ──── (on view.loom.yourcompany.com, NO AUTH)     │
    │                 served from R2 or proxied to sandbox port  │
    │                                                             │
    │   proxyToSandbox()   ──── *.loom.yourcompany.com preview   │
    └──────────┬───────────────────┬───────────────────┬─────────┘
               │                   │                   │
       ┌───────▼──────┐     ┌──────▼──────┐    ┌──────▼────────┐
       │ Sandbox DO + │     │ Dispatcher  │    │ Bindings:     │
       │ Container    │     │ (skills)    │    │ AI, BROWSER,  │
       │ (OpenCode +  │     │             │    │ R2, KV, D1,   │
       │  sidecar)    │     │             │    │ PUBLICATIONS  │
       └──────────────┘     └─────────────┘    └───────────────┘

Quick start
-----------

Prerequisites:

- Cloudflare account on the Workers Paid plan with:
  - Workers for Platforms enabled
  - Browser Rendering enabled
  - A custom domain with wildcard DNS, and a `view.` subdomain in your
    account (e.g. `loom.yourcompany.com`, `*.loom.yourcompany.com`, and
    `view.loom.yourcompany.com`)
- Cloudflare Access configured on your account (free tier is fine)
- GitHub account (for Workers Builds to pull from)

Setup:

    # 1. Fork this repo to your GitHub account
    # 2. Clone it locally
    git clone git@github.com:<you>/loom.git && cd loom

    # 3. Run the bootstrap script — creates CF resources, namespaces,
    #    buckets (including loom-publications for /view), KV, D1,
    #    dispatch namespace, and prints a wrangler.jsonc fragment.
    ./scripts/setup

    # 4. Configure Cloudflare Access:
    #    - Create ONE Access application for `loom.yourcompany.com`
    #      — covers /dash and /mcp.
    #    - Do NOT put `view.loom.yourcompany.com` behind Access.
    #      /view is public by design.
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
    │   ├── web/          THE Worker — serves /dash, /mcp, /view
    │   └── outbound/     egress control Worker for user-deployed skills
    ├── packages/
    │   └── shared-types/ types shared across the repo
    ├── docs/
    │   ├── SPEC.md            architecture + build order
    │   ├── MCP-TOOLS.md       MCP tool catalog contract
    │   ├── MULTI-TENANCY.md   how isolation actually works
    │   ├── VIEW.md            the /view publishing surface
    │   ├── DEPLOYMENT.md      Workers Builds setup + secrets
    │   └── AGENTS.md          instructions for coding agents
    ├── Dockerfile        sandbox container (OpenCode + tools + sidecar)
    ├── scripts/          setup / start / deploy
    └── wrangler.jsonc    single deployment config

License
-------

MIT — see [`LICENSE`](./LICENSE). Fork it, modify it, run it for your
team, contribute back if you'd like.
