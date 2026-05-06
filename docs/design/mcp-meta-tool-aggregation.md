# MCP meta-tool aggregation — design doc

Status: implemented
Owner: this goal
Implementation partition: §9

## 0. TL;DR

Today every MCP operation is exposed to the model as its own top-level tool
(`mcp__<server>__<op>`). A user with 10 MCP servers × 30 ops blows past the
OpenAI 128-tool cap and burns ~120 K tokens of schema before any work happens,
and a single misbehaving server breaks the entire turn. This doc collapses
each MCP server into one **meta-tool** (`mcp_<server>`) plus a shared
`mcp_describe` discovery tool, leaving the underlying per-op MCP protocol —
and `mcp__<server>__<op>` as the *internal* routing identifier — completely
unchanged. All policy resolution, tool-docs, group filtering, and the
`/api/internal/mcp-call` dispatcher are reused.

This is a pure protocol-level transformation. Execution backend (delegates,
sandbox, code-mode) is out of scope.

---

## 1. Existing architecture (research summary)

### 1.1 `src/server/mcp/mcp-manager.ts`

`McpManager` is the single owner of MCP discovery, lifecycle, tool listing,
and dispatch. Key surface relevant to this design:

- **`discoverServers()`** (≈L72) — merges JSON config from cascading sources
  (custom dirs → `~/.claude.json` → `~/.claude/.mcp.json` → `~/.bobbit/.mcp.json`
  → `<cwd>/.mcp.json` → `.claude/.mcp.json` → `.bobbit/config/mcp.json`).
- **`connectServer(name, config)`** (≈L207) — opens stdio/HTTP transport via
  `McpClient`, calls `tools/list`, stashes the `McpToolDef[]` in
  `this.toolDefs.set(name, …)`, calls `_updateDocCache()`. Failures are
  caught, logged, and stored in `this.errors` — **partial failure is already
  tolerated** at the connect level (see §5: we extend this to per-call).
- **`connectAll()`** (≈L243) — fan-out over all discovered servers.
- **`getToolInfos()`** (≈L286) — emits one `McpToolInfo` per *operation*
  (`mcp__<server>__<op>`). Used everywhere downstream as the model-facing
  tool list. **This is the choke point we're collapsing.**
- **`_makeBobbitToolName(serverName, mcpToolName)`** (≈L405) — builds
  `mcp__<server>__<tool>`, truncates to ≤ `MAX_TOOL_NAME_LENGTH = 64`,
  registers a reverse map in `this._toolNameMap`.
- **`_parseToolName(bobbitToolName)`** (≈L425) — reverses via map, falls
  back to splitting on `__`.
- **`callTool(bobbitToolName, args)`** (≈L388) — parses → looks up
  `clients.get(serverName)` → calls `client.callTool(toolName, args)`.
- **`_updateDocCache(serverName, tools)`** (≈L353) — writes
  `<stateDir>/mcp-tool-docs/<serverName>.md` with one `## <op>` section per
  operation plus a `### Parameters` table; uses content-hash dedupe via
  `<serverName>.cache.json`. Builds `_summaryCache` (server → op → one-line
  summary).

### 1.2 `src/server/agent/tool-activation.ts`

- **`generateMcpProxyExtension(serverName, tools[])`** (≈L246) — synthesises
  a pi-coding-agent TS extension that registers one `pi.registerTool({…})`
  per `(server, op)` pair. Each tool's `execute()` POSTs
  `{ tool: "mcp__<server>__<op>", args }` to `gwUrl + "/api/internal/mcp-call"`
  with `Authorization: Bearer <token>` and `X-Bobbit-Session-Id`. Body
  parsing and error handling are inline.
- **`writeMcpProxyExtensions(mcpManager, allowedTools, role, toolManager, groupPolicyStore)`**
  (≈L466) — groups infos by `serverName`, runs each through
  `resolveGrantPolicy`, drops `never`, writes one `<serverName>.ts` extension
  file per server under `<stateDir>/mcp-extensions/[<hash>/]`. Returns paths
  for the spawn to pass via `--extension`.
- **`computeToolPolicies(toolManager, mcpManager, role, groupPolicyStore)`**
  (≈L325) — produces a `Record<toolName, { policy, group }>` map for the
  guard extension, **keyed on the per-op `mcp__<server>__<op>` names**.
- **`writeToolGuardExtension(...)`** (≈L367) — emits a single guard extension
  source; the guard receives `event.toolName` and looks it up in `askPolicies`/
  `neverPolicies`. Today both are keyed on per-op names.
- **`computeEffectiveAllowedTools(toolManager, role, groupPolicyStore, mcpManager)`**
  (≈L154) — runs every builtin + every per-op MCP tool through `resolveGrantPolicy`
  and returns the non-`never` ones. **This is the list the spawn turns into
  the model-visible tool inventory.**
- **`resolveGrantPolicy(toolName, toolGroup, role, toolManager, groupPolicyStore)`**
  (≈L114) — five-layer cascade:
  1. role tool-specific (`role.toolPolicies["mcp__pw__snap"]`)
  2. role group-level via `mcpPolicyPrefix(toolName)` (`mcp__pw`) or `toolGroup`
  3. tool YAML default (`toolDef.grantPolicy`)
  4. group default via `groupPolicyStore.getGroupPolicy(prefix|group)`
  5. system fallback `'allow'`
- **`mcpPolicyPrefix(toolName)`** (≈L145) — exported regex
  `/^(mcp__.+?)__/` extracting `mcp__<server>` from `mcp__<server>__<op>`.
  Locked by tests — **must keep working unchanged**.

### 1.3 `src/server/server.ts`

- `GET /api/mcp-servers` (≈L7511) returns
  `[{ name, status, toolCount, error?, config?, tools: [{ name, description }] }]`.
- `POST /api/mcp-servers/:name/restart` (≈L7530) re-discovers, reconnects,
  re-registers MCP tools with `ToolManager` (`removeExternalTools("mcp__")`
  then `registerExternalTools(...)`).
- `POST /api/internal/mcp-call` (≈L7574) — single dispatch endpoint.
  Validates `X-Bobbit-Session-Id`, checks `allowedTools` for non-MCP tools
  (skips for `mcp__*`), then `mcpManager.callTool(tool, args)`. **All MCP
  execution funnels through here today, and will after this change too —
  the meta extension still POSTs `mcp__<server>__<op>` strings to it.**
