# AGENTS.md — Instructions for AI coding agents working on loom

This file is read automatically by Claude Code, OpenCode, Cursor, and
other agentic coding tools when operating in this repository. Follow it
closely — it captures non-obvious decisions that keep loom coherent.

---

## What loom is

A self-hostable, **multi-user**, agentic-AI sandbox platform built on
the Cloudflare Developer Platform:

1. Team authenticates via **Cloudflare Access** (on both `/dash` and
   `/mcp`).
2. Each user gets an isolated Sandbox container running **OpenCode**.
3. loom's Worker hosts `/mcp` — an **MCP server** exposing every
   Cloudflare primitive (Workers, R2, KV, D1, DO, Workers AI, Browser
   Rendering, DNS, Workers for Platforms) as tools OpenCode can call.
4. Every persistent resource is **partitioned by user** — see
   `MULTI-TENANCY.md`.
5. Deployed via **Workers Builds** — push to `main`, Cloudflare
   builds + deploys.

**OpenCode is the agent. loom is the toolbelt.** Do not build a custom
agent loop. Do not reimplement chat. Do not touch OpenCode's provider
config except by writing to `~/.opencode/` inside the container at
startup.

---

## Architecture invariants

Treat these as hard rules. Violating any of them is a blocker.

1. **Single Worker deployment.** Everything ships from `apps/web` via one
   `wrangler deploy`. Only exception: `apps/outbound` (egress Worker).
2. **`/dash` and `/mcp` are behind Cloudflare Access. `/view` is NOT.**
   The `view.loom.yourcompany.com` origin is deliberately public —
   shortId entropy is the access control. Never route `/view` traffic
   through Access verification.
3. **`userId` comes only from the Access JWT or platform JWT.** Never
   from a request body, header (other than Access / Authorization),
   or URL param. For `/view` the `userId` comes from the
   `publications` row looked up by `shortId` — still never from the
   request.
4. **Every resource is user-scoped.** Prefix `loom-<userId>-*`, or key
   prefix `users/<userId>/*` for shared-binding partitioning. Enforced
   by `apps/web/src/mcp/lib/names.ts` + the `UserRegistry` DO.
5. **OpenCode lives only inside the Sandbox container.** Never as a
   Worker dep, never outside the container.
6. **MCP tools run in the Worker, not the sandbox.** The sandbox reaches
   out via HTTPS; the Worker executes with loom's API token.
7. **User's provider key never leaves the container.** OpenCode calls
   providers directly. The Worker never sees model traffic.
8. **Cloudflare API token is loom's, not the user's.** Tools drive the
   CF API on behalf of the user; safety is by name prefix + registry.
9. **No GitHub Actions for deploy.** Workers Builds deploys from
   `main`. CI for lint/tests is fine, but the deploy happens on CF.
10. **Publishing to `/view` is filesystem-driven, not MCP-driven.**
    The agent writes to `/home/user/workspace/.publish/<alias>/`; a
    sidecar syncs to R2. MCP tools (`view_list`, `view_rotate`,
    `view_revoke`, …) are for control operations only.

---

## Multi-tenancy: the most important doc after this one

Read [`docs/MULTI-TENANCY.md`](./MULTI-TENANCY.md) before adding any MCP
tool. It defines the ownership guardrail every mutating tool must follow.

TL;DR:

    1. fullName = ctx.names.<kind>(name)          // loom-<userId>-<name>
    2. ownership guard                            // ctx.userRegistry.isOwned(...)
    3. CF API call using fullName
    4. register / unregister in UserRegistry

Skipping any step is a security bug.

---

