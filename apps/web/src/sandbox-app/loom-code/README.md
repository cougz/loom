loom-code
=========

CLI that the agent uses for **Code Mode** — cheap, isolated JS
execution at the edge.

Pipes a JS snippet to the Worker's framework endpoint
(`/__code`). The Worker runs it in a Worker Loader isolate with
`globalOutbound: null` and the `loom.*` namespace scoped to the
invoking user.

See [`docs/CODE-MODE.md`](../../../../../docs/CODE-MODE.md) for the
full contract.

M3 will replace this placeholder with a small Go binary.
