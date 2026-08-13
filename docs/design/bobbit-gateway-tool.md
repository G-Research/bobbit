# Historical design: `bobbit` gateway tool suite

> **Historical record.** This document preserves the original architectural decisions for the three-tier gateway tool group. It is not the current agent-tool contract. See [The `bobbit` gateway tool group](../bobbit-gateway-tool.md) and [Focused transcript reads](../read-session.md) for current behavior.

## Motivation

Gateway-wide orchestration previously required agents to discover credentials and hand-write HTTP requests. Goal-scoped task, gate, and team tools could not inspect or operate on arbitrary projects, goals, or sessions.

The design introduced a curated extension over the gateway REST API with three privilege tiers:

| Tool | Purpose | Default access |
|---|---|---|
| `bobbit_read` | Read-only gateway introspection | Allowed |
| `bobbit_orchestrate` | Runtime state changes | Hidden unless granted |
| `bobbit_admin` | Configuration and destructive maintenance | Hidden unless granted |

The split keeps routine discovery broadly available while requiring explicit policy grants for higher-risk operations.

## Architectural decisions retained

- **Normal built-in group.** The tools are discovered from the built-in tool pack like other extension-backed tools. Registration does not depend on Headquarters or goal context.
- **Credential-based registration.** The extension registers when gateway credentials resolve from the process environment or Bobbit state. Missing credentials leave the tools unavailable rather than failing startup.
- **Explicit project ownership.** Goal and session creation require a project id; the tool does not guess a project.
- **Archive rather than delete.** The goal lifecycle exposes archive semantics because the gateway has no separate hard-delete goal endpoint.
- **Operation dispatch.** Each tier uses an operation discriminator and validates operation-specific requirements before calling REST.
- **Dedicated-tool boundaries.** Transcript inspection remains in `read_session`; cross-session prompting remains in the agent/team tools; current-goal task and gate work remains in their dedicated tools.
- **REST separation.** Agent projections are an extension-layer policy. Gateway REST responses used by the UI and programmatic clients remain a separate compatibility surface.

## Current focused-read contract

The original design's agent-facing response expansion guidance has been withdrawn. Current `bobbit_read` behavior is deliberately focused:

1. Use a compact `list_*` operation to discover an id.
2. Use the matching `get_*` operation to inspect one entity.
3. Use `read_session` list mode to choose a message or result index, then inspect that exact target.

The agent schemas do not expose legacy response-expansion controls. Unknown fields fail ordinary schema validation. Current projections and parameters are documented in [The `bobbit` gateway tool group](../bobbit-gateway-tool.md); transcript list/inspect semantics are documented in [Focused transcript reads](../read-session.md).

## Compatibility boundary

The focused-read change does not remove compatibility behavior from direct REST or UI consumers. In particular, the transcript REST endpoint retains its legacy query contract for those clients. The agent tool is intentionally narrower so model context cannot accidentally receive broad transcripts or provider-only payloads.

The change also does not alter unrelated `bobbit_orchestrate` or `bobbit_admin` response behavior. Their manifests and implementation remain authoritative.

## Historical implementation shape

The design used one extension module to register all three tools, YAML manifests for discovery and agent descriptions, and operation tables for path, method, body, and required-field handling. This kept authentication, structured gateway errors, and dispatch logic shared without duplicating existing task, gate, team, or transcript APIs.

That shape remains useful rationale, but schema, projection, paging, and operation details must be read from the current manifests, implementation, and reference documentation rather than this historical design.
