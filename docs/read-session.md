# Focused transcript reads

`read_session` is the agent-facing transcript reader for inspecting another Bobbit session without loading unrelated messages or large tool outputs into context. It uses a two-step contract: list compact diagnostics, then inspect one exact message or result.

This focused contract is intentionally separate from the transcript REST route's legacy behavior for direct REST and UI callers.

## List messages

Start with `operation: "list"`:

```text
read_session(operation="list", session_id="abc-123", offset=-20, limit=20)
```

List mode supports pagination, negative offsets, regex `pattern` filtering, `case_sensitive`, and small `context` expansion. Each summary provides the zero-based message `index`, role, bounded text, and bounded tool-call arguments. Tool-result summaries provide a zero-based `resultIndex`, normalized `status` (`ok`, `error`, or `unknown`), and complete character, line, and UTF-8 byte sizes.

Both Anthropic `tool_use` and Pi `toolCall` messages are summarized, so a tool-only assistant message still identifies the call. List output never contains result bodies or provider signatures.

To narrow discovery before inspection:

```text
read_session(operation="list", session_id="abc-123", pattern="TypeError", context=1)
```

## Inspect one exact target

Use the selected `message_index` with `operation: "inspect"`:

```text
read_session(operation="inspect", session_id="abc-123", message_index=42)
```

This returns one sanitized semantic message. Result metadata remains visible, but result bodies remain omitted.

Add the selected zero-based `result_index` only when that exact result body is needed:

```text
read_session(
  operation="inspect",
  session_id="abc-123",
  message_index=42,
  result_index=0,
  offset=0,
  limit=2000
)
```

Result inspection returns only a bounded excerpt of that result. The default limit is 2,000 characters and the maximum is 8,000. If `nextOffset` is not null, pass it as the next `offset` with the same message and result indexes. The response also reports the returned length, total character count, and whether the result was truncated.

The schema is discriminated by `operation`: list-only filters cannot be mixed into inspect mode, and excerpt `offset` or `limit` requires an exact `result_index`.

## REST and UI compatibility

`GET /api/sessions/:id/transcript` keeps its existing no-operation path for direct REST and UI consumers. Only requests with `operation=list` or `operation=inspect` use the focused agent projection described above. The legacy route's query aliases, paging, and response behavior remain a separate compatibility contract; they are not parameters of the `read_session` agent tool.

## Errors

Transcript reads return concise structured errors for an unknown session, unavailable transcript, invalid regex, invalid bounds, an out-of-range message or result index, and invalid parameter combinations.

See [REST API](rest-api.md#sessions) for the route table and [Orchestration](orchestration.md) for child-agent usage.
