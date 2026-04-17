# loom — Design Spec

> A self-hostable, multi-user, agentic-AI sandbox platform built on the
> Cloudflare Developer Platform. OpenCode is the agent chassis, running
> per-user in a Sandbox container. Cloudflare primitives (R2, D1, KV,
> Workers AI, Browser Rendering) are **integrated into the framework** —
> not exposed as a catalog of tools the agent picks from. "Tools" in
> loom are a user-created, user-shared artifact: templatized agent
> workflows. See [`TOOLS.md`](./TOOLS.md).

---

## 1. Mission

A team signs in via Cloudflare Access, each member gets their own
isolated Linux sandbox with OpenCode pre-configured, and each member's
resources are completely separated. The agent does work; when a user
wants to re-run a workflow, they templatize it into a **tool** — a
parameterised prompt + optional workspace attachments — and share it
with their team.

### Goals (v1)

- **Self-host anywhere a Cloudflare account exists.** Clone, configure,
  deploy. No required external services.
- **Multi-tenancy from day one.** Every persistent resource is owned by
  exactly one user and invisible to the others.
- **Single authentication surface** for `/dash` and `/mcp`. Cloudflare
  Access is the identity.
- **Workers Builds-native.** Git push → Cloudflare CI → live.
- **OpenCode as the agent.** No custom loop, no fork. Wire up via MCP
  and filesystem conventions.
- **Primitives as framework integrations, not tools.** R2 is where
  workspace snapshots and publications live. D1 is where the registry
  lives. Workers AI is the default provider. Browser Rendering is wired
  into chart/preview flows. The agent uses them without ever calling
  `r2.put()` as a tool.
- **Tools as a user artifact.** When the user wants to re-run a
  workflow, they templatize it. Private by default, shareable to the
  team library. See [`TOOLS.md`](./TOOLS.md).
- **`/view` publishing.** Any file or live process in the sandbox can
  be published to an unguessable URL on the main hostname. See
  [`VIEW.md`](./VIEW.md).

### Non-goals (v1)

- A deck/site builder. loom builds *anything*; specialised builders are
  out of scope.
- A public multi-tenant SaaS. loom is a platform *you run for your team*.
- Primitive-level MCP tools (no `r2_put_object`, no `d1_execute`, no
  `ai_run`). Primitives are framework concerns.
- Custom Worker deployment for end-users at runtime. v1 does not use
  Workers for Platforms.
- Custom agent loop. OpenCode does agent.

---

## 2. Tenancy model

### Identity

- **Cloudflare Access** is the only authentication mechanism for
  `/dash` and `/mcp`. `/view` is deliberately public.
- Every authenticated request is gated by a single Access application.
- The Worker verifies the `Cf-Access-Jwt-Assertion` header against the
  team's JWKS at `https://<team>.cloudflareaccess.com`.
- `userId` is derived from the Access `sub` claim: stable slug,
  lowercase, a-z0-9 only.
- `email` is stored for display only — never used as an identifier.

`userId` is the **tenant key** used everywhere.

### What's partitioned

| Thing | How it's partitioned |
|---|---|
| Sandbox container | `getSandbox(env.SANDBOX, userId)` — one DO per user |
| UserRegistry DO | one DO per user (keyed by `userId`) |
| Workspace snapshots (R2) | key prefix `users/<userId>/snapshots/...` |
| Publications (R2) | key prefix `publications/<userId>/<shortId>/...` |
| Tool attachments (R2) | key prefix `users/<userId>/tools/<toolId>/...` |
| Platform KV | key prefix `user:<userId>:...` |
| Platform D1 rows | `WHERE user_id = ?` on every query (enforced via helper) |
| Private tools | rows in the user's `UserRegistry` DO |
| Team-shared tools | rows in `PLATFORM_D1.shared_tools`, readable by all team members |

See [`MULTI-TENANCY.md`](./MULTI-TENANCY.md) for the exhaustive table
and the ownership guardrail pattern.

### Authorization layers

- User → platform: Access JWT on `/dash` and `/mcp`.
- Sandbox → `/mcp`: session-scoped platform JWT minted at sandbox spawn.
- Worker → Cloudflare REST API (when the framework itself needs to
  provision resources, e.g. on first deploy): loom's own API token.
  Never exposed to the user or the container.
- User's OpenCode → model provider: user's own provider key, stored
  per-user in `UserRegistry`, written into the container's OpenCode
  config at startup. Worker does not proxy model traffic.