- `GET /api/tools` (≈L3271) appends `mcpManager.getAvailableTools()` (via
  `toolManager`) to the cascade-resolved tools, tagging origin `"mcp"`.

### 1.4 `src/server/agent/session-manager.ts`

- `mcpManager: McpManager | null` (L427), wired up at startup
  (`connectAll()` at L1038).
- Session activation pipeline uses MCP at three points:
  - L1091: `computeEffectiveAllowedTools(..., this.mcpManager)`
  - L1103-1104: `writeMcpProxyExtensions(this.mcpManager, allowedTools, role, …)`
  - L1121: `writeToolGuardExtension(sessionId, ..., this.mcpManager, ...)`

### 1.5 `src/app/tool-manager-page.ts`

- Renders one row per tool, grouped by `tool.group`. Today the MCP tools
  surface as one row per `mcp__<server>__<op>` under group label
  `"MCP: <server>"` (from `getToolInfos().group`). Group rows show count
  + group-policy dropdown — already correct semantically; we only need the
  *tool* rows to collapse.
- Data source: `fetchToolsScoped()` → `GET /api/tools?projectId=…`
  (L244 of the page; L3271 of the server).

### 1.6 `defaults/tool-group-policies.yaml`

Existing entries already use the **`mcp__<server>` prefix form** —
e.g. `mcp__playwright: never`, `mcp__nano-banana: never`. These keys live
*above* the per-op level, so they survive the refactor untouched: the cascade
matches via `mcpPolicyPrefix()`, which still works on every internal
`mcp__<server>__<op>` name we route through.

### 1.7 Tests that lock the contract

- **`tests/grant-policy.test.ts`** — exhaustive `resolveGrantPolicy` cascade
  cases. Every test is keyed on `mcp__pw__snap`-style names. **Must keep
  passing unmodified.** The internal name shape is unchanged; only the
  *outer* model-facing layer is renamed.
- **`tests/enforce-headless-qa.test.ts`** — asserts `mcp__playwright: never`
  in `defaults/tool-group-policies.yaml` and the qa-tester role's
  toolPolicies. Same prefix form — unchanged.
- New tests live alongside (§8).

---

## 2. Tool surface seen by the model

### 2.1 `mcp_<server>` meta-tool

One per registered MCP server. Emitted in place of every per-op tool that
server contributed today.

**Name function (`src/server/mcp/mcp-meta.ts`, new):**

```ts
/**
 * Produce a model-facing meta-tool name for an MCP server.
 *  - prefix: "mcp_" (single underscore — distinguishes from the legacy
 *    per-op "mcp__" double-underscore form).
 *  - server name sanitized: any char not in [A-Za-z0-9_-] → "_".
 *  - truncated to ≤ 64 chars total (Anthropic API limit).
 *  - empty/all-invalid server names fall back to "mcp_server".
 */
export function makeMetaToolName(serverName: string): string;
```

Examples (matches the goal spec):

| Server name (registered) | Meta-tool name   |
|--------------------------|------------------|
| `gr-halo`                | `mcp_gr-halo`    |
| `gr-jira`                | `mcp_gr-jira`    |
| `nano-banana`            | `mcp_nano-banana`|
| `gr.weird/name`          | `mcp_gr_weird_name` |

**Input schema** (constructed in `buildMetaToolInputSchema(ops)`):

```json
{
  "type": "object",
  "required": ["operation", "args"],
  "properties": {
    "operation": {
      "type": "string",
      "enum": ["get-direct-reports", "get-entity-by-ref", "list-employees"]
    },
    "args": { "type": "object" }
  },
  "additionalProperties": false
}
```

The `enum` is the typo-proof menu. `args` is left as a free-form object —
per-operation arg validation is the underlying MCP server's job, not ours
(re-emitting every op's full schema would defeat the entire context-bloat
fix).

**Description** (~80 tokens, generated by `buildMetaToolDescription(server, ops)`):

```
<one-line server purpose, derived from MCP `tools/list` server description
or first tool's first sentence>. Operations: op1, op2, op3, … Use
mcp_describe(server="<name>", operation="<op>") for the full schema, or
read tool-docs/mcp-<name>.md.
```

The tool-docs reference is a **relative path** so it works under both the
default `<stateDir>/mcp-tool-docs/<server>.md` and project-local docs
dirs. Description hard-cap: 400 chars (truncate the operations list and
append `... (N more)` if needed — measured in `buildMetaToolDescription`).

> **Implementation note (re-attempt).** The original spec proposed 1500
> chars; the shipped implementation tightened this to 400 because per-op
> name lists rarely exceed that and the budget was being used to repeat
> information already available via `mcp_describe`.

### 2.2 `mcp_describe` discovery tool

Single shared tool. Returns the full JSON Schema for an operation on
demand, so the model can drill in only when it needs to.

**YAML at `defaults/tools/mcp/mcp_describe.yaml`** (new — placed in a new
`mcp` tool group):

```yaml
name: mcp_describe
group: MCP
provider:
  type: bobbit-extension
  extension: extension.ts
description: |
  Return the JSON Schema and docs for an MCP operation. Call before
  invoking mcp_<server> when you don't know the args shape.
inputSchema:
  type: object
  required: [server]
  properties:
    server:    { type: string, description: "MCP server name (e.g. gr-halo)" }
    operation: { type: string, description: "Operation name. Omit to list all operations on the server." }
grantPolicy: allow
```

**Extension at `defaults/tools/mcp/extension.ts`** — registers
`mcp_describe`, POSTs `{ server, operation }` to a new internal endpoint
`POST /api/internal/mcp-describe` (§3.3).

**Server-offline fallback** — if `server` is unknown OR
`mcpManager.getServerStatuses().find(...).status !== "connected"`, the
endpoint returns:

```json
{
  "error": "mcp_server_unavailable",
  "server": "gr-halo",
  "reason": "<errors.get(serverName) ?? 'disconnected'>",
  "operations": []
}
```

…which the extension forwards verbatim. The model still gets a structured
result, never a protocol-level abort.

---

## 3. Gateway-side dispatcher

### 3.1 Data flow (new)

