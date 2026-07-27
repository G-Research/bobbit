# Bound Session Diagnostics — Issue Analysis

Status: issue-analysis artifact for goal **Bound Session Diagnostics**. This document describes the pre-fix behavior and the implementation boundary; it is not the shipped user guide.

## 1. Incident and impact

Session `3e541ac7-83f4-48e6-a408-d5ea41b902f5` compared a bug-discovery session with workflow-review sessions. The comparison was answerable, but transcript exploration consumed most of the agent's context before it reached the answer.

Audit totals:

- 100 `read_session` calls returned **11.45 MB** of agent-visible text.
- The corresponding JSONL rows occupied **23.65 MB**, or **97.0%** of the target transcript.
- 94 calls used `verbose: true`.
- 20 calls included raw tool results and returned **7.86 MB**; the largest response was **950.8 KB**.
- Raw Pi tool-result text contributed **6.80 MB**.
- `thinkingSignature`, `textSignature`, and their encrypted/replay payloads contributed about **2.81 MB**.

Raw Pi result text and provider signatures therefore account for about 83.9% of the 11.45 MB returned. The failure was not merely poor exploration discipline: compact mode hid the information needed to explore safely, raw mode was not response-bounded, and the advertised heavy-read guard was not active in the extension actually loaded by spawned agents.

## 2. Confirmed live reproductions

The following observations were made against the audited session without broad raw replay.

### 2.1 Compact Pi calls are blank

A compact tail of messages 232–236 returned assistant messages 232 and 234 as:

```json
{ "role": "assistant", "text": "" }
```

Those messages are Pi `toolCall` messages for `find` and `read`. Their following results retained the tool names, but reported only:

```json
{ "size": { "type": "array", "blocks": 1 }, "omitted": true }
```

Thus compact mode cannot tell an agent what the assistant did or how large the nested result really is. The agent is pushed toward verbose mode.

### 2.2 The production heavy-read guard is bypassed

A live call with `verbose: true, limit: 11` succeeded and returned messages 0–10. Message 1 showed that the audited agent itself had issued:

```json
{
  "session_id": "e6717bf3-5768-4b09-9bdb-f7c26cc4fd49",
  "offset": 0,
  "limit": 200,
  "verbose": true,
  "include_tool_results": false
}
```

The successful 11-message probe also exposed full `thinkingSignature.encrypted_content` values. This proves both failures in the actual spawned-agent path: the `limit <= 10` rule was not enforced, and verbose provider metadata was not scrubbed.

### 2.3 Runtime metadata identifies the stale winner

`bobbit_read(list_tools, projectId=<bobbit>, verbose=true)` reports `read_session` as:

- `origin: "project"`, `overrides: "server"`;
- legacy params with no `include_tool_results`;
- legacy docs saying ordinary limits extend to 200 and making no heavy-read guarantee.

The Headquarters view reports a second stale copy:

- `origin: "server"`, `overrides: "builtin"`;
- `include_tool_results` and redaction are present;
- the `limit <= 10` policy is absent.

The live session behavior matches the stale server override. The checked-in builtin `defaults/tools/agent/extension.ts` contains `contextHeavyLimitError(...)`, but the resolved override extension loaded into the agent does not.

### 2.4 Repetition is measurable even before bodies

In the live sample:

- one repeated author object serializes to 103 bytes;
- a Pi composite call ID is 83 characters;
- the repeated omission sentence is 83 characters.

Verbose redaction repeats these values for many messages and also carries duplicate aliases such as `name` plus `toolName` and `isError` plus `status`.

## 3. Root causes

The incident has seven independent root causes. Fixing only the raw-result opt-in or only the heavy-mode limit will not make transcript exploration bounded.

### RC1 — Compact rendering recognizes only Anthropic tool calls

`src/server/agent/transcript-reader.ts::toCompact()` emits a tool summary only when `block.type === "tool_use"`. Pi persists calls as `type: "toolCall"`, with arguments normally under `arguments` or `input`. Those blocks fall through every branch, leaving a tool-only assistant message blank.

