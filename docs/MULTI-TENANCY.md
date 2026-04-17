# Multi-tenancy in loom

loom is designed to be run by a team for a team. Every persistent
resource — files, workspace, database rows, tool attachments,
publications, provider keys — belongs to exactly one user. This document
is the **contract** that keeps tenants isolated.

If you are adding a feature, a new framework integration, or a new MCP
operation, read this file first.

---

## The tenant key

The **tenant key** is the `userId`, a URL-safe slug derived from the
Cloudflare Access JWT `sub` claim.

    accessJwt.sub → sha256 → base32hex(0, 20).toLowerCase()
    → e.g. "7f3c1a2b9d4e5a6b7c8d"

Every server-side operation receives `userId` from the request context,
never from the request body. It is derived exclusively from the verified
JWT (Access or platform).

---

## Partitioning by tenant key

### Durable Objects

| DO | Scope |
|---|---|
| `UserRegistry` | one per `userId` (DO id = `userId`) |
| `Sandbox` | one per `userId` (same id, so the container is persistent) |

### R2 — shared buckets, partitioned by key prefix

| Bucket | Key pattern |
|---|---|
| `loom-workspace-snapshots` | `users/<userId>/snapshots/v<N>.tar.gz` |
| `loom-publications` | `publications/<userId>/<shortId>/manifest.json` and `.../content/<path>` |
| `loom-tool-attachments` | `users/<userId>/tools/<toolId>/attachments/<id>` |

Keys are always constructed via `ctx.keys.<kind>(...)`, never by
concatenation. Helpers live in `apps/web/src/server/keys.ts`.

### KV — one namespace, keyed by user

| Key | Purpose |
|---|---|
| `user:<userId>:ratelimit:<category>` | per-user rate-limit token buckets |
| `user:<userId>:provider-key-enc` | (legacy; moved to DO) |
| `view:manifest:<shortId>` | per-publication manifest cache (60s) |
| `view:ratelimit:<shortId>` | per-publication rate limit |
| `config:*` | platform-wide config (admin-managed) |
| `admin:users` | set of known userIds for admin listing |

### D1 — one platform database, every row has `user_id`

Every table has a `user_id` column. Every query goes through
`ctx.db.query(sql, { userId, ...params })`, which prepends
`WHERE user_id = ?` automatically.

Tables (v1):

    resources       (user_id, type, name, created_at, metadata)
    audit_log       (user_id, actor, action, target, at)
    publications    (short_id PK, user_id, alias, mode, ...)
    shared_tools    (tool_id PK, author_user_id, version, name, ...)
    tool_installs   (tool_id, installer_user_id, installed_version, installed_at)

### Per-user private state — `UserRegistry` DO (SQLite)

    tools           (id PK, name, description, prompt, parameters_json,
                     attachments_json, visibility, version, created_at,
                     updated_at, invocation_count)
    tool_runs       (id PK, tool_id, tool_version, parameters_json,
                     started_at, completed_at, status, workspace_path,
                     publications_json, exit_message)
    provider_keys   (provider PK, encrypted_key)
    resources       (type, name, created_at, PRIMARY KEY (type, name))
    session         (opencode_port, last_active_at)

Why DO + D1 both? DO gives strong consistency for the owning user's
writes. D1 gives cross-user visibility for admin and shared-library
surfaces. Writes go to DO first, async-mirrored to D1 when the data is
part of a team-visible surface (shared tools, publication index, audit).

---

## Tools — the most sensitive multi-tenant surface

Tools are user-created artifacts. They are the only thing explicitly
designed to cross the tenant boundary (via team sharing).

### Private tools

- Stored in the author's `UserRegistry` DO.
- Attachments in R2 under `users/<authorId>/tools/<toolId>/...`.
- **Invisible** to everyone but the author. `tools.list` called by user
  B never returns user A's private tools. No cross-user listing, no
  counters, no timing side-channels.

### Team-shared tools