---

## 3. HTTP surfaces

One Worker, one hostname, three paths.

| Path | Auth | Purpose |
|---|---|---|
| `/dash/*` | Cloudflare Access | React chrome + OpenCode iframe. |
| `/mcp` | Access **or** platform JWT | Minimal MCP server for tool operations. |
| `/view/<shortId>/...` | **None** — shortId entropy | Public publishing. See [`VIEW.md`](./VIEW.md). |

Plus `*.loom.yourcompany.com` for sandbox preview URLs (Sandbox SDK
routing).

### 3.1 `/dash/*` — the React chrome

- TanStack Start app.
- Workspace UI: header, sidebar (your tools, team library, workspace),
  OpenCode web UI iframe proxied at `/dash/oc/*`.
- Every request requires an Access JWT. Unauthenticated requests
  redirect to `/cdn-cgi/access/login/<hostname>`.

### 3.2 `/mcp` — the MCP server

- Streamable HTTP MCP endpoint implemented via Agents SDK
  `createMcpHandler`.
- OpenCode inside the sandbox is preconfigured to connect here.
- The surface is **deliberately minimal**. It exposes exactly the
  operations OpenCode needs that the framework cannot handle
  transparently:
  - Tool operations: `tools.list`, `tools.invoke`,
    `tools.propose_templatize`, `tools.get_run`
  - Publication control: `view.list`, `view.rotate`, `view.revoke`,
    `view.unrevoke`, `view.set_expiry`, `view.sync_now`
  - Introspection: `whoami`, `workspace.snapshot`, `workspace.restore`
- No `r2_*`, `kv_*`, `d1_*`, `ai_*`, `browser_*` tools.

See [`TOOLS.md`](./TOOLS.md) and [`VIEW.md`](./VIEW.md) for details.

### 3.3 `/view/*` — the public publishing path

Served from the same hostname. The Worker short-circuits Access
verification for path prefix `/view/`. Published content is sandboxed
via a default CSP to mitigate the same-origin caveat. See
[`VIEW.md`](./VIEW.md).

### 3.4 The platform JWT

On sandbox spawn the Worker mints a short-lived JWT containing
`{ userId, sessionId, exp }`, signed with `PLATFORM_JWT_SECRET`. It's
written into the container's OpenCode MCP config and into the
`loom-publish` sidecar's environment. The `/mcp` handler verifies
Access JWT **or** platform JWT and derives `userId` from either.

Rotating `PLATFORM_JWT_SECRET` invalidates all live tokens — sandboxes
re-authenticate on next request.

---

## 4. How Cloudflare primitives are used

Primitives are *how loom is built*, not what the agent chooses from.
They are plumbed in transparently at framework layer so the agent (and
the user) can work naturally — writing files, asking questions,
rendering pages — and loom routes to the right surface underneath.

### Workers (the Worker itself)

- Single deployment hosts `/dash`, `/mcp`, `/view`, and sandbox preview
  proxy.
- Deployed via Workers Builds on every push to `main`.

### Durable Objects

- `Sandbox` — one container per user, persistent workspace. Managed via
  `@cloudflare/sandbox`.
- `UserRegistry` — per-user SQLite-backed state: owned resources,
  encrypted provider keys, private tool registry, tool run records.
  One DO per `userId`.

### Cloudflare Containers

- The `Sandbox` DO provisions a Linux container (Dockerfile at repo
  root) running OpenCode, sidecars, and common CLI tooling. See
  `Dockerfile` for the image.
- Every user gets their own instance; state persists across sessions
  via R2 snapshots when the container is evicted.

### Dynamic Workers (Worker Loader binding)

A **Worker Loader** binding (`env.LOADER`) lets the loom Worker spin
up ad-hoc isolated Worker environments at request time. This is the
foundation for Code Mode (below) and for any other feature that needs
safe, disposable JavaScript execution at the edge.

Properties:

- **Milliseconds to start.** Each load creates a fresh isolate; no
  cold-start penalty from container boot.
- **No network by default.** The binding is instantiated with
  `globalOutbound: null` — the loaded Worker cannot `fetch()` or
  `connect()` anywhere unless loom passes it a `Fetcher`.
- **Module graph under loom's control.** loom decides which modules
  the loaded Worker sees, and can sanitise / rewrite source before
  loading.
- **Scoped to one request.** Results captured (stdout, return value)
  and the isolate discarded.

