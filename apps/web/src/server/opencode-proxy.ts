/**
 * OpenCode proxy routes.
 *
 *   /opencode/<userId>/...         — API proxy to container port 4096
 *   /opencode-oauth/<userId>/...   — OAuth callback forwarded to the
 *                                    in-container listener bound by
 *                                    OpenCode's `redirectUri`.
 *
 * Both routes require a verified Access JWT whose derived userId matches
 * the path segment. The caller (worker-entry.ts) must perform the auth
 * check before invoking; this module only handles sandbox routing and
 * response streaming.
 *
 * Structure mirrors the reference proxy in let-it-slide
 * (cloudflare/ai-agents/let-it-slide — app/src/server/opencode-proxy.ts),
 * adapted for loom's multi-user tenancy model where the path userId must
 * already be verified against the caller's JWT.
 */

import { getSandbox } from "@cloudflare/sandbox";
import type { UserId } from "./auth.js";
import { matchProxyTarget, OPENCODE_PORT } from "./opencode-proxy-routing.js";
import { NULL_BODY_STATUSES, sanitizedErrorResponse } from "./proxy-utils.js";

const SANDBOX_START_TIMEOUT_MS = 30_000;
const CONTAINER_FETCH_TIMEOUT_MS = 30_000;

const OAUTH_CALLBACK_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

type SandboxNamespace = {
  // biome-ignore lint/suspicious/noExplicitAny: Sandbox DO stub namespace type
  idFromName(name: string): any;
  // biome-ignore lint/suspicious/noExplicitAny: DO stub
  get(id: any): any;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function getErrorLogFields(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? "" };
  }
  return { name: "UnknownError", message: String(error), stack: "" };
}

/**
 * Route and forward a request to the user's sandbox container. Returns null
 * when the URL isn't an OpenCode proxy path; caller falls through.
 *
 * The `verifiedUserId` parameter is the userId derived from the caller's JWT
 * — it must already match the path userId, checked by the caller.
 */
export async function proxyOpenCode(
  request: Request,
  sandboxNamespace: SandboxNamespace,
  verifiedUserId: UserId,
): Promise<Response | null> {
  const url = new URL(request.url);
  const target = matchProxyTarget(url);
  if (!target) return null;

  // Defence in depth — caller should have already checked this.
  if (target.sandboxId !== verifiedUserId) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const sandbox = getSandbox(sandboxNamespace as never, target.sandboxId, {
      keepAlive: true,
      normalizeId: true,
    });
    const isOAuthCallback = url.pathname.startsWith("/opencode-oauth/");

    if (isOAuthCallback) {
      // OAuth callbacks can arrive before the container is warm. Ensure the
      // port is listening so OpenCode's in-process callback listener is up
      // when we forward.
      //
      // NOTE: OAuth callbacks run through this proxy without re-verifying
      // the Access JWT on the query string — OpenCode's OAuth `state`
      // parameter is the CSRF boundary. We still require the outer Access
      // JWT (checked by the caller) to get here.
      await withTimeout(
        sandbox.start(undefined, { portToCheck: OPENCODE_PORT }),
        SANDBOX_START_TIMEOUT_MS,
        "sandbox.start",
      );
    }

    const targetUrl = new URL(target.rest + url.search, `http://localhost:${target.port}`);
    const proxyRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });

    const response = await withTimeout(
      sandbox.containerFetch(proxyRequest, target.port),
      CONTAINER_FETCH_TIMEOUT_MS,
      "sandbox.containerFetch",
    );

    if (NULL_BODY_STATUSES.has(response.status)) {
      const responseHeaders = new Headers(response.headers);
      if (isOAuthCallback && responseHeaders.get("content-type")?.includes("text/html")) {
        responseHeaders.set("content-security-policy", OAUTH_CALLBACK_CSP);
      }
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    // containerFetch returns non-OK (rather than throwing) when the container
    // port isn't listening yet. Surface as 503 so the client retries with
    // backoff instead of seeing a raw proxy error.
    if (!response.ok) {
      const body = await response.text();
      if (body.includes("not listening") || body.includes("Error proxying")) {
        return new Response(
          JSON.stringify({ error: "OpenCode server is starting, please retry" }),
          {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
          },
        );
      }
      return sanitizedErrorResponse(body, response);
    }

    const responseHeaders = new Headers(response.headers);
    if (isOAuthCallback && responseHeaders.get("content-type")?.includes("text/html")) {
      responseHeaders.set("content-security-policy", OAUTH_CALLBACK_CSP);
    }

    // Preserve streaming for SSE — do not buffer the body.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("OpenCode proxy request failed", {
      event: "opencode_proxy_request_failed",
      sandboxId: target.sandboxId,
      pathname: url.pathname,
      targetPort: target.port,
      ...getErrorLogFields(error),
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Proxy error" },
      { status: 502 },
    );
  }
}
