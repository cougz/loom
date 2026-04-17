/**
 * Main Worker entry point.
 *
 * Single deployment hosts:
 *   - /dash/*                      — Dash chrome (Access-gated)
 *   - /opencode-ui/*               — Static OpenCode mount bundle (no JWT)
 *   - /opencode/<userId>/*         — OpenCode API proxy (Access-gated)
 *   - /opencode-oauth/<userId>/*   — OpenCode OAuth callback proxy (Access-gated)
 *   - /mcp                         — MCP server (Access or platform JWT)
 *   - /view/*                      — Public publishing (no auth)
 *   - *.hostname                   — Sandbox preview URLs (SDK routing)
 *
 * Dispatch order:
 *   1. *.hostname                → proxyToSandbox()       (SDK — token in hostname)
 *   2. /view/*                   → view router            (no JWT)
 *   3. /opencode-ui/*            → ASSETS                 (no JWT)
 *   4. /opencode/<userId>/*,
 *      /opencode-oauth/<userId>/* → proxyOpenCode()       (Access JWT required)
 *   5. /dash/*                   → dash chrome HTML       (Access JWT required)
 *   6. /mcp                      → MCP handler            (Access or platform JWT)
 */

import { proxyToSandbox as sdkProxyToSandbox } from "@cloudflare/sandbox";
import type { Sandbox as SandboxDO } from "./durable-objects/index.js";
import { createMcpServerHandler } from "./mcp/server.js";
import { type AuthContext, authenticateRequest, createMockAuthContext } from "./server/auth.js";
import { proxyOpenCode } from "./server/opencode-proxy.js";
import { handleViewRequest } from "./view/router.js";

export type Env = {
  // Durable Objects
  // biome-ignore lint/suspicious/noExplicitAny: DurableObject types
  USER_REGISTRY: DurableObjectNamespace<any>;
  SANDBOX: DurableObjectNamespace<SandboxDO>;

  // Bindings
  PLATFORM_KV: KVNamespace;
  PLATFORM_D1: D1Database;
  WORKSPACE_SNAPSHOTS: R2Bucket;
  PUBLICATIONS: R2Bucket;
  TOOL_ATTACHMENTS: R2Bucket;
  AI: Ai;
  BROWSER: Fetcher;
  LOADER: Fetcher;
  ASSETS: Fetcher;

  // Secrets
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  PLATFORM_JWT_SECRET?: string;

  // Vars
  SANDBOX_TRANSPORT: string;
  LOOM_HOSTNAME: string;
};

// Re-export Durable Objects for wrangler.jsonc
export { Sandbox, UserRegistry } from "./durable-objects/index.js";

/**
 * Get the hostname from a request, handling x-forwarded-host if present.
 */
function getHostname(request: Request): string {
  return request.headers.get("x-forwarded-host") || new URL(request.url).hostname;
}

/**
 * Check if this is a sandbox preview URL (*.loom.hostname).
 */
function isSandboxPreview(hostname: string, loomHostname: string): boolean {
  const suffix = `.${loomHostname}`;
  return hostname.endsWith(suffix) && hostname !== loomHostname;
}

/**
 * Proxy requests from *.loom.hostname/* to the user's sandbox container.
 * The SDK's proxyToSandbox extracts the sandbox ID from the hostname token
 * and routes the request to the correct container instance.
 */
async function proxyToSandbox(request: Request, env: Env): Promise<Response | null> {
  // SDK expects { Sandbox: DurableObjectNamespace } — our binding is SANDBOX
  return sdkProxyToSandbox(request, { Sandbox: env.SANDBOX });
}

/**
 * Escape a string for safe HTML insertion.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Get auth context for a request.
 * Dev mode is determined solely by the absence of CF_ACCESS_TEAM_DOMAIN.
 * Never trust a request header to enable dev mode.
 */
async function getAuthContext(request: Request, env: Env): Promise<AuthContext> {
  // Dev mode: CF_ACCESS_TEAM_DOMAIN unset (local wrangler dev only)
  const isDevMode = !env.CF_ACCESS_TEAM_DOMAIN;

  if (isDevMode) {
    // Try to authenticate, but fall back to mock if it fails
    try {
      return await authenticateRequest(request, env);
    } catch {
      return createMockAuthContext();
    }
  }

  return authenticateRequest(request, env);
}

