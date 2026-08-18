# Worktree-scoped managed services

Managed services are the Extension Platform's narrow, gateway-owned path for a pack to **declare** a local service. The gateway derives the service instance from an authorized session and owns its lifecycle, data, authorization, and tool bridge. This prevents a pack declaration or tool request from becoming an arbitrary process, path, or network API.

The implementation design is [Worktree-scoped managed services](design/worktree-managed-services.md). That design records the alternatives and full implementation inventory; this page is the durable contract for pack authors and gateway maintainers.

## Current posture

The gateway constructs the runtime manager and worktree coordinator, reconciles eligible worktree scopes, and wires the closure-bound `host.services.call()` surface into gateway-built server hosts.

There is deliberately **no registered consumer adapter or launcher** in this slice. The gateway's launch seams fail closed, and the core adapter registry is empty. A declaration therefore cannot start a process and `host.services.call()` cannot reach a service until a future core-owned consumer registers a closed adapter and its corresponding launcher. This is intentional: the infrastructure is production-wired without granting a pack an ambient process or transport capability.

There is no browser host API, public HTTP service endpoint, service status endpoint, generic fetch/socket API, log stream, or process API.

## Pack declaration

A schema-2 pack lists a runtime basename in `pack.yaml` and declares it in `runtimes/<name>.yaml`:

```yaml
# pack.yaml
schema: 2
contents:
  runtimes: [memory-service]
```

```yaml
# runtimes/memory-service.yaml
id: memory-service
service:
  runMode: local
  readiness:
    url: http://127.0.0.1:8080/health
    timeoutMs: 500
  stopGraceMs: 500
  restart: on-failure
  ports: [8080]
  dataDir: memory-service/data
config:
  apiKey:
    type: secret
    label: API key
    optional: true
activation:
  requiresConfig: [apiKey]
```

The manifest is the catalogue: an unlisted runtime file is ignored. Pack precedence, install/runtime activation, project settings, and `requiresConfig` filtering occur before a declaration becomes active. An invalid, disabled, shadowed, duplicate, unreadable, or unconfigured declaration is inactive. Listing a runtime never grants authority or starts anything.

### Closed service schema

The runtime file permits only `id`, `service`, `config`, and `activation`. The service mapping is closed; unknown keys are rejected rather than passed through to a newer host.

| Field         | Contract                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runMode`     | `local`, `docker`, or `compose`. Core selects a launcher; the declaration does not.                                                                                                                             |
| `readiness`   | One loopback HTTP(S) URL or a core-recognized shell-free probe identifier, with a 100–60,000 ms timeout. It cannot name a remote endpoint, credentials, fragment, template, shell, executable, or command line. |
| `stopGraceMs` | Integer from 100 to 60,000.                                                                                                                                                                                     |
| `restart`     | `never` or `on-failure`; the runtime permits at most one restart for the current declaration.                                                                                                                   |
| `ports`       | Optional unique ports, each 1–65,535; at most 32. Core owns their leases.                                                                                                                                       |
| `dataDir`     | Optional safe relative suffix. Core resolves it beneath an owned directory; it cannot be absolute, traverse with `..`, or use backslashes.                                                                      |

Packs cannot provide a host path, working directory, executable, command, image, compose file, environment map, socket, transport, endpoint, process handle, log stream, or port owner. A pack's only path-like input is the validated relative `dataDir` suffix. A launcher receives the core-derived working directory, data directory, and effective settings; pack code never receives them.

## Exact instance identity

A service is not project-wide. The gateway derives its exact instance from six fields:

```text
(projectId, component, canonical linked-worktree root, packId, serviceId, discriminator)
```

- **Project** and **component** come from the server-owned session and configured project components. The implicit single-repository component is `.`.
- **Canonical linked-worktree root** is `git rev-parse --show-toplevel` followed by `realpath`. It is internal-only. The Git common directory is never used because linked worktrees share it.
- **Pack** and **service** come from the active winning declaration, not a request-selected pack root or identity.
- **Discriminator** is selected by a future core consumer from a closed vocabulary. It defaults to `default`, is never a path, and is capped at 32 bytes using the safe identifier grammar.

The coordinator derives the root only from persisted session worktree coordinates. For multi-repository sessions, a component must map to its own selected worktree; it cannot fall back to another component. For an ordinary project-root session, only `.` is eligible. Git, filesystem, component, or containment failures fail closed.

All lifecycle ownership uses the complete internal identity: queues, generations, desired/running state, statuses, port leases, restart callbacks, RPC scheduling, and data directories. Thus two linked worktrees or two components in one project cannot share a process, queue, fence, lease, data directory, or status simply because their pack and service IDs match.

The public/status projection replaces the root with an opaque `worktreeKey`: a stable, truncated SHA-256 base64url digest of the canonical root. It contains project, component, worktree key, pack, service, and discriminator, but never a host path. Status is exact-instance only; an ambiguous same-ID lookup has no fallback selection.

## Data, status, and supervision

The coordinator owns the data root:

```text
<project state directory>/managed-services/v1/
  <component>/<worktreeKey>/<packId>/<serviceId>/<discriminator>/