`buildToolNameMap()` partially recognizes both shapes, which is why a later result may recover its name, but this does not repair the assistant call projection. `flattenText()` has the same `tool_use`-only gap, so regex matching is also incomplete for Pi call names/arguments.

### RC2 — Result sizing stops at the outer container

`contentSize()` measures strings, but arrays return only `{ type: "array", blocks: content.length }` and objects return only `{ type: "object" }`. Pi message-level results commonly store their actual text as:

```json
[{ "type": "text", "text": "...large result..." }]
```

Consequently a one-block, hundreds-of-kilobytes result is advertised as `blocks: 1`. The metadata does not support the decision “this result is too large; do not fetch it.”

### RC3 — Verbose projection is a passthrough for non-result blocks

`redactVerboseContent()` returns original content unchanged when results are included and returns every non-result block unchanged when they are redacted. `toVerbose()` therefore exposes provider-owned fields inside thinking/text blocks, including `thinkingSignature`, `textSignature`, and embedded encrypted/replay data.

Compact mode happens not to copy thinking blocks, but there is no explicit provider-metadata policy. A new provider field can silently enter verbose output because the default is passthrough rather than allowlisted semantic projection.

### RC4 — Message-level Pi results lose identity when included

For a message-level Pi `toolResult`, `toCompact()` has a special branch only when results are omitted. When results are included, the function iterates `content`; an inner `{ type: "text" }` becomes ordinary message text and no canonical result metadata is emitted.

In verbose-with-results mode, `redactVerboseContent()` returns the raw `content` array. The outer transcript row says only `role: "toolResult"`; the tool name, call ID, status, and measured size live on `fullMessage`, which `read_session` does not return. The raw result is therefore anonymous content rather than a self-describing result.

### RC5 — Redaction preserves aliases, then adds more fields

`messageLevelToolResultBlock()` synthesizes both `name` and `toolName` and copies error aliases. `redactedToolResultBlock()` copies every non-body field, then adds `content`, `contentOmitted`, `resultSize`, and `status`. This produces:

- `name` and `toolName`;
- `isError`/`is_error` and `status`;
- long raw correlation IDs under one or more aliases;
- one 83-character omission sentence per result.

The response is larger and harder to interpret than one canonical result record.

### RC6 — A message limit is not a byte budget

`readTranscript()` windows by message count and immediately maps every selected message. It never measures the serialized envelope. One verbose result can therefore be almost a megabyte even with `limit: 1`.

`defaults/tools/agent/extension.ts::execute()` then serializes the envelope into `content[0].text` and repeats the envelope messages in `details.messages`. `ReadSessionRenderer` consumes the details copy, so the duplication also lands in persisted Pi tool-result rows. This explains why the audited JSONL growth substantially exceeded the already-large visible response text.

No existing 32 KB live-UI truncation in `truncate-large-content.ts` solves this. That module bounds selected WebSocket message fields after an agent has produced them; it is not an agent-tool response budget and it does not shape `read_session` before the result enters the caller's context/transcript.

### RC7 — Unit tests import the builtin, but production resolves overrides

`tests2/core/read-session-extension.test.ts` imports `defaults/tools/agent/extension.ts` directly. It proves the checked-in builtin calls `contextHeavyLimitError()` before `fetch`, but it does not exercise the extension path selected for a spawned session.

Production uses the tool cascade:

1. `ToolManager::_loadToolDefinitions()` resolves builtin, market, and config layers; a config group shadows the builtin group.
2. `getToolProviders()` records the winning `baseDir`/`groupDir`.
3. `computeToolActivationArgs()` adds the winner's extension path.
4. `RpcBridge` passes that path to Pi.

For ordinary direct sessions, `SessionManager::buildPipelineContext()` resolves project-specific stores but still returns `this.toolManager`, the server-scope manager supplied in `server.ts`; restore/respawn paths likewise pass `this.toolManager`. That is why the audited direct session exhibits the stale **server** override even though the project tool listing shows an even older project winner. Project-scoped/sandbox resolution remains another exposure and must be covered by the resolved-path test.

