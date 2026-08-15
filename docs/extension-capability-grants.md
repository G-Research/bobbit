# Extension capability grants

Extension capability grants are a project-owned, fail-closed authority layer for active
schema-2 packs. They separate a pack declaration and activation from the project's consent to
let core use one specific capability. This makes authority revocable without creating a
pack-defined permission system.

The single grant owner serves both legacy hooks and non-hook pack principals. It is not a Host
API capability, a general runtime permission, or a way for a pack to authorize itself.

For pack installation and activation, see [Marketplace](marketplace.md). For the service
lifecycle that consumes `service.manage`, see [Managed service-extension contract](service-extension-runtime.md).

## Exact durable union

`extension_grants` is native project YAML, not a generic project-config value. Every row names
one exact principal and one closed capability; there are no wildcards, inheritance, defaults, or
built-in-pack exceptions.

Legacy hook rows remain discriminator-free and retain their existing serialized meaning:

```yaml
extension_grants:
  - packId: example-pack
    hookId: choose-mode
    capability: decide
    grantedAt: "2026-04-02T12:34:56.000Z"
    grantedBy: admin
```

A non-hook grant names the pack principal explicitly:

```yaml
extension_grants:
  - packId: hindsight
    principal: pack
    capability: memory.read
    grantedAt: "2026-04-02T12:34:56.000Z"
    grantedBy: admin
```

The exact keys are `(packId, hookId, capability)` for a hook and
`(packId, "pack", capability)` for a pack. A later grant for the same key replaces its stored
metadata. A pack row must not carry `hookId`; a hook row must not carry `principal`. Invalid,
mixed, or malformed rows are dropped independently, so one stale row cannot make another row
usable. Existing hook rows continue to load and serialize compatibly.

The platform owns the closed vocabulary:

- Hook-capable values: `decide`, `mutate`, `filter:tool-result`, `store`, `session`, `agents`,
  `prompt:system-static`, and `prompt:system-author`.
- Pack-only values: `service.manage`, `memory.read`, `memory.write`, `memory.reflect`,
  `memory.invalidate`, and `memory.read.all`.

A hook cannot be granted any pack-only value. The six pack-only values are not manifest-declared
capabilities: an installed active pack is eligible to receive them, but only a project operator
can grant one. Unknown strings always deny; extensions cannot mint authority by adding a string
to a pack file.

## Active principal and live resolver

A durable row alone never activates an extension. Before matching a grant, the platform resolves
the current winning pack for the project. A removed, disabled, shadowed, malformed, or otherwise
inactive pack denies. Hook grants also require the current active hook declaration and its existing
capability-support rules; those rules are not broadened by the pack union.

Server consumers share this exported handoff seam from
`src/server/agent/extension-grant-policy.ts`:

