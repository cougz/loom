# `/view` — the public publishing path

> An unauthenticated path on the main hostname where the agent can
> publish anything — static files, a running web server, a JSON API, a
> one-shot HTML report, a mini game — and share it via an unguessable
> URL.

`/view` is the one deliberately-open part of loom. `/dash` and `/mcp` are
behind Cloudflare Access; `/view` is not. It's what you use when the
agent has built something and the user wants to *show* it — to a
colleague, a client, the internet.

---

## URL shape

    https://loom.yourcompany.com/view/<shortId>[/<path>]

- Served from the **same hostname** as `/dash` and `/mcp`. One Worker,
  one hostname, no extra DNS config. The Worker short-circuits Access
  verification for any request path beginning with `/view/`.
- `<shortId>` is a 12-character base62 string (~71 bits entropy),
  generated server-side. Unguessable, not enumerable.
- `<path>` is optional and supports arbitrary sub-paths:
  `/view/k9x2mPq4Rs7L` (serves the publication's index),
  `/view/k9x2mPq4Rs7L/styles.css`, `/view/k9x2mPq4Rs7L/api/data.json`.
- No `userId`, `email`, or any other identity is encoded in the URL.

### Same-origin caveat

Because `/view` lives on the main hostname, published HTML runs on the
same origin as `/dash`. That means a malicious published page *could*
read the Cloudflare Access session cookie via `document.cookie` (it is
not `HttpOnly`) and impersonate the victim's `/dash` session.

loom mitigates this with layered defaults (see §Security envelope):

1. **Default strong CSP** on all static `/view` responses:
   `sandbox allow-forms allow-scripts allow-popups;
   default-src 'self'; script-src 'unsafe-inline' 'unsafe-eval';`
   — the `sandbox` directive forces the page into a unique null origin
   at the browser level, blocking cookie access even though the URL is
   same-origin.
2. The agent can **opt into** a less strict CSP when it knows its
   content is trusted (e.g. when publishing its own HTML dashboard).
   This is an explicit, logged operation — the manifest sets
   `trusted: true` and the agent's user identity is attached.
3. `/dash` embeds previews in `<iframe sandbox>` regardless, so a
   preview cannot reach the host page.
4. Admin surface (`/dash/admin`) is gated by a separate Access policy
   group so a compromised Access session cannot trivially escalate.

This is good-enough for a self-hosted team tool where operators trust
their agent + members. If you need hard origin isolation, see
"Configuration for stronger isolation" at the end of this document.

---

## What can be published

Anything. loom does not constrain content type. Two modes cover every
case:

### Mode A — Static bundle

Files served from R2. Works for:

- HTML reports, dashboards, landing pages
- Static JSON endpoints (fixed payloads)
- Images, PDFs, zip archives, downloads
- Single-page applications (client-side routing via wildcard fallback)
- Mini-games (JS + WASM)

The agent drops files in the workspace, a sidecar syncs them to R2,
`/view` serves them with per-file response metadata.

### Mode B — Live proxy

`/view/<shortId>` proxies to a port the agent has started inside the
sandbox. Works for:

- Live-reloading dev servers (`vite dev`, `next dev`)
- Backend APIs written in Node / Python / whatever
- WebSocket services (chat rooms, live dashboards)
- Jupyter-style notebooks
- Anything that wants a real server process

The proxy is bi-directional (requests + responses + upgrades) and
attributes traffic to the publishing user's sandbox only.

Both modes share the same URL shape, revocation, and quota systems.

---

## Publishing — the filesystem convention

The agent publishes by writing to a magic folder in its workspace. A
sidecar watches the folder and syncs to R2.

### Workspace layout

    /home/user/workspace/
    └── .publish/
        ├── <alias>/                  # agent-chosen human name, local only
        │   ├── publication.json      # optional — the manifest
        │   ├── index.html
        │   ├── chart.png
        │   └── api/
        │       └── data.json
        └── <another-alias>/
            └── ...

- Each subdirectory of `.publish/` is **one publication**.
- The agent chooses `<alias>` for its own convenience (e.g. `q4-report`).
  The alias is local to the workspace — it is not the `<shortId>`.
- Writing any file under `.publish/<alias>/` triggers a debounced sync
  (1s) of that alias's contents to R2, under
  `publications/<userId>/<shortId>/...`.
- First sync creates the publication and allocates a `<shortId>`. The
  shortId is written back to the workspace as
  `.publish/<alias>/.loom-shortid` so the agent can read it out.

This convention is the **only** way to publish. There is no HTTP upload,
no manual R2 command — keep the agent's mental model simple: drop
files, get a URL.

### The manifest: `publication.json`

Entirely optional. When absent, every file is served with sensible
defaults (content-type by extension, no extra headers, mode = static).
When present, the manifest is the single source of truth for how the
publication behaves. Everything is open-ended — no allowlist:

    {
      "mode": "static",             // or "proxy"
      "index": "index.html",        // file served for /view/<id>/
      "notFound": "404.html",       // file served for unmatched paths

      "headers": {                  // applied to ALL files unless overridden
        "cache-control": "public, max-age=3600",
        "x-frame-options": "DENY"
      },

      "files": {                    // per-file overrides
        "index.html": {
          "contentType": "text/html; charset=utf-8",
          "headers": {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'"
          }
        },
        "download.zip": {
          "contentType": "application/zip",
          "headers": {
            "content-disposition": "attachment; filename=\"report.zip\""
          }
        },
        "api/data.json": {
          "headers": {
            "access-control-allow-origin": "*"
          }
        },
        "redirect-old.html": {
          "status": 301,
          "headers": { "location": "/view/<id>/" }
        }
      },

      "rewrites": [                 // URL rewriting, in order
        { "from": "^/app/.*$", "to": "/index.html" }   // SPA fallback
      ]
    }

For Mode B (proxy):

    {
      "mode": "proxy",
      "port": 3000,                 // port inside the sandbox
      "pathPrefix": "/"             // what to strip from incoming path
    }

In Mode B the manifest is the *only* content; no other files are served.
The sidecar keeps the container warm while a proxy publication is live.

### Rules loom enforces on headers

- `set-cookie` is **stripped**. Publications are auth-free; no state.
- `host`, `connection`, `content-length`, `content-encoding`, and other
  hop-by-hop headers are never settable by the manifest.
- Everything else the agent can set freely. If the agent wants to
  publish a CSP, a CORS policy, custom caching, an HTTP 418 for a
  gag page, a `Link: <rel=preload>` — it can.

loom's job is to be the delivery pipe. The content inside is the
agent's (and user's) problem.

