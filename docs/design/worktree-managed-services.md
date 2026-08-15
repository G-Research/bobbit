# Worktree-scoped managed services

**Status:** implementation design. **Baseline:** `abaa642bc`. **Scope:** make the already-declared managed-service contract production-wired for a *specific linked worktree*, and add the narrow server-host RPC by which an extension tool reaches that exact service instance. This is infrastructure only. It does not add Code Intelligence, a Hindsight managed mode, a pack UI, an HTTP status endpoint, or a general process/RPC API.

## Baseline and decision

The current seams are intentionally dormant:

- `src/server/agent/pack-contributions.ts` strictly loads schema-2 `runtimes/<name>.yaml`; `PackContributionRegistry` applies winning-pack, runtime enablement, and extension-settings/`requiresConfig` filtering; `ServiceExtensionRegistry` returns cloned declarations without settings bytes.
- `ServiceExtensionRuntimeManager` has bounded lifecycle, port leases, per-identity queues, generation fences, status redaction, and a fresh `service.manage` authorization seam, but its identity is only `(projectId, packId, serviceId)` and no gateway constructs it.
- `server.ts` creates the live `ExtensionCapabilityGrantResolver`, invalidates the registry for pack/settings/grant mutations, and owns session/project teardown. It currently does not reconcile a service manager.
- Tool actions already prove the required trust pattern: `authorizeActionRequest()` binds the `x-bobbit-session-id`, checks the session allowlist and an owned transcript `toolUseId`, derives the winning pack/tool server-side, then creates a closure-bound `ServerHostApi`. The parent gateway never imports pack actions.
- Project deletion drains the worktree pool and sessions before `ProjectContextManager.remove()`. `ProjectContextManager.remove()` only closes the context; no managed-service cleanup hook exists. A linked worktree is validated elsewhere with `git rev-parse --show-toplevel`; a linked worktree's `.git` is a file and must not be treated as the identity root.

**Decision:** preserve the declarative pack contract, but replace the project-only service identity with a server-derived `ServiceInstanceRef`. A gateway-owned coordinator resolves this ref from an already authorized session/worktree, starts/reconciles only that instance, and supplies a closure-bound `host.services.call()` bridge to extension action/route workers. The bridge never returns a process, socket, command, host path, settings, or arbitrary endpoint.

## Alternatives considered

Both options retain the approved closed YAML declaration, full server-derived identity, fresh deny-wins `service.manage` checks, bounded runtime lifecycle, and no process/path exposure. Neither adds a Code Intelligence consumer, Hindsight managed mode, browser surface, or generic process/RPC transport.

### Option A — minimal composition in the current runtime and server

Extend `ServiceExtensionIdentity` and `identityKey()` in `src/server/extension-host/service-extension-runtime.ts` to the full `ServiceInstanceRef`. Keep `ServiceExtensionRuntimeManager` as the only long-lived service state owner, place worktree/component scope derivation and reconcile triggers directly in `src/server/server.ts`, and have `createServerHostApi()` bind `services.call()` directly to a server-owned runtime request helper. This reuses the manager's lifecycle, fences, port leases, queues, and redaction, protected by `tests2/core/service-extension-runtime.test.ts`; closed declaration validation in `service-extension-contract.ts`, protected by `tests2/core/service-extension-contract.test.ts`; active-declaration filtering, protected by `tests2/integration/service-extension-registry.test.ts`; and the closure-bound session/action authorization pattern in `action-guard.ts`.

This is the fewest new files, but it makes `server.ts` own Git/fs/session scope transformation plus per-project reconcile coalescing and makes the process lifecycle manager answer request-broker concerns. The resulting seams are harder to isolate than the existing runtime lifecycle tests, even though scope derivation, stale-root cleanup, and operation binding need deterministic unit coverage.

### Option B — coordinator and narrow broker (chosen)