`copyToolGroupWithSharedDependencies()` refreshes a group and `_shared` only when customize/update is invoked. Existing server/project copies remain durable overrides and are not refreshed merely because a newer builtin ships. A safety rule implemented only in the builtin extension can therefore be absent indefinitely. The live origin metadata and successful `limit: 11` request demonstrate this exact split-brain.

## 4. File and function map

| Area | File / symbol | Current responsibility | Gap / required ownership |
|---|---|---|---|
| Transcript parse | `src/server/agent/transcript-reader.ts::parseJsonl` | Parses Pi JSONL message rows | Must feed an explicit agent projection, not provider passthrough |
| Compact text/search | `flattenText`, `toCompact` | Builds regex text and compact rows | Add Pi `toolCall`; bound args; keep tool-only rows useful |
| Tool correlation | `buildToolNameMap`, `toolResultMeta` | Maps call IDs to names | Canonical short references; no repeated aliases/IDs |
| Result size | `contentSize`, `toolResultBody` | Reports broad body type | Aggregate nested Pi text chars/lines/UTF-8 bytes |
| Verbose output | `redactVerboseContent`, `toVerbose` | Raw blocks with optional result redaction | Semantic allowlist; provider-field scrub in all agent modes |
| Reader orchestration | `readTranscript` | Filter, paginate, render | Agent policy selection, slices, whole-response serialized budget |
| REST route | `src/server/server.ts`, `GET /api/sessions/:id/transcript` | Auth, params, sandbox-aware file read, JSON response | Select trusted agent-facing policy without changing ordinary REST/UI defaults |
| Agent wrapper | `defaults/tools/agent/extension.ts::callReadSessionEndpoint/execute` | Guard, REST call, Pi tool result | Exact final-result budget; no envelope duplication; slice params |
| Shared limit helper | `defaults/tools/_shared/context-heavy-guard.ts` | Checked-in extension guard | Cannot be the sole production guard because overrides shadow it |
| Runtime resolver | `src/server/agent/tool-manager.ts::_loadToolDefinitions/getToolProviders/getExtensionPath` | Picks winning extension | Expose/pin the actual winner; safety must be override-independent |
| Session pipeline | `src/server/agent/session-manager.ts::buildPipelineContext` and restore/respawn bridge setup | Supplies the server-scope `this.toolManager` to direct sessions | Explain/pin the actual server winner; cover project/sandbox winners separately |
| Spawn activation | `src/server/agent/tool-activation.ts::computeToolActivationArgs/writeToolGuardExtension` | Loads extensions and intercepts tool calls | Enforce heavy-read rule in an immutable, always-loaded invocation guard |
| Agent process | `src/server/agent/rpc-bridge.ts` | Passes resolved extension args to Pi | Integration seam for proving the guard used by spawned agents |
| Bobbit compact metadata | `defaults/tools/bobbit/compact-projection.ts` | Agent-only operation profiles | Keep `get_session` compact and pin its allowlist |
| Bobbit dispatch | `defaults/tools/bobbit/extension.ts::dispatch` | Fetch, page, project | `get_session` remains agent-only projection; REST is unchanged |
| Renderer | `src/ui/tools/renderers/ReadSessionRenderer.ts` | Renders `details.messages` and opens direct REST modal | Adapt to canonical refs/small details; modal REST behavior stays unchanged |
| Existing unit coverage | `tests2/core/transcript-reader.test.ts` | Anthropic/redaction/paging basics | Missing Pi call projection, nested size, signatures, budgets, slices |
| Existing extension coverage | `tests2/core/read-session-extension.test.ts` | Direct builtin import and mock fetch | Missing resolved runtime-path test |
| Existing REST coverage | `tests2/integration/transcript-api.test.ts` | Direct REST compatibility and errors | Add agent-bound vs ordinary REST assertions |
| Docs | `docs/read-session.md`, `docs/rest-api.md` | Current redaction and limit workflow | Replace raw-output instructions with progressive bounded slices |

## 5. Boundary decision

### 5.1 Preserve the direct REST/UI contract

Do not globally change the default shape of `GET /api/sessions/:id/transcript`.

Direct REST callers without an agent identity keep:

- omitted `include_tool_results` meaning results are included;
- existing pagination, negative offsets, regex/context behavior, and errors;
- the UI modal's direct compact/full rendering;
- existing author objects and verbose content expected by programmatic/UI consumers.

`readTranscript()` should retain a legacy/direct policy as its default so library and REST compatibility do not depend on every caller being updated at once.

### 5.2 Apply context policy at a trusted agent-facing boundary

The route already receives `x-bobbit-session-id` from `callReadSessionEndpoint()`. After normal authentication, the server can resolve that header to an actual caller session and select an **agent projection policy**. The safe policy must not be selected by an untrusted query flag alone.

This gives old override extensions safe response shaping: they already send the caller header even when their local projection code is stale. Ordinary browser/direct REST requests do not send it and stay on the legacy path. An admin caller that deliberately supplies a real agent identity opts into the safer shape; it gains no authority.

The agent policy owns:

- canonical Anthropic/Pi projection;
- provider metadata removal;
- result metadata and slice handles;
- a serialized envelope budget;
- regex matching over omitted bodies without returning those bodies.

The extension still performs a final serialized-size check over the complete Pi tool result, because wrapper fields and renderer `details` are outside the server envelope.

### 5.3 Enforce the heavy-read rule before any fetch

Response shaping at the server is defense in depth, but it does not satisfy “reject before any gateway request.” The `limit <= 10` rule must also live in the immutable generated `tool_call` guard loaded for every spawned agent, not only in an overridable tool-group extension.

Extend `generateToolGuardExtension()`/`writeToolGuardExtension()` so it is emitted whenever `read_session` is available, even if every grant policy is `allow`. On a `read_session` event it must inspect Pi's canonical call input, run the same integer/flag rule, and return a structured `CONTEXT_HEAVY_LIMIT_REQUIRED` block before the tool's `execute()` can call `fetch`. Keep the builtin extension check as a fast local duplicate; the generated guard is the production authority that stale group overrides cannot shadow.

The server route should repeat the rule for authenticated agent-bound requests before `sessionFileRead()`. This protects non-Pi/custom agent clients and proves “reject before fetching the transcript,” while ordinary REST remains unchanged.

## 6. Canonical agent response model

### 6.1 Calls

Normalize both provider shapes into one record:

```ts
interface ProjectedToolCall {
  ref: string;              // short page-local ref, e.g. "t1"
  name: string;
  argumentsPreview: string; // bounded, deterministic JSON/text
  argumentsTruncated: boolean;
}
```

Inputs are read in compatibility order from `arguments`, then `input`. A tool-only assistant row is valid and useful even when `text` is empty because it contains `toolCalls`.

Full provider call IDs may appear once in an optional envelope dictionary when correlation truly requires them. Per-message call/result rows use the short ref. A result whose call lies outside the page still gets a deterministic page-local entry populated from the full-transcript name map.

### 6.2 Results

Every result, redacted or excerpted, uses one record:

```ts
interface ProjectedToolResult {
  ref: string;                 // short correlation ref
  name: string;
  status: "ok" | "error" | "unknown";
  size: {
    type: "string" | "array" | "object" | "null" | "missing" | "other";
    chars?: number;
    lines?: number;
    bytes?: number;
    blocks?: number;
  };
  omitted: boolean;
  handle?: string;             // e.g. "m233:b0"
  excerpt?: {
    start: number;
    end: number;
    text: string;
    nextCursor: number | null;
    complete: boolean;
  };
}
```

There is no `toolName`, `toolUseId`, `isError`, `contentOmitted`, `resultSize`, or prose placeholder alias in the agent projection. Compatibility aliases remain only in the direct REST legacy shape.

For nested Pi arrays/objects, size aggregation walks textual leaves in stable block order. `chars` retains the existing JavaScript string-length convention for compatibility, `lines` sums logical text lines, and `bytes` uses UTF-8 byte length. `blocks` remains available but is never the only size for text-bearing containers.

### 6.3 Lazy bounded slices

`include_tool_results: true` no longer means “return the entire body.” It means “include a bounded, self-describing excerpt.” Add additive agent-tool parameters such as:

```text
result_handle="m233:b0"
result_cursor=4096
result_limit=4096
```

Rules:

- `result_limit` has a conservative maximum and is further reduced by the whole-response budget.
- The response repeats canonical name, status, total size, handle, excerpt range, and next cursor.
- A message-level Pi result uses conceptual block `b0`; block-level results use their real block index.
- A stale handle after transcript rewrite/compaction returns a structured stale/not-found error, never a different result.
- Pattern matching may inspect the entire original result server-side, but a match returns only metadata unless the caller separately requests a slice.

This replaces anonymous raw text and makes continuation explicit.

### 6.4 Serialized budget

Define one shared agent transport constant of **50 KiB (`50 * 1024` bytes)**. Measure `Buffer.byteLength(JSON.stringify(value), "utf8")`; character counts are insufficient because escaping and non-ASCII text expand differently.

Budgeting order:

1. Construct canonical semantic messages with per-field caps.
2. Add messages in requested order.
3. Shrink excerpts before dropping semantic metadata.
4. Stop before the next message would exceed the budget.
5. Return actual `returned`, `offsetStart`, and `offsetEnd`, plus an explicit page continuation cursor/offset.
6. Re-serialize and assert the envelope is within budget.
7. In the extension, build the final Pi result with lightweight renderer details, serialize again, and reduce optional previews if required.

A single oversized message must still return its index/role/call/result metadata and a bounded text/result excerpt. Budget exhaustion is a successful partial response, not an unstructured transport truncation.

Do not store the complete envelope twice. `content[0].text` is the canonical agent-readable JSON. `details` should contain only renderer summary fields and a bounded display projection, or the renderer should parse the canonical text. Either choice must be included in the final 50 KiB measurement.

## 7. Response-projection field audit

Legend:

- **K** — keep semantic value;
- **S** — bounded summary/preview;
- **R** — compact dictionary/reference;
- **M** — canonical normalized metadata;
- **E** — bounded excerpt with cursor;
- **—** — omit.

Modes are **C** compact, **CR** compact with result excerpts, **V** verbose with results redacted, and **VR** verbose with result excerpts. “Verbose” means more semantic content, never provider replay blobs or unbounded result bodies.

