# Bound Session Diagnostics — Issue Analysis

Status: issue-analysis artifact for goal **Bound Session Diagnostics**. This document describes the pre-fix behavior and the implementation boundary; it is not the shipped user guide.

The incident evidence and root-cause sections remain historical. The response contract and audited matrices are the rationale for the shipped projection. The shipped envelope adds explicit `pageStart`/`pageCount` coordinates so a resolved negative or filtered/context window can be refit and continued without confusing page positions with source message indexes.

Post-analysis security hardening also moved all transcript pattern matching to isolated RE2-WASM workers and extended the immutable result boundary through final Pi emission, AgentSession state, and SessionManager persistence. The current operator contract is authoritative in [Bounded session diagnostics](../read-session.md); the additions below record why those server-level safeguards are compatible with the projection rationale.

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
| Agent wrapper | `defaults/tools/agent/extension.ts::callReadSessionEndpoint/execute` | Guard, REST call, Pi tool result | Canonical current wrapper and slice params; not trusted as final budget authority because stale overrides may win |
| Shared limit helper | `defaults/tools/_shared/context-heavy-guard.ts` | Checked-in extension guard | Cannot be the sole production guard because overrides shadow it |
| Runtime resolver | `src/server/agent/tool-manager.ts::_loadToolDefinitions/getToolProviders/getExtensionPath` | Picks winning extension | Expose/pin the actual winner; safety must be override-independent |
| Session pipeline | `src/server/agent/session-manager.ts::buildPipelineContext` and restore/respawn bridge setup | Supplies the server-scope `this.toolManager` to direct sessions | Explain/pin the actual server winner; cover project/sandbox winners separately |
| Spawn activation | `src/server/agent/tool-activation.ts::computeToolActivationArgs/writeToolGuardExtension` | Loads extensions and intercepts tool calls | Enforce heavy-read rule in an immutable, always-loaded invocation guard; prepend the output boundary before resolved extensions |
| Post-result boundary | `src/server/agent/tool-result-error-bridge-extension.ts` (extended or sibling `read-session-result-boundary.ts`) | Wraps subsequently registered tool handlers before Pi persists their returns | Reproject and byte-check the actual resolved `read_session` execute return; fail session activation closed if unavailable |
| Agent process | `src/server/agent/rpc-bridge.ts` | Passes resolved extension args to Pi | Integration seam for proving guard + post-result boundary through direct/sandbox spawn, emission, and persistence |
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

Full provider call IDs are used only inside the server-side correlation index and never appear in an agent projection or dictionary. Correlated call/result rows share a page-local `t1`, `t2`, … ref allocated by first selected source-block order. The optional `correlations` dictionary maps that ref only to bounded semantic data (`name`, call `messageIndex`, and `blockIndex`), never the raw provider ID. A result whose call lies outside the page still gets a page-local `tN` entry populated from the full-transcript correlation map. An uncorrelated result gets `r1`, `r2`, … by selected result order and a dictionary entry containing only its own message/block locator and canonical name; this applies equally to a missing ID and a present ID with no matching call.

#### 6.1.1 Full tool-call search corpus

`argumentsPreview` is presentation only. Pattern matching never searches that bounded preview. Before pagination or projection, every Anthropic `tool_use` and Pi `toolCall` block contributes two independent, unbounded server-side search segments in source-block order:

1. its canonical tool name; and
2. `canonicalToolCallArguments(call)`, including content beyond the preview cap.

The canonical call name is the first own, non-empty, Unicode-well-formed string in exact priority `name`, then `toolName`, or the literal `unknown`; invalid candidates are rejected without coercion. The argument source is the first own, non-`undefined` field in exact priority `arguments`, then `input`; `null` is selected. A selected string is used unchanged after the same Unicode well-formedness check as direct result text. Any other selected JSON value is encoded with the exact recursive stable JSON encoder and invalid-value rejection from §6.2.2; selected `null` encodes as the literal `null`, while a missing source contributes no argument segment. Strings that happen to contain JSON are not parsed and rewritten. The same canonical argument string feeds the bounded preview (a Unicode-scalar-safe prefix, maximum 512 UTF-16 units, with `argumentsTruncated`) and full search, so Pi and Anthropic shapes cannot disagree about what was searched.

The normative per-message search corpus is a sequence of semantic segments, not one lossy concatenation: visible text segments in source order; each call's name then canonical arguments; and each result's full `canonicalToolResultBody`. The compiled regex is reset to `lastIndex = 0` and tested independently against every segment, avoiding matches synthesized across field/block boundaries. A hit in any segment selects that source message index exactly once. Context expansion then uses the existing transcript-index neighborhood, de-duplicates indexes, and sorts them ascending. `matchCount` counts matching source messages before context expansion. Offset resolution—including negative offsets—then applies to this filtered/expanded index list exactly as it does today.

Projection occurs only after selection. A name or argument hit maps to the ordinary projected row for that source message: canonical name, bounded `argumentsPreview`, and `argumentsTruncated`; an argument match beyond the cap does not promote, splice, or excerpt the hidden suffix. Result-body hits likewise return canonical result metadata only unless a separate handle slice was requested. Transport-budget continuation records the next non-negative position in the same filtered/expanded list; the caller repeats the original pattern/case/context and uses that `nextOffset`, so continuation neither overlaps nor changes the search corpus.

Pin this with an authenticated agent-bound fixture containing both providers, 700-unit arguments whose unique sentinels occur after unit 512, and repeated hits at source indexes 2, 5, and 8:

- a tool-name regex with `context: 1` returns the matching Pi/Anthropic call row plus the exact adjacent transcript indexes, with the call name visible but no hidden argument suffix;
- provider-specific regexes find the Pi `arguments` sentinel and Anthropic `input` sentinel beyond the preview, while neither sentinel appears in any returned C/CR/V/VR row;
- a shared beyond-preview argument regex with `context: 0, offset: -2, limit: 1` resolves against the three-row filtered list, returns source index 5, reports `nextOffset: 2`, and a follow-up with the same filter plus `offset: 2` returns source index 8 without overlap;
- the same negative-offset/continuation assertions run for a tool-name regex, and result-body matching remains metadata-only.

These tests run through the agent-facing extension return, not only `flattenText()` or direct REST, and assert each actual return stays within 50 KiB.

#### 6.1.2 Safe regex execution

Both direct and agent-bound searches compile `pattern` with RE2-WASM in Unicode mode inside a resource-bounded worker. Case-insensitive matching uses `iu`; `case_sensitive: true` uses `u`. Patterns are capped at 4096 UTF-16 units and oversized inputs return `invalid_params` before transcript I/O. Syntax errors and unsupported RE2 features—notably lookahead, lookbehind, and backreferences—return the same stable `invalid_regex` discriminator in both modes; compiler `detail` is diagnostic text rather than a compatibility field.

This is the one intentional direct-REST matching restriction. Retaining JavaScript's backtracking engine would leave the gateway event loop vulnerable to adversarial transcript patterns, so preserving those JavaScript-only constructs was incompatible with bounded diagnostics. Supported pattern behavior, direct response projection, pagination, negative offsets, context expansion, author objects, and result defaults remain unchanged. Agent-bound canonical segments are matched separately as specified above; direct REST retains its legacy flattened segment per message. Chunking is worker transport only and never changes regex semantics within one segment.

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
  handle?: string;             // e.g. "rs1:m6h:b0:NUBAzC7icgMYwEPyuR8OFQyx29U"
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

#### 6.2.1 Canonical result identity and status

Result metadata is normalized once, before C/CR/V/VR projection. For a block-level result, the **direct result object** is the result block and the enclosing message is a lower-priority fallback. For a message-level Pi result, `fullMessage` is the direct result object and is not synthesized into a second alias-bearing block.

A correlation ID is the first own, non-empty, well-formed string in this priority: direct `tool_use_id`, `toolUseId`, `toolCallId`, `tool_call_id`, then the same four keys on the enclosing message. Direct `id` is accepted last only on an object whose exact type is `tool_result` or `toolResult`; a generic message `id` is never treated as a call correlation. Invalid candidates are rejected and the next candidate is considered; values are never trimmed, stringified, or truthiness-coerced. A call-side correlation ID is the first own, non-empty, well-formed string in exact priority `id`, `toolCallId`, `tool_call_id`, `toolUseId`, `tool_use_id` on that `tool_use`/`toolCall`; invalid candidates are rejected without coercion and an earlier conflicting alias wins. The correlation map uses the nearest preceding call with that exact canonical ID from the full transcript, even when the call is outside the returned page. If historical duplicate call IDs exist, nearest-preceding order is deterministic; a later/unrelated call never rewrites an earlier result.