Keep `ServiceExtensionRuntimeManager` focused on the full-key process lifecycle. Add `WorktreeServiceCoordinator` as the gateway-owned boundary for session/worktree resolution, coalesced reconciliation, data-directory ownership, exact-instance broker requests, and removal cleanup; place the bounded request/response and registered-adapter contract in `service-extension-tool-rpc.ts`. `server.ts` constructs and invokes the coordinator, while `createServerHostApi()` only closes over the already verified session and derived pack identity.

| Axis | Option A: compose in runtime/server | Option B: coordinator/broker |
|---|---|---|
| Data and control flow | `server.ts` resolves the worktree, builds the full ref, tracks dirty projects, reconciles the runtime, and brokers host calls into it. The runtime receives both process and request concerns. | `server.ts` supplies lifecycle notifications; the coordinator derives scopes, coalesces project passes, reconciles the runtime, and brokers only an exact instance. The runtime owns only lifecycle state. |
| Exact production-source footprint | Modifies `service-extension-contract.ts`, `service-extension-runtime.ts`, `server-host-api.ts`, `server.ts`, `session-manager.ts`, and `session-setup.ts`; adds no module, instead concentrating coordinator/broker responsibilities in `server.ts` and the runtime. | Modifies those same six files; adds exactly `service-extension-tool-rpc.ts` and `worktree-service-coordinator.ts`. `project-context-manager.ts` remains unchanged because `server.ts` invokes cleanup before its existing removal method. |
| Primary failure mode | Git/fs/session resolution and dirty-pass state can drift from lifecycle fences inside a broad `server.ts`; direct host-to-runtime request handling risks mixing typed operation policy with process supervision. | The coordinator can drift from the runtime's instance fences or retain stale scope state; one additional injection boundary can be miswired. Full refs, coordinator-owned fences, and focused seam tests mitigate this. |
| Test seams | Existing runtime tests protect lifecycle, but exact scope/replacement/request behavior needs gateway-level construction and difficult Git/session setup. | Injected Git, fs, session, settings, and adapter seams allow deterministic coordinator/RPC tests; existing runtime, contract, registry, and action-guard tests remain their focused protections. |

### Added defect surface and justification

- **Coordinator state owner and API:** `WorktreeServiceCoordinator` adds only dirty-project/coalesced-reconcile and discovered-scope state, with `reconcile*`, exact `request`, and `stop*`/`close` methods. This is necessary to make a worktree-scoped desired set and its cleanup owner explicit without putting Git/fs/session ownership into the lifecycle manager or `server.ts`.
- **Server Host API:** `ServerHostServicesApi`, the `services` capability, and injected `serviceToolRpc` add one closure-bound API. They are necessary so a tool action can name a closed operation on its own exact instance without receiving a process, path, socket, or caller-selected identity.
- **RPC contract module:** `service-extension-tool-rpc.ts` adds the `ServiceExtensionToolRpc` request/result schemas, bounded validation, and registered adapter lookup. It is necessary to keep operation validation independently testable and prevent an untyped transport from becoming an ambient extension API.
- **Identity and path transformations:** `serviceInstanceKey()`, the opaque `worktreeKey` digest, `resolveScope()`, and coordinator-owned contained `resolveDataDir()` add transformations. They are required respectively for non-colliding lifecycle ownership, safe public/data-directory projection, server-only canonical linked-worktree/component derivation, and a pack-relative suffix that cannot escape its core-owned directory; none accepts a pack or request host path.
- **Lifecycle callbacks:** the worktree-valid callback in `session-setup.ts`, the pre-removal callback in `session-manager.ts`, and server calls after committed invalidation, before project-context removal, and at shutdown are necessary to reconcile only valid scopes and stop an instance before its root/context disappears. They do not alter session tool, sandbox, settings, or decision contracts.

**Selection:** Option B is the smallest robust choice. Option A saves two modules but turns `server.ts` into a hard-to-isolate scope/broker state owner and couples Git/session resolution and typed operations to the lifecycle state machine. Option B adds one ownership boundary and two small modules, but preserves the current runtime's narrow, well-tested lifecycle role, mirrors the existing closure-bound `authorizeActionRequest()` broker pattern, and supplies focused injected seams for the new failure-prone transformations. The accepted cost is coordinator/runtime fence alignment and lifecycle injection wiring; the coordinator/RPC tests and full-instance keying explicitly cover that cost.