/**
 * Main fetch handler.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = getHostname(request);
    const loomHostname = env.LOOM_HOSTNAME;

    // 1. Sandbox preview URLs first (*.loom.hostname)
    if (isSandboxPreview(hostname, loomHostname)) {
      const proxyResponse = await proxyToSandbox(request, env);
      if (proxyResponse) {
        return proxyResponse;
      }
      // proxyToSandbox returned null — sandbox not yet provisioned or no
      // matching route; fall through to 404 below.
    }

    // 2. /view/* — public, no JWT verification
    if (url.pathname.startsWith("/view/")) {
      return handleViewRequest(request, env);
    }

    // 3. /opencode-ui/* — static mount bundle served as Worker assets.
    // No JWT: the bundle is static JS/CSS/HTML, safe to expose publicly.
    // Access gating for the *iframe parent* is enforced by /dash.
    if (url.pathname.startsWith("/opencode-ui/")) {
      return env.ASSETS.fetch(request);
    }

    // 4. /opencode/<userId>/* + /opencode-oauth/<userId>/*
    //    Both require a verified Access JWT whose derived userId matches the
    //    path segment. The OAuth callback is still behind Access — OpenCode's
    //    own `state` parameter is the CSRF boundary on top of that.
    if (url.pathname.startsWith("/opencode/") || url.pathname.startsWith("/opencode-oauth/")) {
      try {
        const auth = await getAuthContext(request, env);

        // Extract the first path segment (sandboxId from URL)
        const prefix = url.pathname.startsWith("/opencode-oauth/")
          ? "/opencode-oauth/"
          : "/opencode/";
        const rest = url.pathname.slice(prefix.length);
        const slash = rest.indexOf("/");
        const sandboxId = slash === -1 ? rest : rest.slice(0, slash);

        if (sandboxId !== auth.userId) {
          return new Response("Forbidden", { status: 403 });
        }

        const proxied = await proxyOpenCode(request, env.SANDBOX, auth.userId);
        if (proxied) return proxied;
        // Shouldn't happen given the path-prefix check above, but be explicit.
        return new Response("Not Found", { status: 404 });
      } catch (err) {
        // Auth failed for /opencode/* — return 401 rather than redirecting
        // to the Access login, because these paths are called by XHR/fetch
        // from the embedded iframe, not navigated to directly.
        const message = err instanceof Error ? err.message : String(err);
        console.error("[/opencode] auth error:", message);
        return new Response(JSON.stringify({ error: "Unauthorized", message }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 5. /dash/* — Dash chrome (Access-gated)
    if (url.pathname.startsWith("/dash/") || url.pathname === "/dash") {
      try {
        const auth = await getAuthContext(request, env);

        // Dash chrome: full-height iframe of the pre-built OpenCode mount
        // bundle. The iframe loads `/opencode-ui/embed.html?serverUrl=...`
        // which imports the bundle and points all API calls through
        // `/opencode/<userId>/...` — proxied to the container by the handler
        // above. The Worker does not start OpenCode here; it starts lazily
        // on the first API call.
        if (url.pathname === "/dash" || url.pathname === "/dash/") {
          const ocServerUrl = `${url.origin}/opencode/${auth.userId}`;
          const iframeSrc =
            `/opencode-ui/embed.html?serverUrl=${encodeURIComponent(ocServerUrl)}` +
            `&directory=${encodeURIComponent("/home/user/workspace")}`;

          return new Response(
            `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>loom</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.5rem 1rem;
      background: #111;
      border-bottom: 1px solid #222;
      height: 2.5rem;
      flex-shrink: 0;
    }
    header h1 {
      margin: 0;
      font-size: 1rem;
      color: #f97316;
      letter-spacing: 0.05em;
    }
    header .email {
      margin-left: auto;
      font-size: 0.75rem;
      color: #737373;
    }
    .frame-wrap {
      position: absolute;
      inset: 2.5rem 0 0 0;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
  </style>
</head>
<body>
  <header>
    <h1>loom</h1>
    <span class="email">${escapeHtml(auth.email)}</span>
  </header>
  <div class="frame-wrap">
    <iframe
      src="${escapeHtml(iframeSrc)}"
      title="OpenCode"
      allow="clipboard-read; clipboard-write"
    ></iframe>
  </div>
</body>
</html>`,
            {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            },
          );
        }

        // Other /dash/* paths — placeholder until TanStack Start lands in M4+
        return new Response(
          `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>loom — ${escapeHtml(url.pathname)}</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      background: #0a0a0a;
      color: #e5e5e5;
    }
    h1 { color: #f97316; }
  </style>
</head>
<body>
  <h1>loom</h1>
  <p>Path: ${escapeHtml(url.pathname)}</p>
  <p>Hello, ${escapeHtml(auth.email)}</p>
  <p><em>Full TanStack Start UI coming in M4+</em></p>
</body>
</html>`,
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      } catch {
        // Auth failed — redirect to Access login page (spec §3.1)
        return Response.redirect(
          `https://${url.hostname}/cdn-cgi/access/login/${url.hostname}`,
          302,
        );
      }
    }

    // 6. /mcp — Access or platform JWT, MCP server
    if (url.pathname === "/mcp") {
      try {
        const mcpHandler = createMcpServerHandler(getAuthContext);
        return await mcpHandler.fetch(request, env);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "MCP error";
        return new Response(JSON.stringify({ error: "MCP Error", message: errorMessage }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 7. Root path — redirect to /dash
    if (url.pathname === "/" || url.pathname === "") {
      return Response.redirect(`${url.origin}/dash`, 302);
    }

    // 404 for unmatched paths
    return new Response(
      JSON.stringify({ error: "Not Found", message: `Path ${url.pathname} not found` }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
} satisfies ExportedHandler<Env>;
