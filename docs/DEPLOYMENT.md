# Deploying loom

loom deploys via **Cloudflare Workers Builds** — push to `main` on your
fork, Cloudflare builds and deploys automatically. No GitHub Actions,
no external CI runners.

This document walks through the one-time setup. Plan for about 20 minutes.

---

## How config reaches Workers Builds

`apps/web/wrangler.jsonc` in the repo is a **template** — it contains
`__FILL_ME_FROM_SETUP_SCRIPT__` and `__LOOM_HOSTNAME__` placeholders and
is **never modified by tooling**. Deployment-specific values (KV/D1 IDs,
hostname) live in two gitignored files that `./scripts/setup` generates:

| File | Purpose |
|---|---|
| `apps/web/.deploy-env` | Stores `PLATFORM_KV_ID`, `PLATFORM_D1_ID`, `LOOM_HOSTNAME` |
| `apps/web/wrangler.local.jsonc` | Generated from the template + `.deploy-env`; used by `wrangler deploy` |

Neither file is committed. For **Workers Builds** (which does a fresh
checkout), the same three values are set as **environment variables in
the dashboard**. `scripts/gen-wrangler-config` — called automatically by
`pnpm deploy` — generates `wrangler.local.jsonc` from those env vars at
deploy time, so `wrangler deploy` always has a fully resolved config
regardless of whether it's running locally or in CI.

---

## Prerequisites

1. **Cloudflare account** with:
   - Workers Paid plan (for Containers and Durable Objects)
   - Browser Rendering enabled (Dashboard → Compute → Browser Rendering)
   - Workers AI available (included on all accounts)

2. **Custom domain** in your Cloudflare account:
   - `loom.yourcompany.com` — main hostname
   - `*.loom.yourcompany.com` — wildcard for sandbox preview URLs

3. **Cloudflare Access** configured on your account. Free tier is fine.

4. **GitHub account** — Workers Builds pulls from here.

---

## Step 1 — Fork and clone

Fork `github.com/<owner>/loom` to your own GitHub account or org, then:

    git clone git@github.com:<you>/loom.git
    cd loom

---

## Step 2 — Configure Cloudflare Access

Before running setup you need the Access AUD tag.

1. **Zero Trust → Access → Applications → Add → Self-hosted.**
2. **Application domain:** `loom.yourcompany.com` (no path suffix).
   `/view` is on the same hostname; the Worker short-circuits Access
   verification for `/view/*` in code, so no separate application is
   needed.
3. **Identity providers:** add the IdPs your team uses (Google, Okta,
   GitHub, Azure AD, etc.).
4. **Policies:** allow your team by email domain or SSO group.
5. Save. Note the **Application AUD tag** from the overview page.
6. Note your **team domain** (Zero Trust → Settings → General,
   e.g. `yourcompany.cloudflareaccess.com`).

---

## Step 3 — Run setup

    ./scripts/setup

The script will prompt for:

| Prompt | Where to find it |
|---|---|
| Hostname | e.g. `loom.yourcompany.com` |
| Access team domain | Zero Trust → Settings → General |
| Access AUD tag | Zero Trust → Access → your app → Overview |
| Account ID | `wrangler whoami` |
| API token | See below |

**API token** — create at My Profile → API Tokens → Create Token →
Custom Token with these permissions:

| Scope | Permission |
|---|---|
| Account → Workers R2 Storage | Edit |
| Account → Workers KV Storage | Edit |
| Account → D1 | Edit |
| Account → Workers AI | Read |
| Account → Browser Rendering | Edit |

The script will:

1. Create R2 buckets: `loom-workspace-snapshots`, `loom-publications`,
   `loom-tool-attachments`
2. Create KV namespace: `loom-platform`
3. Create D1 database: `loom-platform`
4. Set all five Worker secrets (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`,
   `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `PLATFORM_JWT_SECRET`)
5. Write `apps/web/.deploy-env` (gitignored) with the resource IDs and
   hostname
