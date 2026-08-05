# EP-6 — Extension Capability Grants

**Status:** implementation design. **Depends on:** the schema-2 inert hook catalogue, `PackContributionRegistry`, `ProjectConfigStore`, and EP-5 Context trace. **Scope:** backend-only explicit per-project grants, revocation, audit, and hook grant-state visibility. Marketplace grant controls are **EP-7**; EP-6 supplies their authenticated API and response shapes but does not add a settings page.

## Decision

A hook declaration is not authority. `pack_activation` decides whether a declaration is installed/active; EP-6 separately decides whether Bobbit will run a declared decision hook or apply a capability it requests. The project owns that decision through a native `extension_grants` record in its existing `ProjectConfigStore`. Missing, malformed, inactive, shadowed, or revoked grants deny capability use.

Reuse these existing seams:

- `PackContributionRegistry` remains the sole active declaration/precedence lookup: `list(projectId)` supplies the existing per-pack rows and server-derived `packId`, while `listHooks(projectId)` remains the flattened active-hook view.
- `ProjectConfigStore` remains the native per-project configuration owner and atomic publisher.
- `src/server/server.ts` owns authenticated REST validation, cache invalidation, and the response projection.
- `ContextTraceStore` remains lifecycle decision visibility. It is not an audit log.
- Existing pack activation, `ModuleHost` confinement, action guards, role/group/tool policy, and session authorization remain in force. Grants do not bypass, replace, or broaden any of them.

Do **not** create a privileged Host API, a grant-aware extension transport, a parallel hook runner, or a second contribution resolver. A grant permits only the named capability at the existing core application choke point.

## Alternatives considered

### Option A — chosen: native grants plus a small pure policy and durable audit

Keep activation and grants separate: `ProjectConfigStore` persists the exact active grant tuples, `PackContributionRegistry` supplies the already-active declaration, a pure resolver decides one tuple at a time, and a project-owned JSONL audit records administrative history. `server.ts` composes those owners into authenticated routes, cache invalidation, and a metadata-only broadcast; it neither imports hooks nor creates a new execution path. This is minimal composition of existing seams: `tests2/core/project-config-store-native-yaml.test.ts` pins native-field persistence (including `pack_activation`), while `tests2/core/project-config-store-durability.test.ts` and `tests2/core/project-config-store-durability-repro.test.ts` pin atomic publication/failure behavior. `tests2/core/pack-contributions.test.ts` pins winning-pack collapse, hook activation filtering, and registry invalidation. `tests2/integration/marketplace-provider-activation.test.ts` is the closest existing authenticated pack-mutation REST convention; it covers GET/PUT shape and persistence, not resolver invalidation. There is no existing integration test for `invalidateResolverCaches()` itself, so EP-6 adds that focused seam rather than claiming it is already protected. `tests2/browser/e2e/pr-walkthrough-default-off.spec.ts` demonstrates the existing authenticated browser activation → contributions → reload route, but EP-6 does not reuse its Marketplace UI.

### Option B — rejected: capability flags in `pack_activation`, audit rows in `ContextTraceStore`

This touches fewer files by adding per-hook capabilities to `PackActivationMap` in `project-config-store.ts` and appending grant events to `ContextTraceStore` from `server.ts`. The control flow would combine installation/activation and authority in one write, then treat a session diagnostic trace as audit history. It loses for three concrete reasons: a malformed or broadened activation update can silently change a `decide` permission, defeating the separate deny-by-default authority boundary; `ContextTraceStore` is a bounded per-session diagnostic store, so eviction cannot prove that a removed pack was revoked; and activation is scope-oriented while grants are exact project-level `(packId, hookId, capability)` decisions with a different lifecycle. Its tests would also couple permission assertions to activation tests, whereas Option A gives `resolveExtensionGrant()` a dependency-free core seam and preserves the existing activation tests' purpose.

Option A is the smallest robust solution: it adds only the state owners that have distinct durability/lifecycle requirements (active configuration and durable audit), retains the existing registry and application choke points, and makes the fail-closed policy independently testable. Option B's smaller file count does not outweigh its audit-loss and authority-conflation failures.

