/**
 * Tools MCP operations: tools.list, tools.invoke, tools.propose_templatize, tools.get_run
 */

import { z } from "zod";
import { defineMcpOp } from "../define.js";

export const toolsList = defineMcpOp({
  name: "tools.list",
  description: "List the invoker's private tools and installed shared tools.",
  inputSchema: z.object({
    scope: z.enum(["all", "private", "shared"]).default("all"),
  }),
  async execute({ scope }, _ctx) {
    // M1 stub: return empty arrays
    // In M4+, this will call ctx.userRegistry.listTools() via DO RPC
    const ownTools = scope === "shared" ? [] : [];

    // Shared tools from team library (placeholder for M5)
    const installed: unknown[] = scope === "private" ? [] : [];

    return {
      ok: true,
      data: {
        own: ownTools,
        installed,
      },
    };
  },
});

export const toolsInvoke = defineMcpOp({
  name: "tools.invoke",
  description: "Invoke a tool by ID with parameters.",
  inputSchema: z.object({
    toolId: z.string(),
    parameters: z.record(z.unknown()).default({}),
  }),
  async execute(_input, _ctx) {
    // Placeholder for M4
    return {
      ok: false,
      error: "Not implemented",
      code: "NOT_IMPLEMENTED",
    };
  },
});

export const toolsProposeTemplatize = defineMcpOp({
  name: "tools.propose_templatize",
  description: "Propose creating a tool from the last agent trajectory.",
  inputSchema: z.object({
    suggestedName: z.string().optional(),
    suggestedDescription: z.string().optional(),
    suggestedParameters: z.array(z.object({ name: z.string() })).optional(),
  }),
  async execute(_input, _ctx) {
    // Placeholder for M4
    return {
      ok: false,
      error: "Not implemented",
      code: "NOT_IMPLEMENTED",
    };
  },
});

export const toolsGetRun = defineMcpOp({
  name: "tools.get_run",
  description: "Fetch the status of a running tool invocation.",
  inputSchema: z.object({
    runId: z.string(),
  }),
  async execute(_input, _ctx) {
    // Placeholder for M4
    return {
      ok: false,
      error: "Not implemented",
      code: "NOT_IMPLEMENTED",
    };
  },
});
