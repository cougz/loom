# loom — Design Spec

> A self-hostable, multi-user, agentic-AI sandbox platform built on the
> Cloudflare Developer Platform. OpenCode is the agent chassis, running
> per-user in a Sandbox container. loom is the Cloudflare Worker that
> hosts the UI (`/dash`), the MCP server (`/mcp`), and partitions every
> primitive (R2, KV, D1, Durable Objects, Workers for Platforms) per user.

---

## 1. Mission

A team (you + your colleagues) signs in, each member gets their own
isolated Linux sandbox with OpenCode pre-configured, and each member's
resources are completely separated from every other member's. One prompt
and the agent can deploy a Worker, provision a D1 database, render a
chart, or forge a skill — scoped to just that user.

### Goals (v1)

- **Self-host anywhere a Cloudflare account exists.** Clone, configure,
  deploy. No required external services.
- **True multi-tenancy.** Every persistent resource is owned by exactly
  one user and invisible to the others.
- **Single authentication surface** for both the browser UI and the MCP
  protocol endpoint. Cloudflare Access is the identity.
- **Workers Builds-native.** Git push → Cloudflare CI → live. No external
  CI runners required for deployment.
- **OpenCode as the agent.** Use the open-source engine, extend it only
  via MCP.

### Non-goals (v1)