When user A flips a tool to team visibility:

1. The author's tool record stays in A's `UserRegistry`.
2. A row is written to `PLATFORM_D1.shared_tools` (indexed by `team_id`
   — currently a single-team deployment, so just a constant).
3. The R2 attachments are duplicated to a shared path
   `shared/tools/<toolId>/v<N>/attachments/<id>` so installers can
   fetch them without reading user A's R2 namespace.
4. `/dash/library` lists shared tools across the team.

### Installing a shared tool (user B installs user A's tool)

1. Read the shared row from `PLATFORM_D1`.
2. Fetch attachments from the shared R2 path.
3. Write a *copy* to user B's `UserRegistry` with a new `toolId`.
4. Copy attachments to `users/<userB>/tools/<newToolId>/...`.
5. Record the install in `tool_installs` (author, installer, version).

After install, user B's copy is independent. User A cannot modify it.
User A updating their own tool does not auto-propagate — user B sees a
"new version available" indicator and chooses.

### Invoking a shared tool

Execution is always in the **invoker's** sandbox, using the invoker's
provider key, counting against the invoker's rate limits. The author's
only contribution is the prompt + attachments. No cross-tenant compute.

### Attempted cross-tenant violations — reject paths

- User B calling `tools.invoke(toolId)` on a tool not in their registry
  → `NOT_FOUND`. Even if they guess a valid toolId, only their own
  registry is consulted by `tools.invoke`; shared tools are only
  callable if installed.
- User B calling `tools.list()` — returns only their own registry.
- Admin impersonation — only via documented, logged override
  (`/dash/admin`, gated by the admin Access group).

---

## The guardrail pattern

Any operation that mutates a resource follows the four-step pattern:

1. Resolve the fully-qualified name / key via `ctx.keys` or `ctx.names`.
2. Ownership guard: read the user's registry (DO or D1 helper) and
   refuse if the resource isn't theirs (for mutations of existing
   resources) or already exists (for creations).
3. Perform the operation using the fully-qualified name.
4. Update the registry to reflect the mutation.

Skipping any step is a **security bug**. Code review checklist in
`AGENTS.md` includes this item.

---

## `/view` and multi-tenancy

`/view` is public by design, but tenancy still holds:

- Every `shortId` maps 1:1 to a `userId` in
  `PLATFORM_D1.publications`. The `/view` router reads the row,
  derives the R2 path prefix from its `userId`, and fetches content
  from there. User A cannot craft a shortId that reads user B's R2.
- Mode B (proxy) publications proxy only to the publishing user's own
  sandbox.
- Rotation, revocation, expiry: only the owning user or an admin can
  invoke.
- Audit log records `userId` + `shortId` on every publish / rotate /
  revoke / request.

See [`VIEW.md`](./VIEW.md) for the full attribution story.

---

## What tenants MUST NOT share

- User A cannot read user B's workspace files.
- User A cannot read or list user B's R2 objects.
- User A cannot read user B's D1 rows or KV values.
- User A cannot see user B's private tools or invoke them.
- User A cannot modify user B's shared tools (only install).
- User A cannot see user B's provider keys.
- User A cannot access user B's sandbox preview URLs (token-gated).
- User A cannot revoke, rotate, or overwrite user B's publications.
- User A cannot proxy traffic through user B's sandbox via `/view`.

Any violation of the above is a security bug. File via `SECURITY.md`
(once added) or directly to the repo owner.

---

## Admin role

Members of a configurable Access group (default `loom-admins`) can
access `/dash/admin`:

- List all users, last active, resource counts.
- Force-destroy a sandbox.
- Revoke any publication.
- Rotate `PLATFORM_JWT_SECRET` (invalidates all sandbox → `/mcp` JWTs).
- View but not modify private tools (behind a time-boxed
  "impersonation" override with audit log entry).

Admin operations do not bypass registry lookups — they extend them via
a separate code path that is explicit, logged, and reviewable.
