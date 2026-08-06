# Extension decision requests

Schema-2 `mode: decide` hooks can ask a bounded, durable user question without
creating an agent turn or giving an extension a configuration-apply capability.
They are for a decision that is needed to proceed; use an **advisory** for
non-interrupting staff information instead.

The gateway owns validation, persistence, deadlines, scope memories, proposal
routing, and observability. The UI reuses the existing
`AskUserChoicesWidget`, including its accessible keyboard controls, drafts, and
always-present **Other** escape hatch. A decision is not an
`ask_user_choices` transcript envelope and never calls `enqueuePrompt()`.

Related references:

- [Extension Host authoring](extension-host-authoring.md#hook-metadata-hooksnameyaml--schema-2-inert)
  for the schema-2 hook declaration.
- [Extension capability grants](extension-capability-grants.md) for the operator
  grant API and revocation behavior.
- [Staff Inbox Queue](staff-inbox.md) for advisory lifecycle and visibility.
- [REST API](rest-api.md#extension-decision-requests) for the browser projection
  and typed answer routes.

## When to use a decision

A decision request is an asynchronous mediation point. `decide()` returns once;
it never receives a promise for a human response. If the request is accepted,
the server renders it in the session conversation and later invokes optional
`onDecision()` with the durable result. The original provider path and agent
turn continue independently.

Use a request when all of these are true:

- the choice is bounded and has a safe default;
- the choice has an explicit deadline;
- the lifecycle event can continue without waiting for the answer; and
- a later callback can safely consume the recorded answer.

Use an advisory for an informational notice to a staff member. Advisories are
persisted in the inbox but never wake that staff member. Do not use either
feature to block a turn, ask open-ended multi-question forms, carry prompt or
secret data, or directly mutate configuration.

## Enablement

A hook needs all of the following before it can make a decision:

1. A schema-2 pack lists its hook basename in `contents.hooks`.
2. The hook declaration is active and has `mode: decide`.
3. Its event is one of `sessionSetup`, `beforePrompt`, `afterTurn`,
   `beforeCompact`, or `sessionShutdown`.
4. The project has an exact EP-6 `decide` grant for `(packId, hookId)`.

Activation alone is not permission. Operators grant the capability through the
normal authenticated project API:

```bash
curl -X PUT "$GW/api/projects/$PROJECT_ID/extension-grants" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"packId":"review-pack","hookId":"review-mode","capability":"decide"}'
```

The dispatcher resolves that grant immediately before calling `decide()` and
again before an `onDecision()` continuation. Revoking it prevents a later
result from being applied; an in-flight worker is not preempted. See
[Extension capability grants](extension-capability-grants.md) for route errors,
audit, and live-revocation details.

### Pack and module example

```yaml
# pack.yaml
schema: 2
contents:
  roles: []
  tools: []
  skills: []
  hooks: [review-mode]
```

```yaml
# hooks/review-mode.yaml
id: review-mode
module: ../lib/review-mode.mjs
events: [beforePrompt]
mode: decide
capabilities: []
budget:
  maxTokens: 64
  timeoutMs: 1000
```

The module may use either named exports or a default-export object. Only
`decide` and optional `onDecision` are callable. The hook context contains
`event`, `sessionId`, `projectId`, `goalId?`, `roleName?`, and `cwd`; it does
not expose `ctx.host`, prompts, transcripts, headers, tokens, or a working host
API.

```js
// lib/review-mode.mjs
export default {
  decide(ctx) {
    return {
      kind: "request",
      request: {
        version: 1,
        key: "review-mode",
        title: "Review mode",
        question: "Which review mode should be used?",
        options: [
          { value: "quick", label: "Quick" },
          { value: "thorough", label: "Thorough" },
        ],
        other: { minLength: 3, maxLength: 48, pattern: "^[A-Za-z ]+$" },
        default: { kind: "option", value: "quick" },
        scope: "goal",
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        effect: { kind: "none" },
      },
    };
  },

  onDecision(ctx) {
    // ctx.requestId and ctx.resolution are durable server-owned values.
    // ctx.resolution = { value, actor, reason }.
  },
};
```

`decide()` may return `null` or `undefined` for no action, one request, or one
advisory. Any other value is rejected. Unknown fields at every level are
rejected rather than ignored, so authors should treat this as a strict output
contract. `onDecision()` receives the winning durable resolution; its return
value is ignored. A thrown callback is retried during reconciliation up to the
bounded delivery limit without changing that resolution.

## Request contract

A request has this shape:

```ts
type DecisionValue =
  | { kind: "option"; value: string }
  | { kind: "other"; text: string };

type ProposalSeed = {
  proposalType: "goal" | "project" | "workflow" | "role" | "tool" | "staff";
  args: Record<string, unknown>;
};

interface ExtensionDecisionRequest {
  version: 1;
  key: string;
  title: string;
  question: string;
  options: Array<{ value: string; label: string }>;
  other: { minLength?: number; maxLength: number; pattern?: string };
  default: DecisionValue;
  scope: "session" | "goal" | "project";
  deadlineAt: string;
  effect?: { kind: "none" }
    | { kind: "proposal"; proposals: Record<string, ProposalSeed> };
}
```

The server validates both the hook output and every submitted/default value.
Important limits and constraints are:

| Field | Contract |
|---|---|
| `key`, option `value` | Safe identifier: `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`. `key` is the stable semantic identity; do not derive it from display prose. |
| `title`, `question` | Non-empty safe text, at most 120 and 320 characters respectively. |
| `options` | 2–8 entries. Values must be unique and may not be `other`; labels are non-empty safe text up to 120 characters, unique case-insensitively, and may not be `Other` or `__OTHER__`. |
| `other` | Required. `maxLength` is an integer from 1 through 280; `minLength`, when supplied, is 0 through `maxLength`. |
| `pattern` | Optional, anchored, conservative pattern up to 256 characters. It permits literal text or character classes, safe escapes, and at most one simple quantifier. Groups, alternation, lookarounds, backreferences, nested/adjacent quantifiers, and unanchored patterns are rejected to avoid regex backtracking hazards. Examples: `^[A-Za-z ]+$`, `^[0-9]{1,4}$`, `^release-[A-Za-z0-9._-]+$`. |
| `default` | Required and must validate against the current options/Other schema. It can be an option or a valid Other value. |
| `deadlineAt` | Canonical ISO-8601 instant, 30 seconds through 7 days in the future when validated. |
| `scope` | `session`, `goal`, or `project`. A goal-scoped decision is rejected when the lifecycle context has no goal. |

Text containing control characters or credential-bearing URLs is rejected. Do
not put secrets in a question, label, Other constraint, advisory, or proposal
seed.

### Effects

`effect` defaults to `{ kind: "none" }`. A proposal effect maps **every**
option value and the mandatory `other` key to a seed:

```js
effect: {
  kind: "proposal",
  proposals: {
    quick: { proposalType: "goal", args: { title: "Quick review" } },
    thorough: { proposalType: "goal", args: { title: "Thorough review" } },
    other: { proposalType: "goal", args: { title: "Custom review" } },
  },
}
```

`proposalType` is one of `goal`, `project`, `workflow`, `role`, `tool`, or
`staff`. Seed arguments are bounded JSON data; they are validated before the
question is shown. On a durable answer, the server creates an **editable
proposal draft** using the normal proposal seed path. It never applies a
configuration change. Proposal creation failure is recorded separately and
never rolls back the already durable answer.

## Resolution, defaults, and memory

The project owns one atomic decision store. A request remains pending until a
valid user answer, deadline, or headless default wins the first terminal write.
The terminal resolution records:

- `value` — selected option id or Other text;
- `actor` — `user`, `deadline`, or `headless`; and
- `reason` — `answered`, `deadline_elapsed`, or `headless_default`.

There is one earliest-deadline timer, not a timer per card. Gateway startup
reconciles durable pending records before re-arming it. In `CI=true` or with
`BOBBIT_HEADLESS=1`, newly created pending decisions resolve their valid
default immediately and no interactive wait is created.

Concurrent user submit, deadline, restart reconciliation, and retry paths are
safe: the first durable terminal write wins. A malformed answer returns an
error and leaves the request pending. A late answer is treated as already
resolved after the deadline default is applied.

### Budgets and deduplication

The limits are deliberately loud rather than best-effort:

| Scope | Pending limit | Creation limit in the trailing 24 hours |
|---|---:|---:|
| Session | 2 | 6 |
| Goal | 4 | 12 |

Goal limits apply only when the source session has a goal. A request rejected
for a limit is not displayed; the lifecycle trace records a bounded `Budget
exhausted` result.

Requests are semantically deduplicated within the project by the asker
(`packId`, `hookId`), stable request `key`, target scope identity, option ids,
Other schema, default, and effect. Changes to title, question, labels,
lifecycle event, or deadline do not re-ask the same decision. The internal
dedupe fingerprint is never exposed in traces.

### Exact scoped memories

Each successful/default resolution atomically stores a validated memory. Its
identity is exactly:

```
(scope, scopeId, packId, hookId, key)
```

There is no fallback from session to goal/project, between goals, between
packs/hooks, or between keys. A memory suppresses only a request whose saved
value still validates against its current options and Other schema. Memories
intentionally outlive pruned terminal request records; terminal records are
retained for 30 days, while stored memories have no separate expiry.

## Advisories

Return an advisory instead of a request when no user answer is needed:

```js
return {
  kind: "advisory",
  advisory: {
    version: 1,
    staffId: "operations",
    key: "low-space",
    title: "Low disk space",
    body: "The workspace volume is approaching its threshold.",
  },
};
```

Advisory identifiers follow the same safe identifier rule. Title and body are
safe non-empty text limited to 120 and 1,000 characters. The gateway writes a
durable `extension_advisory` inbox entry with its pack and hook source, and
deduplicates pending entries by that source and key. At most 8 pending extension
advisories are retained per staff member. Crucially, it calls the inbox enqueue
path with `wake: false`: the entry is visible and durable but does not nudge,
prompt, or wake the staff agent.

Advisories have no deadline, default, scoped memory, question card, or
continuation.

## UI and REST projection

The conversation surface requests a pending-only projection and renders each
record through `AskUserChoicesWidget`. The shared widget supplies its normal
Other input, validation, keyboard navigation, ARIA semantics, and per-request
draft key. It posts the selected stored option id or Other text directly to the
decision answer endpoint. It does not produce an `ask_user_choices` envelope,
append a transcript user message, or start an agent turn.

The WebSocket message `decision_requests_updated` contains only `sessionId`
and a timestamp. It is an invalidation signal; the browser re-fetches the REST
projection. No decision text or answer travels over that WebSocket frame.

Only the request's owning session can read or answer it. Request ids are not
authority: substituting an id from another session returns not found.

See [REST API — Extension decision requests](rest-api.md#extension-decision-requests)
for response shapes and HTTP errors.

## Observability and privacy

Decision activity appears in the existing EP-5 Context trace as bounded,
server-owned metadata. Resolution rows include the asker pack/hook, request id,
question fingerprint, safe selected option id or literal `other`, whether a
default was applied, actor, and timestamp. Deadline and headless defaults also
carry their fixed reason (`Deadline elapsed` or `Headless default`); the durable
resolution records `answered` for a user answer without copying that generic
reason into the trace. Dispatch rows capture safe outcomes such as grant
required, malformed result, timeout, duplicate, or budget exhaustion.

The trace deliberately excludes question prose, labels, Other text, proposal
or configuration data, prompts, transcripts, credentials, raw errors, and
stacks. Trace append failure cannot change a durable decision or delay provider
output. See [REST API — Context trace endpoint](rest-api.md#context-trace-endpoint)
for the bounded read model.

## Operations and failure behavior

Decision state is stored per project in its project state directory. Missing
state starts empty. Corrupt decision state disables decision requests only for
that project; it does not corrupt staff inboxes, provider output, other hooks,
or other projects. Failed persistence leaves the previous in-memory snapshot
unchanged.

On restart, pending records are reconciled, overdue defaults are attempted, and
terminal callbacks that were not delivered may retry. Callback delivery is
bounded to three attempts; a failure never changes the answer. A failed
terminal persistence retry uses bounded backoff rather than a busy loop.
Failures in UI refresh, proposal seeding, continuation delivery, inbox handling,
or tracing are isolated from the agent/provider path.

### Troubleshooting

| Symptom | Check |
|---|---|
| No question appears | Confirm the pack is schema-2, its hook basename is active, `mode: decide`, event is supported, and the project has the exact `decide` grant. Inspect Context trace for `Grant required`, malformed output, timeout, duplicate, or budget exhaustion. |
| Output is rejected | Remove unknown fields; use 2–8 unique options; include a valid Other schema/default; provide a canonical deadline within 30 seconds–7 days; and use only the conservative anchored regex subset. |
| A repeat does not show | Keep the `key` stable only for the same semantic choice. Dedupe ignores wording/deadline changes, and an exact valid scoped memory suppresses re-asking. Change the semantic key only when the decision itself changes. |
| Staff was not woken by an advisory | Expected. Extension advisories are durable inbox entries with `wake: false`; they are not staff work triggers. |
| A configuration change did not occur | Expected. Proposal effects seed an editable proposal draft only. Review and accept it through the normal proposal path. |
| Question vanishes after submit/reload | Expected after a successful answer: the browser projection lists pending records only. Reload before resolution rehydrates the durable pending card. |

## Tests

Focused coverage is registered in `tests2/tests-map.json`:

- `tests2/core/decision-hook-contract.test.ts` — strict schema, safe patterns,
  defaults, deadlines, proposals, and advisories.
- `tests2/core/decision-request-store.test.ts` and
  `tests2/core/decision-request-manager.test.ts` — atomic persistence,
  corruption, restart, deadlines, headless mode, budgets, dedupe, scope memory,
  races, and failure isolation.
- `tests2/integration/extension-decision-requests.test.ts` and
  `tests2/integration/decision-proposal-routing.test.ts` — grant/revocation,
  answer ownership, no-prompt behavior, and proposal-only effects.
- `tests2/dom/decision-request-renderer.test.ts` — shared widget adapter and
  decision-only answer transport.
- `tests2/browser/e2e/extension-decision-request.spec.ts` — pack activation and
  grant, a real Other answer, reload, no agent prompt, scoped persistence, and
  trace redaction.

Run the relevant tier with `npm run test:unit` or `npm run test:browser`.
