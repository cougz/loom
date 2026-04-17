/**
 * Main Worker entry point.
 *
 * Single deployment hosts:
 *   - /dash/*    — Dash chrome (Access-gated); /dash/oc/* proxied to OpenCode
 *   - /mcp       — MCP server (Access-gated)
 *   - /view/*    — Public publishing (no auth)
 *   - *.hostname — Sandbox preview URLs (SDK handles routing)
 *
 * Dispatch order (per SPEC.md Component map):
 *   1. *.hostname → proxyToSandbox()    (SDK — preview URL token in hostname)
 *   2. /view/*    → view router          (no JWT)
 *   3. /dash/oc/* → proxyOcRequest()    (JWT required — OpenCode web UI proxy)
 *   4. /dash/*    → dash chrome HTML    (JWT required)
 *   5. /mcp       → MCP handler         (JWT required)
 */

import { getSandbox, proxyToSandbox as sdkProxyToSandbox } from "@cloudflare/sandbox";
import { createOpencodeServer, proxyToOpencodeServer } from "@cloudflare/sandbox/opencode";
import type { Sandbox as SandboxDO } from "./durable-objects/index.js";
import { createMcpServerHandler } from "./mcp/server.js";
import { type AuthContext, authenticateRequest, createMockAuthContext } from "./server/auth.js";
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
 * Proxy requests to /dash/oc/* to the user's OpenCode instance.
 *
 * - Starts OpenCode inside the container if not already running.
 * - For initial HTML GET requests (no ?url=), redirects to inject
 *   ?url=<origin>/dash/oc so OpenCode's frontend routes API calls
 *   through our proxy path instead of directly to localhost:4096.
 * - All subsequent requests strip /dash/oc and are forwarded verbatim
 *   to port 4096 inside the container.
 */
async function proxyOcRequest(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const sandbox = getSandbox(env.SANDBOX, auth.userId, {
    keepAlive: true,
    normalizeId: true,
  });

  const server = await createOpencodeServer(sandbox, {
    directory: "/home/user/workspace",
  });

  const url = new URL(request.url);
  const accept = request.headers.get("accept") ?? "";

  // For HTML GET requests without ?url=, redirect to inject the proxy base URL.
  // OpenCode's frontend uses ?url= as the base for all API calls; pointing it
  // to /dash/oc ensures every call passes through this proxy handler.
  if (
    request.method === "GET" &&
    !url.searchParams.has("url") &&
    (accept.includes("text/html") || url.pathname === "/dash/oc" || url.pathname === "/dash/oc/")
  ) {
    url.searchParams.set("url", `${url.origin}/dash/oc`);
    return Response.redirect(url.toString(), 302);
  }

  // Strip the /dash/oc prefix before forwarding to the container.
  // OpenCode serves at its root; it has no knowledge of our proxy prefix.
  url.pathname = url.pathname.replace(/^\/dash\/oc/, "") || "/";
  const rewritten = new Request(url.toString(), {
    method: request.method,
    headers: new Headers(request.headers),
    body: request.body,
    redirect: "manual",
  });

  return proxyToOpencodeServer(rewritten, sandbox, server);
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

    // 3. /dash/oc/* — OpenCode web UI proxy (JWT required)
    // Must be checked before the generic /dash/* handler below.
    if (url.pathname.startsWith("/dash/oc/") || url.pathname === "/dash/oc") {
      try {
        const auth = await getAuthContext(request, env);
        return await proxyOcRequest(request, env, auth);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? (err.stack ?? "") : "";
        console.error("[/dash/oc] error:", message, stack);
        return new Response(`[loom] /dash/oc error: ${message}\n\n${stack}`, {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    // 4. /dash/* — Dash chrome (Access-gated)
    if (url.pathname.startsWith("/dash/") || url.pathname === "/dash") {
      try {
        const auth = await getAuthContext(request, env);

        // Dash chrome: full-height iframe of the OpenCode web UI.
        // The ?url= parameter is pre-set so OpenCode's frontend routes all
        // API calls through /dash/oc (our proxy prefix) from the first load.
        if (url.pathname === "/dash" || url.pathname === "/dash/") {
          const ocBase = `${url.origin}/dash/oc`;
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
      src="/dash/oc/?url=${encodeURIComponent(ocBase)}"
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

        // Other /dash/* paths — placeholder until TanStack Start lands in M2+
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
  <p><em>Full TanStack Start UI coming in M3+</em></p>
</body>
</html>`,
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      } catch {
        // Auth failed — redirect to Access login page (spec §3.1)
        return Response.redirect(`/cdn-cgi/access/login/${url.hostname}`, 302);
      }
    }

    // 5. /mcp — Access-gated, MCP server
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

    // 6. Root path — redirect to /dash
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
