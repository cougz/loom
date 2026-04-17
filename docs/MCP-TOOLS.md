# loom MCP tool catalog

The MCP server at `/mcp` is the core product surface. It exposes
Cloudflare primitives as tools callable by OpenCode. This document is
the **contract**: each tool's name, input, output, and behaviour.

Both `/dash` (the UI) and `/mcp` (this endpoint) are behind a single
Cloudflare Access application. Every request is JWT-verified and the
`userId` is extracted from the Access `sub` claim — see `MULTI-TENANCY.md`.

## Conventions

- Tool names use `snake_case`, namespaced by category (`r2_put_object`).
- Inputs are Zod schemas.
- Outputs are `{ ok: true, data: ... }` or `{ ok: false, error: string, code?: string }`.
- Every tool runs server-side in the loom Worker with the user's
  verified `userId`. The Cloudflare API token used for REST calls is
  **loom's**, never the user's — isolation is by resource name prefix
  and the `UserRegistry` DO.
- Every mutation respects the ownership guardrail in `MULTI-TENANCY.md`.

## Resource naming

All user-created resources are prefixed `loom-<userId>-<name>`:

    Worker:        loom-<userId>-<name>
    R2 bucket:     loom-<userId>-<name>
    KV namespace:  loom-<userId>-<name>
    D1 database:   loom-<userId>-<name>

---

## Category: workers

| Tool | Purpose |
|---|---|
| `workers_deploy` | Upload a new Worker to the dispatch namespace (a skill). Static-analysed before deploy. Max 50 KB source. |
| `workers_update` | Replace an existing Worker's source. New version via Workers Versions API. |
| `workers_delete` | Remove a Worker from the namespace. Registry updated. |
| `workers_list` | List skills owned by the current user, from the registry. |
| `workers_invoke_skill` | Call a deployed skill by logical name (`ctx.names.worker(name)`) with arbitrary JSON input. Returns its JSON response. Registry-gated — rejects unknown skills. |

---

## Category: r2

| Tool | Purpose |
|---|---|
| `r2_create_bucket` | Create an R2 bucket owned by the user. |
| `r2_list_buckets` | List user-owned buckets (from registry). |
| `r2_put_object` | Write an object. Body is base64 for binary, string for text. |
| `r2_get_object` | Read an object. Metadata + body. |
| `r2_list_objects` | List objects with optional prefix. |
| `r2_delete_object` | Delete an object. |
| `r2_delete_bucket` | Delete a bucket (must be empty). |

---

## Category: kv

| Tool | Purpose |
|---|---|
| `kv_create_namespace` | Create a KV namespace. Returns its ID. Registered in user registry. |
| `kv_list_namespaces` | List user-owned namespaces. |
| `kv_put` | Write a value. Supports `expirationTtl`. |
| `kv_get` | Read a value. |
| `kv_list` | List keys with prefix + cursor. |
| `kv_delete` | Delete a key. |
| `kv_delete_namespace` | Delete a namespace. |

---

## Category: d1

| Tool | Purpose |
|---|---|
| `d1_create_database` | Create a D1 database. |
| `d1_list_databases` | List user-owned databases. |
| `d1_execute` | Run a statement (INSERT/UPDATE/DDL). |
| `d1_query` | Run a SELECT; returns rows. |
| `d1_batch` | Run multiple statements atomically. |
| `d1_delete_database` | Delete a database. |

---

## Category: ai (Workers AI)

| Tool | Purpose |
|---|---|
| `ai_run` | Run any Workers AI model. Input validated against model schema. |
| `ai_list_models` | List available models with their schemas. |

The Workers AI binding is shared; usage is attributed to `userId` in the
audit log for per-user rate limiting.

---

## Category: browser (Browser Rendering)

| Tool | Purpose |
|---|---|
| `browser_screenshot` | Screenshot a URL. Returns PNG (base64) + metadata. Large outputs go to R2, a URL is returned. |
| `browser_pdf` | Render a URL as PDF. |
| `browser_scrape` | Fetch a URL, return rendered HTML. |
| `browser_extract` | Fetch a URL, return structured extract. |

---

## Category: dns (Cloudflare DNS)

| Tool | Purpose |
|---|---|
| `dns_add_record` | Add a DNS record in a zone, only in zones the operator has configured as permitted. |
| `dns_delete_record` | Remove a record added by this user. |
| `dns_list_records` | List records in a zone. |

Guardrail: `dns_add_record` can only create records that resolve to a
user-owned Worker route or a sandbox preview hostname. Enforced by
checking the record's target against the user's registry.

---

## Category: routes (Worker routes)

| Tool | Purpose |
|---|---|
| `routes_add` | Add a Worker route. Target script must be a user-owned skill. |
| `routes_list` | List user-owned routes. |
| `routes_delete` | Remove a user-owned route. |

---

## Category: view (publishing surface)

See [`VIEW.md`](./VIEW.md) for the full design. Publishing itself is
not an MCP tool — the agent writes files to `.publish/<alias>/` and a
sidecar syncs to R2. These tools are for **control operations** only.

| Tool | Purpose |
|---|---|
| `view_list` | List the user's publications (alias, shortId, URL, mode, size, last request). |
| `view_info` | Details for one publication by alias or shortId, including resolved manifest. |
| `view_rotate` | Rotate the shortId, invalidating the old URL. Returns the new URL. |
| `view_revoke` | Mark a publication revoked. Returns 410 Gone thereafter. |
| `view_unrevoke` | Restore a revoked publication within the 7-day grace window. |
| `view_set_expiry` | Set or clear an expiry timestamp. |
| `view_sync_now` | Force an immediate sync of an alias (bypass the debounce). |

---

## Category: meta

| Tool | Purpose |
|---|---|
| `list_skills` | Alias for `workers_list`, with descriptions + last_called_at. |
| `workspace_snapshot` | Trigger a workspace tarball snapshot to R2 now. |
| `workspace_restore` | Restore the workspace from a named snapshot. |
| `whoami` | Returns the user's `userId` + `email` (from Access JWT). |

---

## Adding a new tool

1. Create `apps/web/src/mcp/tools/<category>/<name>.ts` exporting a tool
   object conforming to `LoomTool` (in `apps/web/src/mcp/types.ts`).
2. Register it in `apps/web/src/mcp/tools/index.ts`.
3. Add a row to this document under the correct category.
4. If the tool needs a new binding, add it to `apps/web/wrangler.jsonc`.
5. Write Vitest cases for input validation + at least one happy + one
   error path, with mocked `ctx`.
6. Update `docs/MULTI-TENANCY.md` if it introduces a new resource type.

---

## Design rules

- **Tenancy first.** Every tool that touches a resource goes through
  the ownership guardrail (`MULTI-TENANCY.md`).
- **Tools are idempotent where possible.**
- **Tools return small, structured outputs.** Large results (images,
  PDFs, query dumps) go to R2; tool returns a URL.
- **Tools fail loudly.** Never return `{ ok: true }` on a partial success.
- **Tools never accept a Cloudflare API token from the caller.** The
  token is loom's, scoped to loom's resources.
- **No tool ever reads another user's `userId`.** `ctx.userId` is the
  only source of truth; tool inputs cannot override it.
