# AGENTS.md — Instructions for AI coding agents working on loom

This file is read automatically by Claude Code, OpenCode, Cursor, and
other agentic coding tools operating in this repository. Follow it
closely — it captures the non-obvious decisions that keep loom coherent.

---

## What loom is

A self-hostable, **multi-user**, agentic-AI sandbox platform built on
the Cloudflare Developer Platform:

1. Team authenticates via **Cloudflare Access** (on `/dash` and `/mcp`;
   `/view` is deliberately public).
2. Each user gets an isolated Sandbox container running **OpenCode**.
3. Cloudflare primitives (Containers/Sandboxes, **Dynamic Workers via
   Worker Loader → Code Mode**, R2, D1, KV, Workers AI, Browser
   Rendering) are **integrated into the framework** — not exposed as a
   catalog of MCP tools. The agent does not pick `r2_put_object` from a
   menu; loom routes persistence, inference, rendering, and composition
   through primitives transparently.
   The agent reaches for compute through a three-tier hierarchy: Code
   Mode (ms, no-network isolates) → Sandbox (persistent Linux) →
   `/view` (public publishing). See [`CODE-MODE.md`](./CODE-MODE.md).
4. **Tools** are a user artifact: a parameterised prompt + optional
   workspace attachments, templatized from a completed agent trajectory.
   Private by default, explicitly shareable to a team library. See
   [`TOOLS.md`](./TOOLS.md).
5. **`/view`** is the public publishing path on the main hostname. See
   [`VIEW.md`](./VIEW.md).
6. Deployed via **Workers Builds** — push to `main`, Cloudflare builds
   and deploys.

**OpenCode is the agent. loom is the framework.** Do not build a custom
agent loop. Do not reimplement chat. Do not touch OpenCode's provider
config except by writing to `~/.opencode/` inside the container at
startup.

---

## Architecture invariants

Treat these as hard rules. Violating any is a blocker.

1. **Single Worker deployment.** Everything ships from `apps/web` via
   one `wrangler deploy`. No other Workers.
2. **`/dash` and `/mcp` are behind Cloudflare Access. `/view` is NOT.**
   The Worker short-circuits Access verification for path prefix
   `/view/`. Keep that short-circuit narrow.
3. **`userId` comes only from a verified JWT.** Access JWT on `/dash`
   and `/mcp`; platform JWT for sandbox → `/mcp`. For `/view`, `userId`
   comes from the `publications` row looked up by shortId — still never
   from the request.
4. **Every persistent resource is user-scoped.** Key prefix
   `users/<userId>/*` or row-level `user_id` column. Enforced via
   `apps/web/src/server/keys.ts` and the query helpers.
5. **OpenCode lives only inside the Sandbox container.** Never as a
   Worker dep, never outside the container.
6. **Primitives are framework-integrated, not MCP tools.** There are
   no `r2_*`, `kv_*`, `d1_*`, `ai_*`, `browser_*`, `dns_*` MCP tools.
   If the agent needs rendering, inference, or composition, loom
   provides small shell helpers inside the container (`loom-ai`,
   `loom-render`, `loom-code`) that wrap the bindings via
   framework-level Worker endpoints — not via `/mcp`.
   `loom-code` in particular is the agent's primary tool for parsing /
   transforming / composing — it runs JS in a Worker Loader isolate
   with no network, 30s timeout, scoped to the invoking user. See
   [`CODE-MODE.md`](./CODE-MODE.md).
7. **The MCP surface is minimal and tool-centric.** It exposes
   user-tool operations (`tools.list`, `tools.invoke`,
   `tools.propose_templatize`, `tools.get_run`), publication control
   (`view.*`), and introspection (`whoami`, `workspace.*`). Nothing
   else. Adding a primitive-level MCP tool is a design review, not a
   PR.
8. **User's provider key never leaves the container.** OpenCode calls
   model providers directly. The Worker never sees model traffic.
9. **Cloudflare API token is loom's, not the user's.** Used by
   framework-level provisioning only. Never exposed to the agent.
10. **No GitHub Actions for deploy.** Workers Builds deploys from
    `main`. CI for lint/tests is fine, deploy happens on CF.
11. **Publishing to `/view` is filesystem-driven.** The agent writes to
    `/home/user/workspace/.publish/<alias>/`; a sidecar syncs to R2.
    MCP operations on `view.*` are for control only.

---

## Multi-tenancy: the most important doc after this one

Read [`docs/MULTI-TENANCY.md`](./MULTI-TENANCY.md) before adding any
framework feature or MCP operation. It defines the guardrail every
mutating operation must follow.

