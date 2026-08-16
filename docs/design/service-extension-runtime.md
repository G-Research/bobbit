# Service-extension runtime

**Status:** current generic service-runtime contract. Sections 6–12 preserve planning and provenance history; for shipped Hindsight behavior, use [Hindsight memory](../hindsight-memory.md), [managed service runtimes](../managed-runtimes.md), [project extension settings](../extension-settings.md), and [Hindsight Foundation Provenance Audit](hindsight-foundation-provenance.md). Those current references take precedence where this historical plan differs.

## 1. Decision, boundaries, and acceptance criteria

A pack may declare a **runtime**: an operator-consented, gateway-supervised service that its provider/routes/tools consume only through a resolved endpoint. Runtime selection is host-owned. Pack code receives the same `ctx.runtime.endpoint` in all modes and never invokes Docker, Compose, a child process, port allocation, or restart logic.

This is deliberately a service contract, not a Hindsight-specific Docker integration. A second author can implement LangFlow by authoring one descriptor with valid local, Docker, and Compose launch blocks, its assets, provider configuration, and endpoint consumer; no new supervisor, lifecycle API, or deployment-mode code is required.

> **Current Hindsight boundary.** This document retains the generic runtime contract. H-2, H-5, and H-6 mechanics are defined by [Hindsight memory completion](hindsight-memory-completion.md); H-3 is recorded in the [foundation provenance audit](hindsight-foundation-provenance.md); and H-4 ships the managed runtime, settings integration, memory panel, typed routes, and five agent tools described by the operational [Hindsight memory pack](../hindsight-memory.md). Hindsight uses central EP-6/EP-7 contracts and creates no private authorization or settings substitute.

### Scope ledger

| Must ship | Allowed to change | Deferred / prohibited |
|---|---|---|
| Schema-2 runtime descriptor and loader; local-process, Docker-container, and Docker-Compose runners; one lifecycle state machine; config/secrets/storage/diagnostics contracts; H-3 generic-foundation hardening; Hindsight descriptor and mode-independent endpoint wiring; mode-independent unavailable/unhealthy behavior. | Add direct runtime dependencies; new server runtime modules and authenticated pack-scoped typed-route integration; the H-3 host/extension seams named in §7; pack manifest/provider runtime fields; generated pack artifacts; extensions to EP-6/EP-7 consumption points after their work lands. | A LangFlow pack; a private settings or permission UI; arbitrary remote-service management; Kubernetes; automatic install/enable start; host-port choice in user settings; H-2 memory algorithms in H-3; H-4 runtime/screens/tools in H-3; EP-6/EP-7 implementation; Hindsight settings UI, panels, final agent tools, private broad-recall grants, and a global runtime REST API; copying #820 semantics/tests without individual reconciliation. |

Acceptance means all of the following are true.

1. The same Hindsight client operation (`health`, retain, recall) is reachable through `local`, `docker`, and `compose` modes and produces the same response contract; client/provider code does not branch on the mode.
2. Start returns only after the declared HTTP readiness condition passes. A down, refused, crashed, or unhealthy service returns a bounded diagnostic and leaves the calling session usable; no hook, route, or tool waits indefinitely or starts a service implicitly.
3. An explicit start is required once. The persisted desired state then permits bounded crash recovery and gateway-restart reconciliation; install, discovery, configuration reads, status, and provider invocation never start a service.
4. Config and secret provenance is explicit, secrets never appear in settings reads, status, log events, command arguments, or images, and rendered secret files are owner-read/write only.
5. Host ports are loopback-only, dynamically assigned, rediscovered after start, and never reallocated by a read path. Service data survives restart/disable/update; destructive data removal requires an explicit purge of a declared, contained data directory.
6. EP-6 owns authorization/grants and EP-7 owns settings rendering/storage. This feature consumes their public contracts; it does not recreate them.
7. H-3 produces a truthful outcome-level matrix for the generic-foundation goals, classifying each as already delivered on main, superseded by current architecture, implemented here, or explicitly not applicable with evidence. It records the unavailable audited-package caveat without depending on recovery of the package, ledger, or commit identifiers; preserves #1091's durable enqueue outcome and #1106's tri-state durable read/error fidelity; and proves mutation, deadline/abort, retry/idempotency, and lifecycle-boundary behavior through `tests2`.
8. The separately delivered Hindsight completion mechanics preserve collision-safe identities, project-partitioned durable retry/sweeps, and original stranded-record scope. Rich scope derives only from #1099 `HookCtx.scopeContext`; recall is project-scoped and may narrow to the authoritative goal, while missing authoritative project scope fails closed with no remote call. Host goal completion uses `deliverLifecycleOnce` durable fencing; its marker follows remote success or confirmed durable queueing only. See [Hindsight memory completion](hindsight-memory-completion.md) and [Hindsight memory pack](../hindsight-memory.md).
9. Hindsight's native browse/search/detail/invalidate/reflect screens, typed routes, and five `hindsight_*` agent tools are delivered through the central EP-6/EP-7 and generic-runtime contracts. Broad `all` recall remains explicit and requires the central `memory.read.all` grant; the pack creates no private substitute.

## 2. Comparative design

### Option A — port #820's Compose supervisor

#820 has useful reference work: a `runtimes/*.yaml` contribution, strict path checks, `execFile` Compose calls, HTTP readiness, stateful ports/secrets, an API seam, and extensive legacy tests. It is not suitable as the implementation baseline:

- it supports Docker Compose only; the goal requires local process, Docker container, and Compose with a mode-invariant extension contract;
- `probeFreePort()` closes the probe socket before Docker binds it, leaving a TOCTOU conflict window and persisting a port that can churn;
- its raw-manifest `startPolicy` and healthcheck fields bypass the typed manifest;
- local state writes are best effort, including data needed to address a live service;
- it contains Hindsight/deployment special cases in `server.ts` (`resolveRuntimeStartPlan`, capability cards, mode names) rather than a generic endpoint/runner abstraction;
- it does not define a service crash policy, lifecycle state machine, or a real automated Docker E2E contract; its real-Docker test is manual and skips.

#820 is a **mandatory provenance input**, not an optional patch. Cherry-pick the following literal, first-parent-ordered #820 feature and child-integration commits onto the Hindsight parent, then reconcile them against current `origin/main` and this contract. **Do not use a revision range as a cherry-pick input.**

