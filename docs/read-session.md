# Bounded session diagnostics

`read_session` is the agent-facing transcript reader. It projects provider transcripts into a compact, canonical shape so an agent can diagnose another session without loading large tool output or provider replay data into context.

The direct transcript REST endpoint and the browser keep their legacy projection. Agent calls use a trusted caller-session boundary that adds canonicalization, bounded excerpts, strict heavy-read guards, and a complete serialized response budget.

## Progressive diagnostic workflow

1. Fetch compact session metadata once with `bobbit_read(operation="get_session", sessionId="...")`.
2. Read a small compact tail or regex page, normally with `limit <= 10`.
3. Narrow using source message indexes, tool names, normalized statuses, and result `chars`/`lines`/`bytes`.
4. Continue only from the returned page offset; do not reread overlapping windows.
5. If the metadata is insufficient, retrieve at most one bounded result slice by handle. Continue from its returned cursor only when necessary.
6. Stop as soon as the question is answered. `verbose` is not the discovery default.

This order matters because a single nested result can be large even when its outer shape contains only one block.

## Compact projection

Compact mode is the default. Each message retains its source `index`, canonical `role`, bounded visible `text`, timestamp, semantic stop/error fields, attribution reference, and any canonical tool calls or results. Truncation flags distinguish a bounded field from a complete one.

### Tool calls

Anthropic `tool_use` and Pi `toolCall` blocks share one shape:

```json
{
  "ref": "t1",
  "name": "read",
  "argumentsPreview": "{\"path\":\"docs/read-session.md\"}",
  "argumentsTruncated": false
}
```

The argument source is normalized from `arguments`, then `input`. The preview is deterministic and bounded to 512 UTF-16 code units. A tool-only assistant message remains useful through `toolCalls` even when its visible `text` is empty.

Regex matching uses the full canonical tool name and arguments server-side, not only `argumentsPreview`. A match beyond the preview selects the ordinary bounded message row; it does not expose the hidden suffix.

### Tool results

Pi message-level results and Anthropic block-level results also share one shape:

```json
{
  "ref": "t1",
  "name": "read",
  "status": "ok",
  "size": {
    "type": "array",
    "blocks": 1,
    "chars": 1200,
    "lines": 42,
    "bytes": 1238
  },
  "omitted": true,
  "handle": "rs1:m6h:b0:NUBAzC7icgMYwEPyuR8OFQyx29U"
}
```

- `name` is the one canonical direct, message, or correlated call name.
- `status` is exactly `ok`, `error`, or `unknown`.
- `size.chars` counts JavaScript UTF-16 code units, `lines` measures the canonical nested text, and `bytes` is its UTF-8 size. `type` describes the selected outer body and `blocks` is retained for root arrays.
- `omitted` says whether this response contains an excerpt.
- `handle` identifies this session/message/block and canonical body. A changed body makes an old handle stale rather than silently rebinding it.

Duplicate aliases such as `toolName`, `toolUseId`, `isError`, `is_error`, `contentOmitted`, and `resultSize` are not returned. Omission is a boolean, not repeated prose.

### Provider metadata

Agent projection is semantic rather than a provider-object passthrough. Structural provider fields such as `thinkingSignature`, `textSignature`, encrypted/replay payloads, raw response objects, and provider bookkeeping are omitted in every agent-facing mode. Verbose mode may add bounded thinking text, but never those replay fields.

Scrubbing is path-sensitive. A tool's legitimate result text or structured result may itself contain keys such as `signature` or `thinkingSignature`; that payload remains searchable and may appear in an explicitly requested excerpt.

### Attribution and correlation dictionaries

Messages use `authorRef` values such as `a1`; the envelope's `authors` dictionary stores the corresponding `{ kind, id, label }` once. Calls and correlated results share short refs such as `t1`; uncorrelated results use refs such as `r1`. The `correlations` dictionary maps referenced call/result refs to bounded semantic data:

```json
{
  "authors": {
    "a1": { "kind": "agent", "id": "session:...", "label": "Reviewer" }
  },
  "correlations": {
    "t1": { "name": "read", "messageIndex": 12, "blockIndex": 0 }
  }
}
```

Only dictionary entries referenced by returned messages are included. Full provider correlation IDs are never returned.

## Search and page coordinates

`pattern` is a regular expression over discrete server-side segments: visible text, canonical tool names, full canonical call arguments, and full canonical result bodies. Matching can therefore find omitted result text without returning that body. `context` expands each matched source message by up to five neighbouring transcript messages, then de-duplicates and sorts that sequence before paging.

Agent envelopes distinguish page positions from source transcript indexes:

| Field | Meaning |
|---|---|
| `total` | Number of source transcript messages. |
| `matchCount` | Source messages matching `pattern`, before context expansion. Present only for a regex read. |
| `pageCount` | Rows in the pageable sequence: `total` without a filter, or the de-duplicated context-expanded sequence with a filter. |
| `pageStart` | Zero-based resolved position in that pageable sequence. A negative requested offset is normalized here. |
| `returned` | Number of rows actually returned. |
| `offsetStart` / `offsetEnd` | Source transcript indexes of the first and last returned messages, or `-1` for an empty page. |
| `nextOffset` | Next position in the same pageable sequence, when more rows remain. |

For a filtered/context read, repeat the same `pattern`, `case_sensitive`, and `context`, then pass `offset=nextOffset`. A negative initial offset therefore produces a non-negative continuation over the already-defined filtered sequence. Do not substitute `offsetEnd + 1`: source indexes and filtered page positions are different coordinate systems.

