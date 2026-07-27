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

`include_tool_results: true` no longer means “return the entire body.” It means “include a bounded, self-describing excerpt.” The additive agent-tool parameters are:

```text
result_handle="m233:b0:d9a72c1e"
result_cursor=4096
result_limit=4096
```

The slice contract is normative:

- Cursors and `excerpt.start`/`excerpt.end` are **JavaScript UTF-16 code-unit offsets** into the canonical result text. This deliberately matches `size.chars` and JavaScript `String.length`/`slice`.
- Ranges are half-open: `[start, end)`. An omitted `result_cursor` means `0`; `complete` is exactly `end === size.chars`; `nextCursor` is exactly `end` when incomplete and `null` when complete.
- `result_limit` is an integer count of UTF-16 code units. Its default is **4096**, its minimum is **1**, and its maximum is **8192**. The whole-response fitter may return fewer units. It never returns more than requested except for the explicit one-scalar progress case below.
- A caller cursor must be an integer in `[0, size.chars]` and must not point between the high and low surrogates of one scalar value. The server chooses the largest valid scalar boundary at or below `start + result_limit`; when `result_limit: 1` starts before an astral scalar, it advances two code units as the sole progress-guaranteeing exception. Combining sequences and CRLF are not atomic: a boundary may fall between their code units, and exact concatenation using each `end`/non-null `nextCursor` must neither skip nor repeat either unit.
- A message-level Pi result uses conceptual block `b0`; block-level results use their real block index. The digest suffix binds the handle to the result body so transcript rewrite/compaction cannot silently rebound it.
- Validation uses the existing structured error envelope with stable codes: `INVALID_RESULT_HANDLE` for missing/malformed handles, `RESULT_NOT_FOUND` for a valid handle whose message/block does not exist, `STALE_RESULT_HANDLE` for a digest mismatch, `INVALID_RESULT_CURSOR` for non-integer/out-of-range/surrogate-interior cursors, and `INVALID_RESULT_LIMIT` for non-integer or out-of-range limits. No error substitutes a different result or resets the cursor implicitly.
- Pattern matching may inspect the entire original result server-side, but a match returns only metadata unless the caller separately requests a slice.

The pinning Unicode fixture is the exact string `A😀e\u0301\r\nZ` (eight UTF-16 units). With requested limits `1,2,2,1,1,1`, continuation must return ranges `[0,1)`, `[1,3)`, `[3,5)`, `[5,6)`, `[6,7)`, and `[7,8)` and concatenate byte-for-byte to the original. A separate `start: 1, result_limit: 1` assertion returns `[1,3)` under the progress exception. Cursor `2` is invalid because it is inside `😀`; splitting `e\u0301` or `\r\n` across separately requested legal boundaries is allowed and must still reassemble exactly.

This replaces anonymous raw text and makes continuation explicit.

### 6.4 One final serialized Pi-result budget

There is one normative transport invariant:

```ts
const READ_SESSION_FINAL_RESULT_MAX_BYTES = 50 * 1024;
const serializedBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
```

For every successful agent-facing call, `serializedBytes(actualExtensionReturn) <= READ_SESSION_FINAL_RESULT_MAX_BYTES`. “Actual extension return” means the complete value returned by `read_session.execute()`, not the server envelope or `content[0].text` alone. The canonical successful return is built by one shared pure builder:

```ts
{
  content: [{ type: "text", text: JSON.stringify(envelope) }],
  details: {
    session_id,
    total: envelope.total,
    matchCount: envelope.matchCount,
    returned: envelope.returned,
    offsetStart: envelope.offsetStart,
    offsetEnd: envelope.offsetEnd,
    nextOffset: envelope.nextOffset
  }
}
```

`details` never contains `messages`; the renderer parses the canonical text or uses only these scalars. Measuring the outer value counts the quotes/backslashes added when the already-serialized envelope is embedded in `content[0].text`, all UTF-8 bytes for emoji, every wrapper key, and `details`. There is no separate “50 KiB server-envelope budget” that can be filled before wrapping.

