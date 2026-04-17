/**
 * MCP operation unit tests.
 *
 * Each operation: input validation + happy path + error/stub path.
 * Tenancy: userId is always sourced from ctx, never from input.
 */

import { describe, expect, it, vi } from "vitest";
import type { McpContext } from "../mcp/define.js";
import {
  toolsGetRun,
  toolsInvoke,
  toolsList,
  toolsProposeTemplatize,
  viewList,
  viewRevoke,
  viewRotate,
  viewSetExpiry,
  viewSyncNow,
  viewUnrevoke,
  whoami,
  workspaceRestore,
  workspaceSnapshot,
} from "../mcp/operations/index.js";
import type { UserId } from "../server/auth.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const USER_A = "aaaaaaaaaaaaaaaaaaaaaa" as UserId;
const USER_B = "bbbbbbbbbbbbbbbbbbbbbb" as UserId;

function mockD1(rows: unknown[] = []) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: rows }),
      }),
    }),
  };
}

function makeCtx(userId: UserId = USER_A, d1Override?: ReturnType<typeof mockD1>): McpContext {
  // Cast env bindings to unknown first to avoid noExplicitAny while still
  // satisfying the McpContext shape for unit tests.
  const kv = {} as unknown as KVNamespace;
  const r2 = {} as unknown as R2Bucket;
  const d1 = (d1Override ?? mockD1()) as unknown as D1Database;
  return {
    userId,
    userRegistry: {},
    env: {
      PLATFORM_KV: kv,
      PLATFORM_D1: d1,
      WORKSPACE_SNAPSHOTS: r2,
      PUBLICATIONS: r2,
      TOOL_ATTACHMENTS: r2,
    },
  };
}

// ── whoami ────────────────────────────────────────────────────────────────────

describe("whoami", () => {
  it("returns the userId from ctx", async () => {
    const result = await whoami.execute({}, makeCtx(USER_A));
    expect(result).toEqual({ ok: true, data: { userId: USER_A } });
  });

  it("returns a different userId for a different user (tenancy)", async () => {
    const resultA = await whoami.execute({}, makeCtx(USER_A));
    const resultB = await whoami.execute({}, makeCtx(USER_B));
    expect(resultA).not.toEqual(resultB);
    if (resultA.ok && resultB.ok) {
      expect(resultA.data.userId).toBe(USER_A);
      expect(resultB.data.userId).toBe(USER_B);
    }
  });

  it("accepts empty input (Zod strips unknown keys)", async () => {
    // Zod strips unknown keys by default; extra keys are ignored
    const result = await whoami.execute({}, makeCtx());
    expect(result.ok).toBe(true);
  });
});

// ── workspace.snapshot ────────────────────────────────────────────────────────

describe("workspace.snapshot", () => {
  it("returns NOT_IMPLEMENTED (M3 stub)", async () => {
    const result = await workspaceSnapshot.execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_IMPLEMENTED");
    }
  });
});

// ── workspace.restore ─────────────────────────────────────────────────────────

describe("workspace.restore", () => {
  it("requires snapshotId — Zod throws on missing field", async () => {
    await expect(workspaceRestore.inputSchema.parseAsync({} as unknown)).rejects.toThrow();
  });

  it("accepts a valid snapshotId and returns NOT_IMPLEMENTED (M3 stub)", async () => {
    const input = workspaceRestore.inputSchema.parse({ snapshotId: "snap-abc123" });
    const result = await workspaceRestore.execute(input, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_IMPLEMENTED");
    }
  });
});

// ── tools.list ────────────────────────────────────────────────────────────────

describe("tools.list", () => {
  it("returns empty arrays for the default scope", async () => {
    const input = toolsList.inputSchema.parse({});
    const result = await toolsList.execute(input, makeCtx());
    expect(result).toEqual({ ok: true, data: { own: [], installed: [] } });
  });

  it("returns empty arrays for scope=private", async () => {
    const input = toolsList.inputSchema.parse({ scope: "private" });
    const result = await toolsList.execute(input, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.installed).toEqual([]);
  });

  it("returns empty arrays for scope=shared", async () => {
    const input = toolsList.inputSchema.parse({ scope: "shared" });
    const result = await toolsList.execute(input, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.own).toEqual([]);
  });

  it("rejects an invalid scope value", async () => {
    await expect(
      toolsList.inputSchema.parseAsync({ scope: "invalid" } as unknown),
    ).rejects.toThrow();
  });
});

// ── tools.invoke ──────────────────────────────────────────────────────────────

