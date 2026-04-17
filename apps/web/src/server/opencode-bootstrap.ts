/**
 * Idempotent "ensure OpenCode is running in the user's sandbox" orchestrator.
 *
 *   1. Boot the container if it isn't running (sandbox.start).
 *   2. Render a per-user opencode.jsonc with a freshly minted platform JWT
 *      and write it to /root/.opencode/opencode.jsonc.
 *   3. Ensure the workspace dir exists.
 *   4. Start `opencode serve --port 4096 --hostname 0.0.0.0 --cors <origin>`
 *      if it isn't already running under our well-known process id.
 *   5. Wait until /global/health returns 200, or time out.
 *
 * Every step is idempotent — repeat calls on a warm sandbox are cheap
 * (one health probe round trip).
 *
 * Why the Worker has to do this: the sandbox container's default
 * entrypoint just keeps the container alive — it does NOT know about
 * opencode. Without startProcess, port 4096 is never listening, and the
 * SDK's waitForPort logs "Container crashed while checking for ports".
 */

import { getSandbox } from "@cloudflare/sandbox";
import { signPlatformJwt, type UserId } from "./auth.js";
import { errorFields, log } from "./log.js";
import { renderOpencodeConfig } from "./opencode-config.js";

const OPENCODE_PORT = 4096;
const OPENCODE_PROCESS_ID = "loom-opencode";
const OPENCODE_CONFIG_PATH = "/root/.opencode/opencode.jsonc";
const DEFAULT_WORKSPACE = "/home/user/workspace";

const SANDBOX_START_TIMEOUT_MS = 45_000;
const PROCESS_START_TIMEOUT_MS = 20_000;
const HEALTH_POLL_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;

type SandboxNamespace = {
  // biome-ignore lint/suspicious/noExplicitAny: DO namespace
  idFromName(name: string): any;
  // biome-ignore lint/suspicious/noExplicitAny: DO namespace
  get(id: any): any;
};

// biome-ignore lint/suspicious/noExplicitAny: Sandbox SDK surface is large and loose
type SandboxStub = any;