```
model
  └─ tool_use { name: "mcp_gr-halo", input: { operation: "list-employees", args: {…} } }
       │
       ▼
[meta extension on the agent side]
  generated by generateMcpMetaExtension(serverName, ops, gwUrl, token, sid)
       │
       │ POST /api/internal/mcp-call
       │ Body: { tool: "mcp__gr-halo__list-employees", args: {…} }
       │ Headers: Authorization: Bearer <token>, X-Bobbit-Session-Id: <sid>
       ▼
[server.ts /api/internal/mcp-call handler  — UNCHANGED]
  mcpManager.callTool("mcp__gr-halo__list-employees", args)
       │
       ▼
[McpManager._parseToolName → clients.get("gr-halo").callTool("list-employees", args)]
       │
       ▼
[McpClient — JSON-RPC tools/call to the live MCP process — UNCHANGED]
```

### 3.2 Where the meta→op rewrite happens — **option (a), client-side**

**Decision: option (a). The agent-side meta extension assembles the
`mcp__<server>__<op>` string from `(serverName, params.operation)` and
POSTs it to the existing `/api/internal/mcp-call` endpoint as before.**

Rationale:

1. **Zero-change to dispatch.** The `mcp-call` endpoint, its session-auth
   logic, and `mcpManager.callTool()` already accept `mcp__<server>__<op>`
   strings. Keeping the wire format identical means the entire policy
   enforcement, error-wrapping, and observability path on the server is
   untouched.
2. **Keeps `_toolNameMap` (§4) authoritative** — there is *one* canonical
   name format inside the server, which is what every existing test, log
   line, and `tool-docs/` reference uses.
3. **Operation enum is enforced at registration**, not at dispatch — the
   `enum` in the meta-tool's input schema causes the agent runtime
   (TypeBox in pi-coding-agent) to reject typos before they ever hit the
   gateway. Server-side translation (option b) would have to add the same
   guard *again* in `mcp-describe.ts` to be safe — duplication for no
   benefit.

Server-side does need **one** additive change: §3.3 below adds
`/api/internal/mcp-describe` for the discovery tool. That's it for
server.ts.

### 3.3 New endpoint: `POST /api/internal/mcp-describe`

Added in `src/server/server.ts` immediately after the existing
`/api/internal/mcp-call` handler (≈L7660). Same auth contract
(`X-Bobbit-Session-Id` header, validated against live or persisted
sessions).

Request body:

```ts
{ server: string; operation?: string }
```

Behaviour:

- Resolves `mcpManager.getToolInfos()` filtered to `serverName === server`.
- If `operation` is provided, returns `{ server, operation, inputSchema, description, summary }`.
- If omitted, returns
  `{ server, status, operations: [{ name, summary, description }, …], docsPath }`
  where `docsPath` is a path relative to the agent cwd to
  `<stateDir>/mcp-tool-docs/<server>.md`.
- Server unknown / disconnected → 200 OK with the
  `{ error: "mcp_server_unavailable", server, reason, operations: [] }`
  envelope (never 4xx — the model needs to keep going).

### 3.4 Extension generator

**New function in `src/server/agent/tool-activation.ts`:**

```ts
/**
 * Generate a single pi-coding-agent extension that registers ONE meta-tool
 * `mcp_<serverName>` covering all of `operations`. Replaces the per-op
 * registrations produced by `generateMcpProxyExtension`.
 *
 * The generated extension:
 *   1. registerTool({ name: makeMetaToolName(serverName), parameters: <enum-shaped TypeBox>, ... })
 *   2. inside execute(toolCallId, params):
 *      - validate params.operation against the local enum (defensive — TypeBox already did)
 *      - POST { tool: `mcp__${serverName}__${params.operation}`, args: params.args ?? {} }
 *        to gwUrl + "/api/internal/mcp-call"
 *      - response handling identical to the legacy generator (text-content
 *        coalescing, error envelope passthrough)
 */
export function generateMcpMetaExtension(
  serverName: string,
  operations: Array<{
    name: string;          // raw MCP op name
    description?: string;
    inputSchema: Record<string, unknown>;
  }>,
): string;
```

The TypeBox shape it emits inline:

```ts
parameters: Type.Object({
  operation: Type.Union([
    Type.Literal("list-employees"),
    Type.Literal("get-direct-reports"),
    /* … */
  ]),
  args: Type.Optional(Type.Object({}, { additionalProperties: true })),
})
```

`writeMcpProxyExtensions` (existing — `src/server/agent/tool-activation.ts`
≈L466) is **rewritten** to:

1. Group infos by `serverName` (already does this).
2. For each server with at least one *non-`never`* operation in the
   filtered set, call `generateMcpMetaExtension(serverName, ops)` instead
   of the old per-op `generateMcpProxyExtension(...)`.
3. Write one `<serverName>.ts` per server (same path, same cache key) —
   only the file *contents* change.

The legacy `generateMcpProxyExtension` is **kept exported** for one cycle
(no callers; flagged `@deprecated` in JSDoc) so any out-of-tree consumers
or accidental imports surface in TS rather than silently breaking. Removed
in a follow-up.

### 3.5 Discovery extension

`defaults/tools/mcp/extension.ts` (new, ~50 lines) — straight POST to
`/api/internal/mcp-describe` mirroring the body-/error-handling style of
the meta extension. Loaded for every session via the standard tool cascade
(no special-casing in session-manager).

---

## 4. Backwards-compat & migration

The internal **`mcp__<server>__<op>` identifier stays the canonical
routing key** through every layer except the final model-facing surface.

| Layer                                   | Stays / Goes |
|-----------------------------------------|--------------|
| `McpManager._toolNameMap`               | **STAYS** — routing depends on it |
| `McpManager.getToolInfos()` per-op rows | **STAYS** — UI + policy resolution + tool-docs need them |
| `mcpPolicyPrefix(toolName)` regex        | **STAYS** — `mcp__<server>` extraction unchanged |
| `defaults/tool-group-policies.yaml` keys (`mcp__playwright` etc.) | **STAYS** — no migration |
| Per-op `<serverName>.ts` extension contents | **CHANGES** — now registers one meta-tool, body POSTs `mcp__<server>__<op>` |
| `<stateDir>/mcp-tool-docs/<server>.md`  | **STAYS** — already per-server |
| `/api/internal/mcp-call` body shape     | **STAYS** — `{ tool: "mcp__…__…", args }` |
| `computeEffectiveAllowedTools` output (model surface) | **CHANGES** — emits one `mcp_<server>` per server, drops per-op names |
| `computeToolPolicies` output (guard input) | **EXTENDS** — adds a `mcp_<server>` entry whose policy = aggregated server policy, keeps per-op entries for the guard's pre-flight (§4.3) |
| `getAvailableTools()` returned to `/api/tools` | **UNCHANGED** — Tools page still sees per-op rows for the expand-on-click view (§6) |

