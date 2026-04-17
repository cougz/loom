# Tools — user-created, parameterised, shareable

> A **tool** in loom is not a platform fixture. It is something a user
> creates after working with the agent, to capture a workflow so they
> can re-run it with different inputs — and optionally share it with
> their team.

Cloudflare primitives (R2, KV, D1, Workers AI, Browser Rendering, DNS)
are **not tools**. They are the substrate loom runs on, integrated into
the framework. The agent uses them without the user having to name or
choose them. See [`SPEC.md`](./SPEC.md) §"How Cloudflare primitives are
used" for how they are wired in.

This document is about the *user artifact*: what a tool is, how it's
created, how it's invoked, how it's shared.

---

## What a tool is

A tool is:

- **A parameterised prompt** — a natural-language instruction with
  typed parameters (`{url: string, style: enum["brief"|"detailed"]}`).
- **Optional workspace attachments** — files from the user's workspace
  that should travel with the prompt each time it runs (reference data,
  a template to fork from, a schema to follow).
- **Metadata** — name, description, icon/emoji, author, createdAt,
  visibility (private or team-shared), invocation count.

When invoked, a tool runs inside the invoking user's sandbox — fresh
context, the parameterised prompt is filled in, the attachments are
materialised into the workspace, and OpenCode executes it from there.

The tool does not carry compiled code, not a Worker, not a script. It
carries *instruction* — the agent re-does the work each time with the
new inputs.

## Why this shape

- **The agent's flexibility stays.** A tool built from a prompt adapts
  when the environment changes (a dependency moved, a URL format
  shifted) without the user having to edit the tool.
- **Tools are cheap to author.** "Turn this into a tool" is a single
  action on a recent agent trajectory — no IDE, no packaging.
- **Tools are cheap to invoke.** Parameter substitution + sandbox
  startup; no build step.
- **Democratisation is natural.** A tool is small, human-readable, and
  safe to share — there's no binary to audit, just a prompt and some
  files.

What it gives up: determinism. Running the same tool twice on the same
inputs can produce different outputs. For deterministic workflows the
user should ask the agent to produce a script and run that script
directly — but that's a script, not a tool.

---

## Tool lifecycle

### 1. Creation — "templatize this"

The user finishes a chat turn they want to keep. In `/dash` they click
**Templatize** on the most recent agent message, or the agent itself
proposes it ("Want to save this as a tool?"). loom then:

1. Summarises the trajectory (user's intent + what the agent did).
2. Suggests a name, description, and parameter extraction from the
   original request ("I see you asked about `github.com/xyz` — should
   `repoUrl` be a parameter?").
3. Identifies workspace files that were created or modified during the
   turn; asks which (if any) should travel with the tool.
4. Shows a preview of the tool's card — user edits freely, confirms.
5. Writes the tool to the user's registry (DO + R2 attachments).

This is deliberately a conversational flow, not a form. loom uses the
sandbox's own agent to help construct the tool from context.

### 2. Invocation

A tool appears in `/dash` under **Your tools** (left sidebar section).
Clicking it opens a small form with the tool's parameters. On submit:

1. A fresh agent context is opened in the sandbox (new OpenCode
   session, same container, separate working dir
   `/home/user/tools/<toolId>/<runId>/`).
2. Attachments are copied into the run dir.
3. The parameterised prompt is submitted, with parameter values filled
   in. The agent takes it from there.
4. Outputs (files produced in the run dir, chat transcript, any
   `/view` publications the agent makes) are linked from the run
   record.

The user watches it run in a side pane. They can interrupt, amend,
continue — it's still OpenCode, the agent chat is live.

### 3. Sharing — team library

Every tool starts private. A user can flip it to **Team** visibility
from the tool's settings. When shared:

- The tool appears in the team library at `/dash/library`.
- Other team members can **install** it into their own tool list. An
  install is a snapshot — it copies the prompt + attachments into the
  installer's registry. They can then edit their copy freely without
  affecting the original.
- The source tool has a "used by" count and a list of installs.
- The original author can publish an **update**; installers see a
  "new version available" indicator and choose whether to pull it in.

Shared tools live in the team-wide slice of the registry. Execution is
still scoped to the invoking user's sandbox — no cross-tenant leakage.
See [`MULTI-TENANCY.md`](./MULTI-TENANCY.md) §Tools.

### 4. Deletion

Users can delete their own tools. Deleting a shared tool prompts:
"This tool is installed by N team members. Delete anyway?" Delete
removes the author's copy; installed copies are untouched.

---

## Data model

### Tool record

    type Tool = {
      id: string;                   // stable ULID
      authorUserId: UserId;
      name: string;                 // 3-40 chars, unique per author
      description: string;
      icon: string;                 // emoji or single identifier
      visibility: "private" | "team";

      prompt: string;               // parameterised, e.g. "Summarise {repoUrl} in {style} style."
      parameters: ToolParameter[];  // typed param defs
      attachments: Attachment[];    // files from workspace

      version: number;              // increments on update
      createdAt: number;
      updatedAt: number;
      invocationCount: number;
    };

    type ToolParameter = {
      name: string;                 // matches a {placeholder} in `prompt`
      type: "string" | "number" | "boolean" | "enum" | "file";
      description?: string;
      required: boolean;
      default?: unknown;
      // For type="enum":
      options?: string[];
      // For type="file": accepted mime types and size limits
      accept?: string[];
      maxSizeBytes?: number;
    };

    type Attachment = {
      id: string;                   // ULID
      path: string;                 // relative path under the run dir
      r2Key: string;                // users/<userId>/tools/<toolId>/attachments/<id>
      sizeBytes: number;
      contentType: string;
    };

### Tool invocation record

    type ToolRun = {
      id: string;                   // ULID
      toolId: string;
      toolVersion: number;
      invokerUserId: UserId;
      parameters: Record<string, unknown>;
      startedAt: number;
      completedAt?: number;
      status: "running" | "completed" | "failed" | "interrupted";
      workspacePath: string;        // /home/user/tools/<toolId>/<runId>/
      publications: string[];       // shortIds of any /view pubs made
      exitMessage?: string;
    };

### Storage

- **Tool metadata + prompt + parameters:** user's `UserRegistry` DO
  (SQLite table `tools`).
- **Attachments:** R2 under `users/<userId>/tools/<toolId>/attachments/<id>`.
- **Shared-tool copies:** when user B installs user A's team-shared
  tool, a snapshot is written to user B's registry + R2 path. The
  original stays untouched.
- **Run records:** user's `UserRegistry` DO (SQLite table
  `tool_runs`). Run workspaces live inside the container and are
  cleaned up after 7 days.
- **Team library index:** `PLATFORM_D1.shared_tools` table, so the
  library page can list across users without each user's DO being
  queried.

---

## The MCP surface for tools

The agent inside the sandbox can list, invoke, and propose
templatization via a **minimal** MCP surface exposed at `/mcp`:

| Tool | Purpose |
|---|---|
| `tools.list` | List the invoker's tools + library tools. |
| `tools.invoke` | Run a tool by id with parameters. Returns a `runId`. |
| `tools.propose_templatize` | Agent-initiated: send the last trajectory + suggested name/description/parameters back to the user for confirmation. Does not create a tool directly — the user confirms in `/dash`. |
| `tools.get_run` | Fetch the status of a running tool invocation. |

That's it. Four tools. The catalog is intentionally small because the
real surface is *what the user has built*.

Note: `tools.invoke` from within a tool run *is* allowed (composition),
with a recursion depth cap (default 3) to prevent runaway loops.

---

## UX specifics for `/dash`

**Left sidebar, under user menu:**

- **Your tools** — private + your own team-shared.
- **Team library** — browse / install team-shared tools by others.
- **Workspace** — live OpenCode session.

**On an agent message in the chat:**

- Three-dot menu contains **Templatize** when the message represents
  substantial completed work (heuristic: agent performed ≥ 2 tool
  operations and produced output).

**On a tool card (hover):**

- Invoke (primary)
- Edit prompt / parameters / attachments
- Share with team / Make private
- Delete

**On a running tool:**

- Side pane with live chat transcript
- Output files pane (workspace diff for the run dir)
- Publications list (if any `/view` pubs were produced)
- Interrupt / Continue controls

---

## Design rules for contributors

- **Never add platform functionality as an MCP tool.** If loom needs
  to, say, automatically back up the workspace or render a chart, that
  happens in the framework — not via a tool the agent explicitly calls.
- **The tool registry is append-only-visible to the owner.** Never let
  user A enumerate user B's private tools, even indirectly (not
  through `tools.list`, not through a shared counter, not through
  timing). See [`MULTI-TENANCY.md`](./MULTI-TENANCY.md) §Tools.
- **A tool is metadata + prompt + attachments.** Nothing more. No
  compiled code, no shell scripts, no binaries. If a user wants to
  save a script, the script lives as an attachment and the prompt
  instructs the agent to run it. This keeps the sharing boundary small
  and auditable.
- **Attachments have size + count caps.** Default: 10 MB total, 20
  files per tool. Admin-tunable in `PLATFORM_KV:config:tool_limits`.
- **Updating a shared tool does NOT auto-propagate.** Installers pull
  updates on their own schedule.

---

## Future work (post-v1)

- **Tool marketplaces beyond the team.** Import tools from other loom
  deployments via an export/import format (signed, hashed).
- **Deterministic tools.** Opt-in path where a tool captures a
  compiled script as the sole artifact and invocation runs the script
  directly, no LLM in the loop. Cheap, fast, but loses adaptivity.
- **Parameterised attachments.** An attachment whose content is itself
  a template filled by parameters (e.g. a CSV header list driven by
  a param).
- **Tool composition UI.** A visual pane to see what other tools a
  tool invokes, to catch infinite-loop risks before they hit the depth
  cap.
