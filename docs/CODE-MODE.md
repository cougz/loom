# Code Mode in loom

> The agent writes short bursts of JavaScript. The Worker runs them in
> an isolated, network-less Worker isolate, returns the result. This
> is how loom lets OpenCode compose, parse, and transform without
> paying the subrequest cost of a tool-call-per-step loop.

Code Mode is built on Cloudflare's **Worker Loader** binding. It is a
framework primitive (per `SPEC.md`), not an MCP tool. The agent reaches
for it through the `loom-code` CLI baked into the sandbox image.

---

## Why

Without Code Mode, a loop like *"read all markdown files in the
workspace and collect every TODO line"* looks like:

1. MCP call: list files → 1 subrequest
2. MCP call: read file 1 → 1 subrequest
3. MCP call: read file 2 → 1 subrequest
4. ... × N files
5. MCP call: final summary → 1 subrequest

For 50 files that's 52 subrequests — uncomfortably close to the
Workers paid plan cap of 1,000 per request.

With Code Mode, the agent writes:

    loom-code <<'JS'
    const files = await loom.workspace.list("/home/user/workspace", { recursive: true });
    const todos = [];
    for (const f of files.filter(f => f.name.endsWith(".md"))) {
      const body = await loom.workspace.read(f.path);
      todos.push(...(body.match(/TODO.*/g) ?? []));
    }
    return { count: todos.length, items: todos.slice(0, 100) };
    JS

One HTTP call to the Worker. One Worker Loader invocation. One result.
One subrequest on the container's ledger.

The trade-off is that the snippet runs in a **restricted environment**
(no network, 30s timeout, only the `loom.*` namespace). If the agent
needs real binaries, filesystem mutation beyond what the namespace
exposes, or persistent processes, it uses the sandbox directly —
that's what the sandbox is for.

---

## The three-tier decision

The agent should reach for the cheapest tier that gets the job done:

| Tier | Primitive | Latency | Best for |
|---|---|---|---|
| 1. **Code Mode** | Worker Loader isolate | ms | parsing, transforming, chaining, composing |
| 2. **Sandbox** | Container + OpenCode | seconds to boot, then native | real binaries, installs, long-running processes, builds |
| 3. **`/view`** | R2 static or sandbox proxy | ms to serve | sharing the result publicly |

This hierarchy is baked into the default OpenCode system prompt loom
injects at sandbox start.

---

## How it works

### Inside the sandbox — `loom-code`

A small static binary (Go) in the container image. Usage:

    loom-code [--timeout 30s] <<'JS'
    async () => {
      // your code here
      return result;
    }
    JS

- Reads the snippet from stdin.
- Wraps it in an async function if needed.
- POSTs to the Worker at `https://loom.yourcompany.com/__code` (a
  framework-internal route, not part of `/mcp`) with the platform JWT
  as `Authorization`.
- Streams stdout/stderr to the terminal as they arrive.
- Exits with the snippet's final value serialised as JSON, or a
  structured error.

### Inside the Worker — `/__code` handler

1. Verify the platform JWT; extract `userId`.
2. Rate-limit check (token bucket keyed on `userId`).
3. Build the `loom.*` module source — a small ES module whose exports
   are bound to `ctx.userId` (so the snippet cannot escape to another
   user's workspace or publications).
4. Call `env.LOADER.load(...)` with:

        {
          mainModule: "snippet.js",
          modules: {
            "snippet.js": wrappedSnippet,
            "loom": loomNamespaceModule,
          },
          globalOutbound: null,
          timeout: 30_000,
        }

5. Invoke the loaded Worker's default export (the wrapped async fn).
6. Capture the return value + console output; send back as the
   response body.
7. Discard the isolate.

### The `loom.*` namespace (initial surface)

    loom.workspace
      .list(path, opts)             list files in the user's sandbox workspace
      .read(path)                   read a text file
      .write(path, content)         write a file (goes back to sandbox filesystem)
      .stat(path)                   stat a path

    loom.publication
      .list()                       list current user's publications
      .info(alias | shortId)        resolved manifest
      .read(shortId, path)          read a file from the user's own publication

    loom.ai
      .run(model, input)            Workers AI inference
      .listModels()                 available models + schemas

    loom.browser
      .screenshot(url, opts)        Browser Rendering screenshot (returns R2 URL)
      .pdf(url, opts)               → R2 URL
      .scrape(url)                  rendered HTML string
      .extract(url)                 structured extract

    loom.storage
      .kvGet(key)                   per-user KV (not platform-wide)
      .kvSet(key, value, opts)
      .kvDelete(key)

    loom.tools
      .list()                       user's tools + installed shared
      .invoke(toolId, args)         subject to recursion depth cap

Not in the initial surface (by design):

- Raw `fetch()` — Code Mode snippets cannot leave loom's domain. If
  the agent needs to reach an external API, it does so from the
  sandbox shell, which has its own egress.
- Cross-user anything.
- D1 access — query abstraction lives at the framework layer.

---

## Safety model

- **No network.** `globalOutbound: null` at loader construction. A
  snippet cannot `fetch()` arbitrary URLs. The `loom.*` helpers have
  their own pre-arranged Fetchers scoped per call.
- **No cross-user access.** The namespace module captures `userId`
  at module-build time. Every helper's implementation path inside the
  Worker enforces tenancy via `ctx.keys`.
- **Timeout.** Default 30s; max 60s; configurable per call up to the
  max.
- **Memory.** The loader isolate has its own memory budget, separate
  from the Worker's. An OOM in the snippet does not take down loom.
- **No secrets.** The Worker never passes its API token, Access
  config, or `PLATFORM_JWT_SECRET` into the loader's module graph.
- **Audit.** Every `loom-code` invocation logs to `audit_log` with
  userId, snippet hash, duration, outcome.

---

## What Code Mode is NOT

- Not Dynamic Dispatch. We are not using Workers for Platforms.
- Not a mechanism for users to deploy permanent code. A snippet runs
  once, returns a value, and is forgotten. If the user wants reuse,
  they templatize the agent's trajectory into a tool — see
  [`TOOLS.md`](./TOOLS.md).
- Not a shell. The sandbox is the shell.
- Not a package-install surface. The snippet sees the `loom.*`
  namespace and nothing else.
