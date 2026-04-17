/**
 * Render the per-user opencode.jsonc injected into the sandbox container at
 * boot. OpenCode reads this on startup to decide which MCP servers to connect
 * to and which port to bind. Everything else (provider keys, themes, etc.)
 * lives in the baked-in default config layered underneath.
 *
 * The config is written to ~/.opencode/opencode.jsonc inside the container.
 * OpenCode's own config loader merges layered configs, so loom only needs to
 * supply the bits that are per-user (MCP URL + platform JWT) + the bits that
 * must be pinned (port, autoupdate off).
 */

export type OpencodeConfigInput = {
  /** External hostname of the loom Worker (e.g. "loom.yourcompany.com"). */
  loomHostname: string;
  /** Platform JWT minted for this sandbox session. */
  platformJwt: string;
  /** Port OpenCode binds to inside the container. Always 4096 in v1. */
  port?: number;
};

/**
 * Render opencode.jsonc as a JSON string. Emitted as plain JSON (no comments)
 * so OpenCode's parser accepts it — the `.jsonc` extension is informational.
 */
export function renderOpencodeConfig(input: OpencodeConfigInput): string {
  const port = input.port ?? 4096;
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    server: { port },
    mcp: {
      loom: {
        type: "remote",
        url: `https://${input.loomHostname}/mcp`,
        headers: {
          Authorization: `Bearer ${input.platformJwt}`,
        },
      },
    },
  };

  return JSON.stringify(config, null, 2);
}