```text
55adc255c0498155bdd61e49dcaa79f9b87da567  P1 descriptor/loader
1a8883d9fc468c44e4d09b32ddf5c555ccea26df  P2 supervisor/REST
966d20e4457cae85c202b9482f6f638ae9c6c699  P3 mode/consent/linkage
f9f1f18ba2c5811d4d42e72293eca99450abaa97  P4 panel
1bece5624d63762da8afb6796268abbb4b420591  P5 tools
a942784d4799a46f217b4dbcdc8f06392d79a838
0b43d508a45d7bceaec6decb4f6ea7ca75e89961
127a44cf49f959f39111080ba2d181536bfc9ec7
d522dd26d79c30132460e005d31dcc999a0d8ced
39eb11771e0fc20cf06c55c43c54ef4b97019d5d
346b0e9b0d93bce532fa6124df4f514c06ef8b2b
157f4f2c19795d3df75199c90fc8986d5ef3a159
8bb19b84c9dcc34198c8022aa880566f2340238a
ea3f957244d307080ff82dae3601efc03b449e5d
7f9fce9b1c776150ba7726a0a32ade3f15911466
d0bc4358293142e6d7a856be2cdee14a88a28324
6552422c461c875204fc57f6b7dcf94e754bb31c
083cd3143488d66a717017fab678128145784993
cd0eddea994b25f8511ee5f03c7027795e222313  UX child integration
06e49da1ef8b64aef664fe85cef6a917ac7e9e1c
f32685dcdc696d7028fed04122a059bc56c4a406
e68904e4928940a4d2d90eba11a232356bbce250
429647d3a95478d5e04bcb5221e1f3aa4e455fca
537b878c74c1e6973490f9f65f8b7b19e3c581e4
9ddfccdcb9476083f847e1fb1b2ddaa18d5957b2
7d2b051e8ef3485a687d12097ad27e77dbfdfab1
0557a9b17d3b5225ee1de78b1f69806571acb8bf
30686ca90c50bd7c698b147f1c020421e082779a
ec15bc0b51119cf5b23750db15666fb7f2e82b6c
dc040696c8936e3f939ece4aff0dd00817e2a2b8
ff8342bac403f7f7ea891ccd3da51993f2e783e1
cbef9bc281498f1cc17162a3ccbdfa288fc89a5c
767ab4f542d3445350b3634305d71e58543fb380  memory-v2 child integration
35ce99587c2e719dab2bc843c27fd98291ffd8e4
83e279db85be72b000ac18b69a5d85962b0a09c0
6b4188c9042d541637e469e2a9251d8e895b6ea2
44eaceb3e6ec93b1245de719061ab53e09c96011
a084cf344a0b6fc259fa09b63aa1388e53e04e34
```

This list was audited with `git rev-list --first-parent --reverse 7459c10ba17a401af24d7c1e6c133142aab82c4f..origin/goal/hindsight-setu-1d1bf725`, but that command is inventory-only: it must never be piped into `git cherry-pick`. It deliberately excludes the `origin/master` integration merges `9b20cda9f`, `b1a3baac7`, `12b5d0c0f`, `0a6b73a05`, and `9f1e01ab9`, plus unrelated side-branch imports. For every listed SHA, use `git cherry-pick -m 1 <sha>` when it is a merge and ordinary `git cherry-pick <sha>` when it is a feature commit; preserve the listed order. Record the resulting cherry-pick SHAs, conflicts, and dropped-empty commits in the parent PR. This is an absorption/reconciliation, not blind textual replay: classify and refactor every imported semantic against current main, EP-6/EP-7, and the generic service contract; port useful assertions to `tests2` while replacing stale semantics individually.

### Option B — one generic supervisor with three adapters (chosen)

Add a small, typed runtime nucleus that owns declared desired state and delegates launch/inspection/stop to a runner selected by a descriptor mode. All adapters return one `StartedService` (`endpoint`, runner identity, service rows); the supervisor applies identical readiness, restart, diagnostics, storage, and endpoint exposure rules.

This has one new state owner (`ServiceRuntimeStore`), one public runtime context, one lifecycle state machine, and one adapter interface. It adds adapters because their resource ownership is inherently different: a local child needs a PID/tree and bounded bind-conflict retry, a Docker container needs container identity/port inspection, and Compose needs project/service identity and `compose port`. Forcing them through a single list of command strings would obscure validation, leaks, and stop semantics.

### Option C — make each pack implement a supervisor/provider branch

Rejected. It duplicates permission, redaction, readiness, ports, teardown, diagnostics, and test behavior for every service; LangFlow would require a second bespoke integration. It fails the stated generalisation deliverable.

### Existing composition and dependency choice

Use the existing schema-2 `contents.runtimes` key, safe-basename validation (`pack-manifest.ts::isSafeBasename`), contained contribution loading pattern (`pack-contributions.ts` plus `path-guard.ts`), pack identity, `SecretsStore`, `LifecycleHub` provider context, and route/module isolation. Existing protecting tests include `tests2/core/extension-host-module-isolation.test.ts`, `tests2/core/hindsight-provider.test.ts`, `tests2/integration/hindsight-external.test.ts`, and `tests2/core/guard-v2.test.ts`.

Add **direct** dependencies `execa` (local process and Compose CLI, argv-only/no shell, cancellation/output handling), `dockerode` (Docker daemon lifecycle/inspect/port binding), `get-port` (ordinary upstream local-service port selection), and `p-retry` (bounded retry for local bind conflicts and readiness). Do not depend on the currently transitive `execa@1`, and do not hand-roll child-process or Docker HTTP clients. Docker Compose has no maintained Docker Engine API equivalent; invoke the user-installed Compose plugin through `execa("docker", ["compose", ...])` with validated argv. `p-retry` wraps a per-attempt native `fetch` + `AbortController` health check, with the manifest's deadline/interval as the sole retry budget.

`get-port` necessarily has a probe-close TOCTOU window: an unrelated process can claim the returned local port before the upstream service binds it. The local adapter therefore passes the selected port through the descriptor's declared `local.portEnv`, detects an immediate `EADDRINUSE`/early non-zero exit, discards the port, and retries allocation/start/readiness at most three times within `startupTimeoutMs`; after that it reports `SERVICE_PORT_CONFLICT`. This accepts ordinary upstream services without a Bobbit protocol and makes the race bounded/testable. Docker and Compose retain daemon-side dynamic binding (`0`), which has no probe-close gap. The remaining policy loop (desired state, terminal reasons, backoff, and reconciliation) is intentionally narrow host orchestration, not a reimplementation of process supervision.

