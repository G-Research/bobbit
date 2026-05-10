# `gateway_api` tool

A first-class agent tool for calling the local Bobbit gateway REST API.

## Why it exists

Agents previously accessed the gateway by reading `.bobbit/state/token` and
`.bobbit/state/gateway-url` from disk and shelling out to `curl -sk`. That
pattern is brittle: those state files are written by the gateway at the
project root, but agent sessions run inside their own worktrees (and, with
the Docker sandbox, inside containers) where the relative paths often don't
resolve. When `curl` failed, agents typically escalated to brute-force
`find /` searches, burning the token budget and producing nothing useful.

`gateway_api` removes the need for the agent to know where the token lives,
which host the gateway is on, or how to wire up TLS. The tool extension
resolves all of that from the session environment that already exists for
every agent.

## What it does (and doesn't)

- It is **still a network call** to the local gateway over HTTPS \u2014 not a
  literal in-process function call. The benefit is that auth, URL discovery,
  TLS, and JSON parsing are handled centrally and consistently.
- It runs inside the agent's tool process, so it inherits the calling
  session's permissions: the same REST surface the session already has via
  the WebSocket protocol.
- It does **not** replace the underlying REST API. Humans, external scripts,
  and the gateway's own internals continue to use `curl` / `fetch` directly
  against the documented endpoints (see [rest-api.md](rest-api.md)).

## Path whitelist

The `path` argument must start with `/api/`. Anything else \u2014 absolute URLs,
parent-directory escapes, paths to other server routes \u2014 is rejected with
`isError: true` before any request is made. This keeps the tool narrowly
scoped to the documented REST surface and prevents it from being
repurposed to hit arbitrary endpoints on the gateway host.

## Parameter contract

Owned by [`defaults/tools/agent/gateway_api.yaml`](../defaults/tools/agent/gateway_api.yaml)
under `detail_docs`. That YAML is the single source of truth for the
method/path/body/query schema, response shape, truncation behaviour, and
worked examples \u2014 this doc deliberately does not restate it.