## Identity, keys, and public projection

### Exact instance identity

```ts
// src/server/extension-host/service-extension-contract.ts

/** Runtime-selected, bounded instance discriminator; it is never a filesystem path. */
export type ServiceInstanceDiscriminator = string;

/**
 * All fields are core-derived. `canonicalWorktreeRoot` is internal-only and is
 * never serialized into a status, host API, log, trace, or worker context.
 */
export interface ServiceInstanceRef {
  projectId: string;
  component: string;                  // configured component name; "." only for the implicit single repo
  canonicalWorktreeRoot: string;      // realpath(git --show-toplevel), internal only
  worktreeKey: string;                // stable opaque digest of canonicalWorktreeRoot
  packId: string;                     // active winning pack id
  serviceId: string;                  // validated runtime declaration id
  discriminator: ServiceInstanceDiscriminator;
}

/** Safe status may leave the coordinator, but never exposes a host path. */
export interface ServiceStatus {
  ref: Omit<ServiceInstanceRef, "canonicalWorktreeRoot">;
  state: ServiceState;
  updatedAt: string;
  detail?: ServiceStatusDetail;
}
```

`component`, `packId`, `serviceId`, and `discriminator` use the existing safe identifier grammar except that a component name is matched exactly to `ProjectConfigStore.getComponents()` before it is accepted. `discriminator` is additionally capped at 32 bytes and must match `/^[a-z][a-z0-9-]{0,31}$/`. The normal/default discriminator is the literal `default`; a future language consumer may use e.g. `typescript` only after the gateway has selected it from a closed consumer-owned vocabulary. A pack declaration cannot supply a discriminator.

The internal key and queue key are exactly:

```ts
function serviceInstanceKey(ref: ServiceInstanceRef): string {
  return [
    ref.projectId,
    ref.component,
    ref.canonicalWorktreeRoot,
    ref.packId,
    ref.serviceId,
    ref.discriminator,
  ].join("\0");
}
```

`worktreeKey` is `sha256(canonicalWorktreeRoot)` encoded as lowercase base64url without padding and truncated to 22 characters. It is computed once by the coordinator, not accepted from a request. It permits status and data-directory identity without disclosing a local path. A current `ServiceStatus` containing only `id` is replaced rather than overloaded: status lookup must be exact and cannot accidentally select a same-id service from another pack, component, worktree, or discriminator.

### Canonical linked-worktree root

`WorktreeServiceCoordinator.resolveScope()` is the sole derivation point:

1. It starts with a server-owned session's persisted `repoWorktrees` entry for the named component; for a single-repo session it uses `worktreePath`, then `cwd` only when the latter is inside the validated repository top level.
2. It runs `git rev-parse --show-toplevel` with that candidate as `cwd`, requires an absolute result, resolves it with `fs.realpath`, and rejects an error, non-directory, or root outside the selected session worktree/container. The resulting realpath is `canonicalWorktreeRoot`.
3. It resolves the named configured component and requires its primary repo mapping to the selected worktree. For multi-repo sessions, a component may never silently fall back to another component's root. For an ordinary project-root session, only the implicit `.` component is eligible.
4. It derives `worktreeKey`, resolves the active declaration through the project-scoped registry, and derives `packId` and `serviceId` from that result. Callers never send a worktree path, pack root, data path, process endpoint, or pack identity.

The `git` top-level plus `realpath` rule collapses symlink aliases and correctly distinguishes two linked worktrees of the same Git common directory. Do not use the Git common directory: linked worktrees share it and would collapse independent services. Do not use a string-prefix path check. A deleted/replaced worktree fails closed and causes that former instance to stop.

## Contract changes

Keep the closed YAML service specification exactly as it is: no command, image, compose file, executable, working directory, host path, environment map, or endpoint may be pack-provided. `dataDir` remains only a validated relative suffix.

Replace the project-only runtime surface with the following exact interfaces. `ServiceExtensionIdentity` and project-only `status(projectId, id)` are removed, rather than retained as ambiguous compatibility methods.

