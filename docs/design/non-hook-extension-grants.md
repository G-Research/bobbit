# Non-hook extension grants

**Status:** implementation design for the additive EP-6 handoff. This extends the existing
hook-only grant owner; it does not implement Hindsight memory behavior.

## Decision

Keep `ProjectConfigStore.extension_grants` and `ExtensionGrantAuditStore` as the only durable
state owners, but make their rows a compatible discriminated union. Existing hook records stay
exactly as they are. A new `runtime` principal binds a non-hook grant to one active, server-resolved
managed-service declaration:

```ts
export type ExtensionCapability =
  | "decide" | "mutate" | "filter:tool-result" | "store" | "session" | "agents"
  | "prompt:system-static" | "prompt:system-author"
  | "service.manage" | "memory.read" | "memory.write" | "memory.reflect"
  | "memory.invalidate" | "memory.read.all";

export interface ExtensionHookPrincipal {
  kind: "hook";
  packId: string;
  hookId: string;
}
export interface ExtensionRuntimePrincipal {
  kind: "runtime";
  packId: string;
  runtimeId: string;
}
export type ExtensionGrantPrincipal = ExtensionHookPrincipal | ExtensionRuntimePrincipal;

/** Legacy persisted shape. Its absent discriminator means hook. */
export interface ExtensionHookGrant {
  packId: string;
  hookId: string;
  capability: ExtensionCapability;
  grantedAt: string;
  grantedBy: string;
}
export interface ExtensionRuntimeGrant {
  packId: string;
  principal: "runtime";
  runtimeId: string;
  capability: ExtensionCapability;
  grantedAt: string;
  grantedBy: string;
}
export type ExtensionGrant = ExtensionHookGrant | ExtensionRuntimeGrant;
```

`principal: "runtime"` is required only for new rows. The legacy row's lack of `principal` is a
permanent compatibility discriminator for `kind: "hook"`; do not rewrite legacy YAML merely to
add `principal: "hook"`. `runtimeId` deliberately matches the existing
`ServiceExtensionContribution.id` and extension-settings target identity, not the user-facing
manifest basename. It prevents one service in a pack from borrowing another service's authority
and gives the existing runtime row a stable Market owner.

This is the minimal discriminator that is compatible with the current storage. `panel`, `route`,
and `tool` are callers, not authority principals: each must use the same server-derived pack and
runtime principal. Adding caller-specific rows would create several grants for one service,
obscure revocation, and allow a panel or tool declaration to mint authority.

## Closed capability and eligibility model

`EXTENSION_CAPABILITIES` remains the sole closed set and gains **only** these values:

```ts
"service.manage"
"memory.read"
"memory.write"
"memory.reflect"
"memory.invalidate"
"memory.read.all"
```

`isExtensionCapability()` remains the ingress and persisted-row validator. No pack YAML field,
settings value, route parameter, or extension code can introduce another string.

Platform-owned eligibility is likewise closed:

- `hook` principals retain the existing hook declaration rules without broadening them. The six
  new values are unsupported for hooks. In particular, `decide`, `mutate`, and
  `filter:tool-result` keep their current mode/event constraints.
- `runtime` principals support exactly the six new values above. A runtime does not declare
  capabilities; declaring a runtime is not consent and does not expand this set.
- A runtime must be present in the active result of
  `PackContributionRegistry.getPack(projectId, packId)?.runtimes`. That existing projection has
  already applied winning-pack precedence, installed-pack activation, runtime activation,
  extension-settings enablement, schema validation, and `requiresConfig`. A missing, shadowed,
  disabled, unconfigured, malformed, or settings-unavailable runtime is inactive and denies.

Grant creation therefore needs an active resolved runtime, while revocation deliberately does not:
a stale row for an uninstall, disabled target, or evolved declaration remains visible and revocable
but never authorizes work. There are no wildcard pack ids, runtime ids, capabilities, inherited
permissions, or default grants.

## Durable resolver handoff seam

