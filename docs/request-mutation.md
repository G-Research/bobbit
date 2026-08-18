# Gated request mutation

Gated request mutation is the narrow per-turn extension path for changing the model's
transient request text or assessing a tool call before execution. It exists so a project can
use extension advice without giving extension code a general prompt, transcript, tool-argument,
or configuration mutation API.

Extensions only propose typed results. Core owns validation, ordering, the final authorization
check, application, and diagnostics. The feature is off unless a project operator grants it for
the exact hook.

For grant administration and its durable audit, see [Extension capability grants](extension-capability-grants.md).
For general hook declarations, see [Extension Host authoring](extension-host-authoring.md#hook-metadata-hooksnameyaml--schema-2-metadata-first).

## Enablement and authority

A hook is eligible only when all of the following are true:

- Its active, unshadowed declaration is `mode: decide`, declares `capabilities: [mutate]`, and
  declares the applicable event: `beforePrompt` or `beforeToolCall`.
- The project has an active, exact `mutate` grant for its `(packId, hookId)` tuple.
- The declaration is still active when core applies the result.

A capability declaration, pack activation, or a `decide` grant is not a substitute for the exact
`mutate` grant. There are no wildcard grants, built-in exemptions, inherited authority, or
granting by an extension itself.

Grant and revoke mutations require a verified signed `bobbit_session` operator cookie. Bearer,
sandbox, and agent-session credentials cannot grant or revoke this authority. The project grant
route stamps the actor and timestamp; callers cannot provide either. Revocation invalidates the
live grant projection, so the next eligibility check sees it without a gateway or agent restart.

A newly spawned or respawned session determines whether to install its bridge/guard from current
declarations and grants. That generated code contains neither a grant nor hook identity. It is
only an opportunity to ask core; the server rechecks authority on every request. Therefore a
stale bridge or tool guard cannot preserve authority after a revoke or pack deactivation.

## Hook declaration and proposal contract

A request-mutation hook is a `decide` module. It has no Host API, apply callback, gateway token,
session object, system prompt, transcript, tool arguments, tool result, or policy map. Its frozen
context contains only server-derived identity and the one relevant input:

- `beforePrompt`: `event`, `sessionId`, `projectId`, `cwd`, and `prompt`.
- `beforeToolCall`: `event`, `sessionId`, `projectId`, `cwd`, and `tool: { name }`.

A hook returns `undefined`/`null` for no proposal, or one closed envelope:

```yaml
# hooks/request-policy.yaml
id: request.policy
module: ../lib/request-policy.mjs
events: [beforePrompt, beforeToolCall]
mode: decide
capabilities: [mutate]
budget:
  maxTokens: 64
  timeoutMs: 1000
```

```js
export function decide(ctx) {
  if (ctx.event === "beforePrompt") {
    return {
      kind: "request-mutation",
      proposal: {
        kind: "prompt-shape",
        version: 1,
        intent: "clarify",
        text: "A complete replacement for this one request",
        reasonId: "clarify-request",
      },
    };
  }

  if (ctx.tool.name === "deploy") {
    return {
      kind: "request-mutation",
      proposal: {
        kind: "tool-safety",
        version: 1,
        decision: "warn",
        reasonId: "deploy-review",
      },
    };
  }
}
```

### Prompt shaping

A `prompt-shape` proposal replaces the complete transient request for the current model turn.
Its `intent` is one of `clarify`, `compress`, `redact`, or `augment`; it does not change the
scope of the replacement. The replacement and source request are each limited to 32 KiB UTF-8.
The proposal envelope is limited to 40 KiB.

The replacement is not written into the user transcript and cannot change `systemPrompt`, static
prompt sections, provider dynamic context, history, a future turn, or a provider tail. It is a
single replacement rather than a patch so core has one bounded validation and audit boundary.

### Tool safety

A `tool-safety` proposal is either `warn` or `deny`. An omitted `tool` applies only to the current
inspected tool; if supplied, it must exactly equal `ctx.tool.name`. A proposal cannot name a
different tool, allow a denied tool, alter arguments, issue a permission grant, or inspect/filter
a result.

Strict validation rejects unknown fields, wrong event/discriminant, non-plain objects, unsafe or
empty identifiers, control bytes, credential-bearing URLs, oversize values, and out-of-scope tool
names. In particular, fields such as `systemPrompt`, a prompt region, an argument patch, callback,
URL, free-form explanation, and arbitrary metadata are not accepted. `reasonId` is only a bounded
identifier for the hook contract; it is never displayed or persisted as an operator-facing reason.

## Reduction and final authorization fence

Core gathers at most one proposal per eligible hook and bounds the number of extension candidates.
Workers are isolated by their hook timeout: timeout, throw, malformed output, and one hook's
failure do not fail the model turn or suppress independently eligible hooks.

Core validates all candidates before reduction:

- Prompt replacements use higher priority first, then a stable namespaced source identity to
  break ties. Lower-priority valid proposals are recorded as superseded.
- Tool safety uses severity first: `deny` wins over `warn`; priority and stable source identity
  only select attribution within the same severity. A warning never changes normal execution.
- Existing role/group `never` policy runs before request-mutation inspection and remains an
  absolute ceiling. For an `ask` policy, a mutation deny runs before the permission request, so it
  cannot mint a one-time or session grant.

Authorization is deliberately checked more than once. Core checks the exact grant immediately
before invoking a hook and again after that worker returns. It then waits for **all** candidates to
settle and performs a final, fresh declaration-and-grant check for every extension candidate
immediately before reduction/application. This post-settle fence closes the race where a fast
worker returned while a slower worker was still running, and a grant was revoked or the hook was
deactivated in between. Such a result is discarded rather than applied: a still-declared hook is
recorded `Grant required`; a disappeared declaration is recorded `Prompt mutation disabled`.
Core-owned request shapers do not use extension declaration or grant state.

## Application paths

The generated session bridge sends only the bounded current prompt to the prompt route. Core
returns either `{ action: "replace", text }` or `{ action: "pass" }`. The bridge accepts only a
schema-shaped bounded replacement; network errors, non-success responses, malformed responses,
and timeouts return `undefined`, preserving the original request and turn.

The existing generated tool guard retains the role/group `never` check first. It sends only the
tool name to core. Core exposes a deny as `{ action: "deny" }`; the guard blocks only that exact
response with fixed core text. `warn`, pass-through, malformed replies, and transport failures
continue the pre-existing allow/ask path. A safety hook is not an availability policy: when it is
unavailable, normal policy remains authoritative.

Both generated transports use a bounded deadline. They are installed only when a current eligible
source exists (or the existing provider/tool-policy path already needs its extension), retaining
the no-grant baseline without added request-mutation transport.

## Diagnostics and audit

Every dispatcher outcome has a fixed core reason, including `Grant required`, `Prompt mutation
disabled`, `Malformed result`, `Timed out`, `Lower-priority proposal`, `Tool warning`, `Tool
denied`, `Prompt shaped`, and `Unavailable`. Extension prose, `reasonId`, worker errors, raw
prompt text, tool arguments, and tool results never enter the Context trace.

The project-owned request-mutation audit is separate authorized evidence, not an authority source.
It records the session, event, source identity when applicable, core outcome/reason, and tool name
for tool checks. For a selected prompt replacement it records before/after evidence only after
high-confidence secret redaction and UTF-8 clipping. It excludes system prompts, raw worker
errors, tool arguments/results, credentials, and extension reason prose. Corrupt or partial audit
rows are skipped on reads, and audit/trace failures do not change a request or tool decision.

```
GET /api/sessions/:sessionId/request-mutation-audit?limit=N
```

This audit read requires the verified signed operator cookie, is limited to the session's project,
and returns the newest valid entries in chronological order. `limit` is bounded from 1 through
200. It is intentionally stricter than ordinary grant inspection because it can contain redacted
prompt evidence.

## Core consumer seam

The dispatcher also accepts core-owned typed request shapers. This is the additive enforcement
surface for features such as Prompt Cache and Budgets: a core shaper can replace a prompt or warn/
deny a tool without being a pack, being serialized to a worker, or requiring an extension grant.
It participates in the same deterministic reducers (`deny` still wins), while the existing
role/group `never` ceiling still runs first. EP-4 ships the seam, not a Prompt Cache or Budget
policy.

## Non-goals

This feature does not provide raw system-prompt mutation, static prompt composition, generic JSON
patching, tool-argument mutation, tool-result filtering/redaction, a new Host API, a grant UI, or
an extension-owned apply callback. Secret redaction protects diagnostic persistence; it is not a
general secret-classification guarantee.
