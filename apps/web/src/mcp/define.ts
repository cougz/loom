/**
 * MCP operation definition helper.
 *
 * All MCP operations follow the same pattern:
 * - Input validated with Zod
 * - Return { ok: true, data } or { ok: false, error, code? }
 * - Never throw
 * - Never accept userId as input — it comes from ctx
 *
 * Operations expose their input schema as a `z.ZodRawShape`
 * (e.g. `{ alias: z.string() }`) rather than a full `z.ZodObject`.
 * The raw shape is what the MCP SDK's `registerTool` expects — it
 * converts it to a JSON Schema for the client. We still build a
 * `z.object(...)` internally for validation.
 */

import { z } from "zod";
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

export type McpOperation<Shape extends z.ZodRawShape, TOutput> = {
  name: string;
  description: string;
  /** Raw shape, e.g. `{ alias: z.string() }`. */
  inputSchema: Shape;
  execute: (input: z.infer<z.ZodObject<Shape>>, ctx: McpContext) => Promise<McpResult<TOutput>>;
};

export function defineMcpOp<Shape extends z.ZodRawShape, TOutput>(
  config: McpOperation<Shape, TOutput>,
): McpOperation<Shape, TOutput> {
  return config;
}

/**
 * Validate unknown input against an operation's schema. Returns the
 * parsed value or throws a ZodError. Used by the MCP handler where
 * the SDK already validated per its JSON Schema, but we want a
 * second pass for defence in depth.
 */
export function parseOpInput<Shape extends z.ZodRawShape>(
  op: McpOperation<Shape, unknown>,
  input: unknown,
): z.infer<z.ZodObject<Shape>> {
  return z.object(op.inputSchema).parse(input);
}