- A deck/site builder (that's `let-it-slide`).
- A public SaaS. loom is a platform *you run for your team*.
- Custom agent loop. OpenCode does agent.
- Cross-tenant sharing of resources. Later, maybe.

---

## 2. Tenancy model

### Identity

- **Cloudflare Access** is the only authentication mechanism.
- Every request to the loom Worker (both `/dash/*` and `/mcp`) is gated
  by an Access application.
- The Worker verifies the `Cf-Access-Jwt-Assertion` header on every
  request via JWKS from `https://<team>.cloudflareaccess.com`.
- Identity fields used:
  - `email` → displayed in the UI
  - `sub` → the stable user identifier
- The loom-internal user ID is a slug derived from `sub` (lowercased,
  a-z0-9- only). This is the **tenant key** used everywhere.

### Tenant key = scope for everything

Every resource created by the agent or the platform is scoped by
`userId`:

| Primitive | Shape |
|---|---|
| Sandbox container | `getSandbox(env.SANDBOX, userId)` — one DO per user |
| UserRegistry DO | one DO per user, holds the ownership registry |
| Workers (skills) | script name: `loom-<userId>-<skillName>` in dispatch namespace |
| R2 bucket | bucket name: `loom-<userId>-<name>` |
| R2 object (shared bucket) | key prefix: `users/<userId>/...` |
| KV namespace | KV title: `loom-<userId>-<name>` |
| D1 database | db name: `loom-<userId>-<name>` |
| Worker routes | route pattern must resolve to a `loom-<userId>-*` script |
| DNS records | allowed only if the target is a user-owned Worker route |

The **UserRegistry DO** (`UserRegistry` class, id = userId) keeps the
authoritative list of resources the user owns. Every MCP tool that
operates on a named resource:

1. Parses the logical name.
2. Prefixes it with `loom-<userId>-`.
3. Looks it up in `UserRegistry` — rejects if not present (except for
   create tools).
4. Calls the CF REST API (or binding) with the prefixed name.
5. On success, updates `UserRegistry` to reflect the mutation.

This gives us defense in depth: even if the CF API token were somehow
misused, tools refuse to operate on resources they can't find in the
user's registry.

### Shared bindings, partitioned by prefix

Some bindings are shared (one per Worker), so we partition by key:

- **R2 — `WORKSPACE_SNAPSHOTS` bucket:** all users share, keys are
  `users/<userId>/snapshots/vN.tar.gz`.
- **R2 — `SKILL_SOURCE` bucket:** keys are `users/<userId>/<skillName>.mjs`.
- **KV — `PLATFORM` namespace** (platform-internal, e.g. rate-limit
  counters, feature flags): keys are `user:<userId>:...`.
- **D1 — `PLATFORM` database** (platform-internal audit log, skill
  registry if we prefer centralised over per-user DO): every row has a
  `user_id` column and every query filters on it.

User-created R2 buckets, KV namespaces, and D1 databases (via MCP tools)
are **dedicated** — one CF resource per user per name. Shared-binding
partitioning is for platform-internal state only.

### Authorization

- User → platform: Access JWT, verified on every request.
- Worker → CF REST API: loom's own API token in the `CF_API_TOKEN`
  secret. Never exposed to the user or their container.
- User's OpenCode → provider (Anthropic, OpenAI, …): user brings their
  own key, stored per-user in the `UserRegistry` DO, written into the
  container's OpenCode config at startup. Worker does not proxy model
  traffic.

---

## 3. The three HTTP surfaces

All served by the same Worker (single deployment). Authentication model
differs per surface — this is intentional.

| Path | Hostname | Auth | Purpose |
|---|---|---|---|
| `/dash/*` | `loom.yourcompany.com` | Cloudflare Access (required) | The user-facing React chrome. |
| `/mcp` | `loom.yourcompany.com` | Access OR platform JWT (see §3.3) | The MCP server OpenCode talks to. |
| `/view/<shortId>/...` | `view.loom.yourcompany.com` | **None** (shortId entropy) | Public publishing surface. See [`VIEW.md`](./VIEW.md). |

Plus `*.loom.yourcompany.com` for sandbox preview URLs (Sandbox SDK
routing; token in the hostname is the access control).

### 3.1 `/dash/*` — the React chrome

- TanStack Start app served from the main hostname.
- Workspace UI: header, file tree, skills list, preview URL list,
  publications list, and an iframe of OpenCode's web UI proxied from
  the user's sandbox at `/dash/oc/*`.
- Every request requires a valid Access JWT. Unauthenticated requests
  are redirected to `/cdn-cgi/access/login/<loom-hostname>` by returning
  a 302; Access handles the actual login flow.

### 3.2 `/mcp` — the MCP server

- Streamable HTTP MCP endpoint implemented via the Agents SDK's
  `createMcpHandler`.
- OpenCode inside the sandbox is preconfigured to connect here.
- Two authenticated paths in:
  1. **Browsers / external MCP clients** (Claude Desktop, other
     agents the user wants to connect) — Access in front, standard
     JWT flow via `mcp-remote`.
  2. **The user's own sandbox** — a session-scoped **platform JWT**
     minted by the Worker at sandbox spawn, signed by
     `PLATFORM_JWT_SECRET`, carried in the `Authorization: Bearer`
     header. The `/mcp` handler verifies Access JWT **or** platform
     JWT and derives `userId` from either.

### 3.3 `/view/*` — the public publishing surface

Dedicated origin, deliberately unauthenticated. See [`VIEW.md`](./VIEW.md)
for the full design. Summary:

- Host: `view.loom.yourcompany.com` (distinct from the main hostname
  so cookies/storage are origin-isolated).
- URL: `/view/<shortId>[/<path>]` where `<shortId>` is a 12-character
  base62 random string (~71 bits entropy).
- Two modes per publication:
  - **Static** — files in R2 under `publications/<userId>/<shortId>/`,
    served with per-file response metadata from a `publication.json`
    manifest.
  - **Proxy** — requests proxied to a port inside the publishing
    user's sandbox, for live dev servers, APIs, WebSocket apps.
- Publishing happens via a filesystem convention: the agent writes to
  `/home/user/workspace/.publish/<alias>/` inside the sandbox; a
  sidecar syncs to R2 and updates `PLATFORM_D1.publications`.
- Revocation, rotation, expiry, quotas are all user- and admin-
  controllable.
- Zero auth; entropy of the shortId is the access control. Rotate or
  revoke to invalidate.

### 3.4 Access configuration (operator)

Create one Access application for `loom.yourcompany.com` with include
rules for your team's identity sources. **Do not** attach
`view.loom.yourcompany.com` to Access — it must remain public.

Worker behaviour:

- On the main hostname, Access enforces policy in front; the Worker
  trusts any JWT that validates against the team's JWKS + AUD and
  extracts `sub` as the stable identity.
- On the view hostname, the Worker skips JWT verification entirely
  (but still enforces revocation, expiry, and per-publication
  rate limits).

### 3.5 The platform JWT (Worker → /mcp on behalf of sandbox)

On sandbox spawn the Worker mints a short-lived JWT containing
`{ userId, sessionId, exp }`, signed with `PLATFORM_JWT_SECRET`. It's
written into the container's OpenCode MCP config:

    Authorization: Bearer <short-lived-platform-jwt>

The `/mcp` handler verifies Access JWT **or** platform JWT and derives
`userId` from either. The platform JWT is also used by the view-publish
sidecar to authenticate R2 uploads and manifest updates to the Worker
API. Rotating `PLATFORM_JWT_SECRET` invalidates all live tokens —
sandboxes will re-authenticate on next request.

---

## 4. Architecture

### Component map

    ┌────────────────────────────┐   ┌──────────────────────────────┐
    │ Browser (authenticated)    │   │ Browser (unauthenticated)    │
    │ loom.yourcompany.com/dash  │   │ view.loom.yourcompany.com/.. │
    └────────────┬───────────────┘   └────────────┬─────────────────┘
                 │ Access JWT                     │ no auth; shortId
                 ▼                                ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  loom Worker — single deployment                            │
    │                                                             │
    │  ┌────────────────────┐  ┌─────────────────────────────┐   │
    │  │ verifyAccessJwt()  │  │ mintPlatformJwt(userId)     │   │
    │  └────────────────────┘  └─────────────────────────────┘   │
    │  ┌─────────────────────────────────────────────────────┐   │
    │  │ Router (dispatches by hostname + path):             │   │
    │  │   view.*  /<shortId>/* → R2 OR sandbox proxy        │   │
    │  │   main    /dash/*      → TanStack Start routes      │   │
    │  │   main    /dash/oc/*   → proxy → sandbox:4096       │   │
    │  │   main    /mcp         → createMcpHandler           │   │
    │  │   *.main  /*           → proxyToSandbox() preview   │   │
    │  └─────────────────────────────────────────────────────┘   │
    │  ┌───────────────────┐  ┌─────────────────────┐            │
    │  │ UserRegistry DO   │  │ Sandbox DO +        │            │
    │  │ (per user)        │  │ Container (per user)│            │
    │  │ • resources owned │  │ • OpenCode serve    │            │
    │  │ • provider keys   │  │ • workspace         │            │
    │  │ • skills registry │  │ • publish sidecar   │            │
    │  │ • publications    │  │                     │            │
    │  └───────────────────┘  └─────────────────────┘            │
    │  ┌─────────────────────────────────────────────────────┐   │
    │  │ Bindings used by MCP tools + routing:               │   │
    │  │   AI · BROWSER · DISPATCHER · CF_API_TOKEN          │   │
    │  │   WORKSPACE_SNAPSHOTS (R2) · SKILL_SOURCE (R2)      │   │
    │  │   PUBLICATIONS (R2) · PLATFORM_KV · PLATFORM_D1     │   │
    │  └─────────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────────┘

### Why OpenCode as the agent core

- Strong open-source coding agent with MCP client support built in.
- Has a serve mode with a web UI we can iframe — no need to reimplement
  chat, streaming, tool-call visualisation, or diff rendering.
- BYO provider key: OpenCode calls Anthropic/OpenAI/Workers AI directly
  from inside the container, so loom never touches model traffic or
  needs to broker keys.

### Why MCP as the extension shape

- OpenCode speaks MCP natively; tools appear as first-class to the model.
- Adding a new Cloudflare primitive = adding one file under
  `apps/web/src/mcp/tools/<cat>/<tool>.ts`. No OpenCode fork, no
  container rebuild.
- MCP server and UI share the same Worker → no cross-service auth, no
  extra deploy, shared bindings.

---

## 5. CI/CD — Workers Builds

The repo is designed to deploy via **Cloudflare Workers Builds**, no
GitHub Actions for deploy.

### Repo configuration

- `wrangler.jsonc` at `apps/web/wrangler.jsonc`
- All secrets set via dashboard or `wrangler secret put` — never in the
  repo, never in the build command.
- Bindings referenced by *name* in `wrangler.jsonc`. The bootstrap
  script (`./scripts/setup`) prints the exact IDs to copy in.
- `.nvmrc` with Node 22.
- `package.json` engines pinned.

### Workers Builds settings

Configure in **Dashboard → Workers → your-worker → Settings → Builds**:

- **Repository:** `github.com/<you>/loom` (your fork)
- **Production branch:** `main`
- **Build command:** `pnpm install --frozen-lockfile && pnpm --filter @loom/web build`
- **Deploy command:** `pnpm --filter @loom/web deploy`
- **Root directory:** `/` (monorepo root)
- **Build environment variables:** none (everything lives in
  `wrangler.jsonc` or Workers secrets)

Every push to `main` triggers a build and deploy. Preview deploys for
other branches can be enabled in the same UI.

### Outbound Worker (separate deploy)

The `apps/outbound` Worker is deployed separately because it has a
different `wrangler.jsonc` and binds to a different namespace. Also
connect Workers Builds to `apps/outbound` with its own deploy command,
or include it in the main deploy step:

    pnpm --filter @loom/web deploy && pnpm --filter @loom/outbound deploy

---

## 6. Wrangler configuration

The single deployment, `apps/web/wrangler.jsonc`:

    {
      "name": "loom",
      "main": "src/worker-entry.ts",
      "compatibility_date": "2025-12-01",
      "compatibility_flags": ["nodejs_compat"],
      "observability": { "enabled": true },

      "assets": { "directory": "./dist/client", "binding": "ASSETS" },

      "durable_objects": {
        "bindings": [
          { "name": "USER_REGISTRY", "class_name": "UserRegistry" },
          { "name": "SANDBOX",       "class_name": "Sandbox" }
        ]
      },

      "containers": [
        {
          "class_name": "Sandbox",
          "image": "../../Dockerfile",
          "instance_type": "standard-2",
          "max_instances": 200
        }
      ],

      "dispatch_namespaces": [
        {
          "binding": "DISPATCHER",
          "namespace": "loom-skills",
          "outbound": { "service": "loom-outbound" }
        }
      ],

      "ai": { "binding": "AI" },
      "browser": { "binding": "BROWSER" },

      "r2_buckets": [
        { "binding": "WORKSPACE_SNAPSHOTS", "bucket_name": "loom-workspace-snapshots" },
        { "binding": "SKILL_SOURCE",        "bucket_name": "loom-skill-source" },
        { "binding": "PUBLICATIONS",        "bucket_name": "loom-publications" }
      ],

      "kv_namespaces": [
        { "binding": "PLATFORM_KV", "id": "<filled-by-setup-script>" }
      ],

      "d1_databases": [
        { "binding": "PLATFORM_D1", "database_name": "loom-platform",
          "database_id": "<filled-by-setup-script>" }
      ],

      "vars": {
        "SANDBOX_TRANSPORT": "ws",
        "DISPATCH_NAMESPACE": "loom-skills",
        "LOOM_HOSTNAME": "loom.yourcompany.com"
      },

      "routes": [
        { "pattern": "loom.yourcompany.com/*",       "zone_name": "yourcompany.com" },
        { "pattern": "*.loom.yourcompany.com/*",     "zone_name": "yourcompany.com" },
        { "pattern": "view.loom.yourcompany.com/*",  "zone_name": "yourcompany.com" }
      ],

      "migrations": [
        { "tag": "v1", "new_sqlite_classes": ["UserRegistry", "Sandbox"] }
      ]
    }

Secrets (not in the file, set via `wrangler secret put`):

- `CF_ACCESS_TEAM_DOMAIN` — e.g. `yourcompany.cloudflareaccess.com`
- `CF_ACCESS_AUD` — the Application AUD tag from Access
- `CF_ACCOUNT_ID`
- `CF_API_TOKEN`
- `PLATFORM_JWT_SECRET` — HMAC secret for session-scoped MCP tokens

---

## 7. Build order (milestones)

### M0 — Skeleton (this commit)
- Repo scaffolding: README, SPEC, MCP-TOOLS, MULTI-TENANCY, DEPLOYMENT,
  AGENTS.md, directory structure, wrangler.jsonc, Dockerfile,
  package.json, biome/tsconfig, `.nvmrc`, setup script stub
- No runtime code yet

### M1 — Auth + boot
- TanStack Start app at `/dash` serves a placeholder page
- Cloudflare Access JWT verification middleware
- `/mcp` endpoint stub returns an empty tool list, also JWT-verified
- `UserRegistry` DO with a `greet()` method
- `wrangler dev` works end-to-end with a mock JWT
- `scripts/setup` provisions CF resources and prints wrangler fragment
- Repo pushed to GitHub, Workers Builds wired up

### M2 — Sandbox + OpenCode
- Dockerfile builds; container image published to Cloudflare
- `Sandbox` DO provisions one container per user
- Worker proxies `/dash/oc/*` to the sandbox's port 4096
- The `/dash` chrome renders an iframe of OpenCode's web UI
- Container starts OpenCode via `sandbox.startProcess` on first hit

### M3 — MCP handshake
- `/mcp` uses `createMcpHandler` from Agents SDK
- OpenCode in the sandbox preconfigured to connect to `/mcp`
- Short-lived platform JWT minted at sandbox spawn, written into
  OpenCode's MCP config
- Empty tool catalog — but OpenCode reports the MCP server is connected

### M4 — First real tools: `ai_run` + R2 basics
- `ai_run`, `ai_list_models`
- `r2_create_bucket`, `r2_list_buckets`, `r2_put_object`, `r2_get_object`,
  `r2_list_objects`, `r2_delete_object`
- Ownership enforced via `UserRegistry`
- Demo: "Summarise this text with Llama and save the result to R2" works

### M5 — Compute tools + skills
- `workers_deploy`, `workers_update`, `workers_delete`, `workers_list`,
  `workers_invoke_skill`
- Static analysis before deploy (acorn)
- Outbound Worker deployed and bound to the dispatch namespace
- Demo: "Build me an API that returns the time in any timezone and
  deploy it as a skill. Now call it for Tokyo." works

### M6 — Data tools (KV + D1)
- `kv_*` and `d1_*` tools
- Demo: "Deploy a Worker backed by D1 that renders an HTML dashboard"

### M7 — Visualisation tools (Browser Rendering + preview URLs)
- `browser_screenshot`, `browser_pdf`, `browser_scrape`, `browser_extract`
- Preview-URL sidebar pane in `/dash` (watches `sandbox.exposePort` calls)

### M7.5 — The `/view` publishing surface
- `view.loom.yourcompany.com` dedicated origin wired up
- `PUBLICATIONS` R2 bucket + `publications` table in `PLATFORM_D1`
- Filesystem sidecar in the sandbox container watching
  `/home/user/workspace/.publish/`
- Static mode: manifest parsing, per-file headers, rewrites, 404
  handling, sensible defaults
- Proxy mode: request/response/WebSocket forwarding to the user's
  sandbox on the configured port
- MCP tools: `view_list`, `view_info`, `view_rotate`, `view_revoke`,
  `view_unrevoke`, `view_set_expiry`, `view_sync_now`
- `/dash/views` page with list + rotate/revoke actions
- Quota enforcement + audit log
- Demo: *"Write me an HTML status report of my last 10 deployments
  and publish it"* → agent drops the file in `.publish/status/`,
  user gets a shareable URL within 1 second.
- See [`VIEW.md`](./VIEW.md) for the full design.

### M8 — DNS / routing
- `dns_*`, `routes_*` tools
- Demo: "Give this skill a custom domain"

### M9 — Polish
- Workspace snapshots to R2 + restore flow
- Skill GC (unused skills deleted after 14 days idle)
- Per-user per-tool rate limits
- Observability dashboards
- Multi-user admin panel (add/remove users from Access, see per-user
  resource usage)

---

## 8. Hard constraints

| Limit | Source | Mitigation |
|---|---|---|
| 1,000 subrequests per request | Workers paid | `SANDBOX_TRANSPORT=ws` (1 subrequest per turn) |
| Container eviction when idle | Cloudflare Containers | `keepAlive: true` + R2 workspace snapshots |
| 50 KB Worker script size | Workers | Enforce in `workers_deploy` static analysis |
| Dispatch namespace needed for runtime deploys | Workers for Platforms | Provisioned in `scripts/setup` |
| Wildcard DNS for preview URLs | Sandbox SDK | Documented in README + DEPLOYMENT.md |
| Code Mode is beta | `@cloudflare/codemode` | Pin version; use only where valuable |
| Access JWT verification cost | CF Access | Cache JWKS for 10m; verify per request is cheap |
| Concurrent sandboxes (cost) | Cloudflare Containers | Cap per-team in `PLATFORM_KV`; configurable |

---

## 9. Open questions

1. **Cross-tenant sharing.** A team may want "share this skill with
   Alice." v1 says no; v2 could introduce a `shared_with` list in the
   skill registry and a read-only invoke path.
2. **Admin role.** Who can see all users' resource usage? Proposed:
   Access-defined group membership (`loom-admins`) unlocks an admin
   view at `/dash/admin`.
3. **Provider key rotation.** UI flow for updating a user's provider
   key without killing the container mid-session.
4. **Resource quotas.** Per-user caps on Workers deployed, D1 databases,
   R2 objects? Stored in `PLATFORM_KV`, enforced in MCP tools, shown in
   UI.
5. **Workers Builds preview envs.** Do preview builds (non-main
   branches) get their own Access app + hostname or reuse production?
   Proposed: separate hostname `preview-loom.yourcompany.com`,
   separate Access app, operator chooses when forking.

---

## 10. Appendix — why these choices

| Decision | Rejected alternative | Why |
|---|---|---|
| OpenCode as agent | Build our own with Agents SDK | OpenCode is more capable and MCP-native |
| MCP server | Service binding from sandbox to Worker | MCP is OpenCode-native protocol |
| Access JWT | Custom auth (Better Auth / Lucia) | Zero auth code to maintain; one-line integration; teams already have Access |
| Kumo | shadcn/ui | MIT, matches Cloudflare design, used by other CF products |
| TanStack Start | Astro / RR7 | Proven on let-it-slide for this exact app shape |
| Single Worker | Pages + Worker | Pages de-emphasised; static assets on Workers is the path |
| Workers Builds | GitHub Actions | Zero-config CI/CD, official Cloudflare path |
| pnpm workspaces | Nx / Turborepo | Only 3 packages; no build orchestration needed |
| Biome | ESLint + Prettier | One tool, fast, zero config |
