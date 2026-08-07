# Non-hook extension grants

**Status:** implementation design for the additive EP-6 handoff. This extends the existing
hook-only grant owner; it does not implement Hindsight memory behavior.

## Decision

Keep `ProjectConfigStore.extension_grants` and `ExtensionGrantAuditStore` as the only durable
state owners, but make their rows a compatible discriminated union. Existing hook records stay
exactly as they are. A new **pack** principal grants the same exact project/pack capability to
that pack's service lifecycle, panels/routes, and agent tools:

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
export interface ExtensionPackPrincipal {
  kind: "pack";
  packId: string;
}
export type ExtensionGrantPrincipal = ExtensionHookPrincipal | ExtensionPackPrincipal;

/** Legacy persisted shape. Its absent discriminator permanently means hook. */
export interface ExtensionHookGrant {
  packId: string;
  hookId: string;
  capability: ExtensionCapability;
  grantedAt: string;
  grantedBy: string;
}
export interface ExtensionPackGrant {
  packId: string;
  principal: "pack";
  capability: ExtensionCapability;
  grantedAt: string;
  grantedBy: string;
}
export type ExtensionGrant = ExtensionHookGrant | ExtensionPackGrant;
```

`principal: "pack"` is required only for new rows. The legacy row's absence of `principal` is a
permanent compatibility discriminator for `kind: "hook"`; do not rewrite old YAML merely to add
`principal: "hook"`. The pack discriminator is the only new storage discriminator: there is no
runtime id, panel id, route id, tool id, wildcard, inheritance, or default grant. Those surfaces
are callers that share their server-derived pack principal, rather than independent authorities
which could accidentally diverge or let an extension manufacture a new permission scope.

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

Platform-owned eligibility is closed:

- `hook` principals retain the existing hook declaration rules without broadening them. The six
  new values are unsupported for hooks. In particular, `decide`, `mutate`, and
  `filter:tool-result` keep their current mode/event constraints.
- `pack` principals support exactly the six new values. A pack does not declare capabilities;
  installation, activation, or a service declaration is not consent and does not expand this set.
- A pack principal is active only when
  `PackContributionRegistry.getPack(projectId, packId)` returns the current winning active pack.
  That existing server-owned resolution applies installation, precedence/shadowing, and pack
  activation. Missing, uninstalled, shadowed, disabled, malformed, or unavailable packs deny.
  A particular runtime's extension-settings/configuration eligibility remains a separate
  lifecycle ceiling; it is not a second grant principal.

Grant creation requires the active resolved pack. Revocation does not: a stale row for an
uninstalled or inactive pack remains inspectable and revocable but never authorizes work. There
are no wildcard pack ids, arbitrary capability strings, inherited permissions, or client-defined
principal types.

## Durable resolver handoff seam

Provide one exported application-time resolver from
`src/server/agent/extension-grant-policy.ts`. The existing pure `resolveExtensionGrant()` may
remain as an internal hook-compatibility wrapper while callers migrate.

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

This is the public Hindsight handoff. Runtime lifecycle control, a pack panel or route's
server-owned handler, and an agent-tool bridge receive the same
`ExtensionCapabilityGrantResolver`, call it with their server-derived
`{ kind: "pack", packId }`, and never inspect YAML grants themselves. A client/panel cannot
provide a principal to an authorization endpoint: that endpoint derives the pack from its existing
resolved pack binding.

The resolver is synchronous, side-effect-free, and fail closed in this order:

1. Validate project id, discriminated principal fields, and closed capability before lookup;
   malformed values return `invalid_request`.
2. Resolve current project context; missing/unreadable context returns `project_unavailable`.
3. Resolve the winning active pack and, for hooks only, its matching active hook. Missing/inactive
   values return `inactive_principal`.
4. Apply the platform-owned principal/capability matrix. A known capability that is ineligible
   for this principal returns `unsupported_capability`.
5. Call `projectConfigStore.getExtensionGrants()` **at this application fence**, validate the
   stored union row, and look for the exact `(packId, principal kind, hookId when hook,
   capability)` tuple. Return a defensive copy only for that row; otherwise return
   `grant_required`.

Do not cache either the grant array or an allowed decision. Existing grant/settings/activation
mutations continue to invalidate contribution caches and broadcast `extension_grants_updated`,
but that notification is UI metadata, not authorization. `service.manage` is checked immediately
before a runtime manager begins/reconciles a service and after awaited launch boundaries before
publishing it usable. Each memory operation checks its relevant capability at its core application
boundary (`memory.read`, `memory.read.all`, `memory.write`, `memory.reflect`, or
`memory.invalidate`). Revocation therefore wins over stale work before lifecycle state or a memory
result is applied. A running child process may be stopped by ordinary reconcile; no subsequent
operation is allowed while that stop is pending.

## Storage and normalization

`ProjectConfigStore` keeps native `extension_grants:` and its atomic candidate/publication
behavior. Its normalizer accepts both rows:

```yaml
extension_grants:
  # Existing hook row: parsed and serialized in this same shape.
  - packId: existing-pack
    hookId: choose-mode
    capability: decide
    grantedAt: "2026-04-02T12:34:56.000Z"
    grantedBy: admin

  # New non-hook pack row.
  - packId: hindsight
    principal: pack
    capability: memory.read
    grantedAt: "2026-04-02T12:35:00.000Z"
    grantedBy: admin