Canonical `name` uses the first valid candidate in this exact priority:

1. direct result own `name`;
2. direct result own `toolName`;
3. enclosing message own `name`;
4. enclosing message own `toolName`;
5. correlated call name; or
6. the literal `unknown` when correlation is missing and no direct candidate is valid.

A valid name is a non-empty, Unicode-well-formed string; there is no numeric/object coercion and no whitespace trimming. Thus conflicting `name`/`toolName` values choose `name`, and any direct valid name wins a conflicting correlation-map name. Lower-priority conflicts are not copied into output. Projection applies the 128-unit scalar-safe cap only after this choice.

Canonical `status` uses the first valid candidate in this exact priority: direct `status`, direct `isError`, direct `is_error`, enclosing-message `status`, enclosing-message `isError`, enclosing-message `is_error`; the enclosing object is skipped for message-level Pi results because it is already the direct object. `status` accepts only the exact strings `ok`, `error`, and `unknown`. `isError`/`is_error` accept only booleans and map `true` to `error` and `false` to `ok`. All other spellings/types—including `"true"`, `1`, `success`, and mixed-case strings—are rejected as candidates without coercion. If no valid candidate remains, status is `unknown`. A valid higher-priority value wins even when a lower-priority alias conflicts; only the normalized value is projected.

Pin the precedence with exact fixtures in every mode:

| Direct result metadata | Enclosing / correlation metadata | Canonical result |
|---|---|---|
| `name:"read", toolName:"grep", status:"ok", isError:true, is_error:true` | correlation name `find` | `name:"read", status:"ok"` |
| `toolName:"grep", isError:false, is_error:true` | correlation name `find` | `name:"grep", status:"ok"` |
| no direct name, `status:7, isError:"true", is_error:true` | correlation name `find` | `name:"find", status:"error"` |
| block `name:"read", status:"error"` | enclosing `name:"grep", status:"ok"`; correlation name `find` | `name:"read", status:"error"` |
| no direct/enclosing name or status and an unmatched correlation ID | missing correlation | `name:"unknown", status:"unknown", ref:"rN"` |
| no correlation ID, name, or status fields | no correlation candidate | `name:"unknown", status:"unknown", ref:"rN"` |

The fixture assertions also prove that the losing names, all status/error aliases, and raw correlation IDs are absent from the projected result record and envelope dictionaries. A matched result shares its call's `tN`; both an unmatched ID and a wholly missing ID receive deterministic page-local `rN` refs with only source locators in `correlations`. Missing correlation never borrows the most recent unrelated call and never fails body sizing, handle generation, search, or slicing.

#### 6.2.2 One canonical tool-result body

Every operation that needs result text calls one `canonicalToolResultBody(result)` implementation. There is no separate text flattener for metrics, regex, digests, or slices.

Body selection and extraction are normative:

1. For a block-level result, inspect that result block; for a message-level Pi result, inspect `fullMessage`. Select the first **own** field whose value is not `undefined` in this exact priority: `content`, `output`, `result`. `null` is a selected value. If none exists, the body is missing.
2. A selected string is one payload leaf, unchanged, but every direct string/text leaf must be Unicode scalar-value well-formed (no unpaired UTF-16 surrogate). Reject an ill-formed leaf as `INVALID_RESULT_BODY`; never let `Buffer.from` replace it with U+FFFD. A selected array is traversed depth-first in ascending array-index order.
3. Within an array or recognized carrier, a JSON object with exact `type: "text"` and a string `text` contributes that `text` unchanged after the same well-formedness check; all its other keys are metadata and do not contribute. No untyped `{text: ...}` object is treated as a text block.
4. Typed opaque/binary blocks are recognized before carriers by this exact `type` set: `image`, `audio`, `video`, `file`, `attachment`, `binary`. Their raw payload never contributes. Select at most one payload from own keys in priority `data`, `base64`, `bytes`, `content`; convert a well-formed string unchanged or any other JSON value with the stable JSON encoder below; and contribute only the stable-JSON metadata object `{type,mimeType?,encodedChars,digest,omitted:true}`. `mimeType` is an own well-formed string capped at a scalar boundary within 128 UTF-16 units; `encodedChars` is the selected payload representation's UTF-16 length; and `digest` is lowercase `sha256:` plus 64 hex characters over its UTF-8 bytes. Ignore all other block keys. A missing payload hashes the empty string. Thus CR/VR can expose an opaque summary and stale detection without ever returning base64/binary bytes.
5. Any other JSON object with an own, non-`undefined` `content`, `output`, or `result` field is a carrier. Select exactly one field using that same priority and recurse into it; other keys do not contribute. This prevents `content`/`output` aliases from duplicating a body.
6. A plain JSON object that is neither a typed text/opaque block nor a carrier contributes one leaf from a recursive stable JSON encoder. The encoder writes `{`, then each own key in lexicographic JavaScript UTF-16 code-unit order as `JSON.stringify(key):stableJson(value)` separated by commas, then `}`; it does **not** build a sorted ordinary object because `JSON.stringify` would reorder integer-like keys. Arrays retain index order. Primitive spelling/escaping comes from `JSON.stringify`. This is also how a structured result such as `{"signature":"customer-visible-signature","thinkingSignature":"domain-value"}` remains legitimate result content rather than provider metadata.
7. JSON numbers and booleans contribute their `JSON.stringify` spelling. Selected `null`, missing bodies, and null array entries contribute no leaf. Transcript JSON cannot contain `undefined`, functions, symbols, `BigInt`, or cycles; encountering one through an in-memory test seam is `INVALID_RESULT_BODY`, not lossy coercion.
8. Concatenate all leaves with the empty separator. Do not insert spaces or newlines between blocks. Thus adjacent leaves `"a"`, `"b"` form `"ab"`, and leaves ending in `"\r"` and beginning in `"\n"` form one canonical CRLF.
9. Validate that the concatenated canonical body is still Unicode well-formed before chars/lines/bytes, digest, regex, or slicing. This makes UTF-8 encoding injective for accepted bodies and makes the surrogate-boundary slice contract total.

The resulting string is the single source of truth:

```ts
const canonicalBody = canonicalToolResultBody(result);
const chars = canonicalBody.length; // JavaScript UTF-16 code units
const lines = canonicalBody === ""
  ? 0
  : 1 + (canonicalBody.match(/\r\n|[\r\n]/g)?.length ?? 0);
const bytes = Buffer.byteLength(canonicalBody, "utf8");
```

`type` still describes the selected outer value and `blocks` is the selected root array's length when applicable, but neither changes canonical text. Regex matching inspects `canonicalBody`; the digest hashes it; excerpts slice it; and `chars`/`lines`/`bytes` measure it. No operation sums per-leaf line counts.

Pin these boundary fixtures exactly:

| Selected body | Canonical body | chars | lines | bytes |
|---|---|---:|---:|---:|
| `[{"type":"text","text":"a"},{"type":"text","text":"b"}]` | `ab` | 2 | 1 | 2 |
| `[{"content":[{"type":"text","text":"a\r"}]},{"output":[{"type":"text","text":"\nb"}]}]` | `a\r\nb` | 4 | 2 | 4 |
| `{"z":1,"a":"x"}` | `{"a":"x","z":1}` | 15 | 1 | 15 |
| `{"content":null,"output":"ignored","result":"ignored"}` | empty string (`content` wins) | 0 | 0 | 0 |
| `{"text":"a"}` (untyped) | `{"text":"a"}` | 12 | 1 | 12 |
| `[true,2]` | `true2` | 5 | 1 | 5 |
| `{"z":{"b":1,"a":2},"a":[{"d":4,"c":3}]}` | `{"a":[{"c":3,"d":4}],"z":{"a":2,"b":1}}` | 39 | 1 | 39 |
| `{"2":"two","10":"ten"}` | `{"10":"ten","2":"two"}` | 22 | 1 | 22 |
| `{"type":"image","mimeType":"image/png","data":"QUJD"}` | `{"digest":"sha256:d9cae0dbdbf078b2020e2abe5fcd74bc1edba83c35f6b8a86d638ed9b8d3d1f9","encodedChars":4,"mimeType":"image/png","omitted":true,"type":"image"}` | 154 | 1 | 154 |
| `[null,{"type":"text","text":""}]` | empty string | 0 | 0 | 0 |