```ts
export type ExtensionGrantPrincipal =
  | { kind: "hook"; packId: string; hookId: string }
  | { kind: "pack"; packId: string };

export type ExtensionGrantDecision =
  | { allowed: true; grant: ExtensionGrant }
  | { allowed: false; reason:
      "invalid_request" | "project_unavailable" | "inactive_principal" |
      "unsupported_capability" | "grant_required" };

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

Runtime lifecycle code, server-side pack panel/route handlers, and agent-tool bridges use this
public resolver seam with only a server-derived principal. They must retain the resolver, **not**
an allow result. Every call re-resolves active identity and reads current durable grants after those
checks. After awaited work, a consumer calls it again immediately before applying an effect. That
application fence makes a revocation win over stale scheduled work or a late worker result.

The gateway-owned `ServiceExtensionRuntimeManager` and `WorktreeServiceCoordinator` use this seam
for `service.manage`: they check before lifecycle and RPC work and again at asynchronous fences.
The gateway constructs and reconciles them for exact worktree instances, alongside fresh runtime
settings checks. The registered operation-adapter and launch-adapter seams are intentionally empty,
so declarations fail closed until a future core consumer registers a closed adapter and compatible
launcher. A grant is an authorization gate, not a process launch.

## Administrative REST API

All routes are project-scoped and use normal gateway authentication for reads. The server stamps
`grantedAt` and `grantedBy`; clients cannot provide either. A hook mutation retains its historical
authentication rules. **Every pack-principal mutation** requires the verified signed
`bobbit_session` operator cookie, so bearer-only, sandbox, and agent-session credentials are
rejected with `403 PROMPT_EXTENSION_OPERATOR_REQUIRED`.

| Method | Path | Contract |
|---|---|---|
| `GET` | `/api/projects/:projectId/extension-grants` | Returns durable `grants`, active hook status in `hooks`, and active pack-principal status in `packs`. Stale durable rows remain visible and revocable; reads do not prune them. |
| `PUT` | `/api/projects/:projectId/extension-grants` | Grants exactly `{ packId, hookId, capability }` for a hook, or `{ packId, principal: "pack", capability }` for a pack. The target must be currently active and server-resolved. Invalid shapes return `400`; an unavailable principal returns `404`; an unsupported current principal/capability pairing returns `422 EXTENSION_CAPABILITY_UNSUPPORTED`. |
| `DELETE` | `/api/projects/:projectId/extension-grants/:packId/:hookId/:capability` | Unchanged hook revoke route. It can remove a stale hook row after the hook is gone. |
| `DELETE` | `/api/projects/:projectId/extension-grants/:packId/principals/pack/:capability` | Exact pack-principal revoke route. Its distinct path prevents ambiguity with a hook named `pack`; it can also remove a stale pack row. |
| `GET` | `/api/projects/:projectId/extension-grant-audit?limit=N` | Returns newest valid audit records in chronological order. `limit` defaults to 100 and is bounded to 1–200. |

For hook grants, ordinary `decide`, `filter:tool-result`, `store`, `session`, and `agents`
mutations continue to use normal gateway authentication. `mutate`, `prompt:system-static`, and
`prompt:system-author` retain their signed-operator requirement. Pack-principal mutations always
require that operator proof because they change non-hook platform authority.

Audit rows are the same backward-readable union: hook history remains discriminator-free;
pack history has `principal: "pack"` and no `hookId`. Each row contains only timestamp, actor,
`granted`/`revoked`, exact principal identity, and closed capability—never request metadata,
configuration, paths, or secrets.

## Audit durability, recovery, and invalidation

Authority is published to project configuration before its JSONL audit append. If the append
fails, the authority change remains effective and the route returns
`503 EXTENSION_GRANT_AUDIT_UNAVAILABLE`. The audit store queues the normalized exact event in a
durable project-owned outbox, flushes it before later appends, and suppresses a duplicate that was
written just before a crash. Corrupt JSONL rows are ignored on reads.

Retry the same exact revoke URL to recover a revoked event whose audit write failed. Recovery
drains the matching outbox row without restoring authority. A later ordinary no-op revoke returns
`revoked: false` and creates no audit event. The same recovery contract applies to hook and pack
principals.

A successful grant or revoke invalidates derived extension state and emits the metadata-only
`extension_grants_updated` project WebSocket event. Clients re-fetch the server projection; no
browser, agent, or gateway restart is needed for the next resolver call to see a revocation.

## Market controls and compatibility

Market → **Installed** → selected project uses the existing pack card and **Review grants**
disclosure; it does not add a Hindsight permissions page or a second grant UI. The Pack row lists
the six supported pack capabilities individually, with their exact strings, current state, a
confirmation before grant, busy/error state, and an exact Grant or Revoke action. In particular,
`memory.read.all` is described as reading project memory outside the pack's ordinary scope.

The same project surface has **Grant history**, which renders the existing audit stream for both
legacy hook and pack-principal changes. Server projections are authoritative: Market does not infer
capability support from a pack name or treat activation as consent.

The Hindsight handoff is intentionally only this generic contract: the exported
`ExtensionGrantPrincipal`, `ExtensionGrantDecision`, `ExtensionCapabilityGrantResolver`, and
`createExtensionCapabilityGrantResolver()` factory, plus the six platform-owned strings. This slice
does **not** implement Hindsight memory operations, start a Hindsight service, create Hindsight
configuration, or introduce a Hindsight-specific endpoint, store, capability, or permission UI.