TL;DR (four-step pattern):

    1. fullKey = ctx.keys.<kind>(...)         // user-prefixed
    2. ownership guard                        // DO or D1 helper check
    3. primitive operation with fullKey
    4. registry update

Skipping any step is a security bug.

---

## Repository layout

    loom/
    ├── apps/web/                   THE Worker. Everything the user touches.
    │   ├── wrangler.jsonc
    │   └── src/
    │       ├── worker-entry.ts     fetch handler — router, Access, /view bypass
    │       ├── routes/             TanStack Start routes under /dash
    │       ├── components/         React + Kumo
    │       ├── lib/                client-side helpers (no bindings)
    │       ├── server/             server fns — auth, JWKS, keys, db, proxies
    │       │   ├── keys.ts         user-prefixed key/name helpers (CRITICAL)
    │       │   ├── db.ts           D1 query helper with user_id enforcement
    │       │   └── auth.ts         Access + platform JWT verification
    │       ├── durable-objects/    UserRegistry, Sandbox re-export
    │       ├── view/               /view router — static + proxy modes
    │       │   ├── router.ts
    │       │   ├── static.ts
    │       │   ├── proxy.ts
    │       │   └── manifest.ts
    │       ├── mcp/                minimal MCP server — tool ops + view ops
    │       │   ├── server.ts
    │       │   ├── context.ts
    │       │   └── operations/
    │       │       ├── tools.ts    tools.list / invoke / propose_templatize / get_run
    │       │       ├── view.ts     view.list / rotate / revoke / ...
    │       │       └── meta.ts     whoami / workspace.snapshot / workspace.restore
    │       └── sandbox-app/        files baked into the container
    │           ├── opencode.jsonc
    │           ├── tui.jsonc
    │           ├── loom-publish-sidecar/   watches .publish/ → R2
    │           ├── loom-code/              CLI for Code Mode (Worker Loader)
    │           ├── loom-ai/                CLI wrapper over the AI helper
    │           └── loom-render/            CLI wrapper over Browser Rendering
    │
    ├── packages/shared-types/      types shared across the repo
    ├── docs/                       SPEC, TOOLS, MULTI-TENANCY, VIEW, DEPLOYMENT, AGENTS
    ├── Dockerfile                  sandbox container (OpenCode + tools + sidecars)
    └── scripts/                    setup / start / deploy

---

## Stack — do not swap without discussion

| Layer | Pinned choice |
|---|---|
| Runtime | Cloudflare Workers (single deployment) |
| Meta-framework | TanStack Start |
| UI framework | React 19 |
| Components | `@cloudflare/kumo` (MIT, on npm) |
| Icons | `@phosphor-icons/react` (Kumo peer dep) |
| Styling | Tailwind CSS v4 |
| Data fetching | TanStack Query |
| Build | Vite 7 + `@cloudflare/vite-plugin` |
| CI/CD | Cloudflare Workers Builds |
| Auth | Cloudflare Access (JWT verification) |
| Agent core | OpenCode (CLI + web UI, in sandbox) |
| Sandbox | `@cloudflare/sandbox` |
| MCP server | Agents SDK `createMcpHandler` (Streamable HTTP) |
| Lint / format | Biome (one tool) |
| Tests | Vitest |
| Package manager | pnpm workspaces |

---

## Coding conventions

### TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`,
  `verbatimModuleSyntax: true`.
- Prefer `type` over `interface`.
- Export types with `export type { Foo }`.
- No `any`. `unknown` + narrowing. `@ts-expect-error` needs a comment.

### MCP operation shape

Every MCP operation follows the same pattern. The catalog lives in
`apps/web/src/mcp/operations/` and is tiny — see AGENTS invariant #7.

    // apps/web/src/mcp/operations/tools.ts
    import { z } from "zod";
    import { defineMcpOp } from "../define";

    export const toolsList = defineMcpOp({
      name: "tools.list",
      description: "List the invoker's private tools and installed shared tools.",
      input: z.object({ scope: z.enum(["all", "private", "shared"]).default("all") }),
      async execute({ scope }, ctx) {
        const ownTools = await ctx.userRegistry.listTools();
        const installed = scope === "private" ? [] : await ctx.db.listInstalledTools(ctx.userId);
        return { ok: true, data: { own: ownTools, installed } };
      },
    });

Rules:
- Validate ALL input with Zod.
- Return `{ ok: true, data }` or `{ ok: false, error, code? }`.
- Never throw.
- Never read bindings directly; receive them via `ctx`.
- Never accept `userId` as input — it comes from `ctx`.

### React

- Functional components only.
- Kumo components first. `npx @cloudflare/kumo ls`;
  `npx @cloudflare/kumo doc <ComponentName>`.