The authenticated agent route and extension share `buildReadSessionToolResult(envelope, sessionId)` and the same fitter. For deployed stale server/project extensions, the route also constructs the exact audited legacy return shape (including its `details.messages` duplicate) and requires the larger of the canonical and legacy serialized sizes to fit the **same** 50 KiB constant. This compatibility profile is not estimated headroom: it serializes the real legacy object. Thus a missing/stale extension update remains bounded, while an updated extension benefits from deduplicated details. Any future supported wrapper shape must be added as an exact builder and pinning fixture before it may resolve for an agent session.

The fitter is deterministic. Before fitting, variable semantic metadata uses explicit UTF-16 caps: role 32, tool name 128, author label 128, argument preview 512, thinking/error summary 512, and handle/ref 64. Provider correlation IDs are represented by the bounded ref/digest rather than copied raw. Every capped field carries its truncation indicator where loss is diagnostically meaningful.

1. Construct canonical messages using those field caps, accurate metadata, and requested ordering.
2. Add one message at a time and build/serialize the complete supported final return shape(s).
3. If it does not fit, binary-search UTF-16-safe prefixes of result excerpts, visible text, argument previews, and thinking summaries in that order, rebuilding and serializing the complete return at each probe. Do not estimate from source characters.
4. If the selected message is still too large, remove optional previews but retain its index, role, canonical call/result name, status, size, omission state, handle, and author reference. All variable semantic labels/IDs already have bounded canonical representations, so this metadata-only row fits.
5. If another message would overflow, omit that and later messages and set `partial: true`, `truncatedBy: "transport_budget"`, and `nextOffset` to the first unreturned position in the requested/filtered sequence. `returned`, `offsetStart`, and `offsetEnd` describe only rows actually returned.
6. Build and serialize the actual final object once more and assert the invariant before returning it.

An upstream-successful read is never converted to an error merely because its content is large. A single oversized message/result returns a successful metadata-bearing partial row plus a continuation; an empty metadata-only fallback with the same continuation is reserved for a violated internal field-cap invariant and is itself budget-checked. This makes budget exhaustion explicit and recoverable rather than relying on transport truncation.

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

### Slice C — Final-result budgeting and attribution dictionaries

Owner files: agent projection plus a shared serialized-budget/final-return builder imported by the route and extension.

- Fit by serializing the complete canonical and audited legacy Pi return objects, including double JSON escaping, wrapper details, and one oversized message.
- Return a successful metadata-bearing partial page with continuation on budget exhaustion.
- Add page continuation metadata.
- Deduplicate authors and long correlation identifiers with dictionaries/refs.
- Pin the sole 50 KiB final-result constant as test-visible.

### Slice D — Production boundary and invocation guard

Owner files: `src/server/server.ts`, `src/server/agent/tool-activation.ts`, `src/server/agent/tool-guard-extension.ts`.

- Resolve agent-bound transcript requests from authenticated caller identity.
- Apply agent policy and the strict heavy-input matrix before `sessionFileRead()`.
- Generate the `tool_call` heavy-read guard even for all-allow roles.
- Prove the guard through real `SessionManager` spawn/respawn and `RpcBridge` execution for direct server-scope and project/sandbox stale winners; a manual `computeToolActivationArgs()` load is not acceptance coverage.

### Slice E — Agent wrapper, renderer, and session metadata

Owner files: `defaults/tools/agent/extension.ts`, `_shared/context-heavy-guard.ts`, `ReadSessionRenderer.ts`, `defaults/tools/bobbit/compact-projection.ts`.

- Add the normative slice params and progressive prompt guidance.
- Remove full `messages` duplication from `details` and use the shared exact final-return builder.
- Assert the complete returned Pi object is at most 50 KiB; never assert only the inner envelope/text.
- Resolve author/tool refs in the renderer.
- Pin compact `get_session` fields.

### Slice F — Documentation and replay

Owner files: `docs/read-session.md`, `docs/rest-api.md`, relevant debugging/tool docs.

- Document compact-first exploration.
- Replay the original comparison using metadata + compact tails/search + at most one bounded result excerpt.
- Record call count, overlap avoidance, returned bytes, and the point at which exploration stopped.

## 9. Reproduction and regression strategy

New tests belong in `tests2/` and must be registered in `tests2/tests-map.json`.

