# Transcript reads and tool-result redaction

`read_session` is the agent-facing transcript reader for inspecting another Bobbit session without loading the whole chat into context. It calls `GET /api/sessions/:id/transcript`, which parses the target session's agent JSONL transcript server-side and returns a paginated envelope.

The feature exists to make diagnostic reads safe: tool outputs can be much larger than the conversation around them, so agents should first see the flow and metadata, then opt in to raw output only for the small window they need.

## Agent tool default

`read_session` omits tool result bodies by default.

A default compact response still includes:

- message `index`, `role`, and timestamp (`ts`);
- compact message text;
- tool-call summaries in `toolUses`;
- redacted tool-result placeholders in `toolResults`.

A placeholder includes metadata when it can be derived cheaply:

```json
{
  "name": "bash",
  "toolUseId": "toolu_...",
  "omitted": true,
  "status": "ok",
  "size": { "type": "string", "chars": 1200, "lines": 42, "bytes": 1200 }
}
```

`name` can come from the result block itself, the message-level tool metadata, or the preceding tool call associated by id. `status` is `ok`, `error`, or `unknown`. `size` reports string character, line, and byte counts when the body is a string; arrays report block count; other values report their broad type.

## Context-heavy reads are explicitly bounded

Both `verbose: true` and `include_tool_results: true` are context-heavy flags.
Either one requires an explicit integer `limit` from 1 through 10, even though
ordinary compact reads default to 20. Search and compact reads first, then fetch
only the narrow raw window you need. Use successive batches when necessary and
watch token consumption.

A missing, invalid, or larger limit is rejected by the agent tool before it
calls the gateway. The returned tool error contains parseable JSON:

```json
{
  "error": "You should not typically pull this much data from the API. Context-heavy flag(s) `include_tool_results` require an explicit limit at or below 10. Call again with limit <= 10 and fetch in smaller batches only if you REALLY need full verbosity. Keep an eye on token consumption.",
  "code": "CONTEXT_HEAVY_LIMIT_REQUIRED"
}
```

If both flags are enabled, the message names both. Filtering with `pattern` or
`context` does not remove the explicit-limit requirement because only `limit`
bounds the returned window.

## Opting in to result bodies

Pass `include_tool_results: true` with a small explicit `limit` when you
deliberately need the output body.

```text
read_session(session_id="abc-123", offset=42, limit=1, include_tool_results=true)
```

Compact reads with `include_tool_results: true` include tool-result previews instead of omission placeholders. Use `verbose: true` together with `include_tool_results: true` when you need the full content blocks, including raw `tool_result` bodies:

```text
read_session(
  session_id="abc-123",
  offset=42,
  limit=1,
  verbose=true,
  include_tool_results=true
)
```

`verbose: true` by itself is not an opt-in. For the `read_session` tool, verbose mode still redacts tool result bodies unless `include_tool_results: true` is also set. Redacted verbose `tool_result` blocks keep identifying fields and replace the body with an omission marker plus `contentOmitted: true`, `resultSize`, and `status`.

## Search first, opt in second

Use the filtering parameters to locate a large result before requesting its body:

1. Search by a stable string from the output:

   ```text
   read_session(session_id="abc-123", pattern="TypeError", context=2, limit=10)
   ```

2. Note the returned message `index`, tool name/id, status, and size metadata.
3. Read only that message or a small surrounding window with
   `include_tool_results: true` and an explicit `limit <= 10`.

`pattern` matches the flattened raw transcript text, including tool result text, even when returned messages are redacted. `context` expands each regex hit by neighbouring messages before pagination. `offset` and `limit` then page over either the raw transcript window (no pattern) or the deduplicated match-with-context list (with pattern).

## REST endpoint compatibility

`GET /api/sessions/:id/transcript` keeps its legacy default for direct REST callers: when no include flag is supplied, tool results are not redacted. Compact reads keep the legacy previews; verbose reads include raw `tool_result` bodies. The 10-message context-heavy guard is an agent-tool policy, not a REST limit; direct REST and other programmatic consumers retain the endpoint's existing paging behavior.

To request redacted REST output, pass either spelling with a false value:

```http
GET /api/sessions/abc-123/transcript?include_tool_results=false
GET /api/sessions/abc-123/transcript?includeToolResults=0
```

To explicitly include result bodies, pass `include_tool_results=true`, `includeToolResults=true`, or `1`.

`verbose` only selects compact summaries versus full content blocks. It does not override result-body inclusion:

- direct REST with no include flag remains backward-compatible and does not redact tool results; with `verbose=true`, raw `tool_result` bodies are included;
- direct REST with `include_tool_results=false` redacts tool results, even with `verbose=true`;
- `read_session` always sends the include flag, defaulting it to false unless the caller passes `include_tool_results: true`.

## Response shape

The envelope is the same for compact and verbose reads:

```json
{
  "total": 142,
  "matchCount": 3,
  "returned": 1,
  "offsetStart": 42,
  "offsetEnd": 42,
  "messages": []
}
```

`matchCount` appears only when `pattern` is supplied. Empty windows return `messages: []` and `offsetStart` / `offsetEnd` as `-1`.

## Errors

Transcript reads return structured error codes:

| Code | Meaning |
|---|---|
| `session_not_found` | The target session id is unknown. |
| `transcript_unavailable` | The session exists, but its agent transcript file is missing or empty. |
| `invalid_regex` | `pattern` is not a valid regular expression. |
| `invalid_params` | REST pagination, context, or boolean query parameters are invalid. |
| `CONTEXT_HEAVY_LIMIT_REQUIRED` | Agent-tool-only guard: `verbose` or `include_tool_results` needs an explicit integer `limit` from 1 through 10. No REST request is sent. |

See [REST API](rest-api.md#sessions) for the route table and [Orchestration](orchestration.md) for child-agent usage.
