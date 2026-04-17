/**
 * Sandbox Durable Object — re-export from @cloudflare/sandbox.
 *
 * In M1 this is just a skeleton; the full implementation lands in M2.
 * The Sandbox DO provisions a Linux container running OpenCode.
 */

// For M1, we export a minimal placeholder that satisfies wrangler.jsonc
// The actual Sandbox class from @cloudflare/sandbox will be used in M2
export class Sandbox implements DurableObject {
  async fetch(_request: Request): Promise<Response> {
    // Placeholder: in M2 this will proxy to the actual container
    return new Response(
      JSON.stringify({
        status: "Sandbox DO placeholder - full implementation in M2",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