Framework integrations that use Worker Loader:

- **Code Mode** (see below).
- **Safe evaluation of small user snippets** in framework-level UIs
  (e.g. previewing a parameterised prompt before saving a tool).
- **Tool parameter validation** — Zod schemas from user-created tools
  run in a loader isolate to prevent a malicious parameter schema
  from burning the Worker's CPU.

### Code Mode (`@cloudflare/codemode`)

Code Mode is how the agent composes work cheaply, without paying the
subrequest cost of a full tool-call-per-step loop.

The sandbox container exposes a `loom-code` CLI that OpenCode uses to
run short bursts of JavaScript:

    loom-code <<'JS'
    const files = await loom.workspace.list("/home/user/workspace");
    const todos = [];
    for (const f of files.filter(f => f.name.endsWith(".md"))) {
      const body = await loom.workspace.read(f.path);
      todos.push(...body.match(/TODO.*/g) ?? []);
    }
    return todos;
    JS

Under the hood, `loom-code` POSTs the snippet to a framework-level
endpoint on the Worker. The Worker:

1. Wraps the snippet in a tiny module that exposes the `loom.*`
   namespace (workspace access, publication lookup, the AI / Browser
   helpers described below).
2. Loads the module via `WORKER_LOADER` with `globalOutbound: null`
   and a 30s timeout.
3. Executes, captures stdout and the return value, returns them to
   the sandbox over the same HTTP response.

What this buys the agent:

- **1 subrequest per composition.** A loop that would otherwise make
  50 container round-trips becomes one Code Mode invocation.
- **Real programming.** The agent writes idiomatic JS — conditionals,
  loops, error handling — instead of one tool call per step.
- **Sandboxed by default.** No network escape, no cross-user state
  access. The `loom.*` namespace the module sees is built against
  `ctx` derived from the verified JWT, so the snippet is scoped to
  the invoking user.

Code Mode is not an MCP tool the agent has to discover. It is a CLI
baked into the sandbox image, documented in the default OpenCode
system prompt so the agent reaches for it naturally.

See [`CODE-MODE.md`](./CODE-MODE.md) for the namespace reference,
safety model, and the full `loom.*` API.

### R2 — persistent files

Three shared buckets, each partitioned by key prefix:

| Bucket | Purpose | Key pattern |
|---|---|---|
| `loom-workspace-snapshots` | tarballed workspace backups | `users/<userId>/snapshots/v<N>.tar.gz` |
| `loom-publications` | content served by `/view/<shortId>/...` | `publications/<userId>/<shortId>/<path>` |
| `loom-tool-attachments` | attachments travelling with user-created tools | `users/<userId>/tools/<toolId>/attachments/<id>` |

The agent never calls `r2.put()` directly. It writes files in its
sandbox (with the sidecars watching), and loom's framework decides
what to snapshot / publish / attach.

### D1 — platform state queryable across users

One platform database: `loom-platform`. Used for:

- Admin surfaces (cross-user listings for the admin role).
- The team-shared tool library (`shared_tools` table — indexed for the
  `/dash/library` page).
- Audit log (`audit_log` table — every publish / rotate / revoke /
  tool-share event).
- Publication index (`publications` table — `shortId → userId` + manifest).

Every row has a `user_id` column; every query filters on it via the
query helper.

### KV — small, fast, shared state

One platform KV namespace: `loom-platform`. Used for:

- Per-user rate-limit counters (`user:<userId>:ratelimit:<category>`).
- Manifest cache for `/view` (`view:manifest:<shortId>`, 60s TTL).
- Platform config (`config:view_limits`, `config:tool_limits`,
  `config:tools_admin_group`).
- Admin cache (`admin:users`).

### Workers AI

- Default model provider for new sandboxes (`@cf/meta/llama-3.3-70b-instruct`).
- Users can swap in their own Anthropic / OpenAI / etc. key via
  `/dash/settings` — it's written into their OpenCode config at
  container start.
- Internal framework features (e.g. the "propose templatization" UX that
  summarises agent trajectories) can use Workers AI directly without
  burning the user's key.

### Browser Rendering

Plumbed into two places:

- Framework-level: rendering internal previews of `/view`
  publications (thumbnails in `/dash/views`).
- Sandbox-level: accessible via the same HTTP endpoint OpenCode already
  knows about, so when the agent needs to screenshot / PDF / scrape a
  URL, it uses the binding through a small loom-provided helper
  already installed in the container. Not an MCP tool — a command-line
  helper (`loom-render screenshot <url>`) so it feels native to the
  shell.

