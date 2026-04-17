/**
 * /view/* router — public publishing surface.
 *
 * Deliberately unauthenticated. Access control via shortId entropy.
 * Full implementation lands in M6; M1 stub returns 404.
 */

// View router environment type (subset of full Env)
type ViewEnv = {
  USER_REGISTRY: DurableObjectNamespace<unknown>;
  PLATFORM_KV: KVNamespace;
  PLATFORM_D1: D1Database;
  PUBLICATIONS: R2Bucket;
};

/**
 * Handle /view/* requests.
 * Stub for M1: returns 404 Not Found.
 */
export async function handleViewRequest(request: Request, _env: ViewEnv): Promise<Response> {
  // Parse shortId from path
  const url = new URL(request.url);
  const pathMatch = url.pathname.match(/^\/view\/([^/]+)(?:\/.*)?$/);

  if (!pathMatch) {
    return new Response("Invalid view path", { status: 400 });
  }

  const shortId = pathMatch[1];

  // M1 stub: return 404
  return new Response(
    JSON.stringify({
      error: "Not Found",
      message: "/view publishing not yet implemented (M6)",
      shortId,
    }),
    {
      status: 404,
      headers: { "Content-Type": "application/json" },
    },
  );
}
