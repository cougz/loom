# Multi-tenancy in loom

loom is designed to be run by a team for a team. Every resource — files,
databases, KV values, deployed Workers, Durable Objects, preview URLs,
provider keys — belongs to exactly one user. This document is the
**contract** that keeps tenants isolated.

If you are adding a feature or a new MCP tool, you MUST read this file
before opening a PR.

---

## The tenant key

The **tenant key** is the `userId`, a URL-safe slug derived from the
Cloudflare Access JWT `sub` claim.

    accessJwt.sub → sha256 → base32hex(0, 20).toLowerCase()
    → e.g. "7f3c1a2b9d4e5a6b7c8d"

The `sub` claim is stable per-identity-per-Access-application, so
`userId` is stable for a given team member across sessions and devices.
The Access `email` is stored alongside for display only — never used
as an identifier.

Every server-side operation receives `userId` from the request context,
never from the request body. It is derived exclusively from the verified
JWT.

---

## Resource naming

All user-created resources are prefixed `loom-<userId>-<name>`:

| Kind | Name | Example |
|---|---|---|
| Worker (skill) | `loom-<userId>-<name>` | `loom-7f3c1a2b-hn_digest` |
| R2 bucket | `loom-<userId>-<name>` | `loom-7f3c1a2b-assets` |
| KV namespace | `loom-<userId>-<name>` | `loom-7f3c1a2b-cache` |
| D1 database | `loom-<userId>-<name>` | `loom-7f3c1a2b-events` |

The prefix is enforced in `apps/web/src/mcp/lib/names.ts` — tools never
build names by string concatenation, they always call
`ctx.names.worker(name)` and friends.

---

## Shared bindings, partitioned by key

Some bindings are shared by the whole Worker and used for platform-
internal state:

### `WORKSPACE_SNAPSHOTS` (R2 bucket)
Workspace tarballs for all users live here.

    users/<userId>/snapshots/v<N>.tar.gz

Enforce by always constructing keys via `ctx.keys.workspaceSnapshot(userId, version)`.

### `SKILL_SOURCE` (R2 bucket)
Source code of deployed skills, for audit and restore.

    users/<userId>/skills/<name>.mjs

### `PUBLICATIONS` (R2 bucket)
Content served by `/view/<shortId>/...`. See [`VIEW.md`](./VIEW.md).

    publications/<userId>/<shortId>/manifest.json
    publications/<userId>/<shortId>/content/<path>

The `/view` router reads `<userId>` from the `publications` table in
`PLATFORM_D1`, keyed by `<shortId>`. R2 reads are always scoped to the
owning user's path prefix — the shortId alone never grants access to
another user's R2 path.

### `PLATFORM_KV`
Platform-internal KV — rate limits, feature flags, admin cache.

    user:<userId>:ratelimit:<toolCategory>
    user:<userId>:featureflags
    admin:users          (set of known userIds)

### `PLATFORM_D1`
Platform-internal D1. Every table has a `user_id` column. Every query
includes a `WHERE user_id = ?` clause, enforced by a query helper that
takes `userId` as a required parameter.

    resources (user_id, type, name, created_at, metadata)
    audit_log (user_id, actor, action, target, at)
    skill_registry (user_id, name, worker_name, description, input_schema, last_called_at, call_count, created_at)

---

## UserRegistry Durable Object

Per user, keyed by `userId`. Holds the **authoritative** list of
resources the user owns. Every MCP tool that mutates a resource
reads + writes this DO as part of the same logical operation.

    class UserRegistry extends DurableObject {
      // SQLite schema
      //   resources (type TEXT, name TEXT, created_at INTEGER, PRIMARY KEY (type, name))
      //   provider_keys (provider TEXT PRIMARY KEY, encrypted_key BLOB)
      //   session (opencode_port INTEGER, last_active_at INTEGER)

      async registerResource(type: ResourceType, name: string): Promise<void>;
      async isOwned(type: ResourceType, name: string): Promise<boolean>;
      async removeResource(type: ResourceType, name: string): Promise<void>;
      async listResources(type?: ResourceType): Promise<Resource[]>;

      async setProviderKey(provider: string, key: string): Promise<void>;
      async getProviderKey(provider: string): Promise<string | null>;

      async touchSession(): Promise<void>;
    }

Why a DO instead of just `PLATFORM_D1`? Two reasons:

1. **Strong consistency.** A skill-deploy tool wants to register the
   resource and confirm in one atomic step. DOs give us SQLite
   transactions.
2. **Sharded scaling.** Heavy per-user activity (rapid tool calls) stays
   on that user's DO, not on one shared D1 primary.