Replace direct non-hook policy checks with one exported application-time resolver from
`src/server/agent/extension-grant-policy.ts` (the existing pure hook resolver may remain as an
internal compatibility wrapper during migration):

```ts
export type ExtensionGrantDeniedReason =
  | "invalid_request"
  | "project_unavailable"
  | "inactive_principal"
  | "unsupported_capability"
  | "grant_required";

export type ExtensionGrantDecision =
  | { allowed: true; grant: ExtensionGrant }
  | { allowed: false; reason: ExtensionGrantDeniedReason };

export type ExtensionCapabilityGrantResolver = (
  projectId: string,
  principal: ExtensionGrantPrincipal,
  capability: ExtensionCapability,
) => ExtensionGrantDecision;

export function createExtensionCapabilityGrantResolver(deps: {
  contextForProject(projectId: string):
    | { projectConfigStore: Pick<ProjectConfigStore, "getExtensionGrants"> }
    | undefined;
  contributions: Pick<PackContributionResolver, "getPack">;
}): ExtensionCapabilityGrantResolver;
```

This is the public Hindsight handoff: runtime lifecycle control, a pack panel or route's
server-owned request handler, and an agent tool bridge receive the same
`ExtensionCapabilityGrantResolver`, call it with their server-derived project/pack/runtime
identity, and never inspect YAML grants themselves. A client/panel cannot supply the principal
to an authorization endpoint; the endpoint derives it from its already-resolved pack binding and
uses its known runtime id.

The resolver is synchronous, side-effect-free, and fail closed in this order:

1. Validate the project id, discriminated principal fields, and closed capability before any
   lookup; malformed values return `invalid_request`.
2. Resolve the current project context. Missing/unreadable context returns `project_unavailable`.
3. Resolve the winning active pack and its matching active hook or runtime from the contribution
   registry. Missing/inactive returns `inactive_principal`.
4. Apply the platform-owned principal/capability matrix. A known capability that is not eligible
   for that active principal returns `unsupported_capability`.
5. Call `projectConfigStore.getExtensionGrants()` **at this application fence**, validate the
   stored union row, and look for exactly the matching `(packId, principal kind, principal id,
   capability)` row. Return a defensive copy only for that exact row; otherwise return
   `grant_required`.

Do not cache either the grant array or an allowed decision. Existing grant/settings/activation
mutations continue to invalidate contribution caches and broadcast `extension_grants_updated`,
but that notification is UI metadata, not an authorization mechanism. `service.manage` is checked
immediately before a runtime manager begins/reconciles a service and after any awaited launch
boundary before publishing it usable. Every memory operation checks its relevant capability at the
core application boundary (`memory.read`, `memory.read.all`, `memory.write`, `memory.reflect`, or
`memory.invalidate`). Thus revocation wins over an in-flight result before lifecycle state or a
memory response is applied. A running child process may be stopped by the ordinary reconcile path;
no stale grant may authorize a subsequent operation while that stop is pending.

## Storage and normalization

`ProjectConfigStore` keeps the native `extension_grants:` key and its atomic candidate/publication
behavior. Its normalizer accepts both rows above:

```yaml
extension_grants:
  # Existing hook row: parsed and serialized in this same shape.
  - packId: existing-pack
    hookId: choose-mode
    capability: decide
    grantedAt: "2026-04-02T12:34:56.000Z"
    grantedBy: admin

  # New non-hook row.
  - packId: hindsight
    principal: runtime
    runtimeId: memory-service
    capability: memory.read
    grantedAt: "2026-04-02T12:35:00.000Z"
    grantedBy: admin
```

Validation requires safe identifiers, an exact canonical timestamp, the closed capability, and
exactly the fields of the relevant row shape. A legacy hook row with an unknown extra principal
field, a runtime row with `hookId`, an unknown `principal`, an unsafe identifier, or any malformed
row is dropped independently. This preserves valid sibling rows and default-denies bad data.

Deduplicate only on the full principal-aware key:

- hook: `(packId, "hook", hookId, capability)`;
- runtime: `(packId, "runtime", runtimeId, capability)`.