## Terminology and identity

A hook is identified by the tuple:

```ts
type ExtensionHookRef = {
  packId: string;  // server-derived PackContributionRegistry winner
  hookId: string;  // HookContribution.id
};
```

The request body may name a candidate tuple, but never establishes its identity: the server resolves the active winning declaration for the project and accepts only its server-derived `packId`/`hookId` ref. A same-named hook in another pack is distinct. A hook whose pack is disabled, removed, or shadowed cannot be granted or used.

EP-6 introduces this closed capability vocabulary:

```ts
type ExtensionCapability =
  | "decide"       // core may invoke a mode:decide hook for a future decision event
  | "mutate"       // core may apply an explicitly-supported mutation proposal
  | "store"
  | "session"
  | "agents";
```

`decide` is an implicit requested capability of every `mode: "decide"` hook. `mutate` is reserved for a future declaration/consumer; it is intentionally not inferred from `session` or `agents`. The existing manifest `capabilities: ["store" | "session" | "agents"]` stays schema-2-compatible and descriptive. EP-6 does not change what those existing declarations can do. A future consumer may request one of those capabilities only when it has a concrete, existing core choke point.

All capabilities are deny-by-default. In particular, `decide` and `mutate` are never synthesized from hook mode, pack activation, existing stored config, built-in provenance, or `enabled: true`. No generic “all capabilities” grant exists.

## Persistent grant and audit stores

### Active grants: `ProjectConfigStore`

Add a native-YAML field alongside `pack_order` and `pack_activation`:

```ts
interface ExtensionGrant {
  packId: string;
  hookId: string;
  capability: ExtensionCapability;
  grantedAt: string; // canonical ISO-8601 instant, server clock
  grantedBy: string; // server-derived safe principal label
}

type ExtensionGrantMap = ExtensionGrant[];
```

Example project config:

```yaml
extension_grants:
  - packId: extension-platform-demo
    hookId: choose-thinking
    capability: decide
    grantedAt: "2026-04-02T12:34:56.000Z"
    grantedBy: local-user
```

`ProjectConfigStore` adds `getExtensionGrants()` and `setExtensionGrants()` plus draft support. Treat `extension_grants` like the other native fields: strict normalization on load and write, defensive copies, one atomic `mutate()` publication, and no legacy string representation. Invalid rows are dropped; an unreadable project config continues to fail closed through the existing `ProjectConfigLoadError` path.

Validation rules:

- `packId` and `hookId` match the existing safe identifier rule (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`).
- `capability` is an exact `ExtensionCapability` member.
- `grantedAt` is a parseable ISO timestamp emitted by the server, and `grantedBy` is a bounded server-generated identifier/label.
- Uniqueness is `(packId, hookId, capability)`. A new grant for an existing tuple replaces its metadata rather than creating a duplicate.
- The persisted record contains no token, credential reference, config value, module path, request body, free-form rationale, session secret, or user-supplied actor string.

### Append-only audit: `ExtensionGrantAuditStore`

Active configuration cannot prove a revoke happened after its target has been removed. Add `src/server/agent/extension-grant-audit-store.ts`, an append-only JSONL owner at the project's existing `.bobbit/state/extension-capability-audit.jsonl` (the project context supplies the project state directory).

```ts
type ExtensionGrantAuditAction = "granted" | "revoked";
interface ExtensionGrantAuditEntry {
  at: string;                         // server clock, ISO-8601
  actor: string;                      // server-derived, bounded
  action: ExtensionGrantAuditAction;
  packId: string;
  hookId: string;
  capability: ExtensionCapability;
}
```

The store validates/bounds every field before append, writes one JSON object per line, and its reader skips corrupt partial lines. It never accepts an arbitrary details/reason field. Audit append happens only after the `ProjectConfigStore` mutation has persisted successfully. If audit append fails, return a retriable `503 EXTENSION_GRANT_AUDIT_UNAVAILABLE`; the successful active-config change remains in effect and must not be rolled back by a second unrelated write. Log only the safe tuple and error code. This explicit partial-success response lets the operator retry/audit the failure without lying that a revoke did not take effect.

Audit is durable administrative history, separate from the 2 MiB/session diagnostic Context trace. Retention/export UI is deferred; EP-6 exposes a bounded read endpoint for verification and future EP-7 display.

## Policy resolution

Add `src/server/agent/extension-grant-policy.ts` as a pure owner, with no filesystem or HTTP dependency:

```ts
type GrantDecision =
  | { allowed: true; grant: ExtensionGrant }
  | { allowed: false; reason: "grant_required" | "inactive_hook" | "invalid_request" };

function resolveExtensionGrant(
  activeHooks: readonly ResolvedHook[],
  grants: readonly ExtensionGrant[],
  ref: ExtensionHookRef,
  capability: ExtensionCapability,
): GrantDecision;
```

`ResolvedHook` is constructed only from the active `PackContributionRegistry.list(projectId)` rows and their server-derived `packId`; it is never browser input. The same per-pack rows produce the contribution projection, so policy and wire status use one active declaration source without a registry extension. Resolution is exact and synchronous:

1. The hook must be an active registry declaration for the project. Pack activation filtering and winning-pack collapse have already happened. Otherwise return `inactive_hook`.
2. The requested capability must be supported for that declaration: `decide` requires `mode === "decide"`; declared manifest capabilities permit only their same named capability; reserved `mutate` has no eligible current declaration and therefore denies.
3. Match an exact active-grant tuple. No match returns `grant_required`.
4. A caller still applies the existing capability-specific ceilings (role/tool policy, user pin, session state, action guard, validation). `allowed` means only “the extension grant layer did not deny.”

There is no cached positive authorization. A resolver may cache parsed contribution metadata, but it reads grants from the project store on every resolution or invalidates an immutable snapshot synchronously after a successful grant mutation. The implementation must choose the former unless profiling proves it inadequate. This makes revocation effective before the next hook resolution without restarting the gateway, agent, worker, or browser.

## Existing hook visibility and execution

Extend `GET /api/ext/contributions?projectId=` only additively. Each always-emitted active pack row receives `hooks` metadata; it remains declaration metadata, not executable source:

```ts
interface HookGrantStatusWire {
  id: string;
  listName: string;
  mode: "observe" | "decide";
  events: HookEvent[];
  requestedCapabilities: ExtensionCapability[];
  grants: ExtensionCapability[]; // exact currently active grants only
  runnable: boolean;
  status: "observe" | "grant-required" | "granted";
}
```

`runnable` is a static eligibility signal, not an execution signal: it is `true` exactly when a decide hook has its exact active `decide` grant. It does not mean a dispatcher exists, that a module was imported, or that the hook will run. For an observe hook, `requestedCapabilities` is its declared capability list, `runnable` is false, and `status` is `observe`: EP-6 does not make observe hooks executable. For a decide hook, `requestedCapabilities` includes `decide`; without its exact grant its `runnable` is false and its status is `grant-required`. With that grant its status is `granted`, while EP-6 still imports and invokes no hook module. A disabled hook continues to be absent from runtime contributions exactly as today; its unfiltered declaration remains visible through the existing Marketplace activation catalogue, not this runtime endpoint.

This keeps ungranted decision hooks visible to API clients and later UI work while preserving the current inert-hook guarantee. It also means a grant cannot silently resurrect a pack-activation-disabled hook.

When EP-2 or a later decision consumer invokes a hook, it must call `resolveExtensionGrant()` immediately before `ModuleHost.invoke`, validate the typed proposal at its existing core owner, and append the appropriate EP-5 `TraceOutcomeRow`. An ungranted hook produces `denied / Grant required` without importing its module; an inactive declaration produces no execution. EP-6 itself does not add a generic dispatcher or run any hook module.

## REST API

All routes are handled in `src/server/server.ts` after standard API authentication and require the same local-user principal class used for global UI (`admin` or `localhost`). A sandbox/session bearer may not grant, revoke, or read another project's audit history. The actor is derived from this authenticated principal, not accepted from the request; current deployments record `admin` or `localhost`, with a future authenticated account mapped server-side only.

### Read effective grants and active hook status

```
GET /api/projects/:projectId/extension-grants
```

Returns `404` for an unknown project and `200`:

```ts
{
  grants: ExtensionGrant[];
  hooks: Array<{ packId: string; packName: string; hooks: HookGrantStatusWire[] }>;
}
```

Only currently active registry hooks appear in `hooks`; `grants` may include an orphaned tuple only during a crash/interruption window. On normal read, prune neither config nor audit records automatically. A later explicit maintenance operation may surface orphaned grants, but EP-6 must not delete operator state merely because a pack is temporarily absent.

### Grant

```
PUT /api/projects/:projectId/extension-grants
Content-Type: application/json

{ "packId": "extension-platform-demo", "hookId": "choose-thinking", "capability": "decide" }
```

The server rejects malformed bodies with `400`, an unknown/inactive hook with `404`, an unsupported capability for that hook with `422`, and an unreadable/persistence-failed config with the existing safe store error. It does not accept `grantedAt`, `grantedBy`, `actor`, `reason`, or a wildcard. On success it atomically persists/replaces the active grant, appends a `granted` audit record, invalidates resolver/contribution projections, broadcasts a metadata-only project invalidation for clients, and returns `200 { grant, hooks }`.

### Revoke

```
DELETE /api/projects/:projectId/extension-grants/:packId/:hookId/:capability
```

Segments are URI-decoded once and validated as safe identifiers/enums before lookup. The route is idempotent: it removes the exact tuple if present, appends a `revoked` audit record only when a grant changed, invalidates immediately, and returns `200 { revoked: boolean, hooks }`. It never requires a currently installed hook, so a revoked removed/shadowed pack is still auditable and cannot regain authority if reinstalled.

### Audit read

```
GET /api/projects/:projectId/extension-grant-audit?limit=N
```

Returns newest `N` valid entries in chronological order after bounding `limit` to 1..200 (default 100). The response is `{ entries }`; it contains only the five audit fields. EP-7 may render it, but EP-6 has no Marketplace UI.

Use `broadcastToProject(projectId, { type: "extension_grants_updated", projectId, ts })` as an invalidation only. It carries no grant, actor, audit row, reason, or secret. Existing clients may ignore the additive frame; a caller re-fetches the REST projection.

## Live revocation and cache ownership

On every successful grant/revoke config mutation:

1. Persist the active grant record through `ProjectConfigStore`.
2. Append the safe audit entry (or return the explicit audit-unavailable partial-success error).
3. Invalidate the `PackContributionRegistry`/derived contribution status projection through the existing `invalidateResolverCaches()` path, plus any new policy snapshot if one is introduced.
4. Broadcast `extension_grants_updated` to the project.

A future dispatcher must resolve policy at invocation time, not at session creation or provider-bridge generation. In-flight worker execution cannot be safely preempted; revocation guarantees denial of all **subsequent** resolution/application attempts, including in already-running sessions, with no restart. Existing application owners must check again immediately before applying a returned proposal, so a grant revoked while a worker is running cannot allow a late result to mutate state.

## `disabledProviders` compatibility

`bobbit.disabledProviders` remains supported unchanged as a goal-subtree provider kill switch. EP-6 does not rename it, reinterpret it as a grant, or make it activate/deactivate hooks. If implementation generalizes this metadata to `bobbit.disabledExtensions`, it must retain `bobbit.disabledProviders` indefinitely as an exact compatible alias and union both values before filtering. The existing provider bridge behavior—no bridge and no provider execution for a disabled provider—must remain byte-for-byte compatible.

Pack activation and grants are intentionally distinct:

| State | Result |
|---|---|
| Pack/hook activation disabled | Omitted from runtime registry; no grant can execute it. |
| Active observe hook | Visible; remains inert in EP-6. |
| Active decide hook without `decide` grant | Visible as `grant-required`; never imported/executed. |
| Active decide hook with exact grant | Visible as `granted`; eligible only for a later concrete core dispatcher. |
| Grant revoked | Next policy check denies; current session/process is not restarted. |

## Files and implementation slices

| Slice | Files | Responsibility |
|---|---|---|
| A: durable state + pure policy | `src/server/agent/project-config-store.ts`, new `src/server/agent/extension-grant-policy.ts`, new `src/server/agent/extension-grant-audit-store.ts` | Native config normalization/atomic mutation, exact fail-closed resolution, bounded append/read audit. |
| B: contribution projection | `src/server/server.ts`; `src/app/api.ts` types only | Build hook status from the existing per-pack `PackContributionRegistry.list(projectId)` rows (whose `PackContributions` already carry `packId` and active hooks). No registry change or hook-with-pack projection is needed. Do not import hook modules. |
| C: authenticated routes + invalidation | `src/server/server.ts`, `src/server/ws/protocol.ts` | Project-scoped grant/revoke/audit REST routes, principal-derived actor, cache invalidation, metadata-only event. |
| D: later consumer (not EP-6) | EP-2/EP-4 owners | Resolve immediately before execution and immediately before core application; write EP-5 outcome row. |

No `src/app/marketplace-page.ts` or settings UI change belongs in this goal. EP-7 consumes the routes and the unfiltered activation catalogue to build the Marketplace grant controls.

## Test ledger

New tests belong in `tests2/` and must be registered in `tests2/tests-map.json`.

| Layer | File | Required assertions |
|---|---|---|
| Core | `tests2/core/extension-grant-policy.test.ts` | Missing exact grant denies; `(packId, hookId, capability)` isolation; `mode: decide` needs `decide`; unsupported/malformed/inactive refs deny; no wildcard/default-on path. |
| Core | `tests2/core/project-config-store.test.ts` (extend) | Native round-trip, duplicate replacement, invalid-row drop, defensive copies, atomic write failure retains prior grants. |
| Core | `tests2/core/extension-grant-audit-store.test.ts` | Valid append/read ordering and limit, corrupt-line skip, timestamp/actor and tuple only, reject/omit secret-bearing or arbitrary fields. |
| Integration | `tests2/integration/extension-capability-grants.test.ts` | Local-user grant/revoke API authz; server derives actor; inactive/unsupported rejections; audit is append-only; audit-write failure reports partial success; response contains no secrets. |
| Integration | same | Grant/revoke invalidates a prebuilt contribution projection and a policy check in an already-created session context without restart; revocation between simulated worker return and apply check denies application. |
| Integration | `tests2/integration/extension-capability-grants.test.ts` | Active decide hook remains in contribution output with `grant-required`; activation-disabled hook is absent; observe hook remains inert; exact grant changes only that hook’s status. |
| Browser | `tests2/browser/e2e/extension-capability-grants.spec.ts` | Install an active fixture hook and drive the production grant `PUT` and revoke `DELETE` through the authenticated browser test client—no temporary route or Marketplace control. Assert `/api/ext/contributions` reports `grant-required`, then `granted` with `runnable: true`, then `grant-required` with `runnable: false`; reload the browser and re-fetch from the authenticated app origin to prove the persisted revoked state. EP-6 adds no route/UI or WebSocket client handler, so browser coverage is the real REST + reload journey, not a UI/live-event assertion; the integration test owns broadcast/invalidation behavior. Assert no raw actor/audit secret appears. |

The focused implementation commands are:

```bash
npx vitest run tests2/core/extension-grant-policy.test.ts tests2/core/extension-grant-audit-store.test.ts tests2/integration/extension-capability-grants.test.ts --config vitest.config.ts --retry=0
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- tests2/browser/e2e/extension-capability-grants.spec.ts --retries=0
```

## Non-goals

- No generic decision hook executor, typed proposal schema, selection/mutation application, prompt shaping, tool-safety change, or `host.*` capability expansion.
- No grant of ambient Node/worker access; the existing worker boundary is resource/crash isolation, not a general sandbox.
- No direct extension route that changes grants, no client-supplied actor/audit reason, and no secret/config/proposal payload in configuration, audit, WebSocket, or trace.
- No Marketplace settings UI, approval dialog, audit viewer, or activation UI change; all are EP-7.
- No removal or semantic change of `bobbit.disabledProviders`.