| Field or normalized group | C | CR | V | VR | Observed / typical size | Diagnostic usefulness | Size rating | Decision | Compatibility constraints |
|---|---:|---:|---:|---:|---|---|---|---|---|
| Envelope totals, match count, returned range, page continuation | K | K | K | K | Typically <200 B/call | High | Low | Keep | Preserve offset, negative-offset, regex/context semantics |
| Message `index`, `role`, `ts` | K | K | K | K | Roughly 50–100 B/message | High | Low | Keep | Existing indexes and timestamps retain meaning |
| Author identity (`kind`, `id`, `label`) | R | R | R | R | Live object 103 B/message; repeats across most rows | High for attribution | Medium aggregate | Canonicalize into envelope dictionary + short refs | Direct REST/UI author objects unchanged; renderer resolves refs |
| Human/assistant visible text | S | S | bounded K | bounded K | Compact currently up to 800 chars/message; verbose unbounded | High | Medium/high | Summarize, then whole-response budget | Preserve visible text and regex behavior; indicate truncation |
| Thinking summary text | — | — | S | S | Usually tens of chars; currently coupled to large signatures | Medium | Low after scrub | Summarize | Do not expose private replay metadata |
| `thinkingSignature`, `textSignature`, encrypted/replay/provider metadata | — | — | — | — | **2.81 MB observed**; often hundreds–thousands of bytes/block | None for diagnostics | Critical | Omit with an explicit provider-field denylist/allowlist | Scope scrub to provider metadata, not arbitrary tool-output text named “signature” |
| Tool call name + arguments | S | S | S | S | Normally 20–250 B/call after cap; Pi calls currently disappear | High | Low | Canonicalize Anthropic `tool_use` + Pi `toolCall` | Accept `arguments` and `input`; tool-only rows cannot be blank |
| Full provider call IDs and alias IDs | R | R | R | R | Live composite ID 83 chars, repeated in call/result/aliases | Medium | Medium aggregate | Store once only if needed; otherwise short page-local ref/message+block index | Preserve correlation meaning, not raw repetition |
| Result name, normalized status, measured size | M | M | M | M | Typically 80–180 B/result | High | Low | Canonicalize | One `name`, one `status`, one `size`; retain `ok/error/unknown` |
| Nested result text metrics | M | M | M | M | Current live result says only `array, blocks:1`; actual body may be hundreds of KB | High | Low | Summarize accurately | Keep outer `type`/`blocks` while adding chars/lines/bytes |
| Duplicate `toolName`/`name`, `isError`/`is_error`/`status`, body aliases | — | — | — | — | Tens–hundreds B/result plus ambiguity | None once normalized | Medium aggregate | Canonicalize/omit aliases | Direct REST legacy projection may retain aliases |
| Repeated prose omission marker | — | — | — | — | 83 chars/result in live sample | None | Medium aggregate | Replace with boolean `omitted`/`excerpt.complete` | Renderer supplies human prose locally |
| Result body | — | E | — | E | **6.80 MB observed**; raw-mode calls returned **7.86 MB**; one response **950.8 KB** | High only when narrowly targeted | Critical | Lazy-slice | Never anonymous; include metadata and continuation on every excerpt |
| Result retrieval handle/range/cursor | M | M | M | M | Target <60 B/result | High | Low | Keep | Handle must detect stale/rebound transcript content |
| Attachments/images/binary provider blocks | S | S | S | S | Potentially very large | Medium | High | Metadata summary + lazy retrieval; no inline binary | Preserve user-visible meaning without base64/provider blobs |
| Stop/error diagnostics and semantic execution status | M | M | M | M | Usually <200 B/message | High | Low | Keep/canonicalize | Preserve structured error contracts |
| Arbitrary provider/full-message bookkeeping | — | — | — | — | Variable; can include usage/replay/raw-response objects | Low | High | Omit unless explicitly allowlisted as semantic diagnostics | Direct REST verbose remains compatible |
| Pi tool-result `details.messages` duplicate of canonical text | — | — | — | — | Audit JSONL 23.65 MB vs 11.45 MB visible output | None as a duplicate | Critical | Deduplicate transport wrapper | Update `ReadSessionRenderer`; retain small summary/details only |

### 7.1 `bobbit_read(get_session)` compact field audit

The current session profile is the right architectural boundary: Bobbit tool responses are projected after REST, so the session detail REST/UI contract need not change.

| Field group | Compact default | Verbose | Decision |
|---|---|---|---|
| `id`, `title`, `status`, archive state | Keep | Keep | Identity/lifecycle |
| `createdAt`, `lastActivity`, other lifecycle timing | Keep | Keep | Recency and stalled-session diagnosis |
| `role`, `assistantType`, `projectId`, `goalId`, `teamGoalId`, `taskId`, `delegateOf`, parent links | Keep | Keep | Ownership and follow-up navigation |
| `lastTurnErrored`, `consecutiveErrorTurns`, `completedTurnCount`, `restoreError` | Keep | Keep | Error/progress diagnosis |
| `cwd`, `worktreePath`, repository/storage paths, `agentSessionFile` | Omit | On demand | Low-value and potentially sensitive bookkeeping |
| `clientCount`, `lastReadAt`, `isCompacting`, UI workspace/draft/preview state | Omit | On demand | Runtime/UI bookkeeping |
| spawn-pinned model/thinking/image settings and display-only flags | Omit | On demand | Not needed for default identity/status diagnosis |

Add a direct `get_session` projection test, not only list-session coverage, so low-value fields cannot silently return.

## 8. Concrete implementation partition

### Slice A — Canonical transcript semantics

Owner files: `src/server/agent/transcript-reader.ts`, preferably with a small extracted `transcript-agent-projection.ts`.

- Normalize `tool_use` and `toolCall`.
- Normalize message-level and block-level results.
- Aggregate nested text sizes.
- Use explicit semantic allowlists and provider metadata scrubbers.
- Keep regex matching over original omitted content.

### Slice B — Result index and lazy slices

Owner files: reader module and transcript REST route.