A normal page can have `nextOffset` without being transport-partial. When the byte budget itself stops a page, the envelope additionally has:

```json
{
  "partial": true,
  "truncatedBy": "transport_budget",
  "nextOffset": 5,
  "continuationRequest": { "kind": "page", "offset": 5 }
}
```

Follow the exact continuation and retain the original filter parameters.

## Bounded result excerpts

`include_tool_results: true` adds bounded, self-describing excerpts to results in a small page; it never restores raw provider result blocks or returns an unbounded body. Prefer a targeted slice after locating the result:

```text
read_session(
  session_id="abc-123",
  result_handle="<handle-from-prior-result>",
  result_cursor=0,
  result_limit=2048
)
```

A targeted slice does not require `include_tool_results`. `result_cursor` and `result_limit` require `result_handle`.

```json
{
  "name": "read",
  "status": "ok",
  "size": { "type": "array", "blocks": 1, "chars": 1200, "lines": 42, "bytes": 1238 },
  "omitted": false,
  "handle": "rs1:m6h:b0:NUBAzC7icgMYwEPyuR8OFQyx29U",
  "excerpt": {
    "start": 0,
    "end": 1200,
    "text": "...",
    "nextCursor": null,
    "complete": true
  }
}
```

Slice coordinates are half-open UTF-16 ranges `[start,end)`, matching `size.chars`. `result_cursor` defaults to `0`. `result_limit` defaults to `4096` and must be an integer from `1` through `8192`. Slices never split a Unicode scalar; the only over-limit case is the two-unit progress needed for one astral scalar when `result_limit=1`.

When `complete` is false, continue with the same `handle` and `result_cursor=excerpt.nextCursor`. If the complete-response budget shortens a targeted slice, `continuationRequest.kind` is `result_slice` and repeats the exact handle, next cursor, and requested result limit.

## Context-heavy guard

An agent call is context-heavy when any of these is exactly `true`:

- `verbose`
- `include_tool_results`
- the compatibility alias `includeToolResults`

Each spelling is guarded in actual spawned sessions, including stale server/project tool overrides. A heavy call requires an explicitly supplied numeric integer `limit` from `1` through `10`. Missing limits, numeric strings, fractions, zero, negative values, and values above 10 return `CONTEXT_HEAVY_LIMIT_REQUIRED` before the tool handler can fetch the transcript.

The current `read_session` schema exposes `include_tool_results`; the camel-case alias remains protected for compatibility with older or custom wrappers. Ordinary compact calls retain the default `limit` of 20.

`verbose` expands bounded semantic text and thinking summaries. It does not expose provider blocks or make result bodies unbounded. Result excerpts still require `include_tool_results` or a targeted `result_handle` read.

## Complete 50 KiB agent-return budget

Every successful agent-facing call is limited to 50 KiB after serializing the complete Pi tool value—not only the REST envelope or its inner text. This includes JSON escaping and the renderer details wrapper. The wrapper keeps only bounded scalar summary fields and never duplicates `messages`.

The fitter first bounds semantic fields and excerpts, then removes optional previews or later page rows if necessary. A budget-shortened page or targeted slice returns a typed continuation rather than silent transport truncation. If an old resolved extension returns an unrecognized successful wrapper, the boundary returns a small `extension_return_unrecognized` partial with retry metadata instead of forwarding the unknown body.

## Errors

| Code | Meaning |
|---|---|
| `session_not_found` | The target session ID is unknown. |
| `transcript_unavailable` | The session exists, but its agent transcript is missing or empty. |
| `invalid_regex` | `pattern` is not a valid regular expression. |
| `invalid_params` | Pagination, context, boolean, or projection parameters are invalid. |
| `INVALID_RESULT_BODY` | A result cannot be canonicalized safely. |
| `INVALID_RESULT_HANDLE` | The handle is missing, malformed, or required by another slice parameter. |
| `RESULT_NOT_FOUND` | The handle points to a message/block that no longer exists. |
| `STALE_RESULT_HANDLE` | The located result body no longer matches the handle. |
| `INVALID_RESULT_CURSOR` | The cursor is out of range or splits a Unicode scalar. |
| `INVALID_RESULT_LIMIT` | The result limit is not an integer from 1 through 8192. |
| `CONTEXT_HEAVY_LIMIT_REQUIRED` | An agent heavy read lacks an explicit integer `limit` from 1 through 10. No transcript request is made. |

## Direct REST and UI compatibility

`GET /api/sessions/:id/transcript` keeps its legacy direct-caller behavior when the request is not bound to a real caller session:

- omitting both result-inclusion query aliases keeps results included;
- compact mode keeps legacy previews and verbose mode keeps legacy content blocks;
- `include_tool_results=false`, `includeToolResults=false`, or `0` requests legacy redaction;
- direct pagination, negative offsets, regex/context matching, author objects, and error contracts are unchanged;
- the agent-only heavy limit and complete Pi-result budget do not apply.

The browser transcript UI uses this direct boundary. `read_session` sends an authenticated caller-session identity and explicitly defaults `include_tool_results` to false, selecting the bounded agent projection. The caller header is a policy selector only after it resolves to a real session; an absent or unknown header does not change the legacy REST response.

See [REST API](rest-api.md#transcript-reader-and-read_session) for query parameters and boundary selection. The audited rationale and field decisions are in [Bound Session Diagnostics — Issue Analysis](design/bound-session-diagnostics-issue-analysis.md#7-response-projection-field-audit).