---

## How `/view` routing works

Request arrives at `loom.yourcompany.com/view/<shortId>/<path>`. The
Worker dispatches in this **strict order**:

1. If hostname matches `*.loom.yourcompany.com` (sandbox preview) →
   `proxyToSandbox()`.
2. If path begins with `/view/` → **skip Access verification** and
   route to the view handler (see below). This short-circuit happens
   before any JWT check.
3. Otherwise → verify Access JWT, then route `/dash` or `/mcp`.

Inside the view handler:

1. Parse `<shortId>`; reject malformed with 404.
2. Look up the publication in `PLATFORM_D1.publications`:
   - If absent → 404.
   - If `revoked_at IS NOT NULL` → 410 Gone.
   - If `expires_at < now()` → 410 Gone.
3. Load the manifest (cached in `PLATFORM_KV` for 60s).
4. Dispatch:
   - Mode A: resolve `<path>` against the manifest's `files`/`rewrites`
     rules, fetch from R2 at `publications/<userId>/<shortId>/<path>`,
     apply headers + default CSP, return.
   - Mode B: call a `proxyToSandbox`-style helper that targets the
     publishing user's sandbox + configured port. Streams request and
     response, including WebSocket upgrades. Same CSP defaults apply.

The Access short-circuit at step 2 is the one place the Worker
intentionally bypasses JWT verification. It MUST be kept narrow:
exactly the path prefix `/view/`, no other conditions.

---

## Security envelope

### Same-origin + sandboxed CSP
- `/view/*` is served from the main hostname. This means published
  HTML is same-origin with `/dash` and could, in the absence of other
  controls, read Access session cookies or make authenticated requests
  to `/mcp`.
- loom's default response headers on `/view` static content include a
  **sandbox CSP** directive:

      Content-Security-Policy: sandbox allow-forms allow-scripts allow-popups;
        default-src 'self';
        img-src 'self' https: data:;
        style-src 'self' 'unsafe-inline';
        script-src 'self' 'unsafe-inline';

  The `sandbox` directive moves the document into a unique opaque
  origin at render time — the page cannot read cookies, localStorage,
  or IndexedDB for `loom.yourcompany.com`, and its fetches are treated
  as cross-origin.
