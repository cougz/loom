/**
 * Sandbox Durable Object — re-export from @cloudflare/sandbox.
 *
 * The Sandbox DO manages the per-user Linux container running OpenCode.
 * Full container lifecycle (provisioning, process management, port exposure,
 * keepAlive heartbeats, preview-URL routing) is handled by the SDK.
 *
 * The Worker calls:
 *   sandbox.startProcess("opencode serve --port 4096 --hostname 0.0.0.0")
 * on first user interaction; the SDK handles container boot, port readiness,
 * and request proxying transparently.
 *
 * M2: wired up — sandbox starts and proxies /dash/oc/* to OpenCode.
 * M3: OpenCode preconfigured with platform JWT + Code Mode wired.
 */
export { Sandbox } from "@cloudflare/sandbox";