```ts
// src/server/extension-host/service-extension-runtime.ts

export interface ActiveServiceExtension {
  packId: string;
  spec: ServiceExtensionSpec;
}

export interface ServiceExtensionLaunchRequest {
  ref: ServiceInstanceRef;
  spec: ServiceExtensionSpec;
  /** Core-derived worktree root. Available only to a core launch adapter. */
  workingDirectory: string;
  /** Core-owned, contained directory; no raw declaration path is supplied. */
  dataDir?: string;
  /** Runtime-only effective settings; never serialized or retained in status. */
  settings?: Readonly<Record<string, unknown>>;
}

export interface ServiceExtensionRuntime {
  reconcile(ref: ServiceInstanceRef): Promise<void>;
  status(ref: Omit<ServiceInstanceRef, "canonicalWorktreeRoot">): ServiceStatus | undefined;
  stop(ref?: ServiceInstanceRef): Promise<void>;
}

export interface ServiceExtensionRuntimeDeps {
  listActive(projectId: string): Promise<readonly ActiveServiceExtension[]> | readonly ActiveServiceExtension[];
  authorize(projectId: string, principal: { kind: "pack"; packId: string }, capability: "service.manage"): { allowed: boolean };
  launchers: Readonly<Record<ServiceRunMode, ServiceExtensionLauncher>>;
  probe: ServiceReadinessProbe;
  ports: ServiceExtensionPortAllocator;
  filesystem: ServiceExtensionFilesystem;
  clock: ServiceExtensionClock;
  resolveDataDir(ref: ServiceInstanceRef, declaredPath: string): string;
  resolveSettings?(ref: ServiceInstanceRef): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
}
```

The runtime filters `listActive(ref.projectId)` for the exact `{ packId, serviceId }` named by `ref`; duplicate matching declarations fail closed. Its desired map, running map, status map, queue map, generation/fence map, port leases, process-exit callbacks, spec fingerprint, and authorization checks all use `serviceInstanceKey(ref)`. A fence contains a global generation and the full instance key—not merely a project generation—so stopping/replacing one worktree does not cancel another worktree of the same project.

The runtime still rechecks live deny-wins `service.manage`:

- before selection/start;
- after settings resolution, directory creation, each port lease, launch, and each readiness probe;
- before a restart and before recording a late completion as ready.

A denial or stale fence stops its own process and releases only its own leases. Reconcile of an inactive, disabled, invalid, settings-unavailable, removed, or denied declaration removes it from desired state and stops the matching instance. Never cache a positive grant.

### Data directory and lifecycle ownership

The coordinator's data base is server-owned and deterministic:

```text
<project-context.stateDir>/managed-services/v1/
  <component>/<worktreeKey>/<packId>/<serviceId>/<discriminator>/
```

All generated segments are safe identifiers. When `spec.dataDir` is present, `resolveDataDir()` appends it only after `path.resolve(base, declaredPath)` and a relative-containment check prove it remains below `base`. The launcher receives the resulting absolute directory, but pack modules never do. On stop due to a worktree or project removal, remove only this derived instance directory after the process/leases have settled; a failed directory removal is logged with the opaque instance key and remains retriable. Never recursively clean a user worktree or a pack directory.

The gateway owns launch adapters. They receive the core-selected `workingDirectory`, resolved settings, and owned directory, and must terminate the complete adapter-owned process/container invocation. The runtime and coordinator expose no `ChildProcess`, Docker client, socket, command string, log stream, readiness URL, or mutable status object to a pack or an HTTP caller. Existing bounded diagnostic redaction remains local-only.

## Exact-instance service RPC for extension tools

A service is useful only through a bounded core protocol. Do not expose a generic URL, socket, fetch function, or `ServiceExtensionProcess` to the Server Host API.