In-memory-only fixtures pin boundaries JSON cannot express: an inherited `content` property is ignored while an own `output` wins; cyclic/`BigInt` plain objects return `INVALID_RESULT_BODY`; and raw text leaves `"\uD800"` and `"\uD801"` each return `INVALID_RESULT_BODY` rather than collapsing to the same UTF-8 replacement bytes. A source-selection fixture with outer `{ content: null, output: "ignored", result: "ignored" }` separately proves the same own-key/null priority before traversal. Parameterized `attachment` and `binary` blocks carry unique multi-kilobyte payload sentinels: neither sentinel may appear in any C/CR/V/VR projection, their stable summaries must match the exact rule above, and a one-byte payload change must change the result handle and stale the old one.

#### 6.2.3 Path-scoped provider metadata policy

Provider scrubbing is structural and path-sensitive, never a recursive key-name deletion over arbitrary values. The projector classifies a result and selects its `content`/`output`/`result` body before applying the message/block allowlist. It then forbids provider-only own fields such as `thinkingSignature`, `textSignature`, `signature`, `encrypted_content`, `encryptedContent`, replay/encrypted payloads, raw response objects, and provider metadata when they occur on the raw message envelope, `fullMessage` bookkeeping, non-result thinking/reasoning/text blocks, or transport wrapper/details objects. Those structural source paths have no corresponding field in C/CR/V/VR.

The deny policy does **not** descend into the selected canonical result body. Plain result objects use the stable JSON rule unchanged, and text result leaves remain unchanged. Therefore keys named `signature`, `thinkingSignature`, `textSignature`, or `encrypted_content` and their values are legal domain data inside `canonicalToolResultBody`, can participate in server-side pattern matching, and can appear literally within `toolResults[*].excerpt.text` in CR/VR. The same principle applies to tool-call arguments. Only typed opaque/binary result blocks use the separate metadata-only rule in §6.2.2.

Tests must parse the projected envelope and assert paths, not ban substrings from `JSON.stringify(projection)`: provider-field paths and their unique provider-only sentinels are absent from all structural message/block/wrapper locations, while the exact canonical result `{"signature":"customer-visible-signature","thinkingSignature":"domain-value"}` remains byte-for-byte searchable and present in a requested CR/VR excerpt. C/V omit that body because result bodies are redacted, not because either key was scrubbed. A path walker explicitly exempts canonical result body/excerpt text from provider-metadata assertions; a complementary assertion parses the excerpt text and requires both otherwise-forbidden key names and values there.

### 6.3 Lazy bounded slices

`include_tool_results: true` no longer means “return the entire body.” It means “include a bounded, self-describing excerpt.” The additive agent-tool parameters are:

```text
result_handle="rs1:m6h:b0:NUBAzC7icgMYwEPyuR8OFQyx29U"
result_cursor=0
result_limit=4096
```

The slice contract is normative:

- Cursors and `excerpt.start`/`excerpt.end` are **JavaScript UTF-16 code-unit offsets** into the canonical result text. This deliberately matches `size.chars` and JavaScript `String.length`/`slice`.
- Ranges are half-open: `[start, end)`. An omitted `result_cursor` means `0`; `complete` is exactly `end === size.chars`; `nextCursor` is exactly `end` when incomplete and `null` when complete.
- `result_limit` is an integer count of UTF-16 code units. Its default is **4096**, its minimum is **1**, and its maximum is **8192**. The whole-response fitter may return fewer units. It never returns more than requested except for the explicit one-scalar progress case below.
- A caller cursor must be an integer in `[0, size.chars]` and must not point between the high and low surrogates of one scalar value. The server chooses the largest valid scalar boundary at or below `start + result_limit`; when `result_limit: 1` starts before an astral scalar, it advances two code units as the sole progress-guaranteeing exception. Combining sequences and CRLF are not atomic: a boundary may fall between their code units, and exact concatenation using each `end`/non-null `nextCursor` must neither skip nor repeat either unit.
- A message-level Pi result uses conceptual block `b0`; block-level results use their real block index. Handles have the exact form `rs1:m<messageIndex-base36>:b<blockIndex-base36>:<digest>`. Message indexes are non-negative JavaScript safe integers; block indexes are unsigned 32-bit integers. Both use lowercase base36 without leading zeroes (except zero itself). The digest contract below binds the handle to session/message/block identity and the canonical body so transcript rewrite/compaction cannot silently rebound it.
- Validation uses the existing structured error envelope with stable codes: `INVALID_RESULT_HANDLE` for missing/malformed handles, `RESULT_NOT_FOUND` for a valid handle whose message/block does not exist, `STALE_RESULT_HANDLE` for a digest mismatch, `INVALID_RESULT_CURSOR` for non-integer/out-of-range/surrogate-interior cursors, and `INVALID_RESULT_LIMIT` for non-integer or out-of-range limits. No error substitutes a different result or resets the cursor implicitly.
- Pattern matching inspects the entire canonical result body server-side, but a match returns only metadata unless the caller separately requests a slice.

The pinning Unicode fixture is the exact string `A😀e\u0301\r\nZ` (eight UTF-16 units). With requested limits `1,2,2,1,1,1`, continuation must return ranges `[0,1)`, `[1,3)`, `[3,5)`, `[5,6)`, `[6,7)`, and `[7,8)` and concatenate byte-for-byte to the original. A separate `start: 1, result_limit: 1` assertion returns `[1,3)` under the progress exception. Cursor `2` is invalid because it is inside `😀`; splitting `e\u0301` or `\r\n` across separately requested legal boundaries is allowed and must still reassemble exactly.

The handle digest is normative, not an implementation-selected "short hash":

- Algorithm: SHA-256 over an exact binary preimage; retain the first 20 digest bytes (**160 bits**) and encode them as 27 unpadded base64url characters.
- Domain and identity preimage, in order: UTF-8 `bobbit.read-session.result-handle.v1\0`; session-id UTF-8 byte length as unsigned 32-bit big-endian; session-id UTF-8 bytes; message index as unsigned 64-bit big-endian; block index as unsigned 32-bit big-endian; canonical-body UTF-8 byte length as unsigned 64-bit big-endian; canonical-body UTF-8 bytes.
- The full handle is at most 64 ASCII characters: a maximum safe-integer message index uses 11 base36 characters and an unsigned-32-bit block index uses 7, so `rs1:m` + 11 + `:b` + 7 + `:` + 27 is 53. A 160-bit retained digest provides 80-bit birthday-collision resistance while meeting that cap.
- Known vector: session `session-1`, message `233`, block `0`, canonical body `A😀\r\nZ` has full SHA-256 `354040cc2ee2720318c043f2b91f0e150cb1dbd58f982a47454820e0cb9b6554`, suffix `NUBAzC7icgMYwEPyuR8OFQyx29U`, and handle `rs1:m6h:b0:NUBAzC7icgMYwEPyuR8OFQyx29U`.
- Lookup decodes the indexes, locates that exact result in the requested session, reruns `canonicalToolResultBody`, and recomputes the digest before validating the cursor. Missing identity is `RESULT_NOT_FOUND`; a located identity whose canonical body changed is `STALE_RESULT_HANDLE`. It never accepts a handle by digest prefix, silently rebinds after compaction, or hashes raw provider objects.

This replaces anonymous raw text and makes continuation explicit.

### 6.4 One final serialized Pi-result budget

There is one normative transport invariant:

```ts
const READ_SESSION_FINAL_RESULT_MAX_BYTES = 50 * 1024;
const serializedBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
```

For every agent-facing success or error, the final Pi tool return, the emitted/AgentSession-state `toolResult` message, and the persisted JSONL row each serialize to at most `READ_SESSION_FINAL_RESULT_MAX_BYTES` (50 KiB), including JSONL outer metadata and its newline. The invariant is not a route-envelope estimate or a limit on `content[0].text` alone.

#### 6.4.1 Override-independent output boundary

Budget authority lives in a gateway-generated, content-addressed `read-session-result-boundary` Pi extension, implemented in `tool-result-error-bridge-extension.ts` rather than in a tool-group extension. Its source is regenerated and byte-verified, mounted read-only into sandboxes, and injected before every resolved builtin/server/project/market tool extension whenever `read_session` is granted. Session activation fails closed for `read_session` if this boundary cannot be materialized.

Registration wrapping canonicalizes the actual resolved handler return. Shared ExtensionRunner and AgentSession seams then reapply the boundary after the complete `tool_result`, `tool_execution_end`, and `message_end` listener chains and before AgentSession state or SessionManager JSONL persistence. This second layer is required because Pi extensions use private tool maps and downstream listeners may return or mutate values after the registered handler has already been wrapped.

