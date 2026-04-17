/**
 * Small helpers shared by the container-proxy paths.
 */

/** HTTP statuses that must have a null body per the Fetch spec. */
export const NULL_BODY_STATUSES = new Set([101, 204, 304]);

/**
 * Build a response from a re-read body text, stripping Content-Length
 * (which may be stale after re-encoding) and copying headers into a
 * fresh Headers object to avoid leaking internal container headers.
 */
export function sanitizedErrorResponse(body: string, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