```ts
// src/server/extension-host/service-extension-tool-rpc.ts (new)

export interface ServiceToolRequest {
  component: string;
  serviceId: string;
  /** Optional; absent normalizes to "default". */
  discriminator?: string;
  /** Consumer-owned closed operation name, not a URL/path/command. */
  operation: string;
  payload?: unknown;
}

export interface ServiceToolResponse {
  state: ServiceState;
  /** Operation result is JSON-cloneable, bounded, and consumer-validated. */
  value?: unknown;
}

export interface ServiceExtensionToolRpc {
  request(input: {
    sessionId: string;
    packId: string;
    request: ServiceToolRequest;
  }): Promise<ServiceToolResponse>;
}

export interface ServerHostServicesApi {
  call<T = unknown>(request: ServiceToolRequest): Promise<T>;
}
```

`ServerHostApi` gains `readonly services: ServerHostServicesApi`; `ServerHostCapabilities` gains `services: boolean`; `CreateServerHostApiOptions` gains the injected `serviceToolRpc?: ServiceExtensionToolRpc`. The namespace is unavailable and throws when the endpoint did not bind a tool/action session or the gateway did not inject the broker. It is not added to the browser `HostApi`: browser code must use an existing tool action and cannot direct a managed process.

`createServerHostApi()` closes over the verified `sessionId` and server-derived `packId`; `host.services.call()` supplies both to the broker and ignores any attempted identity fields in `payload`. The action endpoint continues to require the owned `toolUseId`; a route can receive the same host only through its existing server-derived surface token/session guard. Thus an extension worker cannot select a different session or pack by shaping a body.

`WorktreeServiceCoordinator.request()` is the broker implementation:

```ts
export interface WorktreeServiceCoordinator {
  reconcileProject(projectId: string): Promise<void>;
  reconcileSession(sessionId: string): Promise<void>;
  request(input: {
    sessionId: string;
    packId: string;
    request: ServiceToolRequest;
  }): Promise<ServiceToolResponse>;
  stopProject(projectId: string): Promise<void>;
  stopWorktree(projectId: string, canonicalWorktreeRoot: string): Promise<void>;
  close(): Promise<void>;
}
```

`request()` validates a closed, consumer-registered operation schema before touching a service. It derives the ref using the session algorithm above, requires that `ref.packId === input.packId`, re-reads active declarations and `service.manage`, then reconciles and obtains only the exact ready instance. It delegates the operation to the core-registered adapter keyed by `(packId, serviceId, discriminator)`; the adapter receives a closure-owned instance transport, never an untyped process handle. It validates/clones/bounds the result before returning it. Unknown operation, inactive/denied service, non-ready service, invalid payload/result, or a stale worktree returns a fixed controlled error/result and never selects a sibling instance. The runtime has a bounded global operation semaphore plus one FIFO per full instance key; operation work is cancelled/rejected when its instance fence changes.

No consumer adapter is included in this slice. Code Intelligence will later register an explicit operation vocabulary and payload/result schema; it must not reach the coordinator through ambient `fetch`, a host path, or an ad-hoc RPC server.

## Gateway wiring and reconciliation

Create one coordinator and one runtime manager in `createServer()` after `projectContextManager`, `packContributionRegistry`, and `extensionCapabilityGrantResolver` are available. Its `listActive` uses `new ServiceExtensionRegistry(packContributionRegistry).list(projectId)`; its settings resolver reads the exact `{ packId, kind: "runtime", id: serviceId }` effective project settings through the existing `ProjectContext.extensionSettingsStore`, including owner-only secret bytes. This is a runtime-only read immediately before launch; the registry remains value-free.

The coordinator is injected into every gateway-built `ServerHostApi` for pack tool actions and routes. It must be created before those endpoints are reachable, and gateway shutdown must `await coordinator.close()` before `moduleHost`/project contexts are closed.

Reconcile is coalesced per project: an invalidation marks the project dirty and schedules one microtask/serialized run; another change while it runs causes exactly one further pass. A pass enumerates current live sessions plus persisted sessions that still have a valid worktree and derives unique scopes. It reconciles every scope and stops desired/running instances in that project whose full ref was not rediscovered. It never starts a service merely because a project has a declaration—there must be a current valid worktree scope or an exact broker request.

