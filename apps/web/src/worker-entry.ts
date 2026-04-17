/**
 * Main Worker entry point.
 *
 * Single deployment hosts:
 *   - /dash/*    — TanStack Start app (Access-gated)
 *   - /mcp       — MCP server (Access-gated)
 *   - /view/*    — Public publishing (no auth)
 *   - *.hostname — Sandbox preview URLs
 *
 * Dispatch order (per SPEC.md Component map):
 *   1. *.hostname → proxyToSandbox()
 *   2. /view/*    → view router (no JWT)
 *   3. /dash/*    → TanStack Start (JWT required)
 *   4. /mcp       → createMcpHandler (JWT or platform)
 */

import { createMcpServerHandler } from "./mcp/server.js";
import { type AuthContext, authenticateRequest, createMockAuthContext } from "./server/auth.js";
import { handleViewRequest } from "./view/router.js";

export type Env = {
  // Durable Objects
  // biome-ignore lint/suspicious/noExplicitAny: DurableObject types
  USER_REGISTRY: DurableObjectNamespace<any>;
  // biome-ignore lint/suspicious/noExplicitAny: DurableObject types
  SANDBOX: DurableObjectNamespace<any>;

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
 * Extract userId from sandbox preview hostname.
 * Format: <token>.<userId-slug>.loom.hostname
 */
// biome-ignore lint/correctness/noUnusedVariables: Used in M2
function extractPreviewToken(
  hostname: string,
  loomHostname: string,
): {
  token: string;
  previewHostname: string;
} | null {
  const suffix = `.${loomHostname}`;
  if (!hostname.endsWith(suffix)) return null;

  const prefix = hostname.slice(0, -suffix.length);
  const parts = prefix.split(".");

  // Need at least: token.previewHostname
  if (parts.length < 2) return null;

  const token = parts[0];
  if (!token) return null;

  const previewHostname = parts.slice(1).join(".");

  return { token, previewHostname };
}

/**
 * Proxy to sandbox for preview URLs.
 * Placeholder for M2.
 */
async function proxyToSandbox(_request: Request, _env: Env): Promise<Response | null> {
  // M2 will implement actual proxy
  // For M1, return null to continue to other handlers
  return null;
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
      // If proxy returns null (M1), fall through to show placeholder
    }

    // 2. /view/* — public, no JWT verification
    if (url.pathname.startsWith("/view/")) {
      return handleViewRequest(request, env);
    }

    // 3. /dash/* — Access-gated, TanStack Start
    if (url.pathname.startsWith("/dash/") || url.pathname === "/dash") {
      try {
        const auth = await getAuthContext(request, env);

        // For M1: return a simple placeholder page
        // In M2+, this will serve the TanStack Start app
        if (url.pathname === "/dash" || url.pathname === "/dash/") {
          return new Response(
            `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>loom</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      background: #0a0a0a;
      color: #e5e5e5;
    }
    h1 {
      color: #f97316;
      font-size: 2rem;
      margin-bottom: 1rem;
    }
    .user-info {
      background: #171717;
      padding: 1rem;
      border-radius: 0.5rem;
      margin-top: 1rem;
    }
    .user-id {
      font-family: monospace;
      color: #a3a3a3;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <h1>loom</h1>
  <p>Hello, ${escapeHtml(auth.email)}</p>
  <div class="user-info">
    <p><strong>User ID:</strong> <span class="user-id">${escapeHtml(auth.userId)}</span></p>
    <p><strong>Status:</strong> M1 milestone — auth + boot complete</p>
  </div>
</body>
</html>`,
            {
              status: 200,
              headers: { "Content-Type": "text/html" },
            },
          );
        }

        // For other /dash/* paths, return placeholder
        return new Response(
          `<!DOCTYPE html>
<html>
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
  <p>User ID: ${escapeHtml(auth.userId)}</p>
  <p><em>Full TanStack Start UI coming in M2+</em></p>
</body>
</html>`,
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          },
        );
      } catch {
        // Auth failed — redirect to Access login page (spec §3.1)
        return Response.redirect(`/cdn-cgi/access/login/${url.hostname}`, 302);
      }
    }

    // 4. /mcp — Access-gated, MCP server
    if (url.pathname === "/mcp") {
      try {
        // Create MCP handler with auth context getter
        const mcpHandler = createMcpServerHandler(getAuthContext);
        return await mcpHandler.fetch(request, env);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "MCP error";
        return new Response(
          JSON.stringify({
            error: "MCP Error",
            message: errorMessage,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // 5. Root path — redirect to /dash
    if (url.pathname === "/" || url.pathname === "") {
      return Response.redirect(`${url.origin}/dash`, 302);
    }

    // 404 for unmatched paths
    return new Response(
      JSON.stringify({
        error: "Not Found",
        message: `Path ${url.pathname} not found`,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
} satisfies ExportedHandler<Env>;
