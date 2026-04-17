/**
 * UserRegistry Durable Object.
 *
 * Per-user state: private tools, tool runs, provider keys, resources, session.
 * One DO instance per user (keyed by userId).
 */

import type { UserId } from "../server/auth.js";

export type Tool = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  parametersJson: string;
  attachmentsJson: string;
  visibility: "private" | "team";
  version: number;
  createdAt: number;
  updatedAt: number;
  invocationCount: number;
};

export type ToolRun = {
  id: string;
  toolId: string;
  toolVersion: number;
  parametersJson: string;
  startedAt: number;
  completedAt: number | null;
  status: "running" | "completed" | "failed" | "interrupted";
  workspacePath: string;
  publicationsJson: string;
  exitMessage: string | null;
};

export type ProviderKey = {
  provider: string;
  encryptedKey: string;
};

export type Resource = {
  type: string;
  name: string;
  createdAt: number;
};

export type Session = {
  opencodePort: number | null;
  lastActiveAt: number;
};

const MIGRATIONS = [
  `
    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      prompt TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('private', 'team')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      invocation_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_tools_visibility ON tools(visibility);
    CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name);
  `,
  `
    CREATE TABLE IF NOT EXISTS tool_runs (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      tool_version INTEGER NOT NULL,
      parameters_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'interrupted')),
      workspace_path TEXT NOT NULL,
      publications_json TEXT NOT NULL,
      exit_message TEXT,
      FOREIGN KEY (tool_id) REFERENCES tools(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tool_runs_tool_id ON tool_runs(tool_id);
    CREATE INDEX IF NOT EXISTS idx_tool_runs_status ON tool_runs(status);
  `,
  `
    CREATE TABLE IF NOT EXISTS provider_keys (
      provider TEXT PRIMARY KEY,
      encrypted_key TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS resources (
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (type, name)
    );

    CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
  `,
  `
    CREATE TABLE IF NOT EXISTS session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      opencode_port INTEGER,
      last_active_at INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO session (id, opencode_port, last_active_at) VALUES (1, NULL, 0);
  `,
];

export class UserRegistry implements DurableObject {
  private sql: SqlStorage;
  private userId: UserId;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.sql = ctx.storage.sql;
    // When created via idFromName(userId), ctx.id.name returns the name used.
    // Fall back to ctx.id.toString() only if the ID was not created by name.
    const namedId = (ctx.id as unknown as { name?: string }).name;
    this.userId = (namedId ?? ctx.id.toString()) as UserId;
    this.runMigrations();
  }

  private runMigrations(): void {
    for (const migration of MIGRATIONS) {
      this.sql.exec(migration);
    }
  }

  /**
   * Simple greeting method for M1 verification.
   */
  async greet(): Promise<{ userId: UserId; greetedAt: number }> {
    const now = Date.now();
    return {
      userId: this.userId,
      greetedAt: now,
    };
  }

  /**
   * Get userId for this registry.
   */
  getUserId(): UserId {
    return this.userId;
  }

  // Tool methods (placeholders for M4/M5)
  async listTools(): Promise<Tool[]> {
    const results = this.sql
      .exec<Tool>(
        `
        SELECT
          id, name, description, prompt,
          parameters_json  AS parametersJson,
          attachments_json AS attachmentsJson,
          visibility, version,
          created_at       AS createdAt,
          updated_at       AS updatedAt,
          invocation_count AS invocationCount
        FROM tools ORDER BY updated_at DESC
      `,
      )
      .toArray();
    return results;
  }

  async getTool(id: string): Promise<Tool | undefined> {
    const results = this.sql
      .exec<Tool>(
        `
        SELECT
          id, name, description, prompt,
          parameters_json  AS parametersJson,
          attachments_json AS attachmentsJson,
          visibility, version,
          created_at       AS createdAt,
          updated_at       AS updatedAt,
          invocation_count AS invocationCount
        FROM tools WHERE id = ?
      `,
        id,
      )
      .toArray();
    return results[0];
  }

  // Tool run methods (placeholders for M4/M5)
  async createToolRun(run: Omit<ToolRun, "completedAt" | "exitMessage">): Promise<void> {
    this.sql.exec(
      `
      INSERT INTO tool_runs (id, tool_id, tool_version, parameters_json, started_at, status, workspace_path, publications_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      run.id,
      run.toolId,
      run.toolVersion,
      run.parametersJson,
      run.startedAt,
      run.status,
      run.workspacePath,
      run.publicationsJson,
    );
  }

  async updateToolRun(
    id: string,
    updates: Partial<Pick<ToolRun, "status" | "completedAt" | "exitMessage">>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.status !== undefined) {
      sets.push("status = ?");
      values.push(updates.status);
    }
    if (updates.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(updates.completedAt ?? null);
    }
    if (updates.exitMessage !== undefined) {
      sets.push("exit_message = ?");
      values.push(updates.exitMessage ?? null);
    }

    if (sets.length === 0) return;

    values.push(id);
    this.sql.exec(
      `
      UPDATE tool_runs SET ${sets.join(", ")} WHERE id = ?
    `,
      ...values,
    );
  }

  // Session methods (for M2)
  async updateSession(session: Partial<Session>): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (session.opencodePort !== undefined) {
      sets.push("opencode_port = ?");
      values.push(session.opencodePort);
    }
    if (session.lastActiveAt !== undefined) {
      sets.push("last_active_at = ?");
      values.push(session.lastActiveAt);
    }

    if (sets.length === 0) return;

    this.sql.exec(
      `
      UPDATE session SET ${sets.join(", ")} WHERE id = 1
    `,
      ...values,
    );
  }

  async getSession(): Promise<Session> {
    const results = this.sql
      .exec<Session>(
        `
        SELECT
          opencode_port  AS opencodePort,
          last_active_at AS lastActiveAt
        FROM session WHERE id = 1
      `,
      )
      .toArray();
    return results[0] ?? { opencodePort: null, lastActiveAt: 0 };
  }

  // Provider key methods (for M2)
  async setProviderKey(key: ProviderKey): Promise<void> {
    this.sql.exec(
      `
      INSERT OR REPLACE INTO provider_keys (provider, encrypted_key)
      VALUES (?, ?)
    `,
      key.provider,
      key.encryptedKey,
    );
  }

  async getProviderKey(provider: string): Promise<string | undefined> {
    const results = this.sql
      .exec<{ encrypted_key: string }>(
        `
        SELECT encrypted_key FROM provider_keys WHERE provider = ?
      `,
        provider,
      )
      .toArray();
    return results[0]?.encrypted_key;
  }

  // Resource tracking
  async trackResource(resource: Resource): Promise<void> {
    this.sql.exec(
      `
      INSERT OR REPLACE INTO resources (type, name, created_at)
      VALUES (?, ?, ?)
    `,
      resource.type,
      resource.name,
      resource.createdAt,
    );
  }

  async listResources(type?: string): Promise<Resource[]> {
    if (type) {
      return this.sql
        .exec<Resource>(
          `
          SELECT type, name, created_at AS createdAt
          FROM resources WHERE type = ? ORDER BY created_at DESC
        `,
          type,
        )
        .toArray();
    }
    return this.sql
      .exec<Resource>(
        `
        SELECT type, name, created_at AS createdAt
        FROM resources ORDER BY created_at DESC
      `,
      )
      .toArray();
  }

  // Required DurableObject method
  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ userId: this.userId }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