A canonical successful envelope has an exact discriminated union. All variants require `total` (non-negative safe integer), `returned` (non-negative safe integer equal to `messages.length`), `offsetStart` and `offsetEnd` (safe source-message indexes), and `messages` (array). Optional common fields are `matchCount` (non-negative safe integer), paired `pageStart`/`pageCount` (non-negative safe integers), `nextOffset` (safe integer or `null`), and `authors`/`correlations` (object dictionaries only). `pageStart` is the resolved zero-based position in the raw or filtered/context-expanded pageable sequence; `pageCount` is that sequence's total length. They are absent from targeted result-slice and unrecognized-wrapper envelopes. When present, `pageStart <= pageCount`, `returned <= pageCount - pageStart`, and a numeric `nextOffset` equals `pageStart + returned`. `truncatedBy` is the exact union `"transport_budget" | "extension_return_unrecognized"`; it is legal only when `partial` is exactly `true`.

The variants are normative:

```ts
type SuccessfulEnvelope =
  | (EnvelopeBase & {
      partial?: false;
      truncatedBy?: never;
      continuationRequest?: never;
      wrapperDiagnostics?: never;
    })
  | (EnvelopeBase & {
      partial: true;
      truncatedBy: "transport_budget";
      continuationRequest:
        | { kind: "page"; offset: number }
        | { kind: "result_slice"; result_handle: string;
            result_cursor: number; result_limit: number };
      wrapperDiagnostics?: never;
    })
  | (EnvelopeBase & {
      partial: true;
      truncatedBy: "extension_return_unrecognized";
      continuationRequest: RetrySameRequest;
      wrapperDiagnostics: { omitted: true; actualBytes: number };
    });
```

For a `transport_budget` page partial, `nextOffset` is required, non-negative, equals both `continuationRequest.offset` and `pageStart + returned`, and identifies the first unreturned position in the raw or filtered/context-expanded sequence. This normalized coordinate is essential after a negative filtered/context offset: the continuation repeats the same filter parameters and passes the non-negative `nextOffset`, never `offsetEnd + 1`. For a `transport_budget` result-slice partial, `pageStart`, `pageCount`, and `nextOffset` are absent; exactly one returned result has a non-null `excerpt.nextCursor`, and the continuation repeats that result's handle, uses that `nextCursor`, and carries an integer `result_limit` in `[1,8192]`. A transport partial must use one of these two forms and must not contain wrapper diagnostics.

The `extension_return_unrecognized` variant has exact base values `total: 0`, `returned: 0`, `offsetStart: -1`, `offsetEnd: -1`, and `messages: []`; `matchCount`, `pageStart`, `pageCount`, `nextOffset`, `authors`, and `correlations` are absent because they cannot be recovered. Its `continuationRequest` is the bounded retry allowlist defined below, and `wrapperDiagnostics.actualBytes` is a non-negative safe integer measuring the discarded actual wrapper. No other variant may carry `wrapperDiagnostics` or retry fields.

Each message must be an object with a non-negative safe-integer `index` and string `role`; it is then reprojected through the same semantic field allowlist/caps as route messages, so unknown nested fields are discarded. The only summary-row additions are `projectionOmitted: true` with non-negative safe-integer `toolCallCount` and `toolResultCount`; those fields are legal only in a `transport_budget` page partial. Incoming dictionaries are never copied wholesale: the boundary rebuilds only entries referenced by retained messages and lets the fitter limit their count. No coercion of numeric strings or aliases occurs. Before candidate search, if returned `details.session_id` exists it must be a string exactly equal to invocation `params.session_id`, otherwise recovery fails.

Candidate search is deterministic and stops at the first valid source: (1) the returned object itself; (2) `content` array entries in ascending order whose exact `type` is `text` and whose `text` parses as a direct envelope; (3) `details.envelope`; (4) a legacy envelope assembled from exact `details.total`, `matchCount`, `returned`, `offsetStart`, `offsetEnd`, `nextOffset`, and `messages` keys. A lower-priority duplicate/conflict is never merged into a higher-priority candidate. The invocation's already-validated `session_id` binds a direct/text candidate when it has no envelope identity of its own. Unknown top-level envelope/wrapper fields are ignored only after a valid candidate is found; if no source validates, the fixed compatibility partial is used.

The stale lifecycle fixtures use these literal outer shapes rather than an invented size profile (where `E` is the real authenticated route envelope and `X` is oversized):

```ts
// deployed server winner: historical details.messages duplication
{ content: [{ type: "text", text: JSON.stringify(E) }],
  details: { session_id: params.session_id, total: E.total,
    matchCount: E.matchCount, returned: E.returned,
    offsetStart: E.offsetStart, offsetEnd: E.offsetEnd,
    messages: E.messages, extra: X } }

// distinct project/sandbox winner: text envelope plus nested legacy details
{ content: [{ type: "text", text: JSON.stringify(E) },
    { type: "text", text: X }],
  details: { session_id: params.session_id, envelope: E,
    legacy: { messages: E.messages }, extra: X } }
```

The first valid text candidate wins in both. Tests also mutate `details.session_id`, required numeric types, and `returned !== messages.length` to prove malformed convenient fixtures take the bounded unrecognized path rather than being accepted.

The execution order is exact:

1. `prependToolResultBoundary()` places the immutable boundary first in the Pi extension argv. It monkey-patches `pi.tool`, `pi.registerTool`, and `pi.tools.register` before a resolved tool group can register anything.
2. A stale server or project/sandbox `agent` extension still wins normal resolution and registers its own `read_session`; the patched registration API wraps that exact handler. No builtin `read_session.execute()` is substituted and no wrapper-version simulation occurs.
3. Pi's immutable `tool_call` guard validates the heavy-input matrix. If allowed, Pi invokes the wrapped resolved handler. The stale handler performs its real gateway request and constructs whatever legacy/reformatted result it actually returns.
4. The boundary awaits that **actual resolved execute return**. Before the promise is allowed to resolve to Pi, it structurally recovers one agent envelope from, in order: a direct envelope object; JSON in a returned text block; a canonical `details.envelope`; or legacy scalar `details` plus `details.messages`. A candidate must satisfy the exact envelope schema and invocation/session identity; malformed candidates are never coerced or merged. Arbitrary extension-added keys, duplicate `details.messages`, and provider-only wrapper bookkeeping are discarded.
5. The boundary always reprojects a recognized successful envelope through `boundReadSessionResult`; it does this even when the stale return happened to be small. A structured error is instead reduced to bounded `error`, `code`, `status`, `detail`, and `message` diagnostics, with only `code` and `status` duplicated in details. Provider-only errors with no semantic diagnostic become `{"error":"read_session_failed"}`.
6. The immutable runner seam snapshots and revalidates the result after all `tool_result` and `tool_execution_end` listeners. The AgentSession seam does the same around `message_end`, state insertion, and persistence. Accessors, custom `toJSON`, `usage`, provider/model fields, signatures, encrypted/replay blobs, duplicate content, and arbitrary downstream extras are therefore absent from success and error values at every final surface.
7. The fitter measures the exact final return, current-Pi message wrapper, and worst-case persisted JSONL row. Only canonical immutable snapshots that keep all three serialized values within 50 KiB proceed. Spawn, restart/restore, server/project precedence, and sandbox path translation all use the same prepended fail-closed boundary.

An unrecognized **successful** legacy shape is also fail-bounded, not passed through and not converted to a transport error. The boundary emits the legal `extension_return_unrecognized` variant above with exact empty/unknown base values, a fixed-schema `continuationRequest`, and `wrapperDiagnostics: { omitted: true, actualBytes }`. `RetrySameRequest` has the exact required fields `kind: "retry"` and `retrySameRequest: true`; its optional allowlist is a well-formed `session_id` truncated at a scalar boundary to 64 UTF-16 units with `sessionIdTruncated` (ill-formed IDs are omitted); safe-integer `offset`/`limit`; booleans `case_sensitive`, `verbose`, and `include_tool_results`; integer `context` clamped to 0–5; and `patternOmitted: true` when a pattern was present. It never echoes pattern text, result handles, unknown parameters, or arbitrary strings. Invalid/out-of-range scalars are omitted rather than stringified. Consequently even a multi-megabyte input pattern cannot grow this prebuilt fallback beyond its separately asserted 1-KiB ceiling. It does not invent `nextOffset` when the unknown wrapper did not expose one and never includes an excerpt of the unknown return. This compatibility partial tells the caller to retry the already-known request after the override is updated while maintaining the hard ceiling. Recognized upstream success that merely exhausts the byte budget uses the legal `transport_budget` variant and retains the exact `nextOffset`/result cursor described below.

The authenticated route still canonicalizes, scrubs, and pre-fits its agent envelope to avoid needless IPC, but it does **not** predict wrapper overhead and is not the final budget authority. Direct REST remains outside this Pi boundary.

