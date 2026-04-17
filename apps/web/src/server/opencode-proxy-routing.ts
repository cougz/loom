/**
 * Pure routing helpers for /opencode and /opencode-oauth.
 *
 * Split out of opencode-proxy.ts so it can be unit-tested without pulling in
 * @cloudflare/sandbox, which has a native container dep that trips up plain
 * Node test runners.
 */

export const OPENCODE_PORT = 4096;

export type ProxyTarget = {
  port: number;
  sandboxId: string;
  rest: string;
};

/**
 * OpenCode's OAuth callback listener binds to the redirectUri port, which is
 * the public hostname port (443 in prod, request port in local dev).
 */
export function getOAuthCallbackPort(url: URL): number {
  if (url.port) {
    const port = Number.parseInt(url.port, 10);
    if (Number.isFinite(port) && port > 0) return port;
  }
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Match `/opencode/<id>/...` or `/opencode-oauth/<id>/...` and extract the
 * target port + sandboxId + path to forward.
 */
export function matchProxyTarget(url: URL): ProxyTarget | null {
  const { pathname } = url;

  if (pathname.startsWith("/opencode/")) {
    const withoutPrefix = pathname.slice("/opencode/".length);
    const slashIndex = withoutPrefix.indexOf("/");
    if (slashIndex === -1) return null;

    const sandboxId = withoutPrefix.slice(0, slashIndex);
    const rest = withoutPrefix.slice(slashIndex);
    if (!sandboxId) return null;

    return { port: OPENCODE_PORT, sandboxId, rest };
  }

  if (pathname.startsWith("/opencode-oauth/")) {
    const withoutPrefix = pathname.slice("/opencode-oauth/".length);
    const slashIndex = withoutPrefix.indexOf("/");
    if (slashIndex === -1) return null;

    const sandboxId = withoutPrefix.slice(0, slashIndex);
    if (!sandboxId) return null;

    // OpenCode matches the full redirectUri pathname (including the
    // /opencode-oauth/<id> prefix) in its in-container listener, so forward
    // the pathname verbatim — only the target port changes.
    return { port: getOAuthCallbackPort(url), sandboxId, rest: pathname };
  }

  return null;
}