### 9.1 Core projection and actual-return fixtures

Create one mixed JSONL fixture containing:

1. Anthropic `tool_use` with `input`.
2. Pi `toolCall` with `arguments` and a tool-only assistant message.
3. Anthropic block-level `tool_result`.
4. Pi message-level `toolResult` whose `content` is a nested text-block array.
5. Duplicate `name`/`toolName`, error aliases, and long composite IDs.
6. Provider blocks containing `thinkingSignature`, `textSignature`, generic provider `signature`, `encrypted_content`, and replay metadata with unique secret sentinels.
7. An opaque tool-result body containing the exact legitimate payload `{"signature":"customer-visible-signature","thinkingSignature":"domain-value"}`. This is the required counterexample: field names are scrubbed only from provider/message metadata, never recursively from tool output.
8. The exact slice string `A😀e\u0301\r\nZ`, quote/backslash/newline-heavy text, and one multi-byte, multi-line nested result larger than 1 MiB.

Assertions across C/CR/V/VR:

- Pi call rows contain name + bounded arguments and are never blank.
- Nested result chars/lines/bytes match the fixture exactly.
- No provider signature/blob key or provider sentinel appears in any serialized agent projection.
- In CR and VR, the bounded tool-result excerpt retains the exact `customer-visible-signature` and `domain-value` payload. In C and V the body is absent only because it is omitted, while sizing and server-side regex matching still inspect the unchanged payload. A direct unit assertion on canonical result extraction proves the scrubber did not delete or rename either tool-output field.
- Only canonical result fields appear; duplicate aliases and omission prose do not.
- The normative Unicode ranges, validation codes, continuation, and exact reassembly from §6.3 hold.
- Result excerpts retain name/status/size/handle and continue with the returned cursor.
- A pattern inside an omitted result yields a hit without returning the matched body.

Budget tests must register and execute the real `read_session` extension against the fixture, await its returned value, and assert:

```ts
Buffer.byteLength(JSON.stringify(actualExtensionReturn), "utf8") <= 50 * 1024
```

They do **not** assert only the projected server `success`, envelope, or inner text. Run this assertion separately for: (a) repeated quotes, backslashes, and control/newline escapes; (b) repeated emoji/non-ASCII text; (c) a single oversized visible message; and (d) a single oversized nested Pi result in each result-including mode. Also execute the audited legacy-wrapper fixture selected by the agent route. Every case must be a successful `partial: true` response with accurate metadata and `nextOffset`/result cursor as applicable, and reparsing `content[0].text` must produce the same partial envelope the renderer sees.

### 9.2 Heavy guard matrix and real spawned lifecycle path

The predicate is exact: when `verbose === true` or `include_tool_results === true`, `limit` must satisfy `typeof limit === "number"`, `Number.isFinite(limit)`, `Number.isInteger(limit)`, and `1 <= limit <= 10`. No defaulting or numeric coercion occurs for a heavy call.

Run the following table for each heavy flag separately and for both flags together at **both** enforcement boundaries:

| `limit` input | Generated Pi guard | Authenticated agent route | Fetch / `sessionFileRead` count |
|---|---|---|---:|
| omitted / `undefined` | reject | reject when query omitted | 0 |
| `null` | reject | reject `limit=null` | 0 |
| string `"10"` | reject | reject the quoted query value `limit=%2210%22` (and other text such as `limit=ten`); canonical HTTP integer text `limit=10` parses to the valid integer | 0 for rejected forms |
| `1.5` | reject | reject `limit=1.5` | 0 |
| `0` | reject | reject `limit=0` | 0 |
| `-1` | reject | reject `limit=-1` | 0 |
| `NaN`, `Infinity`, `-Infinity` | reject | reject those literal query spellings | 0 |
| `11` and a larger integer | reject | reject before transcript read | 0 |
| `1`, `10` | allow | allow | exactly 1 at the boundary under test |

All rejections return the existing structured `CONTEXT_HEAVY_LIMIT_REQUIRED` contract. Ordinary compact calls with both heavy flags absent/false retain their default and pass. Route cases use a valid authenticated agent caller header; paired direct REST cases prove this agent policy did not become a global REST limit.

