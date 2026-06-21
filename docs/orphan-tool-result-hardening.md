# Orphan tool-result hardening

Bobbit persists agent transcripts as `.jsonl` and later rehydrates them into provider requests. A valid tool result is only valid when the retained context also contains the assistant tool call that produced it. If compaction, abort, or an errored turn leaves a `toolResult` / `tool_result` / OpenAI `function_call_output` without that matching call, OpenAI Responses and Codex can reject every later request and wedge the session.

This note documents the two-layer repair path that prevents that failure while preserving normal tool history byte-for-byte.

## Where the fix sits

There are two defensive boundaries:

1. **Restore-boundary transcript sanitizer** — `src/server/agent/transcript-sanitizer.ts` repairs persisted agent `.jsonl` before restore / `switch_session` rehydrates the transcript.
2. **OpenAI Responses request guard** — `src/server/agent/openai-orphan-tool-result-extension.ts` writes a generated pi extension that runs immediately before a provider request and filters orphan OpenAI `function_call_output` items from `payload.input`.

The sanitizer fixes durable history. The OpenAI guard is a final provider-specific preflight for anything still orphaned at request construction time. Together they cover restored sessions, force-abort respawns, compaction boundaries, and late tool results from discarded turns.

## Restore-boundary sanitizer behavior

`sanitizeTranscriptContent()` walks the transcript once from oldest to newest and keeps a set of retained, valid tool-call ids.

It adds assistant tool-call ids only from assistant rows that are not terminally bad:

- `stopReason: "aborted"` is ignored.
- `stopReason: "error"` is ignored.
- Non-aborted / non-errored assistant rows contribute tool-call ids from the supported shapes (`toolCall`, `tool_use`, and pi-shaped `toolCallId`).

Then it repairs result shapes against that retained set:

- Message-level `role: "toolResult"` rows are kept only when `toolCallId` is in the retained set; otherwise the whole row is dropped.
- User-message content blocks with `type: "tool_result"` or `type: "toolResult"` are filtered block-by-block using `tool_use_id`, `toolCallId`, or `id`.
- If filtering removes every content block from a user row, the row is dropped.
- If filtering leaves non-tool content, the existing blank-user-message sanitizer still runs so image/attachment-only prompts are repaired in the same pass.

A compaction boundary naturally creates a new retained context: if the assistant call was compacted away but a later result row remains, the call id is not in the seen set, so the result is treated as orphaned and dropped.

## Valid-pair preservation and idempotence

Valid tool-call/tool-result pairs are deliberately not normalized. When an assistant tool call is retained and its result follows it, the sanitizer leaves both rows byte-identical, including blank text that is part of a valid tool-result user message.

The sanitizer is idempotent:

- A clean transcript returns `changed: false` and unchanged content.
- A repaired transcript becomes clean after one pass.
- Re-running on repaired output is a no-op.
- Non-JSON lines, non-message records, and unrelated message rows are preserved.

This matters because the restore path can run more than once across restart, refresh, and respawn flows; repeated restores must not keep rewriting history.

## Aborted and errored assistant tool calls

An aborted or errored assistant row may still contain a tool-call-looking block. Bobbit does not treat those ids as valid producers because the provider turn did not complete normally. Any late result for those ids is dropped on restore.

This handles the common stuck-session shape:

1. Assistant starts a tool call.
2. The turn is aborted or errors.
3. A late tool result is appended after the assistant row.
4. Restore would otherwise rehydrate a result whose producing call is not valid retained history.

The assistant row itself is preserved for UI/user history; only the invalid result side is removed.

## OpenAI Responses / Codex request guard

OpenAI Responses represents tool calls as `function_call` items and tool results as `function_call_output` items in `payload.input`. The generated guard extension registers pi's `before_provider_request` hook and performs a payload-local scan:

- Track `function_call.call_id` values already seen in `payload.input`.
- Keep a `function_call_output` only if it has a string `call_id` already seen in that same input array.
- Drop outputs with missing/non-string ids or outputs that appear before their call.
- Preserve all other items, valid pairs, and ordering.
- No-op for non-object payloads, payloads without array `input`, and non-Responses-shaped requests.

The extension is added during normal session setup and mirrored in restore / role-reassignment / force-abort respawn paths, so OpenAI and Codex sessions keep the same preflight guard across lifecycle transitions.

## Bounded diagnostics

Repairs are not silent, but logs are bounded and do not include raw tool output.

- Transcript sanitizer success logs include counts such as dropped orphan tool-result rows and filtered orphan result blocks.
- Transcript sanitizer read/write/path failures log warnings and remain non-fatal, so a defensive repair failure does not prevent session restore.
- The OpenAI guard logs only the number of dropped `function_call_output` items with the `[bobbit-openai-orphan-guard]` prefix.

This gives operators enough signal to spot transcript repair without leaking large or sensitive tool-result payloads into logs.

## Dedicated read-only sandbox mount for the OpenAI guard

The OpenAI guard is generated source loaded by sandboxed agents via `--extension`. It is content-addressed under:

```text
.bobbit/state/openai-orphan-tool-result/<hash>/extension.ts
```

and exposed inside sandbox containers as:

```text
/bobbit-state/openai-orphan-tool-result/<hash>/extension.ts
```

It intentionally does **not** live under the existing `tool-guard` state directory. `tool-guard` must stay writable for other session-scoped guard material, while this provider guard is always loaded and its generated source can be reused by later sessions. If a compromised sandbox could write to that reused extension source, it could tamper with future provider requests.

For that reason `docker-args.ts` mounts generated-extension state subdirectories, including `openai-orphan-tool-result`, read-only (`:ro`). Bobbit still avoids mounting the full state directory, which contains secrets such as gateway tokens and TLS material. The writer also revalidates cached file contents before reuse as defense-in-depth.

## Regression coverage

The behavior is pinned by focused unit coverage:

- `tests/transcript-sanitizer.test.ts` — valid pair preservation, idempotence, aborted/errored assistant tool-call handling, compaction-boundary orphan result dropping, and mixed user-message result-block filtering.
- `tests/openai-orphan-tool-result-guard.test.ts` — OpenAI payload guard behavior, bounded diagnostics, generated extension source, and dedicated state subdir placement.
- `tests/docker-args.test.ts` and `tests/container-path-translation.test.ts` — sandbox mount creation, read-only generated-extension mounts, and container/host path translation.