- The agent can opt out of sandboxing by setting `trusted: true` in
  the manifest. This is logged to the audit trail with the publishing
  `userId`. Use for the agent's own HTML reports where you need full
  page capabilities (service workers, permissions, etc.).
- Proxy-mode publications inherit the same default CSP unless the
  upstream sets its own; the Worker never overrides an upstream CSP.

### Auth
- `/view/*` is unauthenticated. That is intentional and non-negotiable.
- The `shortId`'s entropy (~71 bits) is the access control. Treat it
  like a bearer token in the URL — if someone has it, they have access.
- The publishing user can rotate the shortId at any time
  (`view_rotate(alias)`), invalidating the old URL.

### Revocation
- `view_revoke(alias)` sets `revoked_at = now()`.
- Revoked publications return **410 Gone** immediately. The R2 data
  is retained for 7 days (so the user can restore if revoked by
  mistake) then deleted.
- Admin role (`loom-admins` group in Access) can revoke any
  publication via `/dash/admin`.

### Attribution and abuse
- Every publish, rotate, revoke, and request is logged to the audit
  trail with `userId`, `shortId`, timestamp, user-agent, IP.
- Rate limits per user: max concurrent publications, max size per
  publication, max requests per minute per publication. Values in
  `PLATFORM_KV:config:view_limits`, admin-configurable.
- Abuse reports: there will be a `/view/<shortId>/.well-known/report`
  endpoint (post-M9) that lets a viewer flag content; the flag becomes
  visible to admins.

### Content-Security-Policy default
- Mode A publications have a default CSP if the manifest doesn't set
  one: `default-src 'self'; img-src 'self' https: data:;
  script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';`
- The agent can override per-file in the manifest. We default to a
  reasonable CSP, not a maximally-locked one, because the goal is
  *flexibility for the agent*. The origin separation is the real
  boundary.

### Storage quotas (default, tunable)
- Per publication: 100 MB total, 10,000 files.
- Per user: 20 concurrent publications, 2 GB aggregate.
- Per Mode B publication: 4 concurrent WebSocket connections, 1 MB/s
  bandwidth.
- Hitting a limit returns 507 Insufficient Storage on publish, the
  manifest is rejected, and the sidecar surfaces the error in the
  workspace at `.publish/<alias>/.loom-error`.

---

## MCP tools

`/view` is primarily filesystem-driven, but the MCP tool category
exists to expose control operations to OpenCode:

| Tool | Purpose |
|---|---|
| `view_list` | List the current user's publications (alias, shortId, URL, mode, size, created, last-seen request). |
| `view_info` | Details for one publication by alias or shortId. |
| `view_rotate` | Rotate the shortId, invalidating the old URL. Returns the new URL. |
| `view_revoke` | Revoke a publication. 410 thereafter. |
| `view_unrevoke` | Restore a revoked publication within the 7-day grace window. |
| `view_set_expiry` | Set / clear an expiry timestamp. |
| `view_sync_now` | Force an immediate sync of an alias (bypass the 1s debounce). |

Publishing itself is not an MCP tool. It happens via the filesystem
convention, which aligns with OpenCode's native shape (it edits files).

---

## The sidecar

A small process inside the sandbox container watches
`/home/user/workspace/.publish/`. On change:

1. Debounce 1s per alias.
2. Validate manifest (if present) against a JSON schema.
3. Reject if the publication would exceed quotas.
4. Hash each file; compare to last sync; upload diffs to R2.
5. Update `PLATFORM_D1.publications` row with the new manifest + size.
6. Bust the `PLATFORM_KV` manifest cache.
7. Write `.loom-shortid` and a friendly `.loom-url` back to the alias
   directory.

The sidecar binary is part of the container image (`apps/web/src/sandbox-app/loom-publish-sidecar`, Rust or Go for static binary size). It authenticates to loom via the platform JWT the Worker minted at
sandbox spawn.

### Why filesystem convention over an MCP tool for publishing?

You asked for the filesystem shape specifically. It has real advantages:

- OpenCode is already great at editing files; no new tool to learn.
- Natural for multi-file publications (drop a whole directory).
- Watch-mode is the right UX for live-updating publications.
- MCP tool calls would round-trip every file; debounced sync is cheaper.

MCP tools stay for **control operations** (list, rotate, revoke) where
"write a file" doesn't fit.

---

## Storage layout

### R2 bucket: `loom-publications`

    publications/<userId>/<shortId>/
        manifest.json          (current manifest, server-rendered after defaults)
        content/<path>         (actual files as published)