The decisive stale-override tests must not stop at constructing a `ToolManager`, manually calling `computeToolActivationArgs()`, importing extension files, or invoking a handler in-process. Use a real `SessionManager` lifecycle and `RpcBridge` child boundary:

1. **Direct/server winner:** install a stale server-scope `agent` override whose execute path increments a fetch sentinel and lacks the local guard. Create and start a direct session through `SessionManager`; let its real `RpcBridge` spawn the lightweight test Pi child/extension host with the exact generated argv/env. Assert the resolved provider provenance is the stale server directory and the generated immutable guard is also loaded. Send the heavy tool call over the bridge protocol and observe `CONTEXT_HEAVY_LIMIT_REQUIRED`, zero stale fetches, and zero transcript-route reads. Repeat after the session's normal respawn/restore path.
2. **Project/sandbox winner:** install a distinct stale project override and create a project-scoped sandbox session through the same public lifecycle. The child must be spawned through the sandbox-aware `SessionManager`/`RpcBridge` path, not by manually loading host paths. Assert the project/sandbox override is the recorded winner, the generated guard path survives path translation and is loaded by the child, and the same heavy call produces zero gateway/transcript reads.
3. In both scenarios, send valid heavy calls with limits `1` and `10` and one ordinary compact call to prove the spawned tool remains usable; serialize the actual returned Pi value for the final-budget assertion.

Only the gateway endpoint and transcript-read counters are test doubles. Activation, winning-provider selection, session creation, spawn/respawn, RPC dispatch, extension loading, and guard interception are the production classes/paths. This is the lifecycle regression for the live split-brain failure; direct builtin-import tests remain useful but are not acceptance evidence.

### 9.3 REST integration

Extend `tests2/integration/transcript-api.test.ts` with two callers over the same fixture:

- ordinary authenticated REST, no agent caller header: legacy include defaults and UI-compatible verbose content remain unchanged;
- authenticated agent-bound request: canonical scrubbed/budgeted projection and the complete heavy-input table from §9.2, with every rejected case occurring before the injected `readContent`/`sessionFileRead` spy runs.

The valid agent-bound cases `limit=1` and `limit=10` each read once. Retain existing tests for negative offsets, pattern/context, cross-project access, and structured error mapping.

### 9.4 Bobbit metadata

Add `bobbit_read(get_session)` acceptance coverage with a payload containing identity, timing, links, error counters, paths, model pins, and UI/runtime bookkeeping. Assert compact keeps the former groups and omits the latter; `verbose:true` remains the on-demand escape hatch.

### 9.5 Renderer/browser coverage

If `details.messages` or author/tool references change, add a DOM test plus one browser journey that:

- renders a compact `read_session` card with Pi call/result metadata;
- opens the full transcript modal;
- verifies direct UI pagination still works after reload;
- verifies no raw result is exposed implicitly.

### 9.6 Objective original-question replay acceptance

The replay must not read mutable live sessions or use comparison session `3e541ac7-83f4-48e6-a408-d5ea41b902f5`'s answer as evidence. Capture a stable, minimal fixture set under `tests2/fixtures/read-session/original-question-replay/` with `fixtureRevision: 1` and SHA-256 hashes in `manifest.json`. The manifest has exactly six candidates:

1. standalone PR review `e6717bf3-5768-4b09-9bdb-f7c26cc4fd49`;
2. workflow bug hunt `llm-review-889950f7-e15`;
3. workflow code quality `llm-review-0072b056-b90`;
4. workflow regression coverage `llm-review-624e3bde-d6a`;
5. workflow security `llm-review-464b420c-062`;
6. workflow gap analysis `llm-review-8f4ea9b6-da3`.

Each candidate fixture contains only captured/synthetic metadata, prompt text, tool-call/result metadata, cited finding/verdict rows, and the minimum bounded evidence excerpts needed for the comparison. It excludes the audited comparison answer. The manifest also contains the two reviewed SHAs—workflow `62d3ca6d4feaa3849a1830ad39ff3bf97cfcd8fd` and standalone PR head `62e12dfd04e2673063cf219da991878f7ce23207`—plus a captured path/digest list proving their production implementation is identical and only workflow configuration/design documentation changed. Standalone model metadata is present; workflow model metadata is explicitly `unknown` rather than inferred.

