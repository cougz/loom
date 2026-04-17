/**
 * MCP operation definition helper.
 *
 * All MCP operations follow the same pattern:
 * - Input validated with Zod
 * - Return { ok: true, data } or { ok: false, error, code? }
 * - Never throw
 * - Never accept userId as input — it comes from ctx
 */

import type { z } from "zod";
import type { UserId } from "../server/auth.js";

export type McpContext = {
  userId: UserId;
  // biome-ignore lint/suspicious/noExplicitAny: UserRegistry DO stub
  userRegistry: any;
  env: {
    PLATFORM_KV: KVNamespace;
    PLATFORM_D1: D1Database;
    WORKSPACE_SNAPSHOTS: R2Bucket;
    PUBLICATIONS: R2Bucket;
    TOOL_ATTACHMENTS: R2Bucket;
  };
};

export type McpResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export type McpOperation<TInput, TOutput> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, ctx: McpContext) => Promise<McpResult<TOutput>>;
};

export function defineMcpOp<TInput, TOutput>(
  config: McpOperation<TInput, TOutput>,
): McpOperation<TInput, TOutput> {
  return config;
}
