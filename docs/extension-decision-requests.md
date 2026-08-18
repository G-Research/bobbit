# Extension decision requests

Schema-2 `mode: decide` hooks can return one bounded decision result without
creating an agent turn or gaining a configuration-apply capability. Requests
and inbox advisories are durable mediation; selection proposals are
non-durable, host-owned advice. The gateway—not the hook—validates and
classifies every result, owns durable settlement where applicable, and controls
whether silence can continue work. Most decisions belong to a session; the
`projectImported` lifecycle instead belongs to a newly registered project and
has no agent session.

The three classes have deliberately different semantics:

| Class | Purpose | Silence behavior |
|---|---|---|
| **advisory** | Inform a staff member without requiring an answer. | Durable inbox entry only; it never wakes, prompts, or interrupts the staff member. It has no deadline or default. |
| **deferrable** | Ask a bounded question for work that may use a safe fallback. | A schema-valid default is required. Deadline and headless settlement apply that default and record it as `defaulted`. |
| **consent-required** | Protect an operation that must not proceed without a current answer. | Defaults are forbidden. Deadline or headless settlement either denies the current operation or leaves the affected goal paused awaiting consent. |

The UI reuses `AskUserChoicesWidget`, including its accessible keyboard
controls, drafts, and always-present **Other** escape hatch. A decision is not
an `ask_user_choices` transcript envelope and never calls `enqueuePrompt()`.

Related references:

- [Advisory selection proposals](#advisory-selection-proposals) for the non-interrupting, typed selection contract added to `decide()`.
- [Extension Host authoring](extension-host-authoring.md#hook-metadata-hooksnameyaml--schema-2-inert)
  for the schema-2 hook declaration.
- [Extension capability grants](extension-capability-grants.md) for the operator
  grant API and revocation behavior.
- [Staff Inbox Queue](staff-inbox.md) for inbox lifecycle and visibility.
- [Budget enforcement](budget-enforcement.md) for the separate, currently
  unconsumed hard-cap classification boundary.
- [REST API](rest-api.md#extension-decision-requests) for the browser projection
  and typed answer routes.

## When to use a decision

A request is an asynchronous mediation point. `decide()` returns once; it never
receives a promise for a human response. A deferrable request can later invoke
optional `onDecision()` with a durable result. Consent-required settlement is
also fenced by fresh authority and operation checks before it may route a
proposal or continue protected work.

Use a **deferrable** request only when its bounded choice has a schema-valid
safe default and a later callback can safely consume it. Use
**consent-required** when the protected operation must stop until a user
answers; never model that constraint with a permissive default. Use an
**advisory** for staff information that needs no response.

Do not use this feature to ask open-ended multi-question forms, carry prompt or
secret data, or directly mutate configuration. A proposal effect creates an
editable proposal draft; it never applies configuration.

## Enablement

A hook needs all of the following before it can make a decision:

1. A schema-2 pack lists its hook basename in `contents.hooks`.
2. The hook declaration is active and has `mode: decide`.
3. Its event is one of `sessionSetup`, `beforePrompt`, `afterTurn`,
   `beforeCompact`, `sessionShutdown`, or `projectImported`. The last is
   dispatched only by the project-registration lifecycle described below.
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

`decide()` may return `null` or `undefined` for no action, one request, one
advisory, or one selection proposal. Any other value is rejected. Unknown
fields at every level are rejected rather than ignored, so authors should treat
this as a strict output contract. `onDecision()` receives the winning durable
resolution; its return value is ignored. A thrown callback is retried during
reconciliation up to the bounded delivery limit without changing that
resolution.

## Project import decision hooks

`projectImported` lets an installed, active, exactly granted decision hook ask
about a project **after** a new normal project has been registered and its
components have been persisted, but before the Add Project flow starts its
ordinary assistant session. It gives import-time guidance a durable owner
without fabricating a session, transcript, `ask_user_choices` envelope, or
agent wake-up.

Only `POST /api/projects` creates this lifecycle, and only for a new normal
project. Existing projects are not backfilled. A retry with `upsert: true`
reuses the same import run; it does not ask again. A hook declaration that
includes this event must use `mode: decide` and must not declare `selectors` or
`schedule`. The ordinary hook `decide` grant remains the authority check, and
the gateway checks the active declaration and exact grant before invocation and
again before admitting a result or delivering a continuation.

An import hook receives a frozen, server-derived context instead of the normal
session context:

```ts
{
  event: "projectImported";
  projectId: string;
  importId: string;
  projectRoot: string;
  ownedRoots: readonly string[];
  components: readonly Array<{
    id: string;
    root: string;
    languages: readonly DetectedProjectLanguage[];
  }>;
}
```

`projectRoot`, `ownedRoots`, and component roots are absolute canonical paths.
The gateway canonicalizes the project root and each configured component root,
and drops a component that resolves outside the project root. `ownedRoots` is a
sorted, deduplicated set containing the project root and accepted component
roots. Component `id` is a stable opaque identifier; it is not the configured
component name.

The context is intentionally a shallow classification, not Code Intelligence:
the gateway considers at most 30 configured components, examines at most 256
direct directory entries per accepted root, never recurses or reads source
contents, and returns at most 12 sorted language identifiers per component.
The closed language vocabulary is `c`, `cpp`, `csharp`, `dart`, `elixir`,
`go`, `haskell`, `java`, `javascript`, `kotlin`, `lua`, `php`, `python`,
`ruby`, `rust`, `scala`, `shell`, `sql`, `swift`, and `typescript`. Paths are
capped at 4,096 UTF-16 code units. This containment and size boundary prevents
configuration or a repository tree from becoming an unbounded extension input.

Import hooks may return `null`, an advisory, or a request. Selection and
request-mutation outputs are unavailable at this lifecycle. An import request
must use `scope: "project"`; session and goal scope are rejected before
persistence. It otherwise uses the same strict request/value validation,
classification, default, consent, proposal-effect, advisory, and grant rules
as a session decision. A proposal effect creates an editable draft through the
normal proposal path after a valid resolution; it never applies configuration.
No project-import proposal workspace behavior is part of this contract.

### Durable import delivery and replay

The registry first records a `configuring` import marker. The registration route
persists components, changes that marker to `ready`, then dispatches the run.
A `configuring` marker is intentionally skipped at startup: the original
registration body was not durably complete, so guessing would risk importing
an incomplete project. An upsert retry is the recovery path; it completes the
component configuration using its request and publishes the original marker.

Once ready, the project decision store atomically records one immutable context
snapshot and durable per-hook completion entries alongside requests, memories,
and terminal state. Startup reconciles ready markers after project contexts are
available. It invokes only uncompleted hooks against that stored snapshot, not
the current filesystem. A crash after a hook begins but before its completion
entry is durable can invoke the declaration again; request dedupe, terminal
compare-and-set, memory publication, proposal seeding, and continuation state
remain independently durable. Hook authors must therefore keep `decide()`
declarative and free of external side effects.

The import run uses the session delivery limits under its `importId`: at most
two actionable requests and six newly accepted requests in 24 hours. Deferrable
project memory remains keyed by project, pack, hook, and request key—not by
import id—so it keeps the normal project-scope meaning. Consent-required import
requests cannot pause a goal because they have no goal; timeout or headless
settlement denies the protected operation. Deferrable requests use only their
already validated safe default. Silence never authorizes an effect.

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
  requestedClass?: "deferrable" | "consent-required";
  default?: DecisionValue;
  scope: "session" | "goal" | "project";
  deadlineAt: string;
  intent?: string;
  effect?: { kind: "none" }
    | {
        kind: "proposal";
        proposals: Record<string, ProposalSeed>;
        noEffectValues?: string[];
      };
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
| `requestedClass` | Optional request for `deferrable` (the compatibility default) or `consent-required`. It is only a request: trusted core classification can raise it to consent-required, never lower it. `advisory` is a separate hook output, not a request value. |
| `default` | Required for deferrable requests and must validate against the current options/Other schema. Forbidden for consent-required requests. If trusted classification raises a deferrable request, the gateway strips its supplied default before persistence. |
| `deadlineAt` | Canonical ISO-8601 instant, 30 seconds through 7 days in the future when validated. |
| `scope` | `session`, `goal`, or `project`. A goal-scoped decision is rejected when the lifecycle context has no goal. |

Text containing control characters or credential-bearing URLs is rejected. Do
not put secrets in a question, label, Other constraint, advisory, or proposal
seed.

### Effects

`effect` defaults to `{ kind: "none" }`. A proposal effect partitions every option value and
the mandatory `other` key **exactly once** between a proposal seed and `noEffectValues`. The two
sets are mutually exclusive: a seeded value cannot appear in `noEffectValues`, `noEffectValues`
cannot contain duplicates or unknown values, and no option/Other value can be omitted. Ordinary
proposal effects may seed every answer:

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

An effect can instead seed only an affirmative choice and make decline and Other explicitly
effect-free:

```js
effect: {
  kind: "proposal",
  proposals: {
    create: { proposalType: "goal", args: { title: "Create review draft" } },
  },
  noEffectValues: ["decline", "other"],
}
```

`proposalType` is one of `goal`, `project`, `workflow`, `role`, `tool`, or
`staff`. Seed arguments are bounded JSON data; they are validated before the
question is shown. On a durable answer, the server creates an **editable
proposal draft** using the normal proposal seed path. It never applies a
configuration change. Proposal creation failure is recorded separately and
never rolls back the already durable answer.

A scheduled `kind: decision` proposal is narrower still: it must have exactly
`create` with label `Create draft` as its sole seed, list every remaining option
and `other` in `noEffectValues`, and is forced to `consent-required` before
persistence. See the [staff-improvement proposal fixture](staff-improvement-proposals.md)
for the complete constrained example.

## Resolution, defaults, and memory

The project owns one atomic decision store. Deferrable records remain pending
until a valid user answer, deadline, or headless default wins the terminal
write. Their resolution records the selected value, actor (`user`, `deadline`,
or `headless`), and reason. There is one earliest-deadline timer, not one timer
per card. Gateway startup reconciles durable records before re-arming it. In
`CI=true` or with `BOBBIT_HEADLESS=1`, a new deferrable request applies its
valid default immediately and is recorded as `defaulted`.

Consent-required records have no default, memory, or defaulted path. A valid
answer is required to authorize them; a malformed answer leaves the record
actionable. The first durable transition wins across answer, deadline,
headless, restart, and retry races. A late answer sees the authoritative
settlement rather than creating a second result.

### Silence: deny or durable pause

On a consent timeout or in headless mode, the trusted operation owner chooses
the only allowed settlement action:

- **Deny operation.** The current protected operation is denied. No value,
  scoped memory, proposal, continuation, or protected side effect is recorded
  or released.
- **Pause goal.** When the core owner selects it for a goal-bound operation,
  the decision store first persists `paused-awaiting-consent` with an exact
  pause identity: `{ kind: "awaiting-extension-consent", requestId,
  createdAt }`. It then invokes the canonical durable goal-pause lifecycle.
  The goal remains an active goal marked paused—not failed or stalled—until
  settlement.

The durable record is written before external pause or inbox effects so boot
reconciliation can replay incomplete work. Replay is idempotent for that exact
identity and never relabels or re-pauses a manually paused, operator-resumed,
or differently paused goal. A pause stays answerable through the same decision
card.

Answering a paused consent record first durably claims that exact identity, then
runs one canonical exact-match resume action. It resumes only a goal whose
stored pause reason still exactly matches the request id and timestamp; a
manual or different pause is protected and the consent record is denied
instead. A restart before or after that resume is recovered from the durable
claim without replaying the pause or duplicating the resume.

### Fresh settlement fences

Every consent settlement, including direct consent requests with no explicit
protected-operation record, rechecks the active hook and exact `decide` grant.
Protected records additionally rebuild and compare the trusted operation
identity. The manager repeats the check immediately before continuation
release. Missing wiring, revocation, an inactive hook, a changed operation, or
a recheck error fails closed: no proposal is seeded and no protected work
continues.

### Budgets and deduplication

The existing interruption limits remain deliberately loud rather than
best-effort:

| Scope | Actionable limit | Creation limit in the trailing 24 hours |
|---|---:|---:|
| Session or project-import delivery | 2 | 6 |
| Goal (session delivery only) | 4 | 12 |

`pending` and `paused-awaiting-consent` records both consume the actionable
limit. A request rejected for a limit is not displayed; the lifecycle trace
records a bounded `Budget exhausted` result. Deferrable records use the
established semantic dedupe fingerprint. Consent records deduplicate only
while still actionable, so an old terminal consent can never authorize a new
protected operation.

### Exact scoped memories

Only deferrable resolutions atomically store a validated memory. Its identity
is exactly:

```
(scope, scopeId, packId, hookId, key)
```

There is no fallback from session to goal/project, between goals, between
packs/hooks, or between keys. A memory suppresses only a request whose saved
value still validates against its current options and Other schema. Memories
intentionally outlive pruned terminal request records; terminal records are
retained for 30 days, while stored memories have no separate expiry. Consent
answers never become remembered authorization.

## Advisory selection proposals

A selection proposal lets a `mode: decide` hook recommend a host-owned choice
without receiving configuration authority. It belongs alongside decision
requests because it shares the same exact activation and `decide` grant fence,
but it is not a request, has no durable settlement, and never asks the user.
This advisory-first boundary lets packs supply a bounded signal while the host
retains policy and mutation ownership.

`decide()` may return exactly one of the existing request/advisory outputs or a
selection wrapper. The selection wrapper and its nested object are **strict**:
unknown fields are rejected, rather than ignored.

```ts
// Each return is the complete hook result; do not combine proposals.
{ kind: "selection", selection: { kind: "model", provider: "aigw", modelId: "example-model" } }
{ kind: "selection", selection: { kind: "thinking", thinkingLevel: "high" } }
{ kind: "selection", selection: { kind: "role", roleName: "reviewer" } }
{ kind: "selection", selection: { kind: "workflow", workflowId: "standard-review" } }
```

Identifiers use the same safe identifier form as other hook identifiers:
`^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`. `thinkingLevel` must be a host-known
thinking-level identifier. The proposal has no priority, confidence, reason,
or apply flag; those would be policy inputs and are deliberately outside the
extension protocol. Return `null` or `undefined` when the hook has no advice.

### Hook context and admissible values

Selection hooks receive the normal frozen decision context plus immutable,
host-derived availability data:

```ts
type AdvisorySelectionHookContext = DecisionHookContext & {
  // Present only for afterTurn; copied from direct terminal telemetry.
  usage?:
    | {
        telemetry: "known";
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        cost?: number;
        provider?: string;
        modelId?: string;
      }
    | { telemetry: "unknown" };
  availableSelections: {
    models: Array<{ provider: string; modelId: string }>;
    thinkingLevels: string[];
    roles: string[];
    workflows: string[];
  };
};
```

Treat `availableSelections` as a snapshot for this invocation, not a catalogue
to reconstruct or extend. It contains identifiers only—no labels, credentials,
prompts, or configuration bodies. A syntactically valid proposal is admitted
only when its value is in the corresponding host-provided set; a model must
match the complete `{ provider, modelId }` pair. Values absent from the snapshot
are dropped. `usage` is omitted outside `afterTurn`; it is direct terminal
telemetry, not a cost-ledger replacement, and must not be copied into another
extension output or diagnostic.

For example, an after-turn hook can recommend the current host-supported
thinking level based on terminal telemetry:

```js
export default {
  decide(ctx) {
    if (ctx.event !== "afterTurn" || ctx.usage?.telemetry !== "known") return null;
    if (!ctx.availableSelections.thinkingLevels.includes("high")) return null;
    if ((ctx.usage.outputTokens ?? 0) < 2_000) return null;
    return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "high" } };
  },
};
```

### Reduction and current application

The gateway invokes eligible hooks independently and isolates malformed output,
timeouts, throws, and availability-read failures. A failure drops only that
result; it does not delay provider output, alter a previous selection, or block
other hooks. With no active matching decision-hook declarations, the dispatcher
is a no-op: it does not read availability, import a module, write a trace row,
or mutate a session. An active matching declaration without its exact `decide`
grant produces a denied outcome instead. Hindsight currently ships as a
provider contribution without a decision hook; it therefore follows this
no-hook path and produces no advisory-selection outcome.

The gateway reduces accepted proposals independently per kind. Active project
pack precedence is the first ordering key (the higher-precedence pack wins),
then `packId`, then `hookId`; worker completion order is never significant. A
losing proposal is superseded with the fixed reason `Lower-priority selection`.

Selections are advisory by default. **Thinking is the only built-in consumer in
this slice, and it is applied only for `afterTurn`.** Model, role, and workflow
proposals are recorded as advice; they do not change a live session or durable
configuration. This intentionally leaves static prompt contributions to EP-13,
per-turn request shaping and tool safety to EP-4, and replacement/packaging of
the older core thinking heuristic to its separate migration.

Before an after-turn thinking proposal can change a session, the gateway:

1. rechecks the source hook is active and has its exact `(packId, hookId,
   decide)` grant after hook execution;
2. serializes the full live read, clamp, mutation, and read-back with the same
   per-session command serializer used by human model/thinking commands;
3. rechecks the live session/project, exact grant, and explicit human thinking
   pin immediately before the RPC mutation; and
4. clamps the requested level against the **live** model, then reads back the
   effective level as the authoritative result.

An explicit human pin always wins. Revoking the exact grant while a worker is
running does not preempt that worker, but its late proposal cannot enter the
reducer or apply. A pin, revocation, unavailable/replaced session, unsupported
live-model level, RPC failure, or read-back failure is non-destructive: no
fallback, recovery mutation, or replacement choice is attempted.

## Advisories

An advisory is the non-interrupting third class. Return it instead of a request
when no user answer is needed:

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

The conversation surface requests its actionable projection and renders both
pending requests and paused-awaiting-consent records through
`AskUserChoicesWidget`. The shared widget supplies its normal
Other input, validation, keyboard navigation, ARIA semantics, and per-request
draft key. It posts the selected stored option id or Other text directly to the
decision answer endpoint. It does not produce an `ask_user_choices` envelope,
append a transcript user message, or start an agent turn.

The WebSocket message `decision_requests_updated` contains only `sessionId`
and a timestamp. It is an invalidation signal; the browser re-fetches the REST
projection. No decision text or answer travels over that WebSocket frame.

Only the request's owning session can read or answer it. Request ids are not
authority: substituting an id from another session returns not found.

Project-import decisions use the same widget in the Add Project flow, but their
projection is project-owned: `GET /api/projects/:projectId/import-decision-requests`
and `POST /api/projects/:projectId/import-decision-requests/:requestId/answer`.
The GET route exposes records only for that project's current ready import run;
the answer route accepts exactly `{ value }` and rejects a missing, mismatched,
or cross-project request with `404`. It has the same `400` invalid-value and
idempotent terminal-answer behavior as the session route. The metadata-only
`project_import_decision_requests_updated` frame contains only `projectId` and
a timestamp; REST remains authoritative.

See [REST API — Extension decision requests](rest-api.md#extension-decision-requests)
for response shapes and HTTP errors.

## Observability and privacy

Decision activity remains in the existing EP-5 Context trace as bounded,
server-owned metadata. Resolution rows can include the asker pack/hook, request
id, question fingerprint, safe selected option id or literal `other`, whether a
default was applied, actor, and timestamp. Consent rows additionally use fixed
classification, decision-status, timeout-action, and resume-status vocabularies
so an operator can distinguish denial from an awaiting-consent pause without
exposing protected work.

The trace deliberately excludes question prose, labels, Other text, protected
operation data, proposal or configuration data, prompts, transcripts,
credentials, raw errors, and stacks. Existing interruption budgets and safe
audit behavior remain in force. Trace append failure cannot change a durable
decision or delay provider output. See [REST API — Context trace endpoint](rest-api.md#context-trace-endpoint)
for the bounded read model.

## Operations and failure behavior

Decision state is stored per project in its project state directory. Missing
state starts empty. Corrupt decision state disables decision requests only for
that project; it does not corrupt staff inboxes, provider output, other hooks,
or other projects. Failed persistence leaves the previous in-memory snapshot
unchanged.

On restart, the manager reconciles overdue deferrable defaults, consent
pause/claim state, inbox projections, and terminal callbacks. The project-import
coordinator separately replays only ready import markers after project contexts
are initialized; it preserves their immutable snapshot and never backfills a
legacy project. A consent pause
has a durable inbox source key. If the origin session still belongs to a staff
record in the same project, the server creates or reuses exactly one non-waking
`consent_pause` inbox entry. If that target is unavailable, the record changes
to a projection-only fallback and remains answerable in its owning session;
the system never substitutes another staff member. Inbox failure likewise does
not convert the pause into failure or stall.

Callback delivery is bounded to three attempts; a failure never changes the
answer. A failed terminal persistence retry uses bounded backoff rather than a
busy loop. Failures in UI refresh, proposal seeding, continuation delivery,
inbox handling, or tracing are isolated from the agent/provider path.

### Troubleshooting

| Symptom | Check |
|---|---|
| No question appears | Confirm the pack is schema-2, its hook basename is active, `mode: decide`, event is supported, and the project has the exact `decide` grant. Inspect Context trace for `Grant required`, malformed output, timeout, duplicate, or budget exhaustion. |
| Output is rejected | Remove unknown fields; use 2–8 unique options; provide a canonical deadline within 30 seconds–7 days; use only the conservative anchored regex subset; and include a valid default only for a deferrable request. Consent-required requests must omit it. |
| A repeat does not show | Keep the `key` stable only for the same semantic choice. Deferrable dedupe ignores wording/deadline changes, and an exact valid scoped memory suppresses re-asking. Consent dedupes only while actionable. Change the semantic key only when the decision itself changes. |
| Staff was not woken by an advisory or consent reference | Expected. Both are durable inbox entries with `wake: false`; neither is a staff work trigger. |
| A consent request was denied after an answer | Check that the hook remains active with its exact `decide` grant and that the trusted protected-operation identity has not changed. Settlement is fail-closed. |
| A goal remains paused awaiting consent | Expected until a valid answer settles the exact recorded consent pause. Use the decision card; do not replace the pause reason with a manual pause if it should be resumed by that answer. |
| A configuration change did not occur | Expected. Proposal effects seed an editable proposal draft only. Review and accept it through the normal proposal path. |
| Question vanishes after submit/reload | Expected after a successful answer: the browser projection lists actionable records only. Reload before settlement rehydrates a pending or awaiting-consent card. |

## Trusted classification boundary

Extensions may request consent-required but cannot lower a stricter platform
classification, retain a stripped default, choose the timeout action, or name
the protected operation. The server-only classifier forces consent-required
for a core hard-cap override (such as spending beyond a hard cap), a core tool
analysis marked unsafe, capability escalation, grant change, and configuration
change. A protected proposal-effect
adapter currently recognizes reachable proposal types and derives a stable,
opaque operation identity: `tool` is capability escalation, `role` is grant
change, and `project` is configuration change. Its safe timeout action is deny
operation; configuration still routes only to a proposal draft after a valid
answer.

These are composition boundaries, not claims of missing integrations. As
[Budget enforcement](budget-enforcement.md) documents, there is currently no
live hard-cap consumer. Nor is there currently a core unsafe-tool analyzer.
When those future core owners exist, they must pass their own trusted facts at
the operation choke point, choose only a fail-closed consent settlement, and
recheck immediately before applying work. Extension advice, a requested
`deferrable` class, silence, and an ungranted result can never substitute for
that core decision.

## Tests

Focused coverage is registered in `tests2/tests-map.json`:

- `tests2/core/decision-hook-contract.test.ts` and
  `tests2/core/decision-request-manager.test.ts` — class/default validation,
  forced platform floors, silent denial, fresh settlement fences, budgets,
  dedupe, and scoped-memory isolation.
- `tests2/integration/consent-pause-recovery.test.ts` — deny and pause timeout
  paths, restart/race recovery, exact one-action resume, manual-pause
  protection, advisory isolation, and proposal-only configuration effects.
- `tests2/integration/extension-decision-requests.test.ts` — grants/revocation,
  answer ownership, malformed values, and no-prompt isolation.
- `tests2/core/project-import-decision-context.test.ts`,
  `tests2/core/project-import-decision-coordinator.test.ts`,
  `tests2/core/decision-hook-dispatcher.test.ts`, and
  `tests2/dom/project-import-decision-renderer.test.ts` — bounded context,
  immutable run replay, no-session delivery, and the project-owned choice
  projection.
- `tests2/dom/decision-request-renderer.test.ts` and
  `tests2/dom/consent-inbox-reference.test.ts` — shared-card rendering and the
  non-destructive consent inbox Review action.
- `tests2/browser/e2e/extension-decision-request.spec.ts` and
  `tests2/browser/e2e/consent-pause-recovery.spec.ts` — real-browser consent
  rendering, reload, inbox reference, typed answer, no default/failure surface,
  and advisory inbox-only behavior.

Run the relevant tier with `npm run test:unit` or `npm run test:browser`.
