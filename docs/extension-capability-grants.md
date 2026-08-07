# Extension capability grants

Extension capability grants are a project-owned, fail-closed authority layer for declared
schema-2 hooks. They separate *what an active pack declares* from *what the project permits*
so enabling a pack cannot silently authorize a decision or future mutation path.

This is an administrative API and persistence contract. For hook declarations, see the
[Extension Host authoring guide](extension-host-authoring.md#hook-metadata-and-scheduled-advisors-hooksnameyaml--schema-2).
For pack installation and activation, see [Marketplace](marketplace.md).

## Boundaries

A grant is necessary but not sufficient for a hook capability:

- `pack_activation` is an execution ceiling. A disabled, removed, or shadowed hook is absent
  from the active runtime registry and cannot be granted through the API.
- A grant matches one exact `(packId, hookId, capability)` tuple. There are no wildcards,
  default grants, inherited grants, or special treatment for built-in packs.
- The active declaration comes only from the winning, activation-filtered pack contribution.
  Client input names a tuple but never establishes pack or hook identity.
- Existing action guards, Host API scopes, session policy, validation, and worker confinement
  remain separate ceilings. A grant does not add a Host API method or bypass any of them.

The capability vocabulary is `decide`, `mutate`, `filter:tool-result`, `store`, `session`,
`agents`, `prompt:system-static`, and `prompt:system-author`. `decide` is implicitly requested by
a `mode: decide` hook. The other capabilities are eligible only when the active declaration names
the same capability. `mutate` is eligible only for an active `mode: decide` hook that declares
`mutate`; its sole current consumer is [Gated request mutation](request-mutation.md). An exact
grant lets that consumer invoke the hook to make a typed proposal, not directly mutate anything.

`filter:tool-result` is narrower still: it is eligible only for an active `mode: decide` hook
whose **only** event is `afterToolResult` and which declares that same capability. It authorizes
core's post-execution, pre-fan-out result filter; it is not implied by `decide`, `mutate`, pack
activation, built-in provenance, or any other grant. See [EP-14 — Tool-result filter seam](design/ep-14-tool-result-filter.md).

The prompt capabilities are narrow: static permits a pack's literal static sections to enter the
prompt; author permits only an authenticated agent to create or edit an approval proposal.
Neither directly applies text or executes hook code; see [Static system-prompt
sections](extension-host-authoring.md#static-system-prompt-sections-system-promptsnameyaml--schema-2).

## Project configuration

The project configuration owns the active grant list as native YAML. It is not accepted through
the generic project-config key/value writer.

```yaml
extension_grants:
  - packId: example-pack
    hookId: choose-mode
    capability: decide
    grantedAt: "2026-04-02T12:34:56.000Z"
    grantedBy: admin
```

Each entry is server-normalized:

- `packId`, `hookId`, and `grantedBy` are safe identifiers.
- `capability` is one of the closed vocabulary values.
- `grantedAt` is a canonical ISO-8601 timestamp.
- The exact `(packId, hookId, capability)` tuple is unique; a later grant replaces its stored
  metadata.
- Invalid rows are dropped. Missing or malformed configuration fails closed.

The REST grant route stamps `grantedAt` and `grantedBy`; clients cannot provide either value.
Configuration publication is atomic: on a failed write, the preceding active grant snapshot
remains in effect.

## Administrative REST API

The `GET` grant and grant-audit routes use normal gateway authentication. The prompt-sensitive
`PUT` grant and `DELETE` revoke mutations instead require a verified signed `bobbit_session`
operator cookie. A bearer token, sandbox credential, or agent session credential is not an
operator credential: each mutation returns `403 PROMPT_EXTENSION_OPERATOR_REQUIRED`. This keeps
broad automation credentials able to inspect project state while reserving authority changes for
the browser operator path. The server derives the audit actor as `localhost` for an unauthenticated
loopback gateway, otherwise `admin`; no request field can choose the actor.

### Read grants and active hook status

```
GET /api/projects/:projectId/extension-grants
```

Returns:

```ts
{
  grants: Array<{
    packId: string;
    hookId: string;
    capability: "decide" | "mutate" | "filter:tool-result" | "store" | "session"
      | "agents" | "prompt:system-static" | "prompt:system-author";
    grantedAt: string;
    grantedBy: string;
  }>;
  hooks: Array<{
    packId: string;
    packName: string;
    hooks: HookGrantStatusWire[];
  }>;
}
```

`hooks` contains only active contribution-registry declarations. `grants` is durable
configuration and may retain a tuple for a pack that was subsequently removed or shadowed.
Reads do not prune that state. This is a normal-auth read and does not require the signed
operator cookie.

### Grant one exact capability

```
PUT /api/projects/:projectId/extension-grants
Content-Type: application/json

{ "packId": "example-pack", "hookId": "choose-mode", "capability": "decide" }
```

The body must contain exactly those three fields. Wildcards, client timestamps, actors, reasons,
and arbitrary metadata are rejected. This mutation requires the verified signed `bobbit_session`
operator cookie; bearer, sandbox, and agent session credentials receive
`403 PROMPT_EXTENSION_OPERATOR_REQUIRED`. The route returns:

- `400` for an invalid body or tuple;
- `404 EXTENSION_HOOK_NOT_FOUND` when the hook is not currently active;
- `422 EXTENSION_CAPABILITY_UNSUPPORTED` when the active hook cannot request that capability;
- `200 { grant, hooks }` after the config mutation and audit append succeed.

### Revoke one exact capability

```
DELETE /api/projects/:projectId/extension-grants/:packId/:hookId/:capability
```

A revoke does not require the hook to remain installed or active. It requires the verified signed
`bobbit_session` operator cookie; bearer, sandbox, and agent session credentials receive
`403 PROMPT_EXTENSION_OPERATOR_REQUIRED`. It removes the exact persisted tuple if present, returns
`200 { revoked: true, hooks }`, and writes one `revoked` audit event. An ordinary repeat after a
completed revoke is a no-op: `200 { revoked: false, hooks }` and no second audit event.

### Read audit history

```
GET /api/projects/:projectId/extension-grant-audit?limit=N
```

The default limit is 100 and is bounded to 1 through 200. The response is
`{ entries }`: the newest valid rows, ordered chronologically. Each row contains exactly:

```ts
{
  at: string;
  actor: string;
  action: "granted" | "revoked";
  packId: string;
  hookId: string;
  capability: "decide" | "mutate" | "filter:tool-result" | "store" | "session"
    | "agents" | "prompt:system-static" | "prompt:system-author";
}
```

There is no request body, reason, token, configuration value, module path, or proposal payload
in an audit entry. This is a normal-auth read and does not require the signed operator cookie.

## Audit durability and retry

Active authority and audit history have intentionally different failure behavior. The project
configuration is updated first. The audit then appends one normalized JSONL row in the project
state directory. Therefore an audit write failure returns
`503 EXTENSION_GRANT_AUDIT_UNAVAILABLE`, but it does **not** undo the grant or revoke that has
already been safely published.

The audit store attempts to preserve a failed event in a durable project-owned outbox. It flushes
pending rows before a later append and de-duplicates an outbox row that was appended just before
a crash but not yet cleared. This lets the audit recover across a gateway restart without writing
the same event twice. Corrupt JSONL rows are skipped during reads.

A failed revoke needs one specific recovery path because its config tuple is already gone. Retry
the **same** `DELETE` URL after storage is available. If its exact revoked tuple is pending, the
route drains the outbox and returns `revoked: true`; it does not re-grant or re-revoke authority.
A later ordinary no-op DELETE remains `revoked: false` and does not create an audit record.

If even the outbox cannot be written, the route still returns the same safe `503` partial-success
response. Repair the project state storage before retrying; neither error response exposes
filesystem details or secret-bearing request data.

## Active contribution projection and live revocation

`GET /api/ext/contributions?projectId=` includes additive hook status metadata for every active
pack contribution:

```ts
interface HookGrantStatusWire {
  id: string;
  listName: string;
  mode: "observe" | "decide";
  events: string[];
  requestedCapabilities: ExtensionCapability[];
  grants: ExtensionCapability[];
  runnable: boolean;
  status: "observe" | "grant-required" | "granted";
}
```

`runnable` is static grant eligibility. It is `true` exactly for an active `mode: "decide"` hook
with its exact active `decide` grant. It neither imports a module nor guarantees an invocation.
Scheduled advisors run only when they declare the [scheduled-advisor contract](extension-host-authoring.md#every-n-turn-advisor)
and become due after `afterTurn`. Separately, the bounded `DecisionHookDispatcher` invokes active,
granted `mode: decide` hooks on their declared supported lifecycle events. It handles bounded
interactive decision requests, inbox advisories, and [typed selection proposals](extension-decision-requests.md#advisory-selection-proposals).
Observe hooks retain `status: "observe"` and `runnable: false`, even if a declared descriptive
capability is granted.

A successful grant or revoke synchronously invalidates resolver-derived contribution metadata and
broadcasts `extension_grants_updated` to the project. The WebSocket frame contains only
`projectId` and a timestamp; clients re-fetch the REST projection. No gateway, browser, or agent
restart is required for the next resolution to see a revocation.

Scheduled advisors remain an advisory-only hook execution path and use the exact `decide` grant.
The runtime resolves that grant immediately before launch and again before recording an outcome;
revocation or pack invalidation cancels matching advisor workers, and a late result is discarded.

The bounded decision-request dispatcher is a separate `mode: decide` consumer. It resolves the
exact grant immediately before invoking a hook and again before an optional `onDecision()`
continuation. A running decision worker is not preempted: if its grant was revoked while it ran,
a late selection result is denied before it can enter selection reduction or consumer application.
Neither path creates a general-purpose hook runtime, Host API, or configuration-application path:
decision effects seed editable drafts only. See [Extension decision requests](extension-decision-requests.md).

[Gated request mutation](request-mutation.md) is another bounded consumer, but requires the
separate exact `mutate` grant and an explicit `mutate` declaration. It checks the live grant before
invocation and performs a fresh declaration-and-grant fence after every candidate has settled,
immediately before core reduction and application. A revoke or deactivation during that window
therefore discards a previously returned proposal rather than applying it.

[EP-14 tool-result filtering](design/ep-14-tool-result-filter.md) is a separate bounded consumer.
It resolves the exact `filter:tool-result` grant before each worker and again after all workers
settle. If all selected filters lose authority at that final fence, the result passes unchanged;
otherwise an unavailable, malformed, timed-out, aborted, or admission-rejected active filter
fails closed to a core-owned synthetic result. No grant adds a filter API, raw-result archive, or
Host API surface.

## For extension authors

A hook YAML file is a declaration, not a self-service permission request. Authors should give a
hook a stable `id`, choose `observe` or `decide`, and declare only required
`store`/`session`/`agents` metadata as applicable; `mutate` only for a `mode: decide`
`beforePrompt`/`beforeToolCall` hook using [gated request mutation](request-mutation.md); or
`filter:tool-result` only for a `mode: decide`, `events: [afterToolResult]` result-filter hook.
A declaration is a request, not authority. Authors cannot write `extension_grants`, set the actor
or timestamp, call an extension grant route, or gain authority by enabling the pack.

These grants are not Extension Host capabilities. They do not change `host.capabilities`,
`ctx.host`, scoped surface tokens, server-module ambient access, providers, standalone pi
extensions, or existing action/route/channel behavior. A grant can authorize only a narrow
[scheduled-advisor](extension-host-authoring.md#every-n-turn-advisor), the bounded active
`mode: decide` decision-request dispatcher, [gated request mutation](request-mutation.md)
when the hook also declares `mutate` and has its separate exact `mutate` grant, or core's
[post-tool-result filter](design/ep-14-tool-result-filter.md) when it has its separate exact
`filter:tool-result` grant. It does not create a Host API surface or a general hook dispatcher;
decision, mutation, and filter hooks receive no working Host API. See [Extension decision
requests](extension-decision-requests.md).

## Market controls

Market now renders the active hook's exact grant status beside its project settings and activation
state. Granting or revoking opens a named confirmation for the precise `(pack, hook, capability)`
tuple; it still uses the same signed-operator route described above. The UI does not turn a grant
into an execution API: it displays state and sends the exact administrative mutation, while core
continues to resolve activation, configuration, and live authority at the relevant application
fence. See [Project extension settings](extension-settings.md#market-behavior) and the
[Extension Platform lifecycle](extension-platform.md#operator-lifecycle).

`bobbit.disabledProviders` is unrelated to grants and remains a compatible provider kill switch.
It is neither renamed nor interpreted as pack activation or hook authority.