```

Validation requires safe identifiers, a canonical timestamp, the closed capability, and exactly
the fields of the matching row shape. A legacy hook row with an added principal field, a pack row
with `hookId`, an unknown principal, unsafe identifier, or malformed row is dropped independently.
That preserves valid sibling rows and default-denies bad data.

Deduplicate only on the full key:

- hook: `(packId, "hook", hookId, capability)`;
- pack: `(packId, "pack", capability)`.

A replacement keeps the last valid occurrence as today. Empty state removes `extension_grants`.
A failed atomic write leaves the old snapshot usable. Existing hook YAML loads and serializes with
identical semantics; there is no migration, loss, or reinterpretation of `hookId`.

## Generic administrative API and audit

Keep the current routes and normal-auth reads, generalizing them without a Hindsight endpoint:

| Method | Path | Contract |
|---|---|---|
| `GET` | `/api/projects/:id/extension-grants` | `{ grants, hooks, packs }`. `grants` is the durable union (including stale rows); `hooks` keeps its existing wire shape; `packs` is the server-resolved active pack grant projection. |
| `PUT` | `/api/projects/:id/extension-grants` | Accepts exactly one legacy hook body `{ packId, hookId, capability }` or one pack body `{ packId, principal: "pack", capability }`. Server stamps actor/time. |
| `DELETE` | `/api/projects/:id/extension-grants/:packId/:hookId/:capability` | Unchanged legacy-hook revoke route. |
| `DELETE` | `/api/projects/:id/extension-grants/:packId/principals/pack/:capability` | New exact pack revoke route. The `principals` segment avoids treating a valid legacy hook id named `pack` as a pack principal. |
| `GET` | `/api/projects/:id/extension-grant-audit?limit=N` | Existing bounded 1–200 chronological list, now with a backward-readable audit union. |

`PUT` resolves the project before consulting the registry, validates body shape/closed strings,
then verifies the matching active pack and platform capability matrix. It returns `400` for
malformed/unknown input, `404 EXTENSION_GRANT_PRINCIPAL_NOT_FOUND` for inactive/uninstalled pack
or hook, and `422 EXTENSION_CAPABILITY_UNSUPPORTED` for a known capability not supported by that
principal. It accepts no client actor, timestamp, reason, service/settings value, secret, or
arbitrary metadata.

Existing authorization is unchanged for hook capabilities: only `mutate`, `prompt:system-static`,
and `prompt:system-author` require the verified signed `bobbit_session` operator cookie. All six
new pack capabilities require that same verified operator proof for both grant and revoke, because
every new grant is a capability escalation. Reads remain normal-auth. Bearer-only, sandbox, and
agent-session callers receive the existing `403 PROMPT_EXTENSION_OPERATOR_REQUIRED` response for
protected mutations. Actor remains server-derived (`localhost` on permitted loopback, otherwise
`admin`).

`ExtensionGrantAuditStore` keeps its file/outbox ownership but uses matching unions:

```ts
export type ExtensionGrantAuditEntry =
  | { at: string; actor: string; action: "granted" | "revoked"; packId: string;
      hookId: string; capability: ExtensionCapability }
  | { at: string; actor: string; action: "granted" | "revoked"; packId: string;
      principal: "pack"; capability: ExtensionCapability };