Call `reconcileProject(projectId)` after these committed lifecycle changes:

1. extension settings mutation (including a committed mutation that reports secret-audit/persistence ambiguity only after the current settings owner has declared it readable);
2. extension grant mutation/revocation;
3. marketplace install, update, uninstall, pack-order, and runtime activation changes, for every affected live project—not just the request project;
4. successful worktree/session creation once its persisted worktree coordinates are valid; and
5. service request, before its exact readiness check.

Call cleanup instead of only invalidating:

- session archive/terminate/purge and every host worktree cleanup path call `stopWorktree()` after the worktree is no longer usable, using the pre-removal canonical root captured while it still exists;
- `DELETE /api/projects/:id` calls `await coordinator.stopProject(projectId)` after sessions/pool drain but before `ProjectContextManager.remove(projectId)` and registry removal;
- a project root replacement through `PUT /api/projects/:id` is **rejected fail-closed while a `ProjectContextManager` context exists**. That is sufficient: every managed instance requires that context for its owned state directory and live settings read, and every path that removes a context already calls `stopProject()` first. If no context exists, no service can be running, so the existing root update may proceed and a later valid worktree reconciliation can create instances for the new root. The current direct registry update must not replace a root under an extant context;
- process shutdown calls `await coordinator.close()` exactly once, fences all work, then performs existing manager/context shutdown.

`invalidateResolverCaches()` must notify the coordinator after invalidating pack/settings/grant caches. Do not have the registry notify the runtime itself: it must remain read-only and testable without process lifecycle work.

## Safety invariants

1. **Deny wins.** The exact active pack and current durable `service.manage` grant are checked at every lifecycle and RPC fence; an old allow cannot survive a revoke.
2. **Exact worktree isolation.** Full identity includes canonical linked-worktree root and component. Two worktrees of one project, or two components of one multi-repo worktree container, never share a queue, process, port lease, status, fence, or data directory.
3. **Core derives paths.** Requests and packs cannot supply absolute paths, paths with traversal, a command, environment map, image, socket, endpoint, or pack root. The only pack path remains the validated relative `dataDir` suffix.
4. **No process-handle escape.** Pack code sees a typed `host.services.call()` result only. It never receives an adapter, launcher, probe, log, transport, port lease, status map, process handle, or data-directory path.
5. **Bounded supervision.** Reuse one-start restart policy, bounded readiness timeouts, bounded ports, per-full-key FIFO, a global service/RPC concurrency cap, result payload byte/depth limits, cancellation/fences, and best-effort cleanup. No unbounded retry loop, queue, or background scan.
6. **Fresh settings and redaction.** Effective settings/secrets are read only by the coordinator immediately before launch and never enter registry rows, service status, RPC failures, logs, traces, WebSocket frames, test snapshots, or data-directory names.
7. **Hindsight compatibility.** `market-packs/hindsight` remains external-provider-only: its `runtimes` list stays empty, `providers/memory.yaml`, external URL settings, existing routes, queue, and lifecycle behavior remain untouched. A managed Hindsight declaration/adapter is a later consumer change.

## Owned implementation plan

| File | Change |
|---|---|
| `src/server/extension-host/service-extension-contract.ts` | Add exact instance/status reference types and discriminator validation; preserve closed declaration validation. |
| `src/server/extension-host/service-extension-registry.ts` | No change: the coordinator filters its existing value-free `list(projectId)` results by exact pack/service; the registry never owns process or settings work. |
| `src/server/extension-host/service-extension-runtime.ts` | Migrate all identity/fence/status/data-dir/queue keys to `ServiceInstanceRef`; replace ambiguous project-only API. |
| `src/server/extension-host/service-extension-tool-rpc.ts` | New narrow request/response schemas, registered adapter surface, payload/result bounds, and broker type. |
| `src/server/extension-host/worktree-service-coordinator.ts` | New server-derived worktree/component resolver, reconcile coalescer, data-dir resolver, lifecycle/RPC bridge, and cleanup owner. |
| `src/server/extension-host/server-host-api.ts` | Add only the closure-bound `services.call()` namespace and capability/injection seam. |
| `src/server/server.ts` | Construct/inject coordinator; trigger reconcile after committed pack/settings/grant/worktree changes; await project/root-replacement/shutdown cleanup. |
| `src/server/agent/session-manager.ts`, `src/server/agent/session-setup.ts` | Add narrow lifecycle callbacks for valid worktree created and about-to-remove, without changing tool policy or sandbox contracts. |
| `src/server/agent/project-context-manager.ts` | Optional narrow pre-remove hook, or have `server.ts` call the coordinator before existing removal; do not give the context a service manager. |
| `docs/service-extension-runtime.md`, `docs/extension-host-authoring.md`, `docs/extension-platform.md` | Replace “dormant” language with the worktree-instance, exact-RPC, cleanup, and Hindsight compatibility contract. |