A replacement keeps the last valid occurrence as today. Empty state removes `extension_grants`.
A failed atomic write leaves the old snapshot usable. Existing legacy hook YAML continues to load
with identical semantics and is emitted as a legacy hook row; there is no migration, loss, or
silent reinterpretation of a `hookId` as a runtime id.

## Generic administrative API and audit

Keep the current routes and normal-auth reads, generalizing their payloads without creating a
Hindsight endpoint:

| Method | Path | Contract |
|---|---|---|
| `GET` | `/api/projects/:id/extension-grants` | `{ grants, hooks, runtimes }`. `grants` is the durable union (including stale rows); `hooks` keeps its existing wire shape; `runtimes` is the server-resolved active runtime grant projection. |
| `PUT` | `/api/projects/:id/extension-grants` | Accepts exactly one legacy hook body `{ packId, hookId, capability }` or one runtime body `{ packId, principal: "runtime", runtimeId, capability }`. Server stamps actor/time. |
| `DELETE` | `/api/projects/:id/extension-grants/:packId/:hookId/:capability` | Unchanged legacy-hook revoke route. |
| `DELETE` | `/api/projects/:id/extension-grants/:packId/runtime/:runtimeId/:capability` | New exact runtime revoke route. |
| `GET` | `/api/projects/:id/extension-grant-audit?limit=N` | Existing bounded 1–200 chronological list, now with a backward-readable audit union. |

The `PUT` implementation must resolve the project before consulting the registry, validate body
shape/closed strings, then verify the matching active principal and the platform capability matrix.
It returns `400` for malformed/unknown input, `404 EXTENSION_GRANT_PRINCIPAL_NOT_FOUND` for an
inactive or uninstalled resolved principal, and `422 EXTENSION_CAPABILITY_UNSUPPORTED` for a
known capability not supported by that principal. No client actor, timestamp, reason, settings,
service command, secret, or arbitrary metadata is accepted.

Existing authorization is unchanged for hook capabilities: only `mutate`, `prompt:system-static`,
and `prompt:system-author` require the verified signed `bobbit_session` operator cookie. All six
new runtime capabilities require that same verified operator proof for both grant and revoke,
because every new grant is a capability escalation. Reads remain normal-auth. Bearer-only,
sandbox, and agent-session callers receive the existing
`403 PROMPT_EXTENSION_OPERATOR_REQUIRED` response for protected mutation attempts. The actor
remains server-derived (`localhost` on permitted loopback, otherwise `admin`).

`ExtensionGrantAuditStore` keeps its file and outbox ownership but uses matching unions:

```ts
export type ExtensionGrantAuditEntry =
  | { at: string; actor: string; action: "granted" | "revoked"; packId: string;
      hookId: string; capability: ExtensionCapability }
  | { at: string; actor: string; action: "granted" | "revoked"; packId: string;
      principal: "runtime"; runtimeId: string; capability: ExtensionCapability };
```

The legacy JSONL audit row remains valid and listable unchanged. The outbox reference is the same
principal-aware union key plus action. Append-after-config, outbox queueing, restart recovery,
exact failed-revoke retry, duplicate suppression, corrupt-line skipping, safe error messages, and
`503 EXTENSION_GRANT_AUDIT_UNAVAILABLE` partial-success behavior remain unchanged. A no-op revoke
creates neither a grant change nor an audit entry; an exact retry drains only its matching pending
runtime or hook row.

After a successful authority mutation (including authority changed despite audit `503`), invalidate
the resolver/contribution caches, trigger any lifecycle reconcile/stop listener, and broadcast the
existing metadata-only `extension_grants_updated` frame. Do not add a second grant state owner or
a Hindsight-specific audit/outbox.

## Existing Market projection and controls

Extend the existing project extension-settings projection rather than creating a permissions page:

```ts
interface RuntimeGrantStatusWire {
  id: string;
  listName: string;
  requestedCapabilities: ExtensionCapability[]; // the six runtime values
  grants: ExtensionCapability[];
  runtimeAuthorized: boolean; // exact service.manage grant
}
```