describe("tools.invoke", () => {
  it("requires toolId — Zod throws on missing field", async () => {
    await expect(toolsInvoke.inputSchema.parseAsync({} as unknown)).rejects.toThrow();
  });

  it("returns NOT_IMPLEMENTED (M4 stub)", async () => {
    const input = toolsInvoke.inputSchema.parse({ toolId: "tool-1" });
    const result = await toolsInvoke.execute(input, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_IMPLEMENTED");
  });
});

// ── tools.propose_templatize ──────────────────────────────────────────────────

describe("tools.propose_templatize", () => {
  it("accepts empty input and returns NOT_IMPLEMENTED (M4 stub)", async () => {
    const input = toolsProposeTemplatize.inputSchema.parse({});
    const result = await toolsProposeTemplatize.execute(input, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_IMPLEMENTED");
  });

  it("accepts all optional fields", async () => {
    const input = toolsProposeTemplatize.inputSchema.parse({
      suggestedName: "my-tool",
      suggestedDescription: "does stuff",
      suggestedParameters: [{ name: "target" }],
    });
    const result = await toolsProposeTemplatize.execute(input, makeCtx());
    expect(result.ok).toBe(false);
  });
});

// ── tools.get_run ─────────────────────────────────────────────────────────────

describe("tools.get_run", () => {
  it("requires runId — Zod throws on missing field", async () => {
    await expect(toolsGetRun.inputSchema.parseAsync({} as unknown)).rejects.toThrow();
  });

  it("returns NOT_IMPLEMENTED (M4 stub)", async () => {
    const input = toolsGetRun.inputSchema.parse({ runId: "run-abc" });
    const result = await toolsGetRun.execute(input, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_IMPLEMENTED");
  });
});

// ── view.list ─────────────────────────────────────────────────────────────────

describe("view.list", () => {
  it("returns empty publications when D1 returns no rows", async () => {
    const result = await viewList.execute({}, makeCtx(USER_A, mockD1([])));
    expect(result).toEqual({ ok: true, data: { publications: [] } });
  });

  it("passes userId (not any other user's id) to the D1 query (tenancy)", async () => {
    const d1 = mockD1([]);
    await viewList.execute({}, makeCtx(USER_A, d1));

    // The prepare().bind() call must have been called with USER_A
    const bindMock = d1.prepare().bind as ReturnType<typeof vi.fn>;
    expect(bindMock).toHaveBeenCalledWith(USER_A);
    expect(bindMock).not.toHaveBeenCalledWith(USER_B);
  });

  it("returns publications rows from D1", async () => {
    const row = { short_id: "abc123", alias: "my-site", mode: "static" };
    const result = await viewList.execute({}, makeCtx(USER_A, mockD1([row])));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.publications).toEqual([row]);
  });
});

// ── view.rotate ───────────────────────────────────────────────────────────────

describe("view.rotate", () => {
  it("requires alias — Zod throws on missing field", async () => {
    await expect(viewRotate.inputSchema.parseAsync({} as unknown)).rejects.toThrow();
  });

  it("returns NOT_IMPLEMENTED (M6 stub)", async () => {
    const input = viewRotate.inputSchema.parse({ alias: "my-site" });
    const result = await viewRotate.execute(input, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_IMPLEMENTED");
  });
});

// ── view.revoke ───────────────────────────────────────────────────────────────

describe("view.revoke", () => {
  it("requires alias", async () => {
    await expect(viewRevoke.inputSchema.parseAsync({} as unknown)).rejects.toThrow();
  });

  it("returns NOT_IMPLEMENTED (M6 stub)", async () => {
    const result = await viewRevoke.execute({ alias: "my-site" }, makeCtx());
    expect(result.ok).toBe(false);
  });
});

// ── view.unrevoke ─────────────────────────────────────────────────────────────

describe("view.unrevoke", () => {
  it("requires alias", async () => {
    await expect(viewUnrevoke.inputSchema.parseAsync({} as unknown)).rejects.toThrow();
  });

  it("returns NOT_IMPLEMENTED (M6 stub)", async () => {
    const result = await viewUnrevoke.execute({ alias: "my-site" }, makeCtx());
    expect(result.ok).toBe(false);
  });
});

// ── view.set_expiry ───────────────────────────────────────────────────────────

describe("view.set_expiry", () => {
  it("requires alias", async () => {
    await expect(
      viewSetExpiry.inputSchema.parseAsync({ expiresAt: null } as unknown),
    ).rejects.toThrow();
  });

  it("accepts alias + numeric expiresAt and returns NOT_IMPLEMENTED", async () => {
    const input = viewSetExpiry.inputSchema.parse({ alias: "my-site", expiresAt: 9999999999 });
    const result = await viewSetExpiry.execute(input, makeCtx());
    expect(result.ok).toBe(false);
  });

  it("accepts alias + null expiresAt (clear expiry)", async () => {
    const input = viewSetExpiry.inputSchema.parse({ alias: "my-site", expiresAt: null });
    const result = await viewSetExpiry.execute(input, makeCtx());
    expect(result.ok).toBe(false);
  });
});

// ── view.sync_now ─────────────────────────────────────────────────────────────

describe("view.sync_now", () => {
  it("requires alias", async () => {
    await expect(viewSyncNow.inputSchema.parseAsync({} as unknown)).rejects.toThrow();
  });

  it("returns NOT_IMPLEMENTED (M6 stub)", async () => {
    const result = await viewSyncNow.execute({ alias: "my-site" }, makeCtx());
    expect(result.ok).toBe(false);
  });
});
