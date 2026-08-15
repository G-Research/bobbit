# Historical design: Bobbit context-volume guards

> **Superseded design.** This proposal described an earlier agent-facing expansion-and-limit policy. Do not use it as implementation or calling guidance. See [The `bobbit` gateway tool group](../bobbit-gateway-tool.md) and [Focused transcript reads](../read-session.md) for the current contracts.

## Original problem

Agent tools could place much more gateway and transcript data into model context than a task required. Large goal specifications, workflow snapshots, transcript result bodies, provider metadata, and internal paths made calls expensive and increased disclosure risk.

The proposal responded with compact projections plus guarded opt-in expansion. The compact-projection rationale remains valid, but the opt-in recovery path was replaced because advertising a broad-read mechanism encouraged callers to bypass focused discovery.

## Current resolution

Agent reads now have one intentional shape per operation:

- `bobbit_read` list operations return discovery fields only.
- Matching `get_*` operations return useful detail for one entity while excluding provider blobs, storage paths, workflow snapshots, and UI bookkeeping.
- `read_session` has explicit list and inspect modes. List mode summarizes messages and tool calls without result bodies or provider signatures. Inspect mode returns one exact message and, when requested, one bounded result excerpt.
- Removed agent parameters are ordinary unknown fields and fail schema validation; there is no compatibility alias or special migration path.

This makes the safe path the only agent-tool path rather than asking each caller to remember a context-volume limit.

## Compatibility boundary

This policy applies to agent tools, not the underlying transcript REST endpoint. Direct REST and UI clients retain their legacy query compatibility where required. Keeping that boundary avoids breaking existing non-agent consumers while preventing their broad response contract from being injected into model tool schemas.

Unrelated `bobbit_orchestrate` and `bobbit_admin` behavior is outside the focused-read change and remains governed by those tools' current schemas and implementation.

## Rationale retained from this design

- Prefer explicit allowlist projections for stable entity shapes.
- Preserve identity, state, relationships, actionable diagnostics, timestamps, and pagination needed for follow-up calls.
- Remove provider-only payloads, internal filesystem state, embedded workflow snapshots, and unrelated UI fields from agent reads.
- Apply paging before projection so pagination metadata remains accurate.
- Keep agent-tool policy out of shared REST readers so UI and direct API compatibility remain independent.
- Pin operation-to-projection coverage so new operations cannot silently bypass the focused policy.

The previous flag tables, guard constants, recovery messages, schema snippets, and acceptance matrix were deleted because they described removed agent APIs and could be mistaken for current instructions.