### Cloudflare Access

- Gates `/dash` and `/mcp`. Not `/view`.
- Access claims (`sub`, `email`, group memberships) drive `userId` and
  the optional admin role.
- JWKS cached in `PLATFORM_KV` for 10 minutes.

### DNS

- Wildcard DNS record on the main hostname (`*.loom.yourcompany.com`)
  for sandbox preview URLs.
- One main A/CNAME for `loom.yourcompany.com`.
- The agent does not manipulate DNS in v1. If team-wide custom domains
  for `/view` publications are wanted later, it becomes a framework
  feature — operator-configured zones, loom-managed record lifecycle —
  not an exposed tool.

### Not used in v1

- **Workers for Platforms.** Previous drafts used it for agent-deployed
  skills; removed. Tools in loom are prompt templates, not Workers.
- **Cloudflare Queues, Vectorize, Hyperdrive, Cache API.** Possibly
  framework additions later, but not in v1.

---

## 5. Architecture

### Component map

    ┌────────────────────────────┐   ┌──────────────────────────────┐
    │ Browser (authenticated)    │   │ Browser (unauthenticated)    │
    │ loom.yourcompany.com/dash  │   │ loom.yourcompany.com/view/.. │
    └────────────┬───────────────┘   └────────────┬─────────────────┘
                 │ Access JWT                     │ no JWT; shortId
                 ▼                                ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  loom Worker — single deployment                            │
    │                                                             │
    │  ┌─────────────────────────────────────────────────────┐   │
    │  │ Router (dispatches by hostname + path, in order):   │   │
    │  │   1. *.hostname  → proxyToSandbox()                 │   │
    │  │   2. /view/*     → view router (no JWT)             │   │
    │  │   3. /dash/*     → TanStack Start (JWT required)    │   │
    │  │   4. /dash/oc/*  → proxy → sandbox:4096 (OpenCode)  │   │
    │  │   5. /mcp        → createMcpHandler (JWT or platform)│  │
    │  └─────────────────────────────────────────────────────┘   │
    │  ┌───────────────────┐  ┌─────────────────────┐            │
    │  │ UserRegistry DO   │  │ Sandbox DO +        │            │
    │  │ (per user)        │  │ Container (per user)│            │
    │  │ • owned resources │  │ • OpenCode serve    │            │
    │  │ • provider keys   │  │ • workspace /home/  │            │
    │  │ • private tools   │  │   user/workspace    │            │
    │  │ • tool runs       │  │ • publish sidecar   │            │
    │  └───────────────────┘  └─────────────────────┘            │
    │  ┌─────────────────────────────────────────────────────┐   │
    │  │ Framework-integrated primitives:                    │   │
    │  │   LOADER (Worker Loader → Code Mode isolates)       │   │
    │  │   AI · BROWSER                                      │   │
    │  │   WORKSPACE_SNAPSHOTS (R2) · PUBLICATIONS (R2)      │   │
    │  │   TOOL_ATTACHMENTS (R2)                             │   │
    │  │   PLATFORM_KV · PLATFORM_D1                         │   │
    │  └─────────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────────┘

    Compute hierarchy the agent reaches through:

        Code Mode   (ms, no network, per call)     → compose & parse
            │
            ▼
        Sandbox     (seconds to boot, persistent)  → build, run, serve
            │
            ▼
        /view       (ms to serve, public URL)      → share with the world

### Why OpenCode as the agent core

- Strong open-source coding agent with MCP client support built in.
- Has a serve mode with a web UI we can iframe — no need to reimplement
  chat, streaming, diff rendering.
- BYO provider key: OpenCode calls model providers directly from inside
  the container; loom never touches model traffic.

### Why a minimal MCP server

Two reasons:

1. **Primitives are framework, not tools.** The agent should not have
   to decide which bucket or namespace to use; loom routes those.
2. **Users own the tool catalog.** A tool is a thing the user
   templatizes. The MCP server exposes the tool-operation surface
   (`tools.list`, `tools.invoke`, …) plus a small set of publication
   and introspection operations — and nothing else.

---

## 6. CI/CD — Workers Builds

The repo is designed to deploy via **Cloudflare Workers Builds**. No
GitHub Actions for deploy.

### Workers Builds settings

Configure in **Dashboard → Workers → your-worker → Settings → Builds**:

- **Repository:** `github.com/<you>/loom` (your fork)
- **Production branch:** `main`
- **Build command:** `pnpm install --frozen-lockfile && pnpm --filter @loom/web build`
- **Deploy command:** `pnpm --filter @loom/web deploy`
- **Root directory:** `/`
- **Build env vars:** none (config lives in `wrangler.jsonc` and
  Workers secrets)

Every push to `main` triggers a build and deploy.

---

## 7. Wrangler configuration (sketch)

The single deployment, `apps/web/wrangler.jsonc`. Placeholder IDs are
filled in by `./scripts/setup`.

    {
      "name": "loom",
      "main": "src/worker-entry.ts",
      "compatibility_date": "2025-12-01",
      "compatibility_flags": ["nodejs_compat"],
      "observability": { "enabled": true },

      "assets": {
        "directory": "./dist/client",
        "binding": "ASSETS",
        "not_found_handling": "single-page-application"
      },

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

      "ai":      { "binding": "AI" },
      "browser": { "binding": "BROWSER" },

      "worker_loaders": [
        { "binding": "LOADER" }
      ],

      "r2_buckets": [
        { "binding": "WORKSPACE_SNAPSHOTS", "bucket_name": "loom-workspace-snapshots" },
        { "binding": "PUBLICATIONS",        "bucket_name": "loom-publications" },
        { "binding": "TOOL_ATTACHMENTS",    "bucket_name": "loom-tool-attachments" }
      ],

      "kv_namespaces": [
        { "binding": "PLATFORM_KV", "id": "__FILL_ME_FROM_SETUP_SCRIPT__" }
      ],

      "d1_databases": [
        {
          "binding": "PLATFORM_D1",
          "database_name": "loom-platform",
          "database_id": "__FILL_ME_FROM_SETUP_SCRIPT__"
        }
      ],

      "vars": {
        "SANDBOX_TRANSPORT": "ws",
        "LOOM_HOSTNAME": "loom.yourcompany.com"
      },

      "routes": [
        { "pattern": "loom.yourcompany.com/*",   "zone_name": "yourcompany.com" },
        { "pattern": "*.loom.yourcompany.com/*", "zone_name": "yourcompany.com" }
      ],

      "migrations": [
        { "tag": "v1", "new_sqlite_classes": ["UserRegistry", "Sandbox"] }
      ]
    }

Secrets (set via `wrangler secret put`):

    CF_ACCESS_TEAM_DOMAIN      e.g. yourcompany.cloudflareaccess.com
    CF_ACCESS_AUD              Access application AUD tag
    CF_API_TOKEN               used by framework provisioning (not the agent)
    PLATFORM_JWT_SECRET        HMAC secret for sandbox → /mcp tokens

---

## 8. Build order (milestones)

### M0 — Skeleton (this commit's state)
Docs + wrangler.jsonc + Dockerfile + workspace scaffolding. No runtime
code yet.

### M1 — Auth + boot
- TanStack Start app at `/dash` serves a placeholder.
- Access JWT middleware covers `/dash` and `/mcp`.
- `/view/*` path skips Access verification in the router.
- `/mcp` stub returns an empty tool list, verified.
- `UserRegistry` DO with a `greet()` method.
- `wrangler dev` works end-to-end with a mock JWT.
- `./scripts/setup` provisions resources.
- Repo pushed to GitHub, Workers Builds wired up.

### M2 — Sandbox + OpenCode
- Dockerfile builds; container image published.
- `Sandbox` DO provisions one container per user.
- Worker proxies `/dash/oc/*` to the sandbox's port 4096.
- Dash chrome renders an iframe of OpenCode's web UI.

### M3 — MCP handshake + framework primitives wired
- `/mcp` uses `createMcpHandler` + platform JWT.
- OpenCode in the sandbox preconfigured to connect.
- **Worker Loader** binding in place; `loom-code` CLI in the sandbox
  image wired up end-to-end, with the `loom.*` namespace exposing
  workspace read/list/write, publication lookup, and the AI / Browser
  helpers.
- Workers AI binding available via `loom-ai run <model>` in the
  container (thin wrapper around the AI helper in the `loom.*`
  namespace).
- Browser Rendering available via `loom-render screenshot|pdf|scrape
  <url>` similarly.
- `PLATFORM_KV` + `PLATFORM_D1` query helpers in place; migrations run.
- Workspace snapshots wired: sidecar + R2 + restore on cold start.
- OpenCode default system prompt updated to describe the three-tier
  compute hierarchy (Code Mode → Sandbox → /view) so the agent reaches
  for the right one per task.

### M4 — Tools v1 (private)
- Tool data model in `UserRegistry` DO.
- `TOOL_ATTACHMENTS` R2 bucket wired.
- MCP operations: `tools.list`, `tools.invoke`, `tools.propose_templatize`,
  `tools.get_run`.
- `/dash` left sidebar shows **Your tools**.
- Chat UI **Templatize** action on agent messages.
- Tool invocation UI + live run pane.
- Parameter types: string, number, boolean, enum, file.

### M5 — Tools v2 (team library)
- Visibility switch: `private` / `team`.
- `shared_tools` table in `PLATFORM_D1`.
- `/dash/library` page: browse, install.
- "New version" indicator on installed tools.
- Tool composition: `tools.invoke` callable from within a running tool,
  with depth cap.

### M6 — `/view` publishing
- `view.*` MCP operations for control.
- `loom-publish` sidecar watches `.publish/` and syncs to R2.
- `publications` table + manifest cache in KV.
- Mode A (static) + Mode B (proxy to sandbox port).
- Default sandbox CSP on all responses.
- `/dash/views` management page.

### M7 — Admin
- `/dash/admin` for users in the configured admin group.
- Per-user resource usage, revoke publications, rotate
  `PLATFORM_JWT_SECRET`, impersonation with audit log.
- Team library moderation (remove tools shared by others).

### M8 — Polish
- Per-user rate limits (tools, publications, AI, browser renders).
- Observability dashboards.
- Tool export/import format (signed bundle) — lays groundwork for
  cross-deployment marketplaces.

---

## 9. Hard constraints

| Limit | Source | Mitigation |
|---|---|---|
| 1,000 subrequests per request | Workers paid | `SANDBOX_TRANSPORT=ws` (1 subrequest / turn) |
| Container eviction while idle | Cloudflare Containers | `keepAlive: true` + R2 snapshots |
| Wildcard DNS required for preview URLs | Sandbox SDK | Documented in DEPLOYMENT.md |
| Access JWT verification cost | CF Access | JWKS cached 10min in `PLATFORM_KV` |
| Concurrent sandboxes (cost) | Cloudflare Containers | Per-team cap in `PLATFORM_KV:config:sandbox_cap` |

---

## 10. Open questions

1. **Admin role source.** Access group claim vs. `PLATFORM_KV` list?
   Proposal: Access group claim, configurable group name.
2. **Provider key rotation.** UI flow for updating a user's provider
   key without killing the container mid-session.
3. **Tool update semantics.** When the author updates a shared tool,
   should installers see a diff of what changed? Proposal: yes,
   prompt + parameters + attachment hashes diffed.
4. **Tool execution cost attribution.** When user B invokes a shared
   tool that burns AI tokens, whose rate limit is it? Proposal: user
   B's. The tool is a recipe, not a hosted service.
5. **Workers Builds preview envs.** Do non-main branches get their own
   Access app + hostname or reuse production? Proposal: separate
   hostname `preview-loom.yourcompany.com`, separate Access app,
   operator's choice.

---

## 11. Appendix — why these choices

| Decision | Rejected alternative | Why |
|---|---|---|
| Primitives as framework | Primitives as MCP tools | Keeps the MCP surface tiny; matches how OpenCode already works (files + shell). |
| Tools as user artifact | Tools as platform fixtures | The democratization story is the point — tools emerge from work, they aren't seeded by the platform. |
| Prompt-based tools | Script-based tools | Preserves agent flexibility; audit-friendly; cheap to share. |
| Private default | Team-shared default | Sharing is explicit and intentional; avoids accidental exposure. |
| OpenCode as agent | Build our own loop | OpenCode is capable, MCP-native, has a UI. |
| Access JWT | Custom auth | Zero auth code; teams already have Access. |
| TanStack Start | Astro / RR7 | First-class Workers adapter; SSR + SPA shape fits a heavily interactive app. |
| Single Worker | Pages + Worker | Pages de-emphasised; static assets on Workers is the path. |
| Workers Builds | GitHub Actions | Zero-config CI/CD, official CF path. |
| Biome | ESLint + Prettier | One tool, zero config. |
| No Workers for Platforms | Deploy user-authored Workers | Out of v1 scope; use `/view` proxy mode for user-authored live services. |