#### 6.4.2 Canonical final value and fitting

The boundary emits one canonical successful shape:

```ts
{
  content: [{ type: "text", text: JSON.stringify(envelope) }],
  details: {
    session_id: boundedSessionId, // scalar-safe prefix, max 64 UTF-16 units
    sessionIdTruncated,
    total: envelope.total,
    matchCount: envelope.matchCount,
    returned: envelope.returned,
    offsetStart: envelope.offsetStart,
    offsetEnd: envelope.offsetEnd,
    nextOffset: envelope.nextOffset
  }
}
```

`details` never contains `messages`; the renderer parses canonical text or uses only these scalars. Measuring this complete value counts JSON quotes/backslashes/control escapes added around the already-serialized envelope, all UTF-8 bytes for emoji, every wrapper key, and `details`. There is no separately fillable 50 KiB inner budget.

The fitter is deterministic. Before fitting, variable semantic fields use explicit UTF-16 caps: role 32, timestamp 64, tool name 128, author label 128, compact visible text 800, verbose visible text 4096, argument preview 512, thinking/error summary 512, and session ID/handle/ref 64. Provider correlation IDs are represented by bounded refs/digests rather than copied raw. Every string cap uses a Unicode-scalar-safe boundary and carries a truncation or invalid-value indicator where loss is diagnostically meaningful. Hitting one of these declared projection caps sets the row-level truncation flag; it does not by itself set envelope `partial` or claim transport exhaustion.

1. Construct canonical messages using those field caps, accurate metadata, and requested ordering.
2. Add one message at a time and build/serialize the canonical **actual Pi value**.
3. For an explicit targeted result-slice request only, if the requested excerpt would overflow, binary-search a Unicode-safe excerpt prefix while rebuilding and serializing the complete value at each probe. Emit the `transport_budget` result-slice variant whose continuation repeats the handle and exact non-null `nextCursor`. Never estimate from source characters.
4. For a transcript page row that is still too large, remove optional call/result previews and excerpts but retain its index, role, canonical call/result name, status, size, omission state, result handles, and author reference. The retained result handles permit separate targeted slices. Preview removal is normal bounded projection, not an unretrievable transport continuation; a pathological count of otherwise bounded records falls through to the summary fallback in step 6.
5. If another message would overflow, omit that and later messages and emit the `transport_budget` page variant: set `nextOffset` to the first unreturned position in the requested/filtered sequence and require `continuationRequest: { kind: "page", offset: nextOffset }`. `returned`, `offsetStart`, and `offsetEnd` describe only rows actually returned. Page fitting never emits a result-slice continuation, and targeted result-slice fitting never emits a page continuation.
6. A violated internal field/count-cap invariant uses separately budget-pinned canonical outputs, never an untyped “compatibility” shape. A page request returns one fixed-schema summary row for the current source message (`index`, `role`, `projectionOmitted: true`, and non-negative `toolCallCount`/`toolResultCount`), then sets `nextOffset`/page continuation to the following filtered-list position so retry cannot loop. A targeted slice with `cursor < size.chars` returns canonical result metadata plus at least the next complete Unicode scalar (two UTF-16 units for an astral scalar); if content remains, it is the result-slice partial with strictly greater `nextCursor`, otherwise it is the complete variant with `nextCursor: null`. A target at `cursor === size.chars` returns the complete empty `[cursor,cursor)` excerpt. These fixed one-scalar/empty values are separately proven to fit, never carry `wrapperDiagnostics`, never repeat a continuation cursor, and never leak any other part of the oversized intermediate result.
7. Serialize the actual value once more at the post-handler boundary and assert the invariant before returning it.

An upstream-successful read is never converted to an error merely because its content is large. A single oversized visible message returns a complete bounded row with `textTruncated`; a page result returns bounded metadata/excerpt plus a handle; and only actual page omission or a targeted slice shortened below the requested range sets envelope `partial` with the corresponding schema-valid continuation. This makes exhaustion explicit and recoverable rather than relying on transport truncation.

A table-driven schema suite validates the complete variant plus both `transport_budget` continuation forms and `extension_return_unrecognized` before the boundary serializes them. It also rejects: either `truncatedBy` value without `partial: true`; an unknown truncation reason; a page partial without matching `nextOffset`/page continuation; a slice partial without a matching returned excerpt cursor; a summary row outside a transport-page partial or without both counts; an unrecognized partial without `kind: "retry"`, `retrySameRequest: true`, or `wrapperDiagnostics`; wrapper diagnostics on any other variant; and the previously contradictory fallback shape under a transport-only schema. The suite also pins fallback progress: an interior targeted cursor advances by one Unicode scalar and is partial only when content remains; a final-scalar cursor returns a complete excerpt; and `cursor === size.chars` returns a complete empty excerpt. The real stale-wrapper tests validate the parsed `content[0].text` against this same schema, preventing unit-only type assertions from masking an illegal emitted partial.

## 7. Response-projection field audit

Legend:

- **K** — keep semantic value;
- **S** — bounded summary/preview;
- **R** — compact dictionary/reference;
- **M** — canonical normalized metadata;
- **E** — bounded excerpt with cursor;
- **—** — omit;
- **N/A** — mode does not exist for that operation.

Modes are **C** compact, **CR** compact with result excerpts, **V** verbose with results redacted, and **VR** verbose with result excerpts. “Verbose” means more semantic content, never provider replay blobs or unbounded result bodies.

The shipped agent projection records both normalized page coordinates (`pageStart`, `pageCount`, `nextOffset`) and returned source coordinates (`offsetStart`, `offsetEnd`). This is an additive agent-bound field group: direct REST/UI keeps its legacy envelope and derives its own pagination as before.

| Field or normalized group | C | CR | V | VR | Observed / typical size | Diagnostic usefulness | Size rating | Decision | Compatibility constraints |
|---|---:|---:|---:|---:|---|---|---|---|---|
| Envelope totals, match count, normalized `pageStart`/`pageCount`, returned source range, page continuation | K | K | K | K | Typically <250 B/call | High | Low | Keep | Preserve negative-offset and regex/context semantics; `nextOffset` is a page position, while `offsetStart`/`offsetEnd` are source indexes; direct REST/UI shape remains unchanged |
| Message `index` | K | K | K | K | Roughly 10–25 B/message | High | Low | Keep | Existing source indexes retain meaning |
| Message `role`, `ts` | S | S | S | S | Roughly 40–80 B/message after caps | High | Low | Bound and retain | Role is capped at 32 UTF-16 units; timestamp at 64 with explicit truncation/invalid indicators; direct REST values remain unchanged |
| Author identity (`kind`, `id`, `label`) | R | R | R | R | Live object 103 B/message; repeats across most rows | High for attribution | Medium aggregate | Canonicalize into envelope dictionary + short refs | Direct REST/UI author objects unchanged; renderer resolves refs |
| Human/assistant visible text | S | S | bounded K | bounded K | Compact currently up to 800 chars/message; verbose unbounded | High | Medium/high | Summarize, then whole-response budget | Preserve visible text and regex behavior; indicate truncation |
| Thinking summary text | — | — | S | S | Usually tens of chars; currently coupled to large signatures | Medium | Low after scrub | Summarize | Do not expose private replay metadata |
| `thinkingSignature`, `textSignature`, encrypted/replay/provider metadata | — | — | — | — | **2.81 MB observed**; often hundreds–thousands of bytes/block | None for diagnostics | Critical | Omit with an explicit path-scoped provider-field denylist/allowlist | Scope scrub to provider message/block/wrapper metadata paths; preserve same keys in canonical tool-output text |
| Tool call name + arguments | S | S | S | S | Normally 20–250 B/call after cap; Pi calls currently disappear | High | Low | Canonicalize Anthropic `tool_use` + Pi `toolCall` | Accept `arguments` then `input`; full canonical name/arguments remain searchable beyond the bounded preview; tool-only rows cannot be blank |
| Full provider call IDs and alias IDs | R | R | R | R | Live composite ID 83 chars, repeated in call/result/aliases | Medium | Medium aggregate | Use server-side only; project short page-local ref + message/block locator, never raw ID | Preserve correlation meaning without returning provider identifiers |
| Result name, normalized status, measured size | M | M | M | M | Typically 80–180 B/result | High | Low | Canonicalize | One `name`, one `status`, one `size`; exact direct/alias/correlation precedence; retain `ok/error/unknown` |
| Nested result text metrics | M | M | M | M | Current live result says only `array, blocks:1`; actual body may be hundreds of KB | High | Low | Summarize accurately | Keep outer `type`/`blocks` while adding chars/lines/bytes |
| Duplicate `toolName`/`name`, `isError`/`is_error`/`status`, body aliases | — | — | — | — | Tens–hundreds B/result plus ambiguity | None once normalized | Medium aggregate | Canonicalize/omit aliases | Direct REST legacy projection may retain aliases |
| Repeated prose omission marker | — | — | — | — | 83 chars/result in live sample | None | Medium aggregate | Replace with boolean `omitted`/`excerpt.complete` | Renderer supplies human prose locally |
| Result body | — | E | — | E | **6.80 MB observed**; raw-mode calls returned **7.86 MB**; one response **950.8 KB** | High only when narrowly targeted | Critical | Lazy-slice | Never anonymous; include metadata and continuation on every excerpt |
| Result retrieval handle | M | M | M | M | Target <60 B/result | High | Low | Keep | Handle must detect stale/rebound transcript content |
| Result excerpt range/cursor | — | E | — | E | Typically <100 B/excerpt | High only during targeted retrieval | Low | Include with excerpt only | UTF-16 half-open range and exact `nextCursor`; absent when the result body is omitted |
| Attachments/images/binary provider blocks | S | S | S | S | Potentially very large | Medium | High | Metadata summary + lazy retrieval; no inline binary | Preserve user-visible meaning without base64/provider blobs |
| Stop/error diagnostics and semantic execution status | M | M | M | M | Usually <200 B/message | High | Low | Keep/canonicalize | Preserve structured error contracts |
| Arbitrary provider/full-message bookkeeping | — | — | — | — | Variable; can include usage/replay/raw-response objects | Low | High | Omit unless explicitly allowlisted as semantic diagnostics | Direct REST verbose remains compatible |
| Pi tool-result `details.messages` duplicate of canonical text | — | — | — | — | Audit JSONL 23.65 MB vs 11.45 MB visible output | None as a duplicate | Critical | Deduplicate transport wrapper | Update `ReadSessionRenderer`; retain small summary/details only |