function withTimeout<T>(p: Promise<T>, ms: number, op: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${op} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Probe OpenCode's /global/health endpoint through containerFetch.
 * Returns true on 2xx + { healthy: true }, false on anything else.
 */
async function isOpencodeHealthy(sandbox: SandboxStub): Promise<boolean> {
  try {
    const probe = new Request(`http://localhost:${OPENCODE_PORT}/global/health`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const response = await sandbox.containerFetch(probe, OPENCODE_PORT);
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return (
      body !== null && typeof body === "object" && (body as { healthy?: unknown }).healthy === true
    );
  } catch {
    return false;
  }
}

/**
 * Check whether our named OpenCode process is recorded as running.
 * Returns false on any SDK error — caller will re-start the process.
 */
async function isOpencodeProcessAlive(sandbox: SandboxStub): Promise<boolean> {
  try {
    const proc = await sandbox.getProcess(OPENCODE_PROCESS_ID);
    if (!proc) return false;
    const status = (proc as { status?: string }).status;
    return status === "running" || status === "starting";
  } catch {
    return false;
  }
}

export type EnsureOpencodeOptions = {
  /** Hostname the Worker is reachable at (for /mcp + CORS). */
  loomHostname: string;
  /** HMAC secret used to sign the platform JWT. */
  platformJwtSecret: string;
  /** Optional public origin (protocol + hostname[:port]) for CORS. */
  corsOrigin?: string;
  /** Override workspace directory. Defaults to /home/user/workspace. */
  workspaceDir?: string;
};

export type EnsureOpencodeResult = {
  /** Whether OpenCode was newly started (false = already warm). */
  started: boolean;
  /** Workspace directory inside the sandbox. */
  workspaceDir: string;
  /** Total milliseconds spent in ensure. */
  durationMs: number;
};

/**
 * Make sure the per-user sandbox is running an OpenCode server on 4096.
 * Idempotent: safe to call on every request.
 */
export async function ensureOpencodeRunning(
  sandboxNamespace: SandboxNamespace,
  userId: UserId,
  opts: EnsureOpencodeOptions,
): Promise<EnsureOpencodeResult> {
  const started = Date.now();
  const workspaceDir = opts.workspaceDir ?? DEFAULT_WORKSPACE;
  const sandbox = getSandbox(sandboxNamespace as never, userId, {
    keepAlive: true,
    normalizeId: true,
  });

  // Fast path: OpenCode is already responding.
  if (await isOpencodeHealthy(sandbox)) {
    log.debug("opencode.ensure.warm", {
      component: "opencode-bootstrap",
      userId,
      event: "warm_hit",
      durationMs: Date.now() - started,
    });
    return { started: false, workspaceDir, durationMs: Date.now() - started };
  }

  log.info("opencode.ensure.cold_start_begin", {
    component: "opencode-bootstrap",
    userId,
    event: "cold_start_begin",
  });

  // 1. Container boot. sandbox.start is idempotent on the SDK side.
  //    Pass portToCheck only after we've actually started the process,
  //    otherwise waitForPort will fail as it did before.
  try {
    await withTimeout(sandbox.start(), SANDBOX_START_TIMEOUT_MS, "sandbox.start");
  } catch (err) {
    log.error("opencode.ensure.start_failed", {
      component: "opencode-bootstrap",
      userId,
      event: "sandbox_start_failed",
      ...errorFields(err),
    });
    throw err;
  }

  // 2. Write per-user opencode.jsonc with a freshly minted platform JWT.
  //    Every call refreshes the JWT — cheap, and avoids the sandbox ever
  //    holding an expired token.
  const { token: platformJwt } = await signPlatformJwt(
    userId,
    userId, // session id = userId for v1 (one sandbox per user)
    opts.platformJwtSecret,
  );
  const configJson = renderOpencodeConfig({
    loomHostname: opts.loomHostname,
    platformJwt,
    port: OPENCODE_PORT,
  });

  try {
    // mkdir is cheap and idempotent with recursive:true.
    await sandbox.mkdir("/root/.opencode", { recursive: true });
    await sandbox.writeFile(OPENCODE_CONFIG_PATH, configJson);
  } catch (err) {
    log.error("opencode.ensure.config_write_failed", {
      component: "opencode-bootstrap",
      userId,
      event: "config_write_failed",
      ...errorFields(err),
    });
    throw err;
  }

  // 3. Make sure the default workspace exists.
  try {
    await sandbox.mkdir(workspaceDir, { recursive: true });
  } catch (err) {
    // Non-fatal: directory might already exist in the base image.
    log.warn("opencode.ensure.mkdir_workspace_soft_fail", {
      component: "opencode-bootstrap",
      userId,
      event: "mkdir_workspace_soft_fail",
      workspaceDir,
      ...errorFields(err),
    });
  }

  // 4. Start `opencode serve` if our named process isn't alive.
  //    --cors lets the loom-hostname origin make XHR calls to /opencode/<uid>/*
  //    even when OpenCode's CORS check runs on the localhost hostname inside
  //    the container (it sees the Origin header we forward).
  if (!(await isOpencodeProcessAlive(sandbox))) {
    const cmd = [
      "opencode",
      "serve",
      `--port ${OPENCODE_PORT}`,
      "--hostname 0.0.0.0",
      opts.corsOrigin ? `--cors ${opts.corsOrigin}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    try {
      await withTimeout(
        sandbox.startProcess(cmd, {
          processId: OPENCODE_PROCESS_ID,
          // Keep the record around on exit so we can detect crashes.
          autoCleanup: false,
        }),
        PROCESS_START_TIMEOUT_MS,
        "sandbox.startProcess",
      );
      log.info("opencode.ensure.process_started", {
        component: "opencode-bootstrap",
        userId,
        event: "process_started",
        command: cmd,
      });
    } catch (err) {
      log.error("opencode.ensure.process_start_failed", {
        component: "opencode-bootstrap",
        userId,
        event: "process_start_failed",
        command: cmd,
        ...errorFields(err),
      });
      throw err;
    }
  }

  // 5. Poll /global/health until 200, or give up.
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isOpencodeHealthy(sandbox)) {
      const durationMs = Date.now() - started;
      log.info("opencode.ensure.cold_start_done", {
        component: "opencode-bootstrap",
        userId,
        event: "cold_start_done",
        durationMs,
      });
      return { started: true, workspaceDir, durationMs };
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  const durationMs = Date.now() - started;
  log.error("opencode.ensure.health_timeout", {
    component: "opencode-bootstrap",
    userId,
    event: "health_timeout",
    durationMs,
  });
  throw new Error(`OpenCode did not become healthy within ${HEALTH_POLL_TIMEOUT_MS}ms`);
}