```

Every generated segment is safe. If the declaration includes `dataDir`, core resolves it under this root and verifies containment before use. It never cleans a user worktree or pack directory.

The only publishable status is a cloned, path-free record with `ref`, `state`, `updatedAt`, and an optional fixed detail. States are `stopped`, `starting`, `ready`, `unhealthy`, and `failed`. Details are limited to `starting`, `readiness-timeout`, `port-conflict`, `process-exited`, and `configuration-unavailable`. Paths, commands, settings, secrets, probes, ports, logs, transports, and process handles are excluded.

Supervision is bounded: per-full-instance lifecycle queues, a bounded readiness timeout, a one-restart `on-failure` policy, bounded port declarations, and full-instance generation fences. A late launch, probe, or exit callback cannot overwrite a newer instance. The runtime stops its entire adapter-owned process/container invocation and releases its own leases on failure or stop.

## Authorization and freshness fences

`service.manage` is a deny-wins capability for the server-derived active pack principal. The gateway and runtime do not cache an allow. They re-read authorization at selection/start and after every awaited lifecycle boundary, including settings, owned-directory creation, each lease, launch, readiness probe, restart, and late-ready publication.

The runtime reads effective runtime settings, including owner-only secret values, immediately before launch. Settings never enter registry rows, statuses, RPC errors, logs, traces, public keys, or worker contexts. An unreadable, disabled, or invalid setting is treated as inactive; a failed fresh configuration read yields only the bounded `configuration-unavailable` result.

The coordinator also rechecks the active declaration, exact `service.manage` grant, settings readability, current project generation, and exact ready state before and after service operations. Revocation, deactivation, a settings mutation, a root replacement, or a stop advances the relevant fence; stale work is stopped or rejected rather than revived.

## Exact service RPC for extension tools

A server action or route can receive `host.services.call()` only when the gateway has already bound both its session and winning pack identity. The host forwards a closed request envelope; it cannot send a session ID, pack ID, worktree root, path, URL, or transport.

```ts
await ctx.host.services.call({
  component: ".",
  serviceId: "memory-service",
  // discriminator defaults to "default"
  operation: "lookup",
  payload: { query: "release notes" },
});
```

`component`, `serviceId`, optional discriminator, and operation are safe identifiers. Payloads and results must be JSON-cloneable and bounded by byte, depth, and node limits. The request is resolved against a core-owned adapter registry keyed by exact `(packId, serviceId, discriminator)`. Each registered operation supplies payload and result validators.

The coordinator then derives the complete instance from the bound session, verifies that it belongs to the bound pack, re-reads declaration/grant/settings state, reconciles that exact instance, and requires it to be ready. The adapter receives a closure-owned exact reference and abort signal, not a process, socket, URL, data directory, or launcher.

Operation execution has a bounded global concurrency limit and a bounded FIFO for each full instance key. Lifecycle changes invalidate queued work and abort active adapters. Invalid, unknown, inactive, denied, unavailable, non-ready, overloaded, cancelled, or invalid-result requests return fixed controlled errors without revealing host diagnostics.

## Gateway reconciliation and cleanup

The gateway owns one coordinator and one runtime manager. It coalesces reconciliation per project and discovers valid scopes from live and persisted sessions. It does not start a declaration merely because it exists: a valid worktree scope or an exact broker request is required.

Reconciliation runs after committed settings, grants, pack/runtime activation, marketplace, session creation, and durable worktree-ready changes. A mutation while a pass is running schedules one further pass. If the coordinator cannot read declarations, Git, settings, or its other dependencies, it fences and stops affected services without deleting their data.

Cleanup distinguishes a reversible stop from confirmed final deletion:

- **Archive, termination, revoke, deactivation, unreadable settings, reconciliation failure, and gateway shutdown** fence and stop the live instance non-destructively. Its owned data remains for a later authoritative cleanup.
- **Final worktree removal** is destructive only after the session manager confirms the specific captured worktree path is absent _and_ Git metadata no longer lists it. Only `ENOENT` and `ENOTDIR` prove filesystem absence; permission failures, Git failures, and probe errors are unconfirmed and preserve the data.
- **Project removal** first drains worktrees and sessions, then stops managed services before the project context is removed. It can delete only the derived managed-service directory, never a worktree or pack path.
- **Project root replacement** fences/stops services before removing the old project context. If the registry update or new context creation fails, the gateway restores the prior root and recreates the old context before returning the error. A successful replacement can only reconcile from newly valid worktree scopes.

Ownership is shared safely. The coordinator tracks both all recorded owners and active owners for a canonical root. Archiving one session stops a root only when no other active session owns it; final data deletion waits until no recorded owner remains. This prevents a sibling session or borrower that references the same worktree from losing its service or data.

## Hindsight compatibility

Hindsight remains an external-provider integration. Its existing provider declaration, external URL settings, routes, queues, and lifecycle behavior are unchanged; it has no managed runtime declaration, launcher, or service adapter. A managed Hindsight mode is a separate future consumer change.

## Verification

Focused tests cover declaration validation, public-reference redaction, full-instance lifecycle isolation, coordinator root/cleanup behavior, bounded RPC validation and cancellation, production gateway lifecycle wiring, and Hindsight's external-only behavior. Run the managed-service focused tests and type check described in the [implementation design](design/worktree-managed-services.md#focused-test-plan) when changing these seams.
