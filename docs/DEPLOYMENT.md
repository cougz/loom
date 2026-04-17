# Deploying loom

loom is designed to deploy via **Cloudflare Workers Builds** — no
GitHub Actions, no external CI runners. Push to `main` on your fork,
Cloudflare builds and deploys.

This document walks through the one-time setup. Plan for about 20
minutes the first time.

---

## Prerequisites

1. **Cloudflare account** with:
   - Workers Paid plan (for Containers and Durable Objects beyond the
     free tier)
   - Browser Rendering enabled (Dashboard → Compute → Browser Rendering)
   - Workers AI available (on all accounts)

2. **Custom domain** in your Cloudflare account with:
   - `loom.yourcompany.com` — main hostname
   - `*.loom.yourcompany.com` — wildcard for sandbox preview URLs
   - (`/view` shares the main hostname, no extra DNS record needed)

3. **Cloudflare Access** set up on your account. Free tier is fine.

4. **GitHub account.** Workers Builds pulls from here.

---

## Step 1 — Fork the repo

Fork `github.com/<owner>/loom` to your own GitHub account or org.
Clone your fork locally:

    git clone git@github.com:<you>/loom.git
    cd loom
    pnpm install

---

## Step 2 — Provision Cloudflare resources

Run the bootstrap script:

    ./scripts/setup

It will:

1. Prompt you to `wrangler login` if needed.
2. Ask for your Cloudflare account ID and hostname.
3. Create:
   - R2 buckets: `loom-workspace-snapshots`, `loom-publications`,
     `loom-tool-attachments`
   - KV namespace: `loom-platform`
   - D1 database: `loom-platform` (runs initial migrations)
4. Print a `wrangler.jsonc` fragment with all the IDs filled in.

Copy the fragment into `apps/web/wrangler.jsonc`, replacing the
`__FILL_ME_FROM_SETUP_SCRIPT__` placeholders. Commit and push.

---

## Step 3 — Configure Cloudflare Access

In the Cloudflare dashboard:

1. **Zero Trust → Access → Applications → Add an application.**
2. Choose **Self-hosted.**
3. **Application domain:** `loom.yourcompany.com` (no path — the whole
   hostname). `/view` is served on the same hostname; the Worker
   short-circuits Access verification for `/view/*` paths in code, so
   no extra Access application is needed.
4. **Session duration:** whatever your team prefers.
5. **Identity providers:** add the IdPs your team uses (Google, Okta,
   GitHub, Azure AD, etc.).
6. **Policies:**
   - Policy 1: "Team access" — Action: Allow, Include: Emails ending
     in `@yourcompany.com` (or a specific SSO group).
   - Policy 2 (optional): "Admins" — Action: Allow, Include: specific
     SSO group. Sets a custom group claim that loom reads to unlock
     `/dash/admin`.
7. Save. Note the **Application AUD tag** from the application's
   overview page.
8. Note your **team domain** (visible in Zero Trust → Settings →
   General, e.g. `yourcompany.cloudflareaccess.com`).

---

## Step 4 — Set Worker secrets

From the repo root:

    wrangler secret put CF_ACCESS_TEAM_DOMAIN   # e.g. yourcompany.cloudflareaccess.com
    wrangler secret put CF_ACCESS_AUD           # the AUD tag from step 3
    wrangler secret put CF_ACCOUNT_ID           # from wrangler whoami
    wrangler secret put CF_API_TOKEN            # see below
    wrangler secret put PLATFORM_JWT_SECRET     # 32+ random bytes

`PLATFORM_JWT_SECRET` — generate with:

    openssl rand -base64 32

`CF_API_TOKEN` — create at **My Profile → API Tokens → Create Token →
Custom Token.** Required permissions (framework-level provisioning
only — this token is never exposed to the agent or the sandbox):

| Scope | Permission |
|---|---|
| Account → Workers R2 Storage | Edit |
| Account → Workers KV Storage | Edit |
| Account → D1 | Edit |
| Account → Workers AI | Read |
| Account → Browser Rendering | Edit |

---

## Step 5 — Wire up Workers Builds

In the Cloudflare dashboard, once you've done a first manual
`pnpm --filter @loom/web deploy` so the Worker exists:

1. **Workers & Pages → your-loom-worker → Settings → Builds → Connect.**
2. Pick GitHub as the provider, authorise Cloudflare on your fork.
3. **Repository:** `github.com/<you>/loom`
4. **Production branch:** `main`
5. **Build command:**

        pnpm install --frozen-lockfile && pnpm --filter @loom/web build

6. **Deploy command:**

        pnpm --filter @loom/web deploy

7. **Root directory:** `/`
8. Save.
9. (Optional) Enable **Preview deployments** for non-main branches if
   you want PRs to get ephemeral URLs.

From now on, every push to `main` builds and deploys automatically.
You can watch progress in the **Builds** tab.

---

## Step 6 — Build and publish the sandbox container

The container image is referenced by `apps/web/wrangler.jsonc`. Build
and push it:

    wrangler containers build -t loom-sandbox:v1 -p .

The Cloudflare Containers platform stores the image. Update
`apps/web/wrangler.jsonc` with the image tag if you change it, then
redeploy the Worker.

---

## Step 7 — Smoke-test

1. Open `https://loom.yourcompany.com/dash` in your browser.
2. Access redirects you to sign in.
3. After sign-in, the placeholder page loads.
4. Once M2 lands, the OpenCode iframe loads from your sandbox.
5. Once M3 lands, `loom-code`, `loom-ai`, `loom-render` are wired
   through the framework endpoints.

If anything fails:

- **401 on `/dash`** — check `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`
  match the Access application.
- **Preview URL doesn't resolve** — wildcard DNS not set, or route
  pattern in `wrangler.jsonc` missing.
- **Container doesn't start** — check `wrangler containers build` ran
  and the image tag in `wrangler.jsonc` matches.
- **`/view/<shortId>` returns 401** — the Worker's `/view/*` bypass
  is broken; `/view` should never require auth.

---

## Updating loom

- Pull upstream into your fork, merge the diff into your `main`.
- Workers Builds picks up the push and deploys.
- Migrations in `PLATFORM_D1` run automatically on first request after
  deploy (see `apps/web/src/server/migrations.ts`).
- No manual steps unless a release note calls them out.

---

## Tearing it down

    ./scripts/teardown

Destroys all loom resources (R2 buckets, KV, D1, Worker, container
image). Prompts for confirmation. Your user data is gone — there is
no undo.