- Tailwind utilities + Kumo semantic tokens. No CSS modules / styled.
- Server state via TanStack Query. Client state via `useState`.

### Routing

- TanStack Start file-based routing under `apps/web/src/routes/`.
- All authenticated routes under `/dash/*`. `/` redirects to `/dash`.
- Auth guard in `__root.tsx` — redirect to Access login if no JWT.

### Tests

- Every MCP operation: unit test for input validation + happy path +
  error path, with mocked `ctx`.
- Integration tests via `vitest` + `@cloudflare/vitest-pool-workers`
  when bindings are needed.
- Tenancy tests: user A's request never returns user B's data.

---

## Development workflow

Before starting a task:

1. Read the relevant SPEC.md section and the milestone this belongs to.
2. If the change crosses more than 3 directories, write a plan and
   stop for review.
3. If the change affects tenancy (new framework integration, new MCP
   operation, new D1 table, new R2 prefix), re-read
   [`MULTI-TENANCY.md`](./MULTI-TENANCY.md).

Commands:

    pnpm install
    pnpm dev          # wrangler dev (local)
    pnpm lint         # biome check
    pnpm lint:fix
    pnpm typecheck
    pnpm test
    pnpm --filter @loom/web test

Do NOT run `pnpm deploy` to test a change. Workers Builds deploys on
merge to `main`. Use a preview branch for live tests.

Before opening a PR:

- [ ] `pnpm lint && pnpm typecheck && pnpm test` all pass
- [ ] New MCP operations (if any) justified in PR description — they
      should be rare
- [ ] New tenancy surfaces documented in `docs/MULTI-TENANCY.md`
- [ ] New bindings added to `apps/web/wrangler.jsonc`
- [ ] Ownership guard in place for every mutating operation
- [ ] No new entries in `package.json#dependencies` without mention

---

## Secrets & config

- `.dev.vars` for local dev (gitignored).
- `wrangler secret put` for production.
- Never hard-code API keys, tokens, zone IDs, account IDs.
- Full list in `.env.example` at the repo root.

Required secrets:

    CF_ACCESS_TEAM_DOMAIN      yourcompany.cloudflareaccess.com
    CF_ACCESS_AUD              Access application AUD tag
    CF_ACCOUNT_ID              wrangler whoami
    CF_API_TOKEN               framework-level provisioning (not agent)
    PLATFORM_JWT_SECRET        sandbox → /mcp JWT HMAC secret

OpenCode in the container reads its provider key from its own config,
which loom writes at container start after fetching from the
`UserRegistry` DO. The Worker never logs or proxies the key.

---

## Sandbox-specific rules

- Sandbox ID = `userId`. Same ID across sessions → persistent container.
- `keepAlive: true` always. Heartbeat every 30s from `UserRegistry`
  alarm.
- Transport MUST be WebSocket (`SANDBOX_TRANSPORT=ws`).
- `proxyToSandbox()` called first in the fetch handler for
  `*.loom.yourcompany.com` — preview URLs auth via hostname token.
- `/home/user/workspace` is the source of truth. Snapshot to R2 after
  any turn that touches it (debounced 5s).

---

## Kumo usage

    import { Button, Dialog, Input } from "@cloudflare/kumo";
    import "@cloudflare/kumo/styles";     // once, in root layout

Discovery:

    npx @cloudflare/kumo ls
    npx @cloudflare/kumo doc Dialog

Rules:
- Import `@cloudflare/kumo/styles` ONCE in root layout.
- Use Kumo semantic color tokens. No hard-coded hex.
- Dark mode handled by Kumo's tokens.

---

## PR etiquette

- One logical change per PR.
- Title: `<scope>: <imperative summary>`, e.g.
  `mcp: add tools.propose_templatize`.
- Description: what, why, how to test, milestone in SPEC.md.
- If the PR adds an MCP operation, explain why the framework cannot
  handle it transparently.
- If the PR changes tenancy, explicitly call out the guardrails kept
  or added.

---

## When unsure

1. Check [`SPEC.md`](./SPEC.md) for architecture.
2. Check [`CODE-MODE.md`](./CODE-MODE.md) for Code Mode / Worker Loader.
3. Check [`TOOLS.md`](./TOOLS.md) for tool-related questions.
4. Check [`MULTI-TENANCY.md`](./MULTI-TENANCY.md) for isolation.
5. Check [`VIEW.md`](./VIEW.md) for `/view` / publishing / sidecar.
6. Check [`DEPLOYMENT.md`](./DEPLOYMENT.md) for secrets + Workers Builds.
7. Check this file for conventions.
8. If still unsure, open an issue tagged `design-question`. It is
   cheaper to clarify than to refactor.