### 7.1 `bobbit_read(get_session)` compact field audit

The Bobbit post-REST projector is the architectural boundary, so session-detail REST/UI remains unchanged. `get_session` has compact and verbose modes but no result-body opt-in: **C** and **V** below are applicable, while **CR** and **VR** are explicitly **N/A** rather than implied copies. Sizes are serialized UTF-8 field-group bytes including keys from the audited live/session-store shapes; “typical” excludes absent optional fields.

| Field or normalized group | C | CR | V | VR | Observed / typical size | Diagnostic usefulness | Size rating | Decision | Compatibility constraints |
|---|---:|---:|---:|---:|---|---|---|---|---|
| `id`, `title`, `status`, `archived`, `childTerminal` | K | N/A | K | N/A | Observed ~70–225 B; typical ~125 B | High | Low | Keep | Preserve identity/lifecycle, archived meaning, and durable child-terminal state |
| `createdAt`, `lastActivity`, `archivedAt`, `terminalAt` | K | N/A | K | N/A | Observed ~55–150 B; typical ~70 B | High | Low | Keep lifecycle timing | Timestamp types/meaning unchanged; absent optional terminal/archive times stay absent |
| `assistantType`, `role`, `nonInteractive` | K | N/A | K | N/A | Observed ~35–115 B; typical ~55 B | High | Low | Keep/canonicalize execution role | Legacy assistant booleans are aliases; `nonInteractive` distinguishes automated reviewers without exposing prompts |
| `projectId`, `goalId`, `reattemptGoalId`, `teamGoalId`, `taskId`, `staffId` | K | N/A | K | N/A | Observed 0–290 B; typical ~120 B | High | Low | Keep links | Missing optional links stay absent, never fabricated; `reattemptGoalId` remains distinguishable from current `goalId` |
| `delegateOf`, `parentSessionId`, `teamLeadSessionId`, `childKind`, `readOnly` | K | N/A | K | N/A | Observed 0–260 B; typical ~90 B for child sessions | High | Low/medium | Keep ownership/navigation | Preserve parent/child meaning without embedding parent objects |
| `lastTurnErrored`, `consecutiveErrorTurns`, `completedTurnCount` | K | N/A | K | N/A | Observed ~75–120 B; typical ~85 B | High | Low | Keep normalized counters | Preserve booleans/numbers and zero values |
| `restoreError`, `lastTurnErrorMessage` | S | N/A | K | N/A | Observed 0 B when absent and 100 B–4 KiB when errored; typical ~300 B when present | High when present | Medium/high | Bounded 512-code-unit summary in C; full on demand | Retain field name plus truncation marker; verbose error contract unchanged |
| `cwd`, `worktreePath`, `repoPath`, `repoWorktrees`, `agentSessionFile` | — | N/A | K | N/A | Observed `cwd`/worktree 50–260 B each; typical aggregate ~250 B, with maps up to ~2 KiB; `agentSessionFile` absent from current GET | Low for metadata-first diagnosis | Medium/high | Omit default; verbose/on-demand | Direct REST/UI still receives its existing path fields; projector must also drop future store-path additions |
| `clientCount`, `lastReadAt`, `isCompacting`, `wasStreaming`, `streamingStartedAt` | — | N/A | K | N/A | Observed ~50–140 B; typical ~80 B | Low; transient and often stale | Low | Omit default | Available from verbose/direct UI surfaces; status remains the compact lifecycle signal |
| `messageQueue`, `inFlightSteerTexts`, `instructions`, `context`, `allowedTools` | — | N/A | K | N/A | Observed 0 B in current GET; typical persisted non-empty payload ~0.1–10 KiB and can reach tens of KiB | Low for session identity; sensitive | High/unbounded | Omit default | Never expose prompt/task bodies implicitly; verbose is explicit |
| `drafts`, `sidePanelWorkspace`, proposal/preview workspace payloads | — | N/A | K | N/A | Observed 0 B in current GET; typical persisted non-empty payload ~1–100 KiB and can reach MiB | None for metadata-first diagnosis | Critical | Omit default | Pin against future REST enrichment; dedicated preview/proposal tools remain authoritative |
| `modelProvider`, `modelId`, `spawnPinnedModel`, `spawnPinnedThinkingLevel`, image-model fields, `sandboxed` | — | N/A | K | N/A | Observed ~80–320 B; typical ~160 B | Low for default status triage | Medium | Omit default; verbose/on-demand | Model/cause audits may opt into verbose; direct UI model display unchanged |
| `preview`, `accessory`, `colorIndex`, `generation`, display-only flags | — | N/A | K | N/A | Observed ~50–140 B; typical ~80 B | None for diagnostics | Low/medium aggregate | Omit | UI retains fields through direct REST/WS |
| `goalAssistant`, `roleAssistant`, `toolAssistant` legacy aliases | — | N/A | K | N/A | Observed ~60–75 B when all emitted; typical ~65 B | None once `assistantType` exists | Low/medium aggregate | Omit aliases | Verbose/direct REST preserves backward compatibility |
| `branch`, publication-policy and other repository bookkeeping | — | N/A | K | N/A | Observed ~20–100 B; typical ~50 B | Low for session status | Low/medium | Omit default | Git-specific Bobbit operations provide authoritative diagnostics |

A direct `get_session` projection fixture pins every row and every named field individually, including `childTerminal`, `nonInteractive`, and fields absent from today's REST response. It assigns a distinct sentinel/value per field rather than one sentinel per group. C must keep/summarize exactly the declared fields and omit every individual sentinel from omitted groups; V must preserve each unprojected field. CR/VR are asserted unavailable in the operation schema, preventing a future result flag from silently changing this policy.

## 8. Concrete implementation partition

### Slice A — Canonical transcript semantics

Owner files: `src/server/agent/transcript-reader.ts`, preferably with small extracted `transcript-agent-projection.ts` and `canonical-tool-result-body.ts` modules.

- Normalize `tool_use` and `toolCall`; derive bounded previews and full server-side search from one canonical argument string.
- Normalize message-level and block-level results with the exact name/correlation/status precedence in §6.2.1.
- Implement the one exact body-selection/traversal/stringification contract from §6.2.2.
- Derive nested text metrics and result-search input only from that canonical body; build the complete per-message search corpus from discrete visible/call/result segments.
- Use explicit semantic allowlists and path-scoped provider metadata scrubbers.

### Slice B — Result index and lazy slices

Owner files: reader module and transcript REST route.

- Build handles with the exact domain-separated SHA-256/160-bit contract.
- Add bounded slice params and structured stale/not-found errors.
- Derive digest and slices from `canonicalToolResultBody`; repeat canonical identity/status/size on every slice.
- Keep direct REST additions optional and backward compatible.