Do not modify `market-packs/hindsight/**`, extension settings/grant schemas, decision requests, sandbox contracts, the browser `HostApi`, or Code Intelligence consumer code.

## Focused test plan

Register all additions in `tests2/tests-map.json`.

| Layer | File | Coverage |
|---|---|---|
| Core | `tests2/core/service-extension-contract.test.ts` | Discriminator/status-reference validation and absence of host paths from the public projection. |
| Core | `tests2/core/service-extension-runtime.test.ts` | Same project/pack/service across two canonical roots, components, and discriminators gets independent queue/fence/status/data/lease lifecycle; stop/revoke in one cannot affect the other. Retain existing restart/readiness/redaction tests. |
| Core | `tests2/core/worktree-service-coordinator.test.ts` | Linked-worktree realpath derivation; primary project root accepts only the implicit `.` component; component mismatch rejection; no path input; deterministic opaque key/data path; stale/deleted root cleanup; coalesced reconcile; exact active/settings/grant rechecks; and project/global stop fences. Use injected Git/fs/session/settings/adapter seams. |
| Core | `tests2/core/service-extension-tool-rpc.test.ts` | Server-derived session/pack binding, default and bounded discriminator, exact instance selection, closed operation/payload/result validation, no process/path exposure, unavailable/non-ready rejection, concurrent FIFO/cap behavior, and revoke while an operation waits. |
| Integration | `tests2/integration/service-extension-registry.test.ts` | Winning enabled declaration filtering remains value-free and fails closed for disabled or unreadable runtime settings. |
| Integration | `tests2/integration/service-extension-gateway.test.ts` | Production gateway construction, settings/grant/market invalidation reconciles services, a tool action reaches only its own session worktree instance, project deletion stops services before context loss, root replacement is rejected while a context exists and preserves its instance, and global shutdown drains them. Assert redaction in JSON/log capture. |
| Integration | `tests2/integration/hindsight-external.test.ts` | Hindsight remains external-only with no `runtimes` declaration, process launch, or altered request route. |

Focused command after implementation:

```bash
npx vitest run \
  tests2/core/service-extension-contract.test.ts \
  tests2/core/service-extension-runtime.test.ts \
  tests2/core/worktree-service-coordinator.test.ts \
  tests2/core/service-extension-tool-rpc.test.ts \
  tests2/integration/service-extension-registry.test.ts \
  tests2/integration/service-extension-gateway.test.ts \
  tests2/integration/hindsight-external.test.ts \
  --config vitest.config.ts --retry=0
npm run check
```

## Scope ledger

**In scope:** production instantiation/reconcile/cleanup; exact worktree/component/pack/service/discriminator identity; opaque status/data keys; fresh settings/grants; narrow server-host tool RPC; bounded lifecycle/RPC supervision; project/worktree/shutdown cleanup; focused tests and docs.

**Out of scope:** Code Intelligence protocol/adapter/consumer tools; Hindsight managed mode or edits; arbitrary external command/Docker/Compose declarations; browser-managed services; public service endpoints, logs, UI, metrics, or WebSocket status; generic host fetch/socket/process APIs; changes to existing settings, grants, decisions, sandboxing, worktree ownership policy, or unrelated session tool contracts.