6. Generate `apps/web/wrangler.local.jsonc` (gitignored) from the
   template

At the end it prints the three values you will need for Workers Builds
environment variables in Step 5.

---

## Step 4 — First manual deploy

Workers Builds requires the Worker to exist before you can connect it.
Do this once:

    pnpm --filter @loom/web build && pnpm --filter @loom/web run deploy

This builds the Worker bundle into `dist/client`, then calls
`scripts/gen-wrangler-config` (reads `apps/web/.deploy-env` → generates
`wrangler.local.jsonc`) and deploys. Nothing is committed to git.

---

## Step 5 — Build the container image

    wrangler containers build -t loom-sandbox:v1 -p .

This builds the Dockerfile from the repo root and registers the image
with Cloudflare's container registry. Run this again any time the
Dockerfile changes.

---

## Step 6 — Wire up Workers Builds

Workers & Pages → `loom` → Settings → Builds → **Connect**:

| Field | Value |
|---|---|
| Repository | `github.com/<you>/loom` |
| Production branch | `main` |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @loom/web build` |
| Deploy command | `pnpm --filter @loom/web run deploy` |
| Root directory | `/` |

**Environment variables** — Workers Builds does a fresh checkout with
no `apps/web/.deploy-env`, so `scripts/gen-wrangler-config` reads these
from the CI environment instead. Copy the values printed at the end of
`./scripts/setup`:

| Variable | Value |
|---|---|
| `PLATFORM_KV_ID` | KV namespace ID |
| `PLATFORM_D1_ID` | D1 database ID |
| `LOOM_HOSTNAME` | e.g. `loom.yourcompany.com` |

With these set, every push to `main` generates a fresh `wrangler.local.jsonc`
at deploy time and deploys with the correct bindings — without any
deployment-specific data ever touching the git history.

---

## Step 7 — Smoke-test

1. Open `https://loom.yourcompany.com/dash`.
2. Cloudflare Access redirects you to sign in.
3. After sign-in, the dash chrome loads with the OpenCode iframe. The
   first load takes ~30 seconds while the container boots.
4. Subsequent loads are instant (container stays warm via `keepAlive`).

If anything fails:

| Symptom | Likely cause |
|---|---|
| Redirect loop on `/dash` | `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` secret doesn't match the Access application |
| OpenCode iframe blank / error | Container image not built yet — run Step 5 |
| Preview URL (`*.loom.yourcompany.com`) 404 | Wildcard DNS not set, or `LOOM_HOSTNAME` env var wrong in Workers Builds |
| `/view/<shortId>` returns 401 | `/view/*` Access bypass is broken — should never require auth |
| Deploy fails with "placeholder" in config | `PLATFORM_KV_ID` / `PLATFORM_D1_ID` / `LOOM_HOSTNAME` not set in Workers Builds env vars |

---

## Updating loom

Pull upstream into your fork and push:

    git fetch upstream
    git merge upstream/main
    git push

Workers Builds picks up the push and deploys. No manual steps unless a
release note calls them out.

---

## Local development

Run `wrangler dev` against your real Cloudflare resources:

    pnpm dev

This uses `apps/web/wrangler.local.jsonc` (generated by setup) so your
local dev Worker has access to the real KV, D1, and R2 bindings.

For auth, `wrangler dev` sets `CF_ACCESS_TEAM_DOMAIN` to empty by
default (via `.dev.vars`), which puts the Worker in dev mode: any
request without a valid Access JWT falls back to a mock context
(`userId: devuser1234567890123`, `email: dev@localhost`).

To test with real Access JWTs locally, add to `.dev.vars`:

    CF_ACCESS_TEAM_DOMAIN=yourcompany.cloudflareaccess.com
    CF_ACCESS_AUD=your-access-aud

---

## Tearing it down

    ./scripts/teardown

Destroys all loom resources (R2 buckets, KV, D1, Worker, container
image). Prompts for confirmation. Your user data is gone — there is
no undo.