The expected report is objective: it must emit exactly these substantive comparison findings, each with fixture row IDs as citations:

- `two-cross-layer-misses`: the standalone review alone formally found (a) aggregate Git actions/history omitted a repository key and therefore targeted `session.cwd`/the wrong or non-Git root, and (b) aggregate `mergedIntoPrimary` came from the first component and could display “Merged” while another component was ahead/unmerged.
- `coordination-primary-cause`: the main advantage was an open-ended coordinated adversarial audit with overlapping cross-layer traces and parent severity synthesis, versus independent gate-specific verdicts with no cross-gate synthesis.
- `prompt-contributed-not-sufficient`: the broad “any verifiable bugs or malicious code” prompt encouraged exploration; narrow gate objectives, reassuring-but-incomplete tests, and design text encoding the faulty rule mattered more than the bug-hunt high-severity threshold alone.
- `github-not-decisive` and `snapshot-not-decisive`: GitHub improved navigation, but the relevant production code was identical at the two captured SHAs, so neither GitHub access nor snapshot timing explains the misses.
- `model-cause-unknown`: standalone model/reasoning is known, comparable workflow model metadata is absent, so model quality is not a supported causal finding.
- `not-uniformly-superior`: workflow reviewers found other stale-component, sole-root partial-result, and diagnostic-disclosure issues; the standalone advantage was specifically cross-layer semantic/action-routing defects.

Replay the original question against those six candidates with this fixed protocol:

1. Fetch compact `get_session` metadata exactly once per candidate.
2. Issue at most one compact tail or regex page per candidate (`limit <= 10`), using returned tool names, arguments, statuses, indexes, and sizes.
3. Use at most one bounded result slice total, only if the compact evidence is insufficient.
4. Follow only returned continuations; intervals for a candidate may not overlap.
5. Stop when all seven expected finding IDs are evidenced.

Acceptance bounds are: **exactly 6 metadata calls, at most 7 `read_session` calls, at most 13 calls total, at most one result slice, zero verbose reads, no raw/broad result window, and at most 200 KiB total** across `Buffer.byteLength(JSON.stringify(actualToolReturn), "utf8")` for all calls. Every individual successful extension return is at most 50 KiB. The replay report records the ordered call ledger, parameters, returned ranges, per-call final bytes, cumulative bytes, citations, and stop reason. It passes only when the finding-ID set and detailed claims above match exactly; “same substantive conclusion” without this fixture/rubric is not acceptance.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Budget truncation corrupts pagination or causes overlapping reads | Return actual window endpoints plus an explicit continuation over the filtered list; test raw and pattern modes |
| JSON escaping or wrapper details push an inner envelope over 50 KiB | Fit by serializing the actual canonical and audited legacy extension return objects; test quote/control-heavy, emoji, and oversized-single-row cases |
| Slices repeat/skip Unicode, combining, or newline units | Use normative UTF-16 `[start,end)` cursors and exact `nextCursor=end`; pin the surrogate error plus combining/CRLF reassembly fixture |
| Regex search leaks the matching omitted body | Match server-side against raw text, project only canonical metadata unless a slice is explicitly requested |
| Provider scrub removes legitimate tool output fields named `signature` | Apply field policy only to provider/message metadata; explicitly retain `{"signature":"customer-visible-signature"}` in result-including projections and raw canonical extraction |
| Result handles point at different content after rewrite/compaction | Bind handle to message/block identity plus a short digest; return structured stale error on mismatch |
| Author dictionaries break attribution or renderer labels | Keep `kind/id/label` once in the envelope; direct REST unchanged; DOM/browser tests resolve refs |
| Stale overrides bypass a builtin-only fix again | Put the heavy invocation rule in the immutable generated guard and server agent boundary; test a stale override winner |
| Server route accidentally changes UI/direct REST | Agent policy derives from authenticated caller identity, never default query behavior; paired integration assertions |
| Wrapper `details` silently reintroduce duplication | Canonical details contain scalars only; serialize the complete actual Pi return and exact audited legacy duplicate profile against the single final budget |
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