`ExtensionSettingsTargetWire` gains optional `runtimeGrant?: RuntimeGrantStatusWire` for
`ref.kind === "runtime"`; `hookGrant` stays byte-compatible. The `GET extension-grants` response
also returns the matching `runtimes` projection for callers that do not render settings. Projections
must be built from the active registry plus the durable union so inactive/stale durable rows remain
inspectable in `grants` but are not advertised as active targets.

Generalize the current Market grant tuple and row renderer to a discriminated tuple:

```ts
type ExtensionCapabilityGrantTuple =
  | { packId: string; hookId: string; capability: ExtensionCapabilityWire }
  | { packId: string; principal: "runtime"; runtimeId: string; capability: ExtensionCapabilityWire };
```

The existing **Review grants** disclosure, exact confirmation dialog, busy/error state, and
`market-capability-grant` controls render on a runtime target as well as a hook target. They use
the new body/delete URL for runtime rows and keep the current legacy hook URLs untouched. The
runtime row reports `grant-required` when its active service lacks `service.manage`; granted
capabilities on a disabled, unconfigured, or unavailable runtime display **Granted · inactive**.
All state is reloaded from the server after mutation; the UI never infers authorization locally.

## Required registered coverage

Implementation must update the affected existing tests and register any new file in
`tests2/tests-map.json` (run the inventory generator rather than hand-editing generated counts).
At minimum:

1. **Core config/policy** (`extension-grant-config-store`, `extension-grant-policy`): legacy rows
   round-trip semantically and serialize as legacy shape; every six new strings validates; unknown
   strings, malformed unions, wildcards, cross-pack/runtime tuples, unavailable project, inactive
   pack/runtime, and hook use of a runtime capability deny. Prove exact runtime-id scoping and that
   an active runtime plus a different pack's grant does not authorize.
2. **Core audit/outbox** (`extension-grant-audit-store`): legacy audit rows remain readable; runtime
   rows record principal/runtime id; malformed mixed rows are ignored; grant/revoke outbox recovery
   and restart de-duplication remain principal-aware and do not leak arbitrary details.
3. **Integration routes** (`extension-capability-grants`): normal-auth reads; operator requirement
   for every new capability; active-runtime-only PUT; stale-runtime DELETE; canonical actor/time;
   exact audit rows; invalid input/capability responses; cache/WS invalidation; audit `503` and
   exact retry recovery. Retain all old hook route/auth/error behavior.
4. **Resolver consumers:** construct representative service-lifecycle, panel/route server handler,
   and agent-tool bridge seams with the shared exported resolver. Grant then revoke between their
   pre-work and final-apply fences; prove no stale lifecycle start, panel/route result, or tool
   result is applied. Also prove an activation/settings change makes the same grant deny without a
   resolver restart.
5. **Browser** (`tests2/browser/e2e`): install an active runtime fixture, select its existing
   Market runtime row, open **Review grants**, grant one non-hook capability through the real
   confirmation/control, observe its server projection, revoke through that same control, reload,
   and verify default-deny plus audit state. Include the browser-operator failure guidance and
   ensure no secret/settings value or credential appears in DOM, storage, or audit.

Run `npm run check`, the focused core/integration/browser paths, then the required unit/browser and
focused E2E commands before merging. Update the extension capability, REST, extension authoring,
Marketplace/settings, managed-service, and parent-platform documentation to name this single
resolver and the union compatibility contract.

## Explicit handoff

The paused Hindsight parent should consume only:

- `ExtensionGrantPrincipal`
- `ExtensionCapabilityGrantResolver`
- `ExtensionGrantDecision`
- `createExtensionCapabilityGrantResolver(...)`

Its runtime/panel/route/tool code must call the returned resolver with the server-derived
`{ kind: "runtime", packId, runtimeId }` principal and the exact closed capability at each
application fence. It must not add a Hindsight permission file, endpoint, capability string, or
parallel grant cache.