### Slice C — Final-result budgeting and attribution dictionaries

Owner files: agent projection plus the gateway-owned post-result registration wrapper in `src/server/agent/tool-result-error-bridge-extension.ts` or a sibling immutable module.

- Reproject and fit the actual resolved handler return after stale/current `execute()` resolves but before Pi observes it; never simulate wrapper versions in the route.
- Serialize the complete canonical actual Pi value, including double JSON escaping, wrapper details, and one oversized message/result.
- Return successful metadata-bearing transport/compatibility partials with exact continuation when the recovered envelope provides one.
- Deduplicate authors and long correlation identifiers with dictionaries/refs.
- Pin the sole 50 KiB final-result constant and the fail-bounded unrecognized-wrapper fallback.

### Slice D — Production boundary and invocation guard

Owner files: `src/server/server.ts`, `src/server/agent/tool-activation.ts`, `src/server/agent/tool-guard-extension.ts`, `src/server/agent/rpc-bridge.ts`.

- Resolve agent-bound transcript requests from authenticated caller identity.
- Apply agent policy and the strict heavy-input matrix before `sessionFileRead()`.
- Generate the `tool_call` heavy-read guard even for all-allow roles.
- Prepend and require the immutable post-result boundary for every session granted `read_session`, including sandbox path translation; fail activation closed if it cannot load.
- Prove guard and output boundary through real `SessionManager` spawn/respawn and `RpcBridge` execution for direct server-scope and project/sandbox stale winners; a manual `computeToolActivationArgs()` load is not acceptance coverage.

### Slice E — Agent wrapper, renderer, and session metadata

Owner files: `defaults/tools/agent/extension.ts`, `_shared/context-heavy-guard.ts`, `ReadSessionRenderer.ts`, `defaults/tools/bobbit/compact-projection.ts`.

- Add the normative slice params and progressive prompt guidance.
- Remove full `messages` duplication from current `details`; the immutable boundary remains authoritative for stale copies.
- Keep a local complete-value assertion as defense in depth, never as proof of override-independent enforcement.
- Resolve author/tool refs in the renderer.
- Pin the complete C/CR/V/VR `get_session` audit.

### Slice F — Documentation and replay

Owner files: `docs/read-session.md`, `docs/rest-api.md`, relevant debugging/tool docs.

- Document compact-first exploration.
- Replay the original comparison using metadata + compact tails/search + at most one bounded result excerpt.
- Record call count, overlap avoidance, returned bytes, and the point at which exploration stopped.

## 9. Reproduction and regression strategy

New tests belong in `tests2/` and must be registered in `tests2/tests-map.json`.

### 9.1 Core projection and actual-return fixtures

Create one mixed JSONL fixture containing:

1. Anthropic `tool_use` with `input`, including a 700-unit argument with a unique sentinel after the 512-unit preview cap.
2. Pi `toolCall` with `arguments`, a tool-only assistant message, and the corresponding beyond-preview sentinel; repeated call-name/argument hits occur at known source indexes for filtered paging.
3. Anthropic block-level `tool_result`.
4. Pi message-level `toolResult` whose `content` is a nested text-block array.
5. Every conflicting metadata row from §6.2.1: different `name`/`toolName`/correlation-map names, contradictory valid and invalid `status`/`isError`/`is_error` aliases, block-versus-enclosing-message conflicts, conflicting call/result ID aliases, long composite IDs, one result with an unmatched correlation ID, and one with no correlation ID at all.
6. Provider blocks containing `thinkingSignature`, `textSignature`, generic provider `signature`, `encrypted_content`, and replay metadata at distinct message/non-result-block/wrapper paths, each with a unique provider-only sentinel.
7. A plain structured (non-opaque) tool-result body containing the exact legitimate payload `{"signature":"customer-visible-signature","thinkingSignature":"domain-value"}`. This is the required counterexample: field names are scrubbed only from provider/message metadata, never recursively from tool output.
8. The exact slice string `A😀e\u0301\r\nZ`, quote/backslash/newline-heavy text, and one multi-byte, multi-line nested result larger than 1 MiB.
9. Every exact canonical-body row and in-memory counterexample from §6.2.2: outer and nested `content`/`output`/`result` priority (including own `content: null`), inherited-key rejection, typed versus untyped text, adjacent leaves, split CR/LF, primitive leaves, recursive and integer-like plain-object key order, empty/null leaves, image/attachment/binary summaries with raw sentinels, unpaired surrogates, and cyclic/`BigInt` `INVALID_RESULT_BODY`.
10. Two records at the same session/message/block identity whose canonical bodies differ by one code unit, for stale-handle rejection.
11. One valid complete envelope, both valid `transport_budget` continuation variants, one valid `extension_return_unrecognized` variant, and each invalid cross-variant/missing-required-field case listed in §6.4.2.

Assertions across C/CR/V/VR:

- Pi and Anthropic call rows contain canonical names + bounded arguments and are never blank. Name regexes and provider-specific argument regexes beyond the preview select the correct ordinary projected rows without returning the hidden suffix. With repeated hits, `context`, negative offsets, `matchCount`, `nextOffset`, and filtered continuation produce the exact no-overlap indexes from §6.1.1 through the actual agent extension.
- Canonical extraction produces the exact §6.2.2 strings before projection; chars/lines/bytes, regex matching, digest input, and every reassembled slice all use those same strings. In particular adjacent leaves have no inserted separator and split CR/LF counts as one CRLF line break.
- Nested result chars/lines/bytes match the fixture exactly.
- Path-aware assertions reject provider metadata keys and provider-only sentinels at message, non-result block, and wrapper/details metadata paths in C/CR/V/VR; they do not perform a blanket serialized-substring ban. No image/attachment/binary payload sentinel appears in C/CR/V/VR; only the exact opaque summary is present where applicable, and changing one payload byte stales the prior handle.
- In CR and VR, the bounded tool-result excerpt retains the exact `customer-visible-signature` and `domain-value` payload and, when parsed, contains the legitimate `signature` and `thinkingSignature` keys. In C and V the body is absent only because it is omitted, while sizing and server-side regex matching still inspect the unchanged payload. A direct unit assertion on canonical result extraction proves the path-scoped scrubber did not delete or rename either tool-output field.
- Every conflicting/missing result fixture yields the exact canonical `name`/`status` in §6.2.1. Correlated rows share `tN`; unmatched-ID and absent-ID rows receive `rN` refs/source locators. Only canonical result fields appear; losing names, raw correlation IDs (including in dictionaries), status/error aliases, and omission prose do not.
- The normative Unicode ranges, validation codes, continuation, and exact reassembly from §6.3 hold. Raw unpaired-high-surrogate leaves `\uD800` and `\uD801` both reject with `INVALID_RESULT_BODY`, while well-formed astral scalars remain distinct through UTF-8 measurement/digest/slices.
- The digest known vector produces full SHA-256 `354040cc2ee2720318c043f2b91f0e150cb1dbd58f982a47454820e0cb9b6554` and exact handle `rs1:m6h:b0:NUBAzC7icgMYwEPyuR8OFQyx29U`; all handles are at most 64 characters. Reusing the old handle after a one-code-unit body rewrite returns `STALE_RESULT_HANDLE`, while missing message/block identity returns `RESULT_NOT_FOUND`.
- Result excerpts retain name/status/size/handle and continue with the returned cursor.
- A pattern inside an omitted result yields a hit without returning the matched body.

Core budget tests register the current real `read_session` extension behind the immutable registration wrapper, await the wrapped handler value that Pi would receive, and assert:

```ts
Buffer.byteLength(JSON.stringify(actualPiValue), "utf8") <= 50 * 1024
```

They do **not** assert only the projected server `success`, route envelope, stale handler's intermediate return, or inner text. Run this separately for: (a) repeated quotes, backslashes, and control/newline escapes; (b) repeated emoji/non-ASCII text; (c) a single oversized visible message; and (d) a single oversized nested Pi result in each result-including mode. The single visible-message case is a complete bounded row with `textTruncated`; the page-result cases retain accurate metadata/handle and only their normal bounded excerpts; separate multi-row page and oversized targeted-slice cases force the two legal `transport_budget` partial variants and exact continuations. Reparsing `content[0].text` produces the same complete/partial envelope the renderer sees and validates against the `SuccessfulEnvelope` discriminated union. A deliberately unknown oversized return shape plus a multi-megabyte input `pattern` exercises the legal `extension_return_unrecognized` success partial, requires its exact retry continuation and wrapper diagnostics, asserts it is under 1 KiB, and proves no pattern/sentinel substring is echoed. Negative schema fixtures remove each required variant field and mix diagnostics/continuation kinds to prove validation fails. These unit tests complement, but do not replace, the real stale-winner lifecycle proof below.

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