- Build stable message/block handles from the parsed transcript.
- Add bounded slice params and structured stale/not-found errors.
- Repeat canonical identity/status/size on every slice.
- Keep direct REST additions optional and backward compatible.

### Slice C — Whole-response budgeting and attribution dictionaries

Owner files: agent projection plus a shared serialized-budget helper.

- Budget final UTF-8 JSON, including one oversized message.
- Add page continuation metadata.
- Deduplicate authors and long correlation identifiers with dictionaries/refs.
- Pin 50 KiB as a test-visible constant.

### Slice D — Production boundary and invocation guard

Owner files: `src/server/server.ts`, `src/server/agent/tool-activation.ts`, `src/server/agent/tool-guard-extension.ts`.

- Resolve agent-bound transcript requests from authenticated caller identity.
- Apply agent policy and server-side heavy guard before `sessionFileRead()`.
- Generate the `tool_call` heavy-read guard even for all-allow roles.
- Prove the guard on the actual path selected by `ToolManager`/activation, including stale override fixtures.

### Slice E — Agent wrapper, renderer, and session metadata

Owner files: `defaults/tools/agent/extension.ts`, `_shared/context-heavy-guard.ts`, `ReadSessionRenderer.ts`, `defaults/tools/bobbit/compact-projection.ts`.

- Add slice params and progressive prompt guidance.
- Remove full `messages` duplication from `details`.
- Perform the final 50 KiB serialized Pi-result assertion.
- Resolve author/tool refs in the renderer.
- Pin compact `get_session` fields.

### Slice F — Documentation and replay

Owner files: `docs/read-session.md`, `docs/rest-api.md`, relevant debugging/tool docs.

- Document compact-first exploration.
- Replay the original comparison using metadata + compact tails/search + at most one bounded result excerpt.
- Record call count, overlap avoidance, returned bytes, and the point at which exploration stopped.

## 9. Reproduction and regression strategy

New tests belong in `tests2/` and must be registered in `tests2/tests-map.json`.

### 9.1 Core projection fixture

Create one mixed JSONL fixture containing:

1. Anthropic `tool_use` with `input`.
2. Pi `toolCall` with `arguments` and a tool-only assistant message.
3. Anthropic block-level `tool_result`.
4. Pi message-level `toolResult` whose `content` is a nested text-block array.
5. Duplicate `name`/`toolName`, error aliases, and long composite IDs.
6. `thinkingSignature`, `textSignature`, `encrypted_content`, and replay/provider metadata.
7. One multi-byte, multi-line result larger than 50 KiB.

Assertions across C/CR/V/VR:

- Pi call rows contain name + bounded arguments and are never blank.
- Nested result chars/lines/bytes match the fixture exactly.
- No provider signature/blob key or sentinel value appears in serialized output.
- Only canonical result fields appear; duplicate aliases and omission prose do not.
- Result excerpts retain name/status/size/handle and continue with the returned cursor.
- A pattern inside an omitted result yields a hit without returning the matched body.
- `Buffer.byteLength(JSON.stringify(success), "utf8") <= 50 * 1024`, including a one-message window.

### 9.2 Actual resolved extension path

Do not import the builtin extension directly for the decisive test.

Build a temporary config cascade with:

- the current builtin `agent` group;
- a stale server/project `agent` override that lacks `contextHeavyLimitError`;
- a real `ToolManager`, effective role, `computeToolActivationArgs()`, and generated guard.

Load the extension paths returned by activation, invoke Pi's `tool_call` event with `read_session { verbose:true, limit:11 }`, and assert:

- `CONTEXT_HEAVY_LIMIT_REQUIRED` is returned;
- the stale tool's mocked `fetch` count remains zero;
- limits 1 and 10 pass;
- ordinary compact calls pass;
- both heavy flags in either provider input spelling are detected.

This test pins the production resolution failure that the current direct-import test misses.

### 9.3 REST integration

Extend `tests2/integration/transcript-api.test.ts` with two callers over the same fixture:

- ordinary authenticated REST, no agent caller header: legacy include defaults and UI-compatible verbose content remain unchanged;
- authenticated agent-bound request: canonical scrubbed/budgeted projection and server-side heavy rejection before the injected `readContent` spy runs.

Retain existing tests for negative offsets, pattern/context, cross-project access, and structured error mapping.

### 9.4 Bobbit metadata

Add `bobbit_read(get_session)` acceptance coverage with a payload containing identity, timing, links, error counters, paths, model pins, and UI/runtime bookkeeping. Assert compact keeps the former groups and omits the latter; `verbose:true` remains the on-demand escape hatch.

### 9.5 Renderer/browser coverage

If `details.messages` or author/tool references change, add a DOM test plus one browser journey that:

- renders a compact `read_session` card with Pi call/result metadata;
- opens the full transcript modal;
- verifies direct UI pagination still works after reload;
- verifies no raw result is exposed implicitly.

### 9.6 Original-question replay acceptance

Replay “why did the bug-discovery session find bugs the workflow reviews missed?” with this discipline:

1. Fetch each candidate's compact `get_session` metadata once.
2. Read a small compact tail or regex page (`limit <= 10`).
3. Compare tool names, statuses, call arguments, and accurate result sizes.
4. Follow non-overlapping continuation offsets only.
5. Retrieve one bounded result slice only if metadata/text cannot answer the question.
6. Stop as soon as the prompt/lens evidence is sufficient.

Acceptance is the same substantive conclusion as the audited session, no response over 50 KiB, no broad raw transcript window, and a materially smaller total byte/token footprint recorded in the test/report.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Budget truncation corrupts pagination or causes overlapping reads | Return actual window endpoints plus an explicit continuation over the filtered list; test raw and pattern modes |
| JSON escaping pushes a nominal character cap over 50 KiB | Measure the final serialized UTF-8 bytes, not source strings |
| Slicing splits surrogate pairs or UTF-8 sequences | Slice on a defined character boundary, then measure bytes; test emoji and CRLF |
| Regex search leaks the matching omitted body | Match server-side against raw text, project only canonical metadata unless a slice is explicitly requested |
| Provider scrub removes legitimate tool output fields named `signature` | Apply field policy to provider/message blocks, not opaque tool-result text; pin a tool-output counterexample |
| Result handles point at different content after rewrite/compaction | Bind handle to message/block identity plus a short digest; return structured stale error on mismatch |
| Author dictionaries break attribution or renderer labels | Keep `kind/id/label` once in the envelope; direct REST unchanged; DOM/browser tests resolve refs |
| Stale overrides bypass a builtin-only fix again | Put the heavy invocation rule in the immutable generated guard and server agent boundary; test a stale override winner |
| Server route accidentally changes UI/direct REST | Agent policy derives from authenticated caller identity, never default query behavior; paired integration assertions |
| Wrapper `details` silently reintroduce duplication | Budget the complete Pi tool result and add a negative test forbidding a second full `messages` tree |
| Whole-transcript size measurement increases CPU/memory | Aggregate leaf text without serializing whole nested objects; build name/size indexes once per read |
| New optional slice params complicate structured errors | Add explicit invalid/stale/not-found codes while retaining existing error envelope shape |

## 11. Progressive diagnostic workflow to document

The safe operator/agent workflow is:

1. **Metadata once.** Use compact `bobbit_read(get_session)` for identity, status, timing, role/project links, and counters.
2. **Small compact view.** Tail a few messages or search a stable regex. Compact rows must show Pi/Anthropic tool names and bounded arguments.
3. **Narrow with metadata.** Use message indexes, normalized statuses, and accurate chars/lines/bytes. Do not infer “small” from `blocks: 1`.
4. **Avoid overlap.** Continue only from the returned page cursor/offset; never reread broad overlapping windows.
5. **Slice once if necessary.** Request one result handle with a bounded cursor/range. Continue that slice only when the first excerpt is insufficient.
6. **Stop when answered.** Verbose mode is not a discovery default, and `include_tool_results` is never permission for an unbounded body.

This workflow is viable only after compact projection is complete and accurate; guidance alone cannot compensate for blank tool calls, false size metadata, or a bypassable guard.