## Repository layout

    loom/
    ├── apps/web/                   THE Worker. Everything the user touches.
    │   ├── wrangler.jsonc
    │   └── src/
    │       ├── worker-entry.ts     fetch handler — Access + routing
    │       ├── routes/             TanStack Start routes under /dash
    │       ├── components/         React + Kumo
    │       ├── lib/                client-side helpers (no bindings)
    │       ├── server/             server functions — auth, JWKS, proxies
    │       ├── durable-objects/    UserRegistry, Sandbox re-export
    │       ├── view/               /view router — static + proxy modes
    │       │   ├── router.ts       top-level handler for view.* host
    │       │   ├── static.ts       R2-backed static serving
    │       │   ├── proxy.ts        sandbox port proxy + WS forwarding
    │       │   └── manifest.ts     parsing + defaults
    │       ├── mcp/                THE MCP server
    │       │   ├── server.ts       createMcpHandler setup
    │       │   ├── types.ts        LoomTool + context types
    │       │   ├── context.ts      buildContext(userId, env)
    │       │   ├── lib/            cf-api client, names, guards
    │       │   └── tools/
    │       │       ├── index.ts    catalog registration
    │       │       ├── workers/
    │       │       ├── r2/
    │       │       ├── kv/
    │       │       ├── d1/
    │       │       ├── ai/
    │       │       ├── browser/
    │       │       ├── dns/
    │       │       ├── routes/
    │       │       ├── view/       view_list, view_rotate, view_revoke, …
    │       │       └── meta/
    │       └── sandbox-app/        files baked into the container
    │           ├── opencode.jsonc
    │           ├── tui.jsonc
    │           └── loom-publish-sidecar/   watches .publish/ → syncs to R2
    │
    ├── apps/outbound/              egress Worker for user-deployed skills
    ├── packages/shared-types/      types shared between web and outbound
    ├── docs/                       SPEC, MCP-TOOLS, MULTI-TENANCY, DEPLOYMENT, AGENTS
    ├── Dockerfile                  sandbox container (OpenCode + tools)
    └── scripts/                    setup / start / deploy / teardown

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
- Prefer `type` over `interface` except for declaration merging.
- Export types with `export type { Foo }`.
- No `any`. Use `unknown` + narrowing. `@ts-expect-error` needs a comment.

### MCP tool anatomy

Every tool follows this shape:

    // apps/web/src/mcp/tools/r2/create-bucket.ts
    import { z } from "zod";
    import { defineTool } from "../../types";

    export const r2CreateBucket = defineTool({
      name: "r2_create_bucket",
      description: "Create a new R2 bucket owned by the current user.",
      input: z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,50}$/),
      }),
      async execute({ name }, ctx) {
        const fullName = ctx.names.r2Bucket(name);
        if (await ctx.userRegistry.isOwned("r2", fullName)) {
          return { ok: false, error: "Bucket already exists.", code: "EXISTS" };
        }
        await ctx.cfApi.r2.createBucket(fullName);
        await ctx.userRegistry.registerResource("r2", fullName);
        return { ok: true, data: { name: fullName } };
      },
    });

Rules:
- Validate ALL input with Zod.
- Return `{ ok: true, data }` or `{ ok: false, error, code? }`.
- Never throw from `execute` — return a failure result.
- Never read bindings directly; receive them via `ctx`.
- Never accept `userId` as an input — it comes from `ctx`.

### React

- Functional components only.
- Kumo components first. Check: `npx @cloudflare/kumo ls` and
  `npx @cloudflare/kumo doc <ComponentName>`.
- No CSS modules / styled-components. Tailwind utilities + Kumo
  semantic tokens only.
- Server state via TanStack Query. Client state via `useState`.
  No Redux, no Zustand.

### Routing

- TanStack Start file-based routing under `apps/web/src/routes/`.
- All routes under `/dash/*` — `/` redirects to `/dash`.
- Auth guard in `__root.tsx` — redirect to Access login if no JWT.

### Tests

- Every MCP tool: unit test for input validation + happy path + error
  path, with mocked `ctx`.
- Integration tests via `vitest` + `@cloudflare/vitest-pool-workers`
  when bindings are needed.

---

## Development workflow

Before starting a task:

1. Read the relevant SPEC.md section and the milestone this belongs to.
2. If the change crosses more than 3 directories, write a plan and
   stop for review.
