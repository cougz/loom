/**
 * MCP Server — Streamable HTTP endpoint at /mcp.
 *
 * Built on the official @modelcontextprotocol/sdk using the
 * web-standard transport (`WebStandardStreamableHTTPServerTransport`)
 * so it runs natively on the Workers runtime without Node.js HTTP
 * shims. One transport + one `McpServer` instance per request: the
 * server is stateless by design, auth is re-verified every call, and
 * per-request context (userId, DO namespaces, bindings) is captured
 * in the tool-callback closures rather than stored in mutable state.
 *
 * The SDK handles:
 *   • JSON-RPC 2.0 envelope + error codes
 *   • `initialize` handshake + protocol version negotiation
 *   • `tools/list` / `tools/call` dispatch + JSON Schema conversion
 *   • GET for the SSE event stream (returns empty stream — we don't
 *     push server-initiated notifications yet)
 *   • DELETE to terminate a session (no-op in stateless mode)
 *
 * See `./operations/*` for the tool definitions themselves.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ZodRawShape } from "zod";

import type { AuthContext } from "../server/auth.js";
import { errorFields, log } from "../server/log.js";
import type { Env } from "../worker-entry.js";
import type { McpContext, McpResult } from "./define.js";
import * as operations from "./operations/index.js";

/**
 * Erased operation shape — fields we actually read at registration
 * time plus an execute that takes `unknown` input (the zod schema we
 * pass to the SDK does the validation before the callback fires).
 *
 * Using `unknown` here (rather than a generic `McpOperation<Shape, T>`)
 * sidesteps TS's contravariant function-parameter variance:
 * `(input: { scope: string }) => ...` is NOT assignable to
 * `(input: { [k]: unknown }) => ...` even though at runtime any
 * object is fine.
 */
type ErasedOperation = {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  execute: (input: unknown, ctx: McpContext) => Promise<McpResult<unknown>>;
};

/**
 * All operations in a single flat list so we can iterate at
 * registration time. Adding a new operation is one export in
 * ./operations/index.ts plus one entry here.
 *
 * Cast is safe because zod parses raw input at the transport layer
 * before our callback runs — the operation's own signature enforces
 * typing internally.
 */
const ALL_OPERATIONS: ErasedOperation[] = [
  operations.whoami,
  operations.workspaceSnapshot,
  operations.workspaceRestore,
  operations.toolsList,
  operations.toolsInvoke,
  operations.toolsProposeTemplatize,
  operations.toolsGetRun,
  operations.viewList,
  operations.viewRotate,
  operations.viewRevoke,
  operations.viewUnrevoke,
  operations.viewSetExpiry,
  operations.viewSyncNow,
] as unknown as ErasedOperation[];

/**
 * Convert our `{ ok, data } | { ok, error }` result into an MCP
 * `CallToolResult`. Text content is a JSON-encoded body so clients
 * that don't know our schema can still display it; `isError` is set
 * for rejection paths so clients surface it as a tool error.
 */
function toCallToolResult(result: McpResult<unknown>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
} {
  const text = JSON.stringify(result, null, 2);
  if (!result.ok) {
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text }],
    // structuredContent is returned alongside `content` for clients
    // that can parse structured tool output (MCP spec 2025-06-18+).
    structuredContent: { data: result.data },
  };
}

/**
 * Build a fresh McpServer for this request with every operation
 * registered as a tool whose callback has `ctx` closed over.
 */
function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({
    name: "loom",
    version: "0.1.0",
  });

  for (const op of ALL_OPERATIONS) {
    server.registerTool(
      op.name,
      {
        description: op.description,
        inputSchema: op.inputSchema,
      },
      async (args: unknown) => {
        try {
          const result = await op.execute(args, ctx);
          return toCallToolResult(result);
        } catch (err) {
          log.error("mcp.tool.exception", {
            component: "mcp",
            userId: ctx.userId,
            event: "tool_exception",
            tool: op.name,
            ...errorFields(err),
          });
          return toCallToolResult({
            ok: false,
            error: err instanceof Error ? err.message : "Unknown error",
            code: "INTERNAL_ERROR",
          });
        }
      },
    );
  }

  return server;
}

/**
 * Create the MCP HTTP handler.
 *
 * `getAuthContext` is injected so the handler can support both Access
 * JWTs (for user-initiated calls from /dash) and platform JWTs (for
 * calls originating inside the sandbox container). See
 * `server/auth.ts` for the dual-JWT verification.
 */
export function createMcpServerHandler(
  getAuthContext: (request: Request, env: Env) => Promise<AuthContext>,
) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      // Verify the caller before allocating anything MCP-shaped —
      // saves work on unauthenticated probes and ensures tool
      // callbacks always have a real userId.
      let auth: AuthContext;
      try {
        auth = await getAuthContext(request, env);
      } catch (err) {
        log.warn("mcp.auth_failed", {
          component: "mcp",
          event: "auth_failed",
          ...errorFields(err),
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : "Unauthorized",
            },
            id: null,
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Build the per-request MCP server + transport.
      // Stateless transport: `sessionIdGenerator: undefined` so the
      // SDK accepts each request on its own without requiring a
      // session id header, which fits a Worker's no-shared-memory
      // model. `enableJsonResponse: true` returns plain JSON instead
      // of opening an SSE stream on POST — simpler for the client
      // and avoids tying up the Worker invocation.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      // DurableObjectNamespace<any> recurses through stub typing when passed
      // as a value — the TS checker then reports 'excessively deep'. Casting
      // to any here is the documented workaround used elsewhere in the
      // codebase (mirrors durable-objects/index.ts).
      // biome-ignore lint/suspicious/noExplicitAny: see comment above
      const ns = env.USER_REGISTRY as any;
      const registryId = ns.idFromName(auth.userId);
      const userRegistry = ns.get(registryId);

      const ctx: McpContext = {
        userId: auth.userId,
        userRegistry,
        env,
      };

      const server = buildMcpServer(ctx);
      await server.connect(transport);

      try {
        const response = await transport.handleRequest(request);
        return response;
      } catch (err) {
        log.error("mcp.request_failed", {
          component: "mcp",
          userId: auth.userId,
          event: "request_failed",
          method: request.method,
          ...errorFields(err),
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : "Internal error",
            },
            id: null,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      } finally {
        // Free the per-request transport. McpServer.close() also
        // cancels any pending streams so we don't leak promises past
        // the Worker invocation.
        await server.close().catch(() => {});
      }
    },
  };
}