The decisive stale-override tests must not stop at constructing a `ToolManager`, manually calling `computeToolActivationArgs()`, importing extension files, invoking a handler in-process, or serializing a guessed wrapper. Use a real `SessionManager` lifecycle and `RpcBridge` child boundary:

1. **Direct/server winner:** install a stale server-scope `agent` override that lacks the local heavy guard and returns the historic duplicated `details.messages` shape plus configurable oversized `details.extra`. Create/start a direct session through `SessionManager`; let its real `RpcBridge` spawn the lightweight test Pi child/extension host with the production argv/env. Assert provider provenance points at that stale server directory, while the immutable invocation guard and post-result boundary precede it in the child. Repeat after the normal stop/restore/respawn path.
2. **Project/sandbox winner:** install a distinct stale project override that reformats the envelope under a legacy text/details wrapper and adds a different oversized extra field. Create a project-scoped sandbox session through the public lifecycle. The real sandbox-aware `SessionManager`/`RpcBridge` must choose that project override, translate and load both immutable boundary paths in the child, then repeat after sandbox respawn/restore. No test may manually load a host extension path.
3. In both winners, first send the rejected heavy matrix and observe `CONTEXT_HEAVY_LIMIT_REQUIRED`, zero stale-handler fetch sentinels, and zero transcript-route reads. Then send valid heavy calls with limits `1` and `10` plus an ordinary compact call; each makes exactly one stale-handler gateway fetch and proves the resolved tool remains usable.
4. In **each** server and project/sandbox winner, parameterize successful endpoint payloads for quote/backslash/control/newline-heavy text, repeated emoji/non-ASCII text, a single oversized visible message, a single oversized nested Pi result (CR and VR), a multi-row page forced over budget, and an oversized targeted slice forced below its requested range. Configure the stale override so its intermediate returned object exceeds 50 KiB and visibly duplicates/reformats the body. Invoke `read_session` over real RPC. Capture the actual `tool_execution_end.result`, wait for Pi's persisted `toolResult` JSONL row, and extract the stored result value. For every case assert both
   `Buffer.byteLength(JSON.stringify(event.result), "utf8") <= 50 * 1024` and
   `Buffer.byteLength(JSON.stringify(persistedResultValue), "utf8") <= 50 * 1024`, and assert the two canonical values are equal and validate against `SuccessfulEnvelope`. Also assert accurate canonical name/status/size and no stale extra/duplicate fields. The single-message/result projections may be complete under declared caps; the forced page and targeted-slice cases must be `partial: true` with the exact matching continuation. These assertions run before and after the lifecycle respawn.
5. In each winner, configure the resolved stale execute path to return an unknown oversized wrapper for a valid call carrying a multi-megabyte `pattern`. Assert the actual emitted and persisted values validate as `extension_return_unrecognized`, are each under 1 KiB (therefore also under 50 KiB), contain the exact retry continuation, `wrapperDiagnostics: { omitted: true, actualBytes }`, and `patternOmitted: true`, and contain neither the pattern nor unknown-wrapper sentinels.

Only endpoint payloads and fetch/read counters are test doubles. Activation, winning-provider selection, session creation, spawn/respawn, RPC dispatch, extension loading/translation, stale handler execution, post-handler reprojection, Pi emission, and JSONL persistence are production classes/paths. The deliberately oversized stale intermediate confirms the ceiling is enforced on the actual value after arbitrary winner formatting, not on a route simulation. Direct builtin-import and pure builder tests remain useful but are not acceptance evidence.

### 9.3 REST integration

Extend `tests2/integration/transcript-api.test.ts` with two callers over the same fixture:

- ordinary authenticated REST, no agent caller header: legacy include defaults and UI-compatible verbose content remain unchanged;
- authenticated agent-bound request: canonical scrubbed/budgeted projection and the complete heavy-input table from §9.2, with every rejected case occurring before the injected `readContent`/`sessionFileRead` spy runs.

The agent-bound caller also runs the §6.1.1 matrix against both Pi `toolCall.arguments` and Anthropic `tool_use.input`: tool-name and beyond-preview argument patterns, context expansion, `offset: -2`, and the returned filtered continuation. It asserts exact source indexes/match counts, no overlapping continuation windows, no matched hidden suffix in the body, and a <=50 KiB actual extension return. Pattern evaluation may inspect full call arguments and omitted result bodies server-side; projection never returns either implicitly.

The valid agent-bound cases `limit=1` and `limit=10` each read once. Retain existing direct-REST tests for negative offsets, pattern/context, cross-project access, and structured error mapping.

### 9.4 Bobbit metadata

Add a table-driven `bobbit_read(get_session)` fixture with a unique sentinel/value for **every named field** in §7.1, including `childTerminal`, `nonInteractive`, current REST fields, and store-only future-enrichment counterexamples. Pin all audit columns: C keeps identity/status/timing/role/project-parent links/counters, caps error summaries at 512 UTF-16 units with a truncation marker, and contains none of the individual path, queue/prompt, draft/workspace, model/display, legacy-alias, or repository-bookkeeping sentinels. V preserves each field byte-for-byte. The operation schema exposes neither a result-including flag nor CR/VR variants, and the test explicitly records those columns as N/A. Snapshot the measured serialized group sizes/rating/decision rows (or an equivalent checked audit fixture) so changing the allowlist requires an intentional audit update rather than silently returning low-value fields.

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
| JSON escaping or arbitrary stale-wrapper details push a route envelope over 50 KiB | The immutable registration wrapper awaits, reprojects, serializes, and bounds the actual resolved execute return before Pi observes it; run quote/control, emoji, visible-row, and nested-result cases through real server and project/sandbox stale winners |
| Different flatteners disagree about adjacent leaves or split CRLF | One exact `canonicalToolResultBody` feeds metrics, regex, digest, and slices; pin multi-leaf boundary vectors |
| Unpaired UTF-16 surrogates collide under UTF-8 replacement or break cursors | Reject ill-formed direct string/text/binary leaves as `INVALID_RESULT_BODY`; pin distinct unpaired-surrogate rejects and valid astral continuation |
| Binary/image payloads re-enter excerpts through plain-object serialization | Recognize the exact opaque type/payload keys before carriers, expose only stable metadata/digest, and assert unique raw sentinels are absent in C/CR/V/VR |
| Slices repeat/skip Unicode, combining, or newline units | Use normative UTF-16 `[start,end)` cursors and exact `nextCursor=end`; pin the surrogate error plus combining/CRLF reassembly fixture |
| Regex search misses full calls or leaks hidden arguments/results | Match discrete server-side segments for visible text, canonical tool name, full canonical arguments, and full canonical result body; project only the normal bounded row unless a result slice is explicitly requested; pin context, negative-offset, and filtered continuation |
| Provider scrub removes legitimate tool output fields named `signature` | Apply field policy only to provider/message/wrapper metadata paths; use path-aware assertions and explicitly retain `{"signature":"customer-visible-signature"}` in result excerpts and canonical body extraction |
| Result handles point at different content after rewrite/compaction or collide | Bind session/message/block and canonical-body bytes with domain-separated SHA-256, retain 160 bits in a ≤64-character handle, and pin known-vector plus stale-body rejection |
| Author dictionaries break attribution or renderer labels | Keep `kind/id/label` once in the envelope; direct REST unchanged; DOM/browser tests resolve refs |
| Stale overrides bypass builtin-only input or output fixes again | Put the heavy rule in the immutable pre-call guard and the byte ceiling in the immutable post-handler registration wrapper; test real server and project/sandbox winners before/after respawn |
| Server route accidentally changes UI/direct REST | Agent policy derives from authenticated caller identity, never default query behavior; paired integration assertions |
| Wrapper `details` silently reintroduce duplication | Post-handler reprojection discards stale wrapper extras/duplicates and canonical details contain scalars only; assert actual emitted and persisted Pi values, not simulated profiles |
| A successful fallback violates its own envelope type or cannot be continued | Use the discriminated `truncatedBy` union; require variant-specific continuation and wrapper diagnostics; validate complete, transport-page, transport-slice, and unrecognized outputs with one runtime schema |
| Whole-transcript canonicalization increases CPU/memory | Stream accepted leaves into indexed canonical call/result representations, stable-serialize only structured JSON payloads, and reuse them for previews, metrics, regex, digests, and slices |
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