```

Legacy JSONL rows remain valid and listable unchanged. The outbox reference is the same
principal-aware union key plus action. Append-after-config, queueing, restart recovery, exact
failed-revoke retry, duplicate suppression, corrupt-line skipping, safe errors, and
`503 EXTENSION_GRANT_AUDIT_UNAVAILABLE` partial-success behavior remain unchanged. A no-op revoke
creates neither authority nor audit event; an exact retry drains only that matching hook or pack
row.

After an authority mutation, including an authority change followed by audit `503`, invalidate
resolver/contribution caches, trigger lifecycle reconcile/stop listeners, and broadcast the
existing metadata-only `extension_grants_updated` frame. Do not add a second state owner or a
Hindsight-specific audit/outbox.

## Existing Market projection and controls

Use the existing selected-project Market surface, not a permissions page. The server adds a
pack-principal projection to the existing `Pack` target row:

```ts
interface PackGrantStatusWire {
  packId: string;
  requestedCapabilities: ExtensionCapability[]; // only the six pack values
  grants: ExtensionCapability[];
}
```

`ExtensionSettingsTargetWire` gains optional `packGrant?: PackGrantStatusWire` for the synthetic
existing `kind: "pack"` target; `hookGrant` stays byte-compatible. The grant list endpoint also
returns matching active `packs` for non-Market callers. The settings catalogue must include an
active pack target even when the pack has no provider/hook/runtime settings target, so a
panel/route/tool-only pack has one visible place for its grants. Durable rows for inactive or
uninstalled packs remain inspectable in `grants` and audit, never as an actionable active
projection.

Generalize the current Market tuple and renderer:

```ts
type ExtensionCapabilityGrantTuple =
  | { packId: string; hookId: string; capability: ExtensionCapabilityWire }
  | { packId: string; principal: "pack"; capability: ExtensionCapabilityWire };
```

The existing **Review grants** disclosure, `market-capability-grant` row, exact confirmation,
busy/error state, success live region, and grant/revoke controls render in the existing **Pack**
row as well as hook rows. It must show only server-projected recognized capabilities, one exact
capability per row, in the UX-defined stable order; no bundle, wildcard, or grant-all control.
The confirmation identifies project, pack display name and id, pack principal, exact capability,
and for `memory.read.all` its all-project-memory consequence. The new tuple uses the pack delete
route above; all legacy hook URLs and test seams remain unchanged.

States are server-derived: `Not granted`, `Granted`, `Granted · inactive`, or `Unavailable`.
Granting requires an active pack; revoke remains available for a retained inactive durable row.
After every mutation, reload the durable projection rather than inferring authority locally. Keep
project-level read-only grant history in the same Installed surface so audit rows for uninstalled
packs remain visible; legacy rows display as Hook and new rows display as Pack.

## Required registered coverage

Implementation updates affected tests and registers every new file in `tests2/tests-map.json`
(using the inventory generator rather than editing generated counts). At minimum:

1. **Core config/policy** (`extension-grant-config-store`, `extension-grant-policy`): legacy rows
   round-trip and serialize in legacy shape; each six new strings validates; malformed unions,
   wildcards, cross-pack tuples, unavailable project, inactive/uninstalled/shadowed pack, and
   hook use of a pack capability deny. Prove exact pack scoping and that a grant on pack A cannot
   authorize pack B.
2. **Core audit/outbox** (`extension-grant-audit-store`): legacy audit rows remain readable; pack
   rows record `principal: "pack"`; malformed mixed rows are ignored; grant/revoke restart
   recovery and duplicate suppression are principal-aware and secret-free.
3. **Integration routes** (`extension-capability-grants`): normal-auth reads; verified operator
   requirement for every new capability; active-pack-only PUT; stale-pack DELETE; canonical
   actor/time; exact audit rows; invalid input/capability responses; cache/WS invalidation; audit
   `503` and exact retry recovery. Retain every hook route/auth/error behavior.
4. **Resolver consumers:** use the shared exported resolver from representative service-lifecycle,
   panel/route handler, and agent-tool bridge seams. Grant then revoke between pre-work and final
   apply fences; prove no stale lifecycle start, panel/route result, or tool result applies. Also
   prove activation/precedence changes deny without resolver restart.
5. **Browser** (`tests2/browser/e2e`): install an active fixture pack, select its existing
   `market-project-pack-row`, open **Review grants**, grant a non-hook capability through the real
   confirmation/control, reload and verify exact persistence, revoke through that same control,
   and inspect Pack-attributed audit beside readable legacy Hook audit. Assert no duplicate UI,
   no grant-all action, correct operator failure guidance, and no credential/secret in DOM,
   storage, or audit.

Run `npm run check`, focused core/integration/browser tests, then required unit/browser and
focused E2E commands. Update extension-capability, REST, extension authoring, Marketplace/settings,
managed-service, and parent-platform documentation to name this resolver and its compatibility
union.

## Explicit handoff

The paused Hindsight parent consumes only:

- `ExtensionGrantPrincipal`
- `ExtensionCapabilityGrantResolver`
- `ExtensionGrantDecision`
- `createExtensionCapabilityGrantResolver(...)`

Runtime, panel, route, and tool code call the returned resolver with the server-derived
`{ kind: "pack", packId }` and exact closed capability at each application fence. They must not
add a Hindsight permission file, endpoint, capability string, caller-specific grant, or parallel
grant cache.