## 3. Exact authored contract

`contents.runtimes` remains a schema-2 array of safe descriptor basenames. Each item loads `runtimes/<name>.yaml`. The loader carries `RuntimeContribution { id, listName, sourceFile, packRoot, manifest }`; deep validation is performed by `parseServiceManifest` before every control operation. Bad descriptors are warn-and-drop at load, but an explicitly addressed invalid descriptor returns `SERVICE_MANIFEST_INVALID`, never an unscoped command.

The concrete TypeScript contract is in `src/server/service-runtime/service-manifest.ts`:

```ts
export type ServiceRunMode = "local" | "docker" | "compose";
export type RestartPolicy = "never" | "on-failure";
export type ServiceEnvSource =
  | { value: string }
  | { setting: string }
  | { secret: string }
  | { generatedSecret: string }
  | { endpointPort: true };

export interface HttpProbe {
  path: string;                 // begins with /, no URL/host
  expectedStatus: number;       // 100..599
  requestTimeoutMs: number;     // 100..10_000
  intervalMs: number;           // 100..10_000
  startupTimeoutMs: number;     // 1_000..300_000
}

export interface RuntimeEndpoint {
  protocol: "http" | "https";
  /** Listener in the local process/container. The local runner passes this selected port unchanged. */
  servicePort: number;          // 1..65535
  health: HttpProbe;
}

export interface RuntimeStorage {
  /** EP-7 non-secret string setting whose resolved absolute path is mounted as `target`. */
  setting: string;
  target: string;               // absolute POSIX path inside container; relative under local cwd forbidden
  survival: "preserve";
}

export interface RuntimeRestart {
  policy: RestartPolicy;
  maxAttempts: number;          // 0..10
  windowMs: number;             // 1_000..3_600_000
  initialBackoffMs: number;     // 100..60_000
  maxBackoffMs: number;         // initial..300_000
}

export interface LocalLaunch {
  command: string;
  args: string[];
  cwd?: string;
  /** Upstream listener's ordinary port environment-variable name. */
  portEnv: string;
  /** Required upstream listener-host variable; local runner forces loopback. */
  hostEnv: string;
}
export interface DockerLaunch { image: string; command?: string[]; }
export interface ComposeLaunch {
  file: string;                 // contained pack-relative path
  service: string;              // Compose service token
  projectName: string;          // validated template using pack/runtime/server identity only
}

export interface ServiceRuntimeManifest {
  apiVersion: 1;
  id: string;
  title: string;
  endpoint: RuntimeEndpoint;
  lifecycle: { startPolicy: "manual"; restart: RuntimeRestart };
  environment: Record<string, ServiceEnvSource>;
  storage?: RuntimeStorage;
  modes: { local: LocalLaunch; docker: DockerLaunch; compose: ComposeLaunch };
}
```

Validation rejects unknown keys, duplicate env names, unsafe ids/images/service names, non-array argv, invalid `local.portEnv`, a missing/non-literal-loopback `local.hostEnv`, shell metacharacter-bearing Compose project template values, `..`/absolute/symlink-escaping `file` and `local.cwd` paths, secret strings in `value`, an `endpointPort` environment source not mapped to the declared endpoint, malformed probe paths, and storage targets that are not absolute container paths. `environment` is a map, not string interpolation: an authored descriptor can only source a literal, EP-7 non-secret setting, EP-7 write-only secret, generated secret, or the runtime endpoint port. No descriptor can copy arbitrary process environment values.

The selected mode is an EP-7 enum setting named `runtimeMode`, values exactly `local`, `docker`, `compose`; the default is `local` for development-oriented packs and is authored per pack. It selects only the runner. It does not change the provider, route, tool, REST client, service protocol, or semantic configuration.

### Provider linkage

A provider's existing optional `runtime` field is normalized as a runtime id. The host injects this public, mode-free context only for the matching active provider:

```ts
export interface ServiceRuntimeContext {
  endpoint?: string; // e.g. http://127.0.0.1:49152; absent unless observed ready
  state: "stopped" | "starting" | "ready" | "degraded" | "blocked" | "unavailable";
  diagnostic?: { code: ServiceDiagnosticCode; retryAt?: string };
}
```

`endpoint` is loopback only and is absent in every non-ready state. Providers must retain their existing defensive dormancy guard: absent endpoint returns normal no-op/empty behavior. The lifecycle hub simply resolves and injects this object; it does not call `start`.

## 4. Generic lifecycle and state ownership

`ServiceRuntimeStore` persists one record per `(serverIdentity, packId, runtimeId)`, never per session or project. The descriptor declares a server-owned service; allowing two project configurations to start one shared Compose project would race secrets/data. EP-7 may scope settings per project, but service-affecting settings are server-scoped for Hindsight and a conflicting project attempt returns `SERVICE_CONFIGURATION_CONFLICT` with the current owner/settings revision, not last-writer-wins.

```ts
type DesiredState = "stopped" | "running";
type ObservedState = "stopped" | "starting" | "ready" | "degraded" | "blocked" | "unavailable";
interface PersistedServiceRuntime {
  version: 1;
  desired: DesiredState;
  selectedMode: ServiceRunMode;
  settingsRevision: string;
  runnerIdentity?: { kind: ServiceRunMode; id: string; composeProject?: string };
  endpoint?: string;             // current discovery only, cleared before start/after stop
  restartAttempts: number[];     // timestamps inside window only
  lastDiagnostic?: ServiceDiagnostic;
  updatedAt: string;
}
```

The record and generated secrets live under `<stateDir>/service-runtimes/<encoded pack>/<runtime>/`; its runtime `.env` is `0600`, atomically replace-written, and is not served, archived, or copied with a pack update. Metadata never contains a raw secret. Generated secrets are stored in `SecretsStore` under `service-runtime:<packId>:<runtimeId>:<key>`, while EP-7 user secrets remain in its own write-only settings store; they are resolved only at start.

### State machine

```text
stopped --explicit start + EP-6 grant--> starting --ready probe--> ready
starting --bad config/Docker unavailable--> blocked | unavailable
starting --probe timeout/process exit--> degraded
ready --health failure/process/container exit--> degraded
ready --explicit stop/disable/uninstall--> stopping --> stopped
starting/degraded --restart eligible--> starting
starting/degraded --attempt budget exhausted--> degraded
any --explicit stop--> stopping --> stopped
```

