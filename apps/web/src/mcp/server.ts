/**
 * MCP Server — Streamable HTTP endpoint at /mcp.
 *
 * Basic Streamable HTTP MCP implementation.
 * Exposes minimal operations: tools.*, view.*, meta.*
 */

import type { AuthContext } from "../server/auth.js";
import type { Env } from "../worker-entry.js";
import type { McpContext } from "./define.js";
import * as operations from "./operations/index.js";

/**
 * MCP Tool definition
 */
type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

/**
 * Create the MCP server handler.
 *
 * Returns a simple MCP implementation that lists tools and handles tool calls.
 */
export function createMcpServerHandler(
  // biome-ignore lint/suspicious/noExplicitAny: env type is complex for M1 stub
  getAuthContext: (request: Request, env: any) => Promise<AuthContext>,
) {
  // Define available tools
  const tools: McpTool[] = [
    {
      name: "whoami",
      description: "Return the current user's identity",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "workspace.snapshot",
      description: "Create a snapshot of the current workspace state",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "workspace.restore",
      description: "Restore workspace from a snapshot",
      inputSchema: {
        type: "object",
        properties: { snapshotId: { type: "string" } },
        required: ["snapshotId"],
      },
    },
    {
      name: "tools.list",
      description: "List the invoker's private tools and installed shared tools",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "private", "shared"] },
        },
      },
    },
    {
      name: "tools.invoke",
      description: "Invoke a tool by ID with parameters",
      inputSchema: {
        type: "object",
        properties: {
          toolId: { type: "string" },
          parameters: { type: "object" },
        },
        required: ["toolId"],
      },
    },
    {
      name: "tools.propose_templatize",
      description: "Propose creating a tool from the last agent trajectory",
      inputSchema: {
        type: "object",
        properties: {
          suggestedName: { type: "string" },
          suggestedDescription: { type: "string" },
          suggestedParameters: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" } } },
          },
        },
      },
    },
    {
      name: "tools.get_run",
      description: "Fetch the status of a running tool invocation",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
    },
    {
      name: "view.list",
      description: "List the current user's publications",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "view.rotate",
      description: "Rotate the shortId for a publication",
      inputSchema: {
        type: "object",
        properties: { alias: { type: "string" } },
        required: ["alias"],
      },
    },
    {
      name: "view.revoke",
      description: "Revoke a publication",
      inputSchema: {
        type: "object",
        properties: { alias: { type: "string" } },
        required: ["alias"],
      },
    },
    {
      name: "view.unrevoke",
      description: "Restore a revoked publication",
      inputSchema: {
        type: "object",
        properties: { alias: { type: "string" } },
        required: ["alias"],
      },
    },
    {
      name: "view.set_expiry",
      description: "Set or clear an expiry timestamp",
      inputSchema: {
        type: "object",
        properties: {
          alias: { type: "string" },
          expiresAt: { type: ["number", "null"] },
        },
        required: ["alias"],
      },
    },
    {
      name: "view.sync_now",
      description: "Force an immediate sync",
      inputSchema: {
        type: "object",
        properties: { alias: { type: "string" } },
        required: ["alias"],
      },
    },
  ];

  /**
   * Handle an MCP tool call
   */
  async function handleToolCall(
    toolName: string,
    params: Record<string, unknown>,
    request: Request,
    env: Env,
  ): Promise<unknown> {
    // Get auth context
    const auth = await getAuthContext(request, env);

    // Get user registry DO
    // biome-ignore lint/suspicious/noExplicitAny: DO namespace types
    const registryId = (env.USER_REGISTRY as any).idFromName(auth.userId);
    // biome-ignore lint/suspicious/noExplicitAny: DO namespace types
    const userRegistry = (env.USER_REGISTRY as any).get(registryId);

    const ctx: McpContext = {
      userId: auth.userId,
      userRegistry,
      env,
    };

    // Route to appropriate operation
    switch (toolName) {
      case "whoami":
        return operations.whoami.execute(params, ctx);
      case "workspace.snapshot":
        return operations.workspaceSnapshot.execute(params, ctx);
      case "workspace.restore":
        return operations.workspaceRestore.execute(params as { snapshotId: string }, ctx);
      case "tools.list":
        return operations.toolsList.execute(params, ctx);
      case "tools.invoke":
        return operations.toolsInvoke.execute(
          params as { toolId: string; parameters?: Record<string, unknown> },
          ctx,
        );
      case "tools.propose_templatize":
        return operations.toolsProposeTemplatize.execute(params, ctx);
      case "tools.get_run":
        return operations.toolsGetRun.execute(params as { runId: string }, ctx);
      case "view.list":
        return operations.viewList.execute(params, ctx);
      case "view.rotate":
        return operations.viewRotate.execute(params as { alias: string }, ctx);
      case "view.revoke":
        return operations.viewRevoke.execute(params as { alias: string }, ctx);
      case "view.unrevoke":
        return operations.viewUnrevoke.execute(params as { alias: string }, ctx);
      case "view.set_expiry":
        return operations.viewSetExpiry.execute(
          params as { alias: string; expiresAt: number | null },
          ctx,
        );
      case "view.sync_now":
        return operations.viewSyncNow.execute(params as { alias: string }, ctx);
      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  }

  /**
   * Handle MCP requests
   */
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        const body = (await request.json()) as {
          method?: string;
          params?: Record<string, unknown>;
        };

        // Handle tools/list method
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        // Handle tools/call method
        if (body.method === "tools/call") {
          const toolName = body.params?.name as string;
          const toolParams = (body.params?.arguments as Record<string, unknown>) ?? {};

          if (!toolName) {
            return new Response(JSON.stringify({ error: "Missing tool name" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const result = await handleToolCall(toolName, toolParams, request, env);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Unknown method
        return new Response(JSON.stringify({ error: `Unknown method: ${body.method}` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    },
  };
}
