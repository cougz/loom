/**
 * Meta MCP operations: whoami, workspace.*
 */

import { z } from "zod";
import { defineMcpOp } from "../define.js";

export const whoami = defineMcpOp({
  name: "whoami",
  description: "Return the current user's identity.",
  inputSchema: {},
  async execute(_input, ctx) {
    return {
      ok: true,
      data: {
        userId: ctx.userId,
      },
    };
  },
});

export const workspaceSnapshot = defineMcpOp({
  name: "workspace.snapshot",
  description: "Create a snapshot of the current workspace state.",
  inputSchema: {},
  async execute(_input, _ctx) {
    // Placeholder for M3
    return {
      ok: false,
      error: "Not implemented",
      code: "NOT_IMPLEMENTED",
    };
  },
});

export const workspaceRestore = defineMcpOp({
  name: "workspace.restore",
  description: "Restore workspace from a snapshot.",
  inputSchema: { snapshotId: z.string() },
  async execute(_input, _ctx) {
    // Placeholder for M3
    return {
      ok: false,
      error: "Not implemented",
      code: "NOT_IMPLEMENTED",
    };
  },
});