- `blocked` is an actionable prelaunch fault: missing grant, missing/invalid setting/secret, invalid descriptor, or a fixed configured storage path that is inaccessible. `unavailable` is a missing/unreachable Docker daemon or Compose plugin. Neither is retried automatically.
- `degraded` records a bounded classified fault (exit code/signal, readiness timeout, health failure, Docker failure); secrets, full child environment, and opaque upstream bodies are excluded.
- `start` is deduplicated by the service identity. Same request receives the in-flight result; a different selected mode/settings revision gets `SERVICE_START_CONFLICT` and must retry after it settles.
- Explicit `start` resets the attempt window and starts from `stopped`/`degraded`; explicit `restart` is `stop` then start; explicit `stop` cancels a pending backoff and sets `desired: stopped` before runner teardown.
- While desired is `running`, runner exit or failed periodic health check uses `on-failure` at `initialBackoffMs * 2^n`, capped by `maxBackoffMs`, only while attempts inside `windowMs` are below `maxAttempts`. Exhaustion stays `degraded`; there is no unbounded retry loop. `never` records degraded immediately.
- On gateway startup the supervisor reconstructs the record. Docker/Compose runners inspect their persisted labelled identity and preserve a ready service; local processes cannot be safely reparented, so a prior user-approved `desired: running` is restarted through the same bounded policy. A gateway restart never starts a service with `desired: stopped`.
- Stop is graceful first: local sends `SIGTERM` to its owned process tree and waits 10 seconds before `SIGKILL`; Docker sends `stop` with 10-second timeout; Compose sends `compose stop --timeout 10 <service>`. It then confirms absence via inspect/`compose ps`; a timed-out stop returns `SERVICE_STOP_TIMEOUT` and stays degraded. `down` is reserved for uninstall/purge and scopes only the declared Compose project/service.

## 5. Runner behavior, networking, storage, and diagnostics

### Uniform endpoint discovery and ports

All listeners bind loopback from Bobbit's perspective. Fixed host-port settings are intentionally unsupported.

| Mode | Start and endpoint discovery | Conflict behavior |
|---|---|---|
| Local | `get-port({ host: "127.0.0.1" })` selects a candidate; `execa(command, args, { cwd, env: { [local.portEnv]: candidate, [local.hostEnv]: "127.0.0.1" }, reject:false })` starts the unmodified upstream service. `hostEnv` is required, declared as a literal loopback variable, and assigned after resolved settings so it cannot be overridden. The adapter forms `http://127.0.0.1:<candidate>` and uses `p-retry`-bounded health polling. | Probe-close is inherently TOCTOU. An early `EADDRINUSE`/non-zero bind exit or unavailable health endpoint discards the candidate and retries allocation/start at most three times inside `startupTimeoutMs`; exhausted attempts return `SERVICE_PORT_CONFLICT`/`SERVICE_UNHEALTHY`, never hang. |
| Docker | `dockerode.createContainer` with label `io.bobbit.service=<identity>`, `HostConfig.PortBindings` mapping `<servicePort>/tcp` to host port `0` on `127.0.0.1`; start then inspect `NetworkSettings.Ports`. | Docker atomically allocates/binds. No host port is persisted; restart rediscovery inspects the live container. |
| Compose | `execa("docker", ["compose", "-p", project, "-f", containedFile, "up", "-d", service])`; authored Compose maps `127.0.0.1::${SERVICE_PORT}`. Discover with `docker compose ... port service servicePort`, validate `127.0.0.1:<port>`, then probe. | Docker/Compose allocates atomically. A publication conflict or unavailable plugin is classified, bounded, and shown in diagnostics. |

`status`, diagnostics reads, log reads, and provider calls inspect only; they do not allocate a port, render an env file, resolve secrets, or issue `up`. Adapters pass only validated argv, never a shell command. Compose commands always include the contained `-f` file and deterministic project name. Containers and Compose services have labels/project names that include a persisted server identity so a second gateway cannot inspect or stop another gateway's service.

### Storage and survival

`storage.setting` is resolved by EP-7 to an absolute path. The supervisor canonicalizes its parent, creates it with `0700`, verifies it is not a symlink escape from the declared root when Bobbit owns the default, and mounts it exactly once at `target`; it is never under the installed pack directory. Hindsight's default is `<stateDir>/service-data/hindsight`, editable to a user-selected absolute directory only after the settings UI discloses it.

- restart, stop/disable, and pack update preserve data and generated service credentials;
- uninstall stops/removes runner resources but preserves the bind directory and service state needed to reinstall;
- **purge** requires an explicit destructive typed-route/UI confirmation, stops first, removes runner resources and runtime state, then recursively removes only the resolved declared storage root after containment/revalidation. It never accepts a path supplied by the request;
- local working files, Docker containers/networks, Compose project resources, rendered env, and logs are Bobbit-owned and may be removed by uninstall/purge. User-selected data is only removed by purge.

### Configuration/secrets provenance and redaction

| Value | Owner/source | At-rest/use policy |
|---|---|---|
| `runtimeMode`, non-secret environment values, storage setting | EP-7 typed settings | Validated by EP-7 schema; read only at start; non-secret values may be shown in the capability summary. |
| User secret (`apiKey`, Hindsight LLM key, external DB URL) | EP-7 write-only secret field | EP-7 returns only `<name>Set`; supervisor resolves in memory and injects runner env/0600 env file. Never in API responses, diagnostics, logs, Compose arguments, image layers, or persisted metadata. |
| Generated service secret | `SecretsStore`, namespaced by service identity | Generated once at first start, reused across restart; never exposed. |
| Host endpoint/port | runner discovery | Ephemeral observed state; status may show loopback endpoint/port after ready, never before. |
| data directory | EP-7 non-secret setting | Shown before start and in diagnostics; not copied into pack files. |

Runner stdout/stderr is held in a bounded 64 KiB ring and redacted before persistence/return using the exact resolved secret values plus `KEY=value` forms. The UI and typed routes expose at most a 200-line sanitized tail. Command/adapter errors are mapped to stable codes; raw error text is retained only in the server log after the same redaction pass. Diagnostics include `state`, selected mode, changed time, sanitized reason, restart count/next retry, runner identity, endpoint when ready, health probe summary, and sanitized log tail.