### 4.1 Direct/legacy invocations

If a user prompt or stored history references `mcp__gr-halo__list-employees`
literally, the agent runtime will not have that tool registered (the meta
extension only registered `mcp_gr-halo`). In that case the agent emits a
"tool not found" error to the model. We accept this — the meta tool's
description tells the model the canonical form, and historical references
in transcripts are display-only.

If a fixture or test still calls `mcpManager.callTool("mcp__…__…", args)`
directly (server-side path), it works unchanged — `_parseToolName` and
`_toolNameMap` are untouched.

### 4.2 Group-policy resolution for the meta-tool

The meta-tool's *group* is set to `MCP: <server>` (same as the legacy
per-op tools), so `resolveGrantPolicy("mcp_gr-halo", "MCP: gr-halo", role,
…)` resolves via:

1. Role tool-specific — model authors or admins may set
   `role.toolPolicies["mcp_gr-halo"] = "ask"` in addition to the legacy
   `role.toolPolicies["mcp__gr-halo"]`. Both spellings supported by
   `mcpPolicyPrefix()` extension below.
2. Role group / `mcpPolicyPrefix("mcp_gr-halo")` — **regex extended** to
   match `mcp_<server>` in addition to `mcp__<server>__<op>`. Concretely:

   ```ts
   // src/server/agent/tool-activation.ts
   export function mcpPolicyPrefix(toolName: string): string | undefined {
     // legacy per-op:  "mcp__server__op"  → "mcp__server"
     const legacy = toolName.match(/^(mcp__.+?)__/);
     if (legacy) return legacy[1];
     // meta-tool:      "mcp_server"       → "mcp__server"
     const meta = toolName.match(/^mcp_([^_].*)$/);
     if (meta) return `mcp__${meta[1]}`;
     return undefined;
   }
   ```

   This means **`mcp__playwright: never` in the group-policy YAML
   continues to block both the legacy per-op tools *and* the new
   meta-tool with a single key**. No YAML migration required.

3. Tool YAML default — the meta-tool has no YAML; resolves to `undefined`.
4. Group default — `groupPolicyStore.getGroupPolicy("mcp__playwright")`
   via the prefix branch.
5. `'allow'` fallback.

The cascade of tests in `tests/grant-policy.test.ts` is unchanged in
behaviour. New tests in §8 lock the meta-tool branch.

### 4.3 Tool guard

The guard receives `event.toolName` from pi-coding-agent. With meta-tools,
`event.toolName === "mcp_gr-halo"` for every MCP call — the guard cannot
discriminate between operations.

**Strategy: server-side aggregation, two layers of enforcement.**

Layer A — `computeToolPolicies` (server, pre-spawn):

For each MCP server with at least one non-`never` op, emit the meta-tool
entry `{ "mcp_<server>": { policy: aggregatedPolicy, group: "MCP: <server>" } }`,
where `aggregatedPolicy` is computed as:

```
if any per-op resolves to 'ask'    → 'ask'    (maximally cautious)
else if all per-op resolve 'allow' → 'allow'
else                                → 'never' (only happens if every op is 'never';
                                              then we don't emit the meta-tool at all)
```

This is enough for the guard's pre-flight: if any op needs the user's
permission, the meta-tool prompt fires once on first use of that server,
the user grants, and subsequent ops on the same server flow through
freely. Per-op `ask` is a usability anti-pattern at this scale anyway —
real-world users rarely set `ask` per-op.

Layer B — server-side per-call check (definitive):

The existing `/api/internal/mcp-call` handler (§1.3, ≈L7616) already has
the session + allowedTools context. We **extend** it to also resolve the
per-op policy for `mcp__<server>__<op>` after parsing the body, and reject
calls whose underlying op is `never` even if the meta-tool was granted:

```ts
// src/server/server.ts inside /api/internal/mcp-call, after session check,
// before mcpManager.callTool(...)
if (toolStr.startsWith("mcp__") && perOpPolicyDeniesCall(toolStr, session, …) {
  json({ error: "operation_denied", tool: toolStr, reason: "policy=never" }, 403);
  return;
}
```

This guarantees `mcp__nano-banana: never` (for example) keeps blocking
the `nano-banana__generate_image` op even if a future role granted the
meta-tool wholesale. Layer B is the source of truth; Layer A is a UX
optimisation that surfaces consent earlier.

Per-op `ask` policies that the meta aggregator promoted to
`server-level ask` are not re-asked at Layer B — granted-once = granted-
for-server. This is documented in the doc-comment on
`computeToolPolicies` and the description of the meta-tool. Users who
need per-op gating can keep using `never`, which is the only level of
granularity that survives.

### 4.4 `computeEffectiveAllowedTools` output

Instead of returning every `mcp__<server>__<op>` whose policy ≠ `never`,
return one `mcp_<server>` per server that has **any** non-`never` op,
**plus** the always-on `mcp_describe`. Per-op names are no longer in this
list — the model never sees them.

```ts
// after the existing for-of over mcpInfos:
//   per-op resolveGrantPolicy → drop 'never'
// Replace the result.push(info.name) line with: collect by server.
const byServer = new Map<string, McpToolInfo[]>();
for (const info of mcpInfos) {
  const policy = resolveGrantPolicy(info.name, info.group, role, toolManager, groupPolicyStore);
  if (isNeverPolicy(policy)) continue;
  // ALSO drop ops blocked at the meta level — i.e. if mcp__<server> resolves to 'never'
  const serverPolicy = resolveGrantPolicy(`mcp_${info.serverName}`, info.group, role, toolManager, groupPolicyStore);
  if (isNeverPolicy(serverPolicy)) continue;
  let arr = byServer.get(info.serverName);
  if (!arr) { arr = []; byServer.set(info.serverName, arr); }
  arr.push(info);
}
for (const server of byServer.keys()) {
  result.push(makeMetaToolName(server));
}
// Always include the discovery tool
result.push("mcp_describe");
```

The cache key (§1.2 `hashKey({...})`) doesn't need new inputs —
`mcp.map(i => [i.name, i.group])` already varies with the underlying ops.

---

## 5. Failure isolation (success criterion #3)

### 5.1 Per-call timeout

Currently the only timeout sits in `McpClient.connect()`. We add:

- **`tools/list` deadline: 10 s.** Wrapped at `McpManager.connectServer`
  (≈L221) as `Promise.race([client.listTools(), rejectAfter(10_000)])`.
  On timeout, the server's `errors` map is set to
  `"tools/list timed out after 10s"` and `toolDefs` stays empty — the
  meta-tool stub (§5.3) takes over.
- **`tools/call` deadline: 30 s.** Wrapped in `McpManager.callTool`
  (≈L388) as `Promise.race([client.callTool(...), rejectAfter(30_000)])`.
  On timeout, throws `Error("tools/call timed out after 30s")`, which the
  `/api/internal/mcp-call` handler already converts to a structured
  `{ error: msg, stack }` JSON response.

The actual timeout enforcement is added to `McpManager` only —
`McpClient` (the JSON-RPC client) is left alone (per the constraints
section: "Avoid touching `mcp-client.ts` unless adding the per-call
timeout"). We choose to wrap at `McpManager` level so retries/circuit-
breaker logic stays out of the JSON-RPC core.

### 5.2 Schema validation at registration

After `tools/list` returns, we filter out malformed ops before they reach
`getToolInfos()` / the meta-tool enum:

```ts
// src/server/mcp/mcp-meta.ts (new)
export function isValidOperationSchema(t: McpToolDef): { ok: true } | { ok: false; reason: string };
```

Rules — minimal, just enough to catch the failures we've seen in the wild:

1. `t.name` is a non-empty string ≤ 64 chars matching `[A-Za-z0-9_.-]+`.
2. `t.inputSchema` is an object.
3. `t.inputSchema.type` is either undefined or `"object"`.
4. If `t.inputSchema.properties` exists, it's a plain object.
5. If `t.inputSchema.required` exists, it's an array of strings.

`McpManager.connectServer()` (≈L227, just after `this.toolDefs.set`) is
extended to:

```ts
const validTools = tools.filter(t => {
  const v = isValidOperationSchema(t);
  if (!v.ok) {
    console.warn(`[mcp] dropping malformed op "${t.name}" on "${name}": ${v.reason}`);
  }
  return v.ok;
});
this.toolDefs.set(name, validTools);
```

A bad op never poisons the rest of the server — the meta-tool's enum
just won't list it, and `mcp_describe` won't return its schema. **Other
servers are unaffected**: every server has its own `connectServer`
invocation and its own try/catch (already exists at L233-249), and `tools/list`
runs `Promise.all`.

### 5.3 Stub meta-tool when a server is down

`writeMcpProxyExtensions` (§3.4) currently iterates only over connected
servers (because `getToolInfos()` only returns connected ones). We
extend by *also* generating a stub when a configured server has an
`errors.get(name)` entry — keyed off `mcpManager.getServerStatuses()`:

```ts
// new helper in mcp-meta.ts:
export function generateMcpStubMetaExtension(
  serverName: string,
  reason: string,        // errors.get(name) or "disconnected"
  reasonAt: string,      // ISO timestamp
): string;
```

The stub registers `mcp_<server>` with:

```
description: "MCP server '<server>' unavailable since <ts>: <reason>. Operations: __unavailable__."
parameters: Type.Object({ operation: Type.Literal("__unavailable__"), args: Type.Optional(Type.Any()) })
execute: returns { content: [{ type: "text", text: JSON.stringify({ error: "mcp_server_unavailable", server, reason }) }] }
```

The model gets a structured error and moves on. The agent turn never
aborts at the protocol level.

`writeMcpProxyExtensions` orchestration after the change:

```ts
const statuses = mcpManager.getServerStatuses();
for (const status of statuses) {
  const ops = (toolsByServer.get(status.name) ?? []);
  if (status.status === "connected" && ops.length > 0) {
    code = generateMcpMetaExtension(status.name, ops);
  } else {
    code = generateMcpStubMetaExtension(status.name, status.error ?? status.status, new Date().toISOString());
  }
  // write <serverName>.ts as before
}
```

### 5.4 Per-call error envelope

`/api/internal/mcp-call`'s catch block (≈L7625) already returns
`{ error, stack }` — we only add `server` and `operation` fields parsed
from the inbound `tool` string, so the meta extension can surface a
clean structured error without a stack-trace blob:

```ts
} catch (err) {
  const e = err as Error;
  const parsed = toolStr.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  json({
    error: e.message,
    server: parsed?.[1],
    operation: parsed?.[2],
    stack: e.stack,
  }, 500);
}
```

The legacy clients that read `result.error` still work — we only
*added* fields.

---

## 6. Tools page UI

### 6.1 Server-grouped MCP rendering

`src/app/tool-manager-page.ts` already groups tools by `tool.group`,
and MCP operations all carry `group: "MCP: <server>"`. The change is
visual-only: collapse one `MCP: <server>` group node into a single
**server row** with an inline expand toggle that reveals the per-op
rows already in the data.

Rendering changes around the existing groups loop (`src/app/tool-manager-page.ts`
≈L593-622):

1. After `groups` is built, **partition** keys: `mcpGroups = those starting "MCP: "`,
   `nonMcpGroups = the rest`. Render non-MCP groups exactly as today.
2. Render a single top-level **"MCP" section header** above the
   non-MCP groups (sibling to "File System", "Browser", etc.). Its body
   is one row per `mcpGroups` entry showing:
   - server name (`groupName.slice("MCP: ".length)`)
   - status pill (`connected` / `error` / `disconnected`) — fetched from
     `GET /api/mcp-servers` (existing endpoint)
   - operation count (`groupTools.length`)
   - the existing group-policy `<select>` (unchanged controller — keys on
     the `MCP: <server>` group name *and* the `mcp__<server>` prefix; we
     render whichever the YAML uses).
   - chevron expand toggle.
3. Expanded state reveals the existing per-op rows
   (`groupTools.map(renderToolRow)`). Same renderer, no nesting changes
   beyond CSS indent.

### 6.2 Server status fetch

Add to the existing `Promise.all` at L267:

```ts
const [t, r, gp, mcpServers] = await Promise.all([
  fetchToolsScoped(),
  fetchRoles(),
  fetchGroupPolicies(),
  fetchMcpServers(),         // new — wraps GET /api/mcp-servers
]);
```

`fetchMcpServers()` is a 6-line wrapper added to `src/app/api.ts`,
returns `Array<{ name; status; toolCount; error? }>`. The page caches
the array in module scope keyed by server name and renders the status
badge from there.

No server-side change needed beyond the existing `/api/mcp-servers`
endpoint (§1.3).

---

## 7. Auto-generated tool-docs

Reuse the existing generator (`McpManager._updateDocCache`, §1.1). The
meta-tool description points at the per-server file via the relative
path `tool-docs/mcp-<server>.md` — concretely
`<stateDir>/mcp-tool-docs/<server>.md`, which is already the location.
No change to that code.

`mcp_describe` returns the same per-op data inline so the model doesn't
have to read the file (and so it works in sandboxed agents that can't
hit the local filesystem).

---

## 8. Test plan

All paths are repo-relative.

### 8.1 New unit tests

- **`tests/mcp-meta-name.test.ts`** (NEW)
  - `makeMetaToolName("gr-halo") === "mcp_gr-halo"`
  - `makeMetaToolName("nano-banana") === "mcp_nano-banana"`
  - `makeMetaToolName("weird/name with spaces") === "mcp_weird_name_with_spaces"`
  - empty string → `"mcp_server"`
  - 100-char input → ≤ 64 chars output and remains unique within a
    fixture set of 5 distinct long names (no collisions).

- **`tests/mcp-meta-schema.test.ts`** (NEW)
  - `buildMetaToolInputSchema([…ops])` produces the right `enum` order
    and shape; idempotent on duplicate op names.
  - `buildMetaToolDescription(server, ops)` truncates to ≤ 400 chars
    and ends with `... (N more)` when truncation hits.
  - `isValidOperationSchema` accepts a vanilla MCP op, rejects each of:
    missing name, name with spaces, non-object inputSchema, properties
    being an array, required containing non-strings.

- **`tests/mcp-meta-extension.test.ts`** (NEW)
  - Snapshot/regex-based assertions on `generateMcpMetaExtension(...)`:
    the emitted source contains exactly one `pi.registerTool(`,
    references `gwUrl + "/api/internal/mcp-call"`, includes the literal
    server name in the body's `tool` field as `\`mcp__${serverName}__\${params.operation}\``
    (template literal preserved).
  - `generateMcpStubMetaExtension(...)` includes the
    `"mcp_server_unavailable"` literal and an enum of just
    `__unavailable__`.

- **`tests/mcp-failure-isolation.test.ts`** (NEW)
  - Construct an `McpManager` with two mock servers; one's `tools/list`
    returns a tool with `inputSchema = "not-an-object"`, the other
    returns valid tools. Assert:
    - the malformed op is dropped from the bad server's `getToolInfos()`
    - the good server's tools are unaffected
    - both servers still appear in `getServerStatuses()`
  - Mock `tools/list` that hangs > 10 s on server A; server B normal.
    Assert server A reports `error` status, B reports `connected`,
    `getToolInfos()` returns only B's ops.
  - `writeMcpProxyExtensions` produces a stub `<server-A>.ts`
    containing `mcp_server_unavailable`, and a real `<server-B>.ts`
    containing one `pi.registerTool(`.

### 8.2 Updated unit tests (must keep passing **without modification**)

- `tests/grant-policy.test.ts` — every existing test asserts the prefix-
  based cascade on `mcp__<server>__<op>` names. The internal name format
  is unchanged → all 25 cases pass as-is.
- `tests/enforce-headless-qa.test.ts` — asserts YAML keys
  `mcp__playwright`. YAML untouched → passes as-is.

### 8.3 New unit tests on the policy cascade

- **`tests/mcp-meta-policy.test.ts`** (NEW)
  - `mcpPolicyPrefix("mcp_gr-halo") === "mcp__gr-halo"` — proves the
    extended regex maps the new meta-tool name to the legacy YAML key.
  - With `groupPolicyStore = { "mcp__playwright": "never" }`,
    `resolveGrantPolicy("mcp_playwright", "MCP: playwright", {}, …, gps) === "never"`.
  - `computeEffectiveAllowedTools` returns `["mcp_gr-halo", "mcp_describe"]`
    (and not `["mcp__gr-halo__list-employees", …]`) when given a
    fixture with one server and one op.
  - Same call with `groupPolicyStore = { "mcp__gr-halo": "never" }`
    returns `["mcp_describe"]` — server-level `never` wipes the meta-tool.
  - Aggregated policy: server with one `allow` op + one `ask` op →
    `computeToolPolicies()["mcp_gr-halo"].policy === "ask"`.

### 8.4 API E2E test

- **`tests/e2e/mcp-meta-call.spec.ts`** (NEW; in-process harness)
  - Boot the gateway with a fake MCP server fixture under
    `tests/fixtures/fake-mcp-server.ts` (a tiny stdio JSON-RPC server
    that responds to `initialize`, `tools/list` with two ops, and
    `tools/call` with deterministic output).
  - Hit `GET /api/mcp-servers` — assert payload structure (one entry
    per server, with `tools` array intact for the UI).
  - POST `/api/internal/mcp-call` with body
    `{ tool: "mcp__fake__echo", args: { msg: "hi" } }` and the new
    session header — assert pass-through to the fake server.
  - POST `/api/internal/mcp-describe` with `{ server: "fake" }` —
    assert `{ operations: [{name:"echo",…},{name:"add",…}] }`.
  - POST `/api/internal/mcp-describe` with
    `{ server: "fake", operation: "echo" }` — assert the inputSchema
    is returned verbatim.
  - POST `/api/internal/mcp-describe` with `{ server: "nope" }` →
    `{ error: "mcp_server_unavailable", … }` (status 200).

  If a fake-MCP fixture doesn't exist yet, the test plan adds
  `tests/fixtures/fake-mcp-server.ts` (≈80 LOC, stdio JSON-RPC).

### 8.5 Browser E2E test

- **`tests/e2e/ui/tool-manager-mcp-section.spec.ts`** (NEW; browser
  harness). Reuses the fake-MCP fixture above.
  - Navigate to the Tools page.
  - Assert one row labelled `fake` (server name) is rendered under a
    section header `MCP`, with status pill `connected` and op-count `2`.
  - Click the chevron — assert two child rows for `echo` and `add`.
  - Reload the page — assert the section persists (not a render race).

### 8.6 Existing E2E tests

No changes expected to any existing E2E. The MCP integration tests in
`tests/manual-integration/` (if any reference per-op MCP tool names)
will be reviewed during implementation; if they reference the legacy
form, they keep working via `/api/internal/mcp-call` (server-side
unchanged).

---

## 9. File-by-file change list (parallel-coder partition)

This is the partition I will use to spawn parallel coders. Each entry =
one file path + one paragraph of intent. Most are isolated; `(C)` flags
the coordination points where two coders must agree on a shared
signature.

### 9.1 New files

- **`src/server/mcp/mcp-meta.ts`** *(new — owner: Coder A)*
  Pure helpers: `makeMetaToolName(serverName)`, `buildMetaToolInputSchema(ops)`,
  `buildMetaToolDescription(server, ops, docsRelPath)`,
  `isValidOperationSchema(toolDef)`, sanitisation regex. No runtime
  dependencies beyond `@sinclair/typebox` types. Exports drive every
  other file. **(C)** with Coder B on the exact `Op` type shape.

- **`defaults/tools/mcp/mcp_describe.yaml`** *(new — Coder C)*
  Tool YAML for `mcp_describe`, group `MCP`, points to `extension.ts`,
  schema as in §2.2.

- **`defaults/tools/mcp/extension.ts`** *(new — Coder C)*
  pi-coding-agent extension; POSTs to `/api/internal/mcp-describe`;
  same body/error patterns as the legacy MCP proxy generator
  (`src/server/agent/tool-activation.ts` ≈L256 onwards) — copy the
  `gwUrl`/`token` bootstrap verbatim.

- **`tests/fixtures/fake-mcp-server.ts`** *(new if missing — Coder D)*
  Minimal stdio JSON-RPC server with two ops (`echo`, `add`) for E2E
  tests in §8.4 and §8.5.

- **`tests/mcp-meta-name.test.ts`** — §8.1
- **`tests/mcp-meta-schema.test.ts`** — §8.1
- **`tests/mcp-meta-extension.test.ts`** — §8.1
- **`tests/mcp-failure-isolation.test.ts`** — §8.1
- **`tests/mcp-meta-policy.test.ts`** — §8.3
- **`tests/e2e/mcp-meta-call.spec.ts`** — §8.4
- **`tests/e2e/ui/tool-manager-mcp-section.spec.ts`** — §8.5

### 9.2 Modified files

- **`src/server/mcp/mcp-manager.ts`** *(Coder B)*
  - In `connectServer`, wrap `client.listTools()` in a 10 s race
    (§5.1) and filter through `isValidOperationSchema` (§5.2) before
    `this.toolDefs.set`.
  - In `callTool`, wrap `client.callTool` in a 30 s race.
  - No public-API change beyond the new behaviour. **(C)** with
    Coder A on importing `isValidOperationSchema`.

- **`src/server/agent/tool-activation.ts`** *(Coder E — biggest file)*
  - Add `generateMcpMetaExtension` (§3.4) and import the new helpers
    from `mcp-meta.ts`.
  - Mark `generateMcpProxyExtension` `@deprecated` but leave its body.
  - Extend `mcpPolicyPrefix` to also match `mcp_<server>` (§4.2).
  - Rewrite `writeMcpProxyExtensions` to emit one meta extension per
    server, including the stub branch (§5.3) for disconnected/errored
    servers.
  - Rewrite the MCP loop in `computeEffectiveAllowedTools` to dedupe
    by server and append `mcp_describe` (§4.4).
  - Extend `computeToolPolicies` to also emit a `mcp_<server>` entry
    per server with the aggregated policy (§4.3, Layer A).
  - Cache keys (§1.2) gain one byte: include
    `kind: 'mcpProxy_v2'` so old cache files don't return stale paths
    after upgrade. Same trick for the `effectiveAllowedTools` cache.

- **`src/server/server.ts`** *(Coder F)*
  - Add `POST /api/internal/mcp-describe` (§3.3) immediately after the
    existing `/api/internal/mcp-call` block (≈L7660).
  - Inside `/api/internal/mcp-call`, after the existing session check
    and before `mcpManager.callTool(...)`, add the per-op `never`
    check (§4.3 Layer B). Reuse `resolveGrantPolicy` + the session's
    role/groupPolicyStore — pull these from the live session record.
  - Extend the catch block to add `server`/`operation` fields parsed
    from the `tool` string (§5.4).
  - No change to `GET /api/mcp-servers` — already returns what the UI
    needs.

- **`src/app/api.ts`** *(Coder G)*
  - Add `fetchMcpServers()` returning the typed shape of `GET /api/mcp-servers`.

- **`src/app/tool-manager-page.ts`** *(Coder G)*
  - Wire `fetchMcpServers()` into the initial `Promise.all`.
  - Partition the rendered groups into MCP / non-MCP and add the
    "MCP" parent section with one row per server (§6).

- **`AGENTS.md`** *(any coder, last)*
  - Add a recipe entry under `## Recipes`:
    "**Add an MCP meta-tool** → server-side: `src/server/mcp/mcp-meta.ts`,
    extension generator `generateMcpMetaExtension` in
    `src/server/agent/tool-activation.ts`, dispatcher unchanged
    (`/api/internal/mcp-call` still receives `mcp__<server>__<op>`)."
  - Add a debugging entry: "MCP server unavailable / partial outage —
    look for stub meta extension at `<stateDir>/mcp-extensions/<server>.ts`
    containing `mcp_server_unavailable`."

### 9.3 NOT touched

- `src/server/mcp/mcp-client.ts` — JSON-RPC core. (Per the constraints,
  the per-call timeout lives in `McpManager`, not here.)
- `src/server/mcp/mcp-types.ts` — types are reused as-is.
- `src/ui/components/ToolPermissionCard.ts` — per-tool card unchanged;
  the page-level grouping is what changes.
- `defaults/tool-group-policies.yaml` — keys (`mcp__playwright`,
  `mcp__nano-banana`) keep working via the extended `mcpPolicyPrefix`.
- `src/server/agent/tool-guard-extension.ts` — guard receives
  `mcp_<server>` toolNames via Layer A; per-op enforcement happens at
  `/api/internal/mcp-call` Layer B (no guard-side changes).

---

## 10. Out of scope (deliberate)

This phase is **purely a tool-surface transformation**. Explicitly
deferred:

- **Code-mode / sandbox-mediated execution.** The model still emits
  `tool_use` blocks; we just collapse the names. A future phase can
  swap the dispatcher behind `/api/internal/mcp-call` to a TS-on-
  virtual-FS execution surface without changing what the model sees.
- **Per-op output truncation / summarisation.** Big payloads (e.g.
  a Jira issue list) still come back inline; existing
  `truncateLargeToolContent` (>32 KB) handles this in the chat
  renderer, not here.
- **RAG retrieval over operations within a single server.** Helpful
  only above ~50 ops/server; we revisit if a real user hits that.
- **Per-identity / per-role tool filtering.** The existing
  `tool-group-policies.yaml` + per-role `toolPolicies` covers this for
  every meta-tool via the extended `mcpPolicyPrefix` regex.
- **Cross-server aggregation.** The user spec calls out "if a user
  wants `gr-*` clustered, that's a presentation concern." We leave
  the Tools page's MCP section alphabetised by server name; an
  optional future cluster-by-prefix UI is non-blocking.

---

## Constraints — confirmed satisfied

- ✅ Single-source name parsing: `mcp__<server>__<op>` is unchanged
  inside the gateway, in tool-docs files, in `/api/internal/mcp-call`
  body, in `_toolNameMap`, and in every existing test.
- ✅ Tools page shows one row per server matching the model's view.
- ✅ Changes confined to `src/server/mcp/`,
  `src/server/agent/tool-activation.ts`,
  `src/app/tool-manager-page.ts`, plus the new
  `src/server/mcp/mcp-meta.ts` generator — and small additive
  endpoints in `src/server/server.ts`. `mcp-client.ts` is untouched.
- ✅ All file paths and function references include line numbers /
  named symbols quoted from current `master`.

---

## Re-attempt: gateway grouping & policy UX

The protocol-level rewrite above shipped. Two real-world gaps for
**gateway-style MCP servers** (one MCP server proxying multiple sub-MCPs and
emitting two-level tool names like `mcp__gr__ai-adoption__list-articles`) are
addressed in this re-attempt:

1. Such servers used to collapse into one giant meta-tool with a flat enum of
   `ai-adoption__list-articles, ai-adoption__create-article, jira__get-queue, …`.
2. The Tools page MCP section had no policy `<select>` at any level — only
   `tool-group-policies.yaml` editing worked.

### Mental model

> MCP server = group, sub-namespace = tool, op = parameter.

### Parser (single source of truth)

`parseMcpToolName(bobbitName)` in `src/server/mcp/mcp-meta.ts` returns
`{ server, sub?, op }`. Strip `mcp__<server>__`, split the remainder on the
**first** `__` — 0 separators ⇒ flat (`{server, op}`); ≥ 1 ⇒
`{server, sub: <left>, op: <right-literal>}`. Returns `null` for non-MCP
names so callers can short-circuit cleanly. Six unit tests cover the table
in `docs/mcp-meta-tools.md`.

**Companion helper:** `mcpPolicyKeys(toolName)` in
`src/server/agent/tool-activation.ts` returns `{group, tool}` for both
the legacy `mcp__<server>__<rest>` form and the meta-tool
`mcp_<server>[__<sub>]` form. `mcpPolicyPrefix` is kept as a thin wrapper
returning the group key, so legacy callers and tests pass unchanged.

Every existing site that re-parsed names ad-hoc — `mcp-manager._parseToolName`,
the `byServer` aggregation map in `tool-activation.ts`, `mcpPolicyPrefix` /
`mcpPolicyKeys`, the two `indexOf("__", …)` parses in `server.ts` — routes
through this helper. Reintroducing an ad-hoc parse at any of these sites
brings back the gateway-grouping bug (one giant flat-enum meta-tool).

### Two-level meta-tools

`generateMcpMetaExtension` is keyed by `(server, sub?)` instead of `(server)`.
Each `(server, sub)` pair produces ONE meta-tool, named `mcp_<server>__<sub>`
(or `mcp_<server>` for flat). The op enum lists ops for that sub-namespace
only. The execute body still dispatches the original
`mcp__<server>__<sub>__<op>` (or `mcp__<server>__<op>` for flat) — dispatcher
unchanged.

`writeMcpProxyExtensions` writes one file per `(server, sub?)`. Stub
extensions for error-state servers continue to land at `<server>.ts` (no sub
knowledge possible — server failed before listing tools).

### Policy keys

Two-level keys can both appear in `tool-group-policies.yaml` and per-role
`toolPolicies`. `mcpPolicyPrefix` returns `{group, tool}`; callers consult
**tool-key first, then group-key**, preserving existing precedence
(role > project > group default > system fallback).

| Scope                    | Key                     | Covers                              |
|--------------------------|-------------------------|-------------------------------------|
| Group (whole server)     | `mcp__gr`               | every `mcp_gr__<sub>` meta-tool     |
| Tool (one sub-namespace) | `mcp__gr__ai-adoption`  | `mcp_gr__ai-adoption` only          |
| Flat server              | `mcp__playwright`       | `mcp_playwright` (= group = tool)   |

### `/api/mcp-servers` payload

The payload is extended **additively**: each operation entry carries
`subNamespace?: string` and `op: string` alongside `name` and
`description`, derived server-side from `parseMcpToolName`. The Tools
page groups by `subNamespace` client-side without re-parsing. Older
clients that ignore the new fields keep working unchanged.

### Tools page UI

`renderMcpSection()` in `src/app/tool-manager-page.ts` rewritten so each
server row mirrors a built-in tool group:

- **Server header** with chevron + status pill + group-policy `<select>`
  (`data-testid="mcp-server-policy"`, key `mcp__<server>`).
- **Server expanded** → one tool row per sub-namespace
  (`data-testid="mcp-tool-row"`, with `mcp-tool-policy` select keyed
  `mcp__<server>__<sub>`). Flat servers collapse to a single tool row whose
  name = server.
- **Operations** (deepest, `mcp-server-ops`) are read-only — `operation` is a
  parameter, not a tool.

`/api/mcp-servers` payload is extended with `subNamespace?: string` and
`op: string` per operation entry. The UI groups by `subNamespace`
client-side. Backward-compatible (additive).

### Backward compatibility

- Existing `mcp__<server>` entries keep working as **group keys** under the
  new precedence.
- Per-op policies (`mcp__<server>__<op>` or
  `mcp__<server>__<sub>__<op>`) keep being matched at the per-op level by
  `resolveGrantPolicy(info.name, …)` before meta-aggregation.
- 3-segment legacy keys are treated as **tool keys** by default. Flat-server
  users with such keys are unaffected because flat servers never carry
  sub-namespaces.

See [docs/mcp-meta-tools.md](../mcp-meta-tools.md) for the user-facing
documentation.