3. If the change affects tenancy (new tool, new resource type, new
   binding), re-read MULTI-TENANCY.md.

Commands:

    pnpm install                      # once
    pnpm dev                          # wrangler dev (local)
    pnpm lint                         # biome check
    pnpm lint:fix                     # biome check --write
    pnpm typecheck                    # tsc --noEmit across workspace
    pnpm test                         # vitest across workspace
    pnpm --filter @loom/web test      # scoped test

Do NOT run `pnpm --filter @loom/web deploy` to test a change. Workers
Builds deploys on merge to `main`. Use a preview branch if you need a
live test.

Before opening a PR:

- [ ] `pnpm lint && pnpm typecheck && pnpm test` all pass
- [ ] New MCP tools documented in `docs/MCP-TOOLS.md`
- [ ] New resource types documented in `docs/MULTI-TENANCY.md`
- [ ] New bindings added to `apps/web/wrangler.jsonc`
- [ ] No new entries in `package.json#dependencies` without mention in
      PR description
- [ ] Ownership guard checked for every mutating tool

---

## Secrets & config

- `.dev.vars` for local dev (gitignored).
- `wrangler secret put` for production.
- Never hard-code API keys, tokens, zone IDs, account IDs.
- Full list in `.env.example` at the repo root.

Required secrets in the loom Worker:

    CF_ACCESS_TEAM_DOMAIN      yourcompany.cloudflareaccess.com
    CF_ACCESS_AUD              Access application AUD tag
    CF_ACCOUNT_ID              wrangler whoami
    CF_API_TOKEN               token with all needed scopes
    PLATFORM_JWT_SECRET        HMAC secret for session-scoped MCP tokens

OpenCode inside the container reads its provider key from its own
config, which loom writes at container start after fetching from the
UserRegistry DO. The Worker never logs or proxies the key.

---

## Sandbox-specific rules

- Sandbox ID = `userId`. Same ID across sessions → persistent container.
- Always use `keepAlive: true` when getting the sandbox. Heartbeat every
  30s from the `UserRegistry` DO alarm.
- Transport MUST be WebSocket (`SANDBOX_TRANSPORT=ws`). HTTP transport
  hits the 1k subrequest limit per agent turn.
- `proxyToSandbox()` MUST be called first in the fetch handler, before
  Access auth — preview URLs authenticate via token in the hostname, not
  via Access.
- `/home/user/workspace` is the source of truth. Snapshot to R2 after
  any turn that touches it (debounced 5s). Key:
  `users/<userId>/snapshots/v<N>.tar.gz`.

---

## Kumo usage

    import { Button, Dialog, Input } from "@cloudflare/kumo";
    import "@cloudflare/kumo/styles";     // once, in root layout

Discovery:

    npx @cloudflare/kumo ls              # list all components
    npx @cloudflare/kumo doc Dialog      # show Dialog docs

Rules:
- Import `@cloudflare/kumo/styles` ONCE in the root layout.
- Use Kumo semantic color tokens. No hard-coded hex.
- Dark mode is handled by Kumo's tokens.

---

## PR etiquette

- One logical change per PR.
- Title: `<scope>: <imperative summary>`, e.g.
  `mcp: add r2_list_objects tool`.
- Description must cover: what, why, how to test, milestone in SPEC.md.
- If the PR adds an MCP tool, include a `curl` or
  `npx @modelcontextprotocol/inspector` demo.
- If the PR changes tenancy, explicitly call out the guardrails kept
  or added.

---

## When unsure

1. Check SPEC.md for architecture.
2. Check MCP-TOOLS.md for tool-catalog questions.
3. Check MULTI-TENANCY.md for isolation questions.
4. Check VIEW.md for anything about `/view` / publishing / the sidecar.
5. Check DEPLOYMENT.md for secrets / Workers Builds questions.
6. Check this file for coding conventions.
7. If still unsure, open a GitHub issue tagged `design-question`
   rather than guessing. It is cheaper to clarify than to refactor.