The generic runtime nucleus exposes **no global REST API**. A host integration exposes authenticated, pack-scoped typed routes and derives pack, project, and session scope from the host binding; callers do not address a generic runtime path or select a runtime by request. Hindsight is the concrete composition; its route contract is documented in [Hindsight typed pack routes](../rest-api.md#hindsight-typed-pack-routes). Control uses the saved EP-7 revision and selected `runtimeMode`, accepts no arbitrary environment/body overlay, and returns stable diagnostic codes rather than secret-bearing text.

## 6. Hindsight mapping

Hindsight remains external by default. Its existing provider client and tools use `clientConfig` from a host-injected `ServiceRuntimeContext`; replace its Hindsight-specific `mode === managed` branches with the generic rule: a configured external URL is used in external mode, otherwise a ready runtime endpoint is used. In all unavailable states it returns the present non-fatal empty/diagnostic behavior and preserves the durable retain queue; it never calls the supervisor.

Author these additions after EP-7:

```yaml
# market-packs/hindsight/pack.yaml
contents:
  runtimes: [hindsight]

# market-packs/hindsight/providers/memory.yaml
runtime: hindsight
config:
  runtimeMode: { type: enum, values: [external, local, docker, compose], default: external }
  llmApiKey: { type: secret, optional: true }
  dataDir: { type: string, default: "${stateDir}/service-data/hindsight" }
```

`external` is a Hindsight provider setting, not a `ServiceRunMode`: it means no Bobbit-managed service and keeps `externalUrl` behavior. `local`, `docker`, and `compose` are mapped to the generic runner mode only when starting the `hindsight` runtime. This mapping belongs in one `HindsightRuntimeSettingsAdapter` in the pack/runtime linkage, not `server.ts`; LangFlow supplies its own configuration schema but uses no different supervisor branch.

`market-packs/hindsight/runtimes/hindsight.yaml` supplies:

- `endpoint: { protocol: http, servicePort: 8888, health: { path: /health, expectedStatus: 200, requestTimeoutMs: 1500, intervalMs: 1000, startupTimeoutMs: 120000 } }`;
- `local` command/package entry with `portEnv` and required `hostEnv` set to Hindsight's audited listener variables, so the unmodified service receives a normal selected port and forced loopback host with no Bobbit-specific ready protocol;
- digest-pinned `ghcr.io/vectorize-io/hindsight` Docker image and a Compose stack with only the verified API plus `pgvector/pgvector`; `SERVICE_PORT` is dynamically published on loopback;
- a generated Postgres password, write-only Hindsight LLM key, and the declared bind storage path;
- `lifecycle.restart: { policy: on-failure, maxAttempts: 3, windowMs: 300000, initialBackoffMs: 1000, maxBackoffMs: 30000 }`.

The Hindsight compose template contains `restart: "no"`; Bobbit owns recovery so Docker and the supervisor cannot race or hide a crash. Hindsight memory mechanics consume this endpoint contract rather than reintroducing runtime management; their current scope and non-goals are documented in [Hindsight memory completion](hindsight-memory-completion.md) and [Hindsight memory pack](../hindsight-memory.md).

## 7. Hindsight completion and foundation context

### Delivered baseline and provenance

Do **not** rebuild the already-landed safety work: H-1 is on current main — #1091 makes failed retain/enqueue persistence observable and #1106 makes pack-store reads tri-state rather than treating I/O/corruption as an empty queue. #1099's `HookCtx.scopeContext` is also landed and is the only source for rich lifecycle scope. Preserve those contracts while reconciling the #820 import; no imported code may restore a `void` enqueue result, default through a failed store read, or reconstruct scope from untrusted route/tool input.

The Hindsight H-2, H-5, and H-6 completion work is delivered and supersedes the prescriptions formerly in this document. It is a pack-level consumer of this generic runtime design; see [Hindsight memory completion](hindsight-memory-completion.md) for its mechanics and [Hindsight memory pack](../hindsight-memory.md) for the current operational contract. H-3 remains the generic host/extension foundation audit described below.

### Workstreams and ownership boundary

| Stream | Ownership boundary |
|---|---|
| Hindsight Memory Completion (H-2/H-5/H-6) | Delivered pack mechanics; collision-safe identity, durable project-partitioned recovery, host-fenced goal completion, and fail-closed authoritative scope. |
| H-3 Foundation Hardening | Generic host/extension durability and lifecycle contracts only. |
| Runtime Core | Generic supervisor/descriptor and mode-independent endpoint injection. |
| Experience / EP-6 | Deferred settings UI, screens, final tools, additional routes, and central authorization work. |

### H-3 — generic foundation hardening and provenance audit

H-3 is the remaining host/extension foundation portion identified by the earlier audit. That package is unavailable in this checkout, so its bundle, ledger, and individual commit identifiers are historical context only; they are not required verification inputs and must not block completion. It is a semantic reference, never a cherry-pick series.

The outcome matrix is H-3's completion record. Each generic-foundation outcome is classified with current-code evidence as **already delivered on main**, **superseded by the current architecture**, **implemented here**, or **not applicable** to H-3 because another named stream owns it. Do not silently drop or reclassify an outcome: record the current contract, rationale, resulting commit where applicable, and registered regression coverage.

| ID | Generic-foundation outcome audited from the reference package | Outcome classification | Required evidence / completion disposition |
|---|---|---|---|
| GF-01 | Distinguish absent, readable-empty, corrupt, and I/O-failed PackStore reads; recover before queue CAS/sequence/quota decisions. | already delivered on main | #1106 (`73da91431`) and its PackStore durable-read tests; H-3 must prove no new primitive collapses a failed read to empty. |
| GF-02 | Surface failed retain-plus-durable-enqueue persistence rather than returning success. | already delivered on main | #1091 (`4aba79b60`) and the current durable-outcome provider path; H-3 may consume, never revert, its non-`void` failure result. |
| GF-03 | Typed PackStore mutation results and error fidelity for read/write/compare/commit operations used by extensions. | implemented here | Reconcile the reference semantics into the exact `PackStore` contract; map every error to a stable host result, retain cause for diagnostics, and add focused core/integration tests. |
| GF-04 | Mutation fences: validate/preflight before mutation and record a durable commit outcome so failed or racing writes never look committed. | implemented here | Add only reusable host-store fencing; tests cover preflight failure, write failure, concurrent fence conflict, and recovery without a false success. |
| GF-05 | A single bounded deadline and `AbortSignal` cross the host → worker → extension/store/client boundary. | implemented here | Tests prove timeout cancellation reaches each injected boundary, late completion cannot commit, and the caller receives a bounded classified result. |
| GF-06 | Durable retry, idempotency, and lifecycle seams expose retryable/non-retryable outcomes without duplicating work after restart or repeated lifecycle delivery. | implemented here | Host seams are generic; tests prove restart/replay, duplicate invocation, and terminal failure. H-5 consumes them for goal outcomes but is not implemented here. |
| GF-07 | Old provider-owned scope/lifecycle context plumbing assumed by the reference package. | superseded by current architecture | #1099 (`c9f230529`) is the authoritative `HookCtx.scopeContext` contract. H-3 does not change scope algorithms; H-6 alone consumes it. |
| GF-08 | Reference-package test locations and legacy harness conventions. | superseded by current architecture | New/ported assertions are registered in `tests2/tests-map.json`; legacy `tests/` placement is not acceptance evidence. |
| GF-09 | Prefix-ID allocation, sweep cadence/checkpoints, and stranded-record scope privacy. | not applicable to H-3 | H-2 / Memory Completion owns these pack algorithms and their Hindsight-only tests. H-3 must not alter their algorithm or storage format. |
| GF-10 | Managed modes, supervisor/runner/endpoint injection, runtime status, panels, agent tools, and deployment assets. | not applicable to H-3 | H-4 / Runtime Core + Experience owns these consumers. H-3 may expose generic error/lifecycle seams but cannot add service modes, UI, tools, or a Hindsight branch. |

H-3 may change only these host/extension contracts, with the listed ownership boundaries:

| Area | Exact files/contracts H-3 may change | Boundary |
|---|---|---|
| Pack-store primitives and fidelity | `src/server/extension-host/pack-store.ts`, `src/server/extension-host/server-host-api.ts`, and their exported `PackStore`/store-result/error contracts | Preserve #1106 read states and #1091 durable outcome semantics; no Hindsight-specific queue logic. |
| Worker mutation boundary | `src/server/extension-host/{module-host-bootstrap,module-host-worker,action-dispatcher,route-dispatcher}.ts` and the serialized host API request/result contract | Carry typed mutation/fence outcomes; no route/tool-specific policy or private permission path. |
| Deadlines and cancellation | `src/server/agent/lifecycle-hub.ts`, `src/server/agent/provider-bridge-extension.ts`, `src/server/extension-host/module-host-worker.ts`, and `HookCtx`/host-call deadline-plus-abort contract | Propagate a host-owned remaining deadline and abort signal; do not change H-2 sweep scheduling or create a service supervisor. |
| Durable retry/idempotency/lifecycle seams | `src/server/agent/lifecycle-hub.ts`, `src/server/agent/pack-contributions.ts`, `src/server/extension-host/pack-contribution-registry.ts`, and generic provider invocation result/lifecycle delivery contracts | Expose reusable result/idempotency seams only. H-5 remains sole owner of `goalCompleted` content/key algorithm. |
| Tests and mapping | `tests2/core/{pack-store,extension-host,lifecycle-hub}-*.test.ts`, `tests2/integration/{extension-host,lifecycle-hub}-*.test.ts`, and `tests2/tests-map.json` | Port assertions as v2 coverage. No production Hindsight pack, runtime, screen, tool, or EP-6/EP-7 file is in H-3 scope. |

H-3 acceptance requires a parent-PR outcome appendix for GF-01…GF-10. For each outcome, it records the classification, current-main path/contract comparison, rationale, resulting current commit(s) where applicable, and exact registered `tests2` test IDs. The appendix records the unavailable-package caveat and does not require recovering a bundle, ledger, or individual commit identifiers. It also records that #1091/#1106 were preserved and why no H-2/H-4/EP-6/EP-7 code was pulled into this subgoal.

### H-2 — delivered memory hardening

The audited package remains behavioral reference only. The delivered pack mechanics use collision-safe canonical identities and complete-boundary prefix validation; queued and stranded records preserve their original project/goal/session scope plus bank and namespace. A shared injected-clock sweep is due-only, non-overlapping, deadline-bound, and advances its checkpoint only after the related durable mutation. These mechanics retain #1091/#1106 durability behavior and never make service-runtime calls.

See [Hindsight memory completion](hindsight-memory-completion.md#h-2-batching-sweep-and-stranded-replay) and [Hindsight memory pack](../hindsight-memory.md#retry-queue-stranded-records-and-diagnostics).

### H-5 — delivered host-fenced goal completion

Goal completion remains host-originated. The host uses `deliverLifecycleOnce` to coalesce concurrent delivery and persist a completion marker only after the Hindsight provider reports remote success or confirmed durable queueing. A compound remote-and-queue failure, deadline/abort, or marker-write failure leaves no success marker. The provider retains a bounded host snapshot and uses the same durable retry path as ordinary retention.

See [Hindsight memory completion](hindsight-memory-completion.md#h-5-host-goal-completion-delivery) and [Lifecycle Hub](../lifecycle-hub.md#goal-completion-delivery).

### H-6 — delivered fail-closed recall

Rich identity derives only from #1099 `HookCtx.scopeContext`; flat fields and request data do not select scope. Recall requires authoritative project scope, may narrow to the authoritative goal, and fails closed without a project scope before constructing a client or making a remote call. Broad `all` is not a normal option. It remains unavailable unless a central EP-6 invocation grant supplies `memory.read.all`; this slice creates neither that contract nor a private grant path.

See [Hindsight memory completion](hindsight-memory-completion.md#h-6-narrow-recall-and-capability-boundary) and [Hindsight memory pack](../hindsight-memory.md#bank--tag-taxonomy).

### Delivered Hindsight experience

Hindsight settings UI, panel, typed routes, agent tools, browser journey, and central EP-6/EP-7 composition are delivered. The current operational contract is [Hindsight memory](../hindsight-memory.md); this planning record is not an acceptance checklist for those surfaces.

Current regression coverage is registered in `tests2/core/hindsight-memory-completion.test.ts`, `tests2/core/hindsight-provider.test.ts`, `tests2/core/lifecycle-delivery-foundation.test.ts`, and `tests2/integration/hindsight-memory-completion.test.ts`.

## 8. LangFlow authoring recipe

A LangFlow author does exactly this:

1. Add `runtimes/langflow.yaml` and list `langflow` in `contents.runtimes`.
2. Declare LangFlow's HTTP service port and a real readiness endpoint, bounded probe timings, and all three required [launch-mode blocks](../managed-runtimes.md#launch-modes): `local` argv with its normal `portEnv` and listener `hostEnv`, a digest-pinned Docker image, and a contained Compose file/service. The local runner supplies that normal port variable and forces the declared host variable to loopback; Docker/Compose use loopback dynamic publication. No LangFlow code emits or understands Bobbit-specific readiness messages.
3. Declare every setting/secret through the provider or pack EP-7 schema, and map each process environment variable via `environment`. Add `storage` only if LangFlow must persist data. Never read raw environment/config or construct a Docker command in the pack module.
4. Set a provider's `runtime: langflow`; provider/routes/tools read only `ctx.runtime.endpoint`. If absent/not ready, return their documented graceful no-service behavior.
5. Request `service.manage` in the manifest capability metadata. EP-6 displays/audits the grant; the generic supervisor only checks the resolved grant before control actions.
6. Add the same runner-contract fixtures and mode matrix described below. No new server integration, settings screen, permission system, endpoint injection, port logic, or lifecycle code is authored.

If a service cannot bind its ordinary declared `local.portEnv` and `local.hostEnv`, or expose the declared HTTP readiness endpoint, it is not eligible to declare this runtime until upstream supports it. The current contract has no one- or two-mode exception: Docker and Compose support alone is insufficient for the mode-independence promise.

## 9. File-level implementation plan and control flow

| File | Change |
|---|---|
| `src/server/agent/pack-types.ts`, `pack-manifest.ts` | Retain/strictly document schema-2 `contents.runtimes`; reject duplicate safe basenames. |
| `src/server/agent/pack-contributions.ts` | Add `RuntimeContribution`, `loadRuntimes`, deep path-safe file anchoring, and normalize provider `runtime`. |
| `src/server/extension-host/pack-contribution-registry.ts` | Add `getRuntime`/active runtime listing. Activation filtering and EP-6 grants remain centralized here; raw descriptor is never exposed to a worker. |
| `src/server/service-runtime/service-manifest.ts` | Exact schema/types, strict validator, contained path resolution, endpoint/environment/storage checks. |
| `src/server/service-runtime/service-runners.ts` | `ServiceRunner` interface plus Local/Docker/Compose adapters. Uses `get-port` + `execa` + bounded `p-retry` for ordinary local services and `dockerode`/Compose for containers; each adapter returns the shared `StartedService` and scopes operations by identity. |
| `src/server/service-runtime/service-runtime-store.ts` | Versioned atomic state, `0600` env/log files, generated-secret namespacing, server identity, recovery record reads. Failed durable writes stop control operations rather than claiming success. |
| `src/server/service-runtime/service-supervisor.ts` | State machine, start dedupe, readiness/periodic health, restart/backoff, graceful stop, startup reconciliation, redacted diagnostics, and injectable clock/probe/runners/store seams. |
| `src/server/service-runtime/index.ts` | Narrow public exports for server wiring/tests. |
| `src/server/extension-host/pack-store.ts`, `server-host-api.ts`, `module-host-{bootstrap,worker}.ts`, `action-dispatcher.ts`, `route-dispatcher.ts`, `src/server/agent/{lifecycle-hub,provider-bridge-extension,pack-contributions}.ts`, and `pack-contribution-registry.ts` | H-3 only: reconcile typed PackStore result/error fidelity, reusable mutation fences, host-owned deadline/abort propagation, and durable retry/idempotency/lifecycle result seams. Preserve #1091/#1106; do not change H-2 algorithms, H-4 runtime/screens/tools, or EP-6/EP-7 ownership. |
| `src/server/agent/lifecycle-hub.ts`, `src/server/agent/pack-contributions.ts`, and current goal-completion dispatch wiring | Inject the read-only `ServiceRuntimeContext` resolver before module invocation and carry the validated `goalCompleted` event to providers. Resolver only reads status; goal completion remains host-originated. |
| `src/server/server.ts` | Construct the supervisor after state/settings/grant dependencies; compose it with Hindsight's authenticated pack-scoped typed routes and lifecycle resolver. Do not add a global runtime REST route or a Hindsight-specific plan switch. |
| `market-packs/hindsight/{pack.yaml,providers/memory.yaml,runtimes/hindsight.yaml,runtime/compose.yaml,src/shared.ts,src/provider.ts,src/routes.ts}` | Declare/consume the mode-independent runtime endpoint and config redaction. The delivered H-2/H-5/H-6 mechanics are maintained as specified in [Hindsight memory completion](hindsight-memory-completion.md); this runtime plan does not prescribe additional memory routes. |
| Hindsight panels, final agent tools, and their entrypoints | Delivered separately by H-4 through the central EP-6/EP-7 contracts. See [Hindsight memory](../hindsight-memory.md); they are not part of the generic runtime implementation plan. |
| `package.json`, lockfile | Add direct `execa`, `dockerode`, `get-port`, `p-retry`, and types needed by Dockerode. |
| `tests2/tests-map.json` | Register every new v2 test and affected-reader edges. |

**Start flow:** authenticated user action → EP-6 grant check → EP-7 resolved/revision-checked config → registry descriptor → strict parse → atomically persist `desired:running/starting` → resolve in-memory secrets/storage → selected runner start → discover loopback endpoint → bounded probe → atomically persist ready record → lifecycle resolver injects endpoint → provider/client uses it.

**Failure flow:** validation/grant/settings fault → `blocked`; dependency missing → `unavailable`; runner exit/probe fault → redacted diagnostic + `degraded`; optional bounded recovery; provider observes absent endpoint and returns no-op/queue behavior. No error path runs a fallback mode or dials an old endpoint.

**Stop/update flow:** disable/uninstall/purge sets desired stopped before runner operation → graceful scoped teardown → clear endpoint → preserve or explicitly purge data according to verb. Pack update never owns/moves service state/storage; a later reconciliation reads the latest descriptor and either retains the known-running service if compatible or marks a manifest incompatibility degraded.

## 10. EP-6/EP-7 dependency plan

This goal is blocked on the relevant extension-platform slices. **Preferred integration:** wait for EP-6 and EP-7 to merge to their parent integration branch, then rebase this branch and implement against their exported resolver/settings contracts. The parent PR records the exact parent SHA(s) used.

If schedule requires it, cherry-pick only the additive, reviewed EP-6 grant and EP-7 settings commits onto the Hindsight parent branch, recording commit SHAs and conflicts in the parent PR body. Independently, perform the mandatory #820 first-parent cherry-picks specified in §2 onto that same parent before runtime reconciliation. If the needed exported interface is absent from EP-6/EP-7, record it as a blocking finding and request an additive platform slice; do not create a parallel grants store, private settings form, or secret store.

The runtime consumes, but does not define:

- EP-6 `ExtensionGrantResolver.isGranted(projectId, packId, "service.manage")` and its audit/revoke semantics. Revoke takes effect on the next control action and immediately stops scheduled restart; it does not silently kill a ready service without an explicit EP-6 policy decision.
- EP-7 resolved typed values/secrets, revision token, schema validation, scoped configuration, and write-only redaction. Settings mutations invalidate the registry/runtime resolver cache; the next explicit restart applies them.

## 11. Test plan (tests2 only)

Every new test is registered in `tests2/tests-map.json`; fixtures live below the test run root and use no ambient credential, port, Docker resource, or user data. Qualification uses the repository wrappers with `BOBBIT_V2_RETRY_FREE=1`; tests synchronize on readiness/exit events, not sleeps.

| Tier/file family | Seams and assertions |
|---|---|
| `tests2/core/service-runtime-manifest.test.ts` | Descriptor strictness, duplicate ids, contained paths/symlink escape rejection, env provenance, secret-in-literal rejection, valid Hindsight/LangFlow-shaped fixture parsing. |
| `tests2/core/service-runtime-supervisor.test.ts` | Fake runner/probe/clock/store: all state transitions, same-start dedupe/conflicting-mode rejection, bounded readiness, no-auto-start reads, recovery cap/backoff, stop cancellation, restart reconciliation, durable-write failure, redaction, and endpoint absence in degraded/unavailable states. |
| `tests2/core/service-runtime-runners.test.ts` | Injected `get-port`/`execa`/Dockerode/Compose seams: argv only, loopback dynamic ports, ordinary upstream local health polling, `EADDRINUSE` probe-close retry cap, correct container/Compose identity and service scoping, graceful escalation, and no port allocation/read mutation. No daemon/process is launched. |
| `tests2/core/hindsight-service-runtime.test.ts` | Hindsight descriptor maps all three modes to the same provider client config; external remains dormant/no Docker; provider never calls supervisor; config GET has `*Set` booleans only. |
| `tests2/core/{pack-store,extension-host,lifecycle-hub}-*.test.ts`, `tests2/integration/{extension-host,lifecycle-hub}-*.test.ts` | H-3 GF-03…GF-06: typed error fidelity, mutation fences, deadline/abort propagation, late-completion suppression, durable retry/idempotency/lifecycle replay, and explicit preservation of #1091/#1106. Every provenance-matrix row maps to an exact registered test. |
| `tests2/core/hindsight-memory-completion.test.ts`, `tests2/core/hindsight-provider.test.ts` | H-2 identity/prefix separation, injected-clock sweep cadence/lease/deadline/checkpoint behavior, scope-preserving stranded replay, provider durability, and no cross-project remote call. |
| `tests2/core/lifecycle-delivery-foundation.test.ts` | H-5 concurrent lifecycle single-flight, durable marker fencing, deadline behavior, and retryable failures without false success. |
| `tests2/integration/hindsight-memory-completion.test.ts` | Host-to-worker authoritative scope, missing-context fail-closed behavior, completion marker/queue behavior, and isolation of foreign or malformed stranded records. |
| `tests2/browser/e2e/service-runtime-settings.spec.ts` | EP-7 settings → EP-6 consent/grant → start status/diagnostics → reload → stop; inaccessible/down service is displayed with an actionable state and the normal session UI continues. Includes keyboard/accessibility and cleanup. |
| Hindsight panel/tool browser journeys | Delivered separately by H-4; `tests2/browser/e2e/hindsight-experience.spec.ts` covers the shipped experience. They are not acceptance requirements for this generic-runtime slice. |
| `tests2/_e2e/service-runtime-docker.test.ts` (registered as `vitest-e2e`) | The automated Docker proof. Build a tiny purpose-built HTTP fixture image and Compose fixture locally (no external pull), start the **same unmodified fixture service** in local/Docker/Compose through real adapters, assert identical `/health`, retain/recall fixture behavior, dynamic loopback ports, graceful stop, and data persistence. Force one candidate-port bind conflict to prove the bounded local retry; a deliberately down health endpoint must reach `degraded` within `startupTimeoutMs` and a session request completes within its ordinary provider timeout. Docker absence is reported by the E2E coordinator as unavailable rather than silently skipping the contract. |

The existing legacy #820 unit/API/manual tests are an assertion inventory, not acceptance evidence. Translate their useful intent into the above fixtures and reject stale assertions such as fake web containers, fixed/probed ports, manual-only Docker proof, and Hindsight-specific server switches. `npm run check`, `npm run test:unit`, `npm run test:browser`, and `npm run test:e2e` are required before integration; the Docker matrix belongs in E2E, not `test:manual`.

## 12. #820 absorption/reconciliation checklist

1. On the Hindsight parent, cherry-pick only the exact ordered #820 SHA list in §2, using `-m 1` only for its merge commits. Do not substitute a revision range or include an `origin/master` merge; do not skip the mandatory provenance import merely because a semantic is later replaced. Record empty/redundant picks rather than silently omitting them.
2. Rebase the imported parent on current `origin/main`, resolve each conflict in favor of current durable-read behavior (#1091/#1106) and landed scope context (#1099), then classify every imported runtime change: retained, refactored, or individually superseded with a reason.
3. Refactor retained mechanics into the generic contract: safe descriptor/Compose containment, argv-only calls, service-scoped inspection/control, no-auto-start, HTTP readiness, stable identity, env-file permissions, and explicit teardown/data survival. Replace #820's raw fields, persistent probe-allocated ports, Compose-only abstraction, Hindsight branch in `server.ts`, manual-only Docker acceptance, and best-effort state writes.
4. Defer #820 panel/tools and additional memory UI until their owning EP-6/EP-7 work is available. Any later work must consume `ServiceRuntimeStatus`, typed settings, and resolved central grants; it must not restore a private authorization path.
5. In the parent PR body, list each imported #820 SHA and any dropped-empty result, conflicts and resolution, retained/refactored/superseded behavior, EP-6/EP-7 SHA strategy, direct dependency rationale, and end with the required Bobbit footer.