Platform-wide analytics (cross-user listings for admins) still go to
`PLATFORM_D1`; tools that mutate a user's state write to the DO first,
then async-mirror to `PLATFORM_D1` for the admin surface.

---

## The guardrail pattern

Every MCP tool that operates on an existing resource follows this
pattern:

    export const deleteBucket = defineTool({
      name: "r2_delete_bucket",
      input: z.object({ name: z.string() }),
      async execute({ name }, ctx) {
        const fullName = ctx.names.r2Bucket(name);

        // 1. Refuse if not owned
        if (!(await ctx.userRegistry.isOwned("r2", fullName))) {
          return { ok: false, error: "Bucket not found in your registry.", code: "NOT_OWNED" };
        }

        // 2. Call CF API with the prefixed name
        await ctx.cfApi.r2.deleteBucket(fullName);

        // 3. Update registry
        await ctx.userRegistry.removeResource("r2", fullName);

        return { ok: true, data: { name: fullName } };
      },
    });

For *create* tools, step 1 is skipped, step 3 is
`registerResource(...)`. For *list* tools, steps 2 and 3 are replaced
with a listing from the registry (never from the CF API — registry is
source of truth).

---

## Sandbox isolation

One `Sandbox` DO per user. The DO id is `env.SANDBOX.idFromName(userId)`.
Containers cannot see each other. Filesystem, processes, env vars, and
preview URLs are all scoped to that sandbox.

Preview URLs work across users *because* their hostname encodes the
sandbox ID:

    https://<port>-<sandboxId>-<token>.loom.yourcompany.com

`proxyToSandbox()` routes by hostname, so even if user A guesses user
B's preview URL (they can't — the token is unguessable), the request
never reaches A's sandbox.

---

## Workers for Platforms isolation

User-deployed skills live in a single dispatch namespace
(`loom-skills`). They are deployed as:

    loom-<userId>-<skillName>

The `workers_invoke_skill` tool:

1. Looks up `<skillName>` in the user's registry (→ fully qualified name).
2. Calls `env.DISPATCHER.get("loom-<userId>-<skillName>")`.
3. Invokes the Worker with the user's args.

If the user tries to invoke `workers_invoke_skill({name: "other-user-skill"})`
via a crafted OpenCode prompt, step 1 fails — it's not in the user's
registry, so the tool refuses.

The outbound Worker (`apps/outbound`) tags every egress request with
`x-loom-user-id` for auditability.

---

## Provider keys (BYO)

Each user provides their own Anthropic / OpenAI / Workers AI key
through `/dash/settings`. The key is:

1. Encrypted with a per-user AEAD key derived from `userId + PLATFORM_JWT_SECRET`.
2. Stored in `UserRegistry.provider_keys`.
3. Written into the container's `~/.opencode/opencode.jsonc` at sandbox
   startup, in-process (never leaves the Worker → sandbox boundary
   except through the sandbox API).
4. Never logged. Never included in audit events.

When a user rotates their key, the container is restarted (OpenCode
re-reads config on process start).

---

## Admin role

Members of the Access group `loom-admins` (configurable in Access) get
`/dash/admin`:

- List all users, last active, resource counts.
- Force-destroy a sandbox (incident response).
- Rotate `PLATFORM_JWT_SECRET` (invalidates all sandbox → MCP JWTs).

No admin tool bypasses the ownership check — admins cannot read another
user's R2 objects or D1 rows. Incident response requires a documented
"admin impersonation" log entry and a time-boxed override.

---

## `/view` and multi-tenancy

The `/view` origin is the one deliberately-open surface. It is
public-by-shortId, but tenancy still holds:

- Every shortId maps 1:1 to a `userId` in `PLATFORM_D1.publications`.
- The `/view` router enforces the userId→R2 path mapping on every
  request; a user cannot craft a shortId that reads another user's
  publication (different shortId → different row → different userId).
- Mode B (proxy) publications can only proxy to the publishing user's
  own sandbox. User A can never serve traffic from user B's sandbox.
- Revocation is per-shortId; only the owning user or an admin can
  revoke.
- Audit log records `userId` + `shortId` on every publish / rotate /
  revoke / request.

See [`VIEW.md`](./VIEW.md) for the full attribution story.

---

## What tenants MUST NOT share

- User A cannot read user B's workspace files.
- User A cannot read or list user B's R2 objects, KV values, D1 rows,
  or Workers.
- User A cannot invoke user B's skills.
- User A cannot see user B's provider keys.
- User A cannot access user B's sandbox preview URLs (token-gated).
- User A cannot revoke, rotate, or overwrite user B's publications.
- User A cannot proxy traffic through user B's sandbox via `/view`.

Any violation of the above is a **security bug**. Report via
`SECURITY.md` (once added) or directly to the repo owner.