### `PLATFORM_D1.publications` table

    CREATE TABLE publications (
      short_id        TEXT PRIMARY KEY,       -- 12-char base62
      user_id         TEXT NOT NULL,          -- owner
      alias           TEXT NOT NULL,          -- workspace-local name
      mode            TEXT NOT NULL,          -- 'static' | 'proxy'
      size_bytes      INTEGER NOT NULL,
      file_count      INTEGER NOT NULL,
      proxy_port      INTEGER,                -- Mode B only
      manifest_json   TEXT NOT NULL,          -- resolved manifest
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      expires_at      INTEGER,                -- NULL = no expiry
      revoked_at      INTEGER,                -- NULL = not revoked
      UNIQUE (user_id, alias)                 -- alias unique per user
    );

### `PLATFORM_KV`

    view:manifest:<shortId>     → manifest JSON (60s TTL, cache layer)
    view:ratelimit:<shortId>    → token bucket (requests/min)
    config:view_limits          → admin-tunable quotas

---

## Operator configuration

No new DNS or Access setup on top of the base deployment — `/view` is
a path on the main hostname.

### `wrangler.jsonc` routes

Unchanged from the base. The same two routes cover `/view`:

    "routes": [
      { "pattern": "loom.yourcompany.com/*",    "zone_name": "..." },
      { "pattern": "*.loom.yourcompany.com/*",  "zone_name": "..." }
    ]

### R2 bucket

    wrangler r2 bucket create loom-publications

Bound as `PUBLICATIONS` in the Worker.

### Cloudflare Access

Configure the Access application to cover `loom.yourcompany.com` as
before. The Worker bypasses JWT verification for `/view/*` paths in
code — see §How routing works. Access's own rules will still be
bypassable for `/view` because the Worker short-circuits before
checking them; this is intentional.

**Important:** if you add Access Bypass rules at the Cloudflare edge
(in the Access app's policy UI) to allow `/view/*` without a session,
do NOT rely on those alone — Access bypass rules at the edge can be
subtly mis-configured. The Worker's in-code short-circuit is the
source of truth.

### Secrets

No new secrets; the existing `PLATFORM_JWT_SECRET` signs the sidecar's
Worker-bound tokens.

### Configuration for stronger isolation (optional)

If you want true origin isolation (the previous design), set the
`LOOM_VIEW_HOSTNAME` var in `wrangler.jsonc` to a separate hostname
(e.g. `view.loom.yourcompany.com`), add a DNS record + route for it,
and keep it out of Access. The view router checks `LOOM_VIEW_HOSTNAME`
at runtime: when set and the request hostname matches, it skips the
same-origin CSP sandbox and serves content as-is. When unset (the
default), it serves from the main hostname with the sandbox CSP on.

---

## `/dash/views` — the user's publications page

Authenticated surface on the main origin for managing your own
publications:

- List of publications (alias, URL with copy button, mode, size,
  created, last request).
- Per-row actions: **Copy URL**, **Rotate**, **Revoke**, **View logs**.
- Quota usage meter.
- Empty state: a docs snippet showing the filesystem convention.

This view reads from `PLATFORM_D1` filtered by `userId` — same rules
as every other per-user surface.

---

## Open questions

1. **Domain aliasing.** Should a user be able to attach a custom
   domain to a publication (e.g. `promo.theirsite.com` →
   `/view/<id>/`)? Proposal: yes in M9, via a `view_set_domain` tool
   that adds a DNS record and a Worker route — gated by zone ownership
   checks.
2. **Password-protect a view.** If the shortId is leaked, the only
   remedy is rotation. Should we support optional HTTP Basic Auth per
   publication? Proposal: yes, via `view_set_password`, stored hashed
   in the manifest. Post-M9.
3. **Analytics.** Should publishers see viewer counts / geo / referrer?
   Proposal: yes, aggregated in Workers Analytics Engine, surfaced in
   `/dash/views`. Post-M9.
4. **Signed URLs for short-lived access.** For one-time share links
   with automatic expiry — useful if you want to send a publication to
   a client for 24 hours. Proposal: `view_sign_url({alias, ttl})`
   returning a URL with a signed query param.
5. **Embedding elsewhere.** Do we set `X-Frame-Options: DENY` by
   default, or allow embedding? Proposal: default to `SAMEORIGIN`
   (blocks most embedding), let the manifest override.
