# Service-extension runtime

**Status:** implementation design for Hindsight and the reusable external-service contract.

## 1. Decision, boundaries, and acceptance criteria

A pack may declare a **runtime**: an operator-consented, gateway-supervised service that its provider/routes/tools consume only through a resolved endpoint. Runtime selection is host-owned. Pack code receives the same `ctx.runtime.endpoint` in all modes and never invokes Docker, Compose, a child process, port allocation, or restart logic.

This is deliberately a service contract, not a Hindsight-specific Docker integration. A second author can implement LangFlow by authoring one descriptor, its container/Compose assets, provider configuration, and endpoint consumer; no new supervisor, lifecycle API, or deployment-mode code is required.

### Scope ledger

| Must ship | Allowed to change | Deferred / prohibited |
|---|---|---|
| Schema-2 runtime descriptor and loader; local-process, Docker-container, and Docker-Compose runners; one lifecycle state machine; config/secrets/storage/diagnostics contracts; mandatory #820 provenance absorption; H-2/H-3/H-5/H-6 hardening and scope work; native memory screens and explicit agent tools; Hindsight descriptor and wiring; mode-independent tests including unavailable/unhealthy behavior. | Add direct runtime dependencies; new server runtime modules and REST routes; the H-3 host/extension seams named in §7; pack manifest/provider/tool/panel fields; generated pack artifacts; extensions to EP-6/EP-7 consumption points after their work lands. | A LangFlow pack; a private settings or permission UI; arbitrary remote-service management; Kubernetes; automatic install/enable start; host-port choice in user settings; H-2 memory algorithms in H-3; H-4 runtime/screens/tools in H-3; EP-6/EP-7 implementation; copying #820 semantics/tests without individual reconciliation. |

Acceptance means all of the following are true.

1. The same Hindsight client operation (`health`, retain, recall) is reachable through `local`, `docker`, and `compose` modes and produces the same response contract; client/provider code does not branch on the mode.
2. Start returns only after the declared HTTP readiness condition passes. A down, refused, crashed, or unhealthy service returns a bounded diagnostic and leaves the calling session usable; no hook, route, or tool waits indefinitely or starts a service implicitly.
3. An explicit start is required once. The persisted desired state then permits bounded crash recovery and gateway-restart reconciliation; install, discovery, configuration reads, status, and provider invocation never start a service.
4. Config and secret provenance is explicit, secrets never appear in settings reads, status, log events, command arguments, or images, and rendered secret files are owner-read/write only.
5. Host ports are loopback-only, dynamically assigned, rediscovered after start, and never reallocated by a read path. Service data survives restart/disable/update; destructive data removal requires an explicit purge of a declared, contained data directory.
6. EP-6 owns authorization/grants and EP-7 owns settings rendering/storage. This feature consumes their public contracts; it does not recreate them.
7. H-3 reconciles every remaining generic-foundation outcome from the audited 37-commit reference package through the finite provenance matrix in §7. It preserves #1091's durable enqueue outcome and #1106's tri-state durable read/error fidelity, has no unresolved `missing`/`implement` row, and proves mutation, deadline/abort, retry/idempotency, and lifecycle-boundary behavior through `tests2`.
8. The audited H-2 package closes the prefix-ID race, sweep cadence/deadline behavior, and stranded-scope privacy coverage; H-5 retains a completed goal outcome exactly once through the landed goal-completion hook; H-6 scopes recall from the landed #1099 `HookCtx.scopeContext` without cross-project leakage.
9. Native memory browse/search/detail/invalidate/reflect screens and `hindsight_*` agent tools are available only through EP-6 grants and EP-7 configuration, consume the same generic runtime status, redact secrets, survive reload, and clean up their transient UI state.

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

Validation rejects unknown keys, duplicate env names, unsafe ids/images/service names, non-array argv, invalid `local.portEnv`, shell metacharacter-bearing Compose project template values, `..`/absolute/symlink-escaping `file` and `local.cwd` paths, secret strings in `value`, an `endpointPort` environment source not mapped to the declared endpoint, malformed probe paths, and storage targets that are not absolute container paths. `environment` is a map, not string interpolation: an authored descriptor can only source a literal, EP-7 non-secret setting, EP-7 write-only secret, generated secret, or the runtime endpoint port. No descriptor can copy arbitrary process environment values.

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
| Local | `get-port({ host: "127.0.0.1" })` selects a candidate; `execa(command, args, { cwd, env: { [local.portEnv]: candidate }, reject:false })` starts the unmodified upstream service. The adapter forms `http://127.0.0.1:<candidate>` and uses `p-retry`-bounded health polling. | Probe-close is inherently TOCTOU. An early `EADDRINUSE`/non-zero bind exit or unavailable health endpoint discards the candidate and retries allocation/start at most three times inside `startupTimeoutMs`; exhausted attempts return `SERVICE_PORT_CONFLICT`/`SERVICE_UNHEALTHY`, never hang. |
| Docker | `dockerode.createContainer` with label `io.bobbit.service=<identity>`, `HostConfig.PortBindings` mapping `<servicePort>/tcp` to host port `0` on `127.0.0.1`; start then inspect `NetworkSettings.Ports`. | Docker atomically allocates/binds. No host port is persisted; restart rediscovery inspects the live container. |
| Compose | `execa("docker", ["compose", "-p", project, "-f", containedFile, "up", "-d", service])`; authored Compose maps `127.0.0.1::${SERVICE_PORT}`. Discover with `docker compose ... port service servicePort`, validate `127.0.0.1:<port>`, then probe. | Docker/Compose allocates atomically. A publication conflict or unavailable plugin is classified, bounded, and shown in diagnostics. |

`status`, diagnostics reads, log reads, and provider calls inspect only; they do not allocate a port, render an env file, resolve secrets, or issue `up`. Adapters pass only validated argv, never a shell command. Compose commands always include the contained `-f` file and deterministic project name. Containers and Compose services have labels/project names that include a persisted server identity so a second gateway cannot inspect or stop another gateway's service.

### Storage and survival

`storage.setting` is resolved by EP-7 to an absolute path. The supervisor canonicalizes its parent, creates it with `0700`, verifies it is not a symlink escape from the declared root when Bobbit owns the default, and mounts it exactly once at `target`; it is never under the installed pack directory. Hindsight's default is `<stateDir>/service-data/hindsight`, editable to a user-selected absolute directory only after the settings UI discloses it.

- restart, stop/disable, and pack update preserve data and generated service credentials;
- uninstall stops/removes runner resources but preserves the bind directory and service state needed to reinstall;
- **purge** requires an explicit destructive REST/UI confirmation, stops first, removes runner resources and runtime state, then recursively removes only the resolved declared storage root after containment/revalidation. It never accepts a path supplied by the request;
- local working files, Docker containers/networks, Compose project resources, rendered env, and logs are Bobbit-owned and may be removed by uninstall/purge. User-selected data is only removed by purge.

### Configuration/secrets provenance and redaction

| Value | Owner/source | At-rest/use policy |
|---|---|---|
| `runtimeMode`, non-secret environment values, storage setting | EP-7 typed settings | Validated by EP-7 schema; read only at start; non-secret values may be shown in the capability summary. |
| User secret (`apiKey`, Hindsight LLM key, external DB URL) | EP-7 write-only secret field | EP-7 returns only `<name>Set`; supervisor resolves in memory and injects runner env/0600 env file. Never in API responses, diagnostics, logs, Compose arguments, image layers, or persisted metadata. |
| Generated service secret | `SecretsStore`, namespaced by service identity | Generated once at first start, reused across restart; never exposed. |
| Host endpoint/port | runner discovery | Ephemeral observed state; status may show loopback endpoint/port after ready, never before. |
| data directory | EP-7 non-secret setting | Shown before start and in diagnostics; not copied into pack files. |

Runner stdout/stderr is held in a bounded 64 KiB ring and redacted before persistence/return using the exact resolved secret values plus `KEY=value` forms. The UI/API expose at most a 200-line sanitized tail. Command/adapter errors are mapped to stable codes; raw error text is retained only in the server log after the same redaction pass. Diagnostics include `state`, selected mode, changed time, sanitized reason, restart count/next retry, runner identity, endpoint when ready, health probe summary, and sanitized log tail.

The runtime REST surface is admin-authenticated and small:

```text
GET  /api/service-runtimes?projectId=             -> { runtimes: ServiceRuntimeStatus[] }
GET  /api/service-runtimes/:id                    -> ServiceRuntimeStatus
POST /api/service-runtimes/:id/start              -> ServiceRuntimeStatus
POST /api/service-runtimes/:id/stop               -> ServiceRuntimeStatus
POST /api/service-runtimes/:id/restart            -> ServiceRuntimeStatus
GET  /api/service-runtimes/:id/logs?tail=         -> { lines: SanitizedLogLine[] }
POST /api/service-runtimes/:id/purge              -> ServiceRuntimeStatus
```

`start` has no arbitrary environment/body overlay. It uses the saved EP-7 revision and selected `runtimeMode`; a stale settings revision returns `409 SERVICE_SETTINGS_STALE`. `purge` requires `{ confirm: "<packId>:<runtimeId>" }`. Missing grants are `403`, invalid descriptor/settings are `400`, missing runtime `404`, unavailable dependency `503`, and bounded runner/start failure `502`. All responses use diagnostic codes rather than secret-bearing text.

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
- `local` command/package entry with `portEnv` set to the audited upstream Hindsight listener variable, so the unmodified service receives a normal selected port with no Bobbit-specific ready protocol;
- digest-pinned `ghcr.io/vectorize-io/hindsight` Docker image and a Compose stack with only the verified API plus `pgvector/pgvector`; `SERVICE_PORT` is dynamically published on loopback;
- a generated Postgres password, write-only Hindsight LLM key, and the declared bind storage path;
- `lifecycle.restart: { policy: on-failure, maxAttempts: 3, windowMs: 300000, initialBackoffMs: 1000, maxBackoffMs: 30000 }`.

The Hindsight compose template contains `restart: "no"`; Bobbit owns recovery so Docker and the supervisor cannot race or hide a crash. Existing Hindsight memory semantics (bank/tags, durable-read hardening, queue behavior, scoped recall, agent tools, panel) remain separate implementation work and must consume this endpoint contract rather than reintroducing runtime management.

## 7. Complete Hindsight delivery plan

### Delivered baseline and provenance

Do **not** rebuild the already-landed safety work: H-1 is on current main — #1091 makes failed retain/enqueue persistence observable and #1106 makes pack-store reads tri-state rather than treating I/O/corruption as an empty queue. #1099's `HookCtx.scopeContext` is also landed and is the only source for rich lifecycle scope. Preserve those contracts while reconciling the #820 import; no imported code may restore a `void` enqueue result, default through a failed store read, or reconstruct scope from untrusted route/tool input.

The remaining Hindsight work is H-2 hardening, H-3 generic-foundation hardening, H-5 goal-outcome retention, H-6 scoped recall, native memory screens, and explicit agent tools. They are part of this goal's acceptance, not follow-up ideas.

### Workstreams, order, and operator pause

| §3 item | Parent subgoal / stream | Ownership boundary |
|---|---|---|
| H-2 | Memory Completion | Hindsight-only ID, sweep, and stranded-scope algorithms. |
| H-3 | Foundation Hardening | Generic host/extension durability and lifecycle contracts only. |
| H-4 | Runtime Core + Experience | Runtime Core owns the generic supervisor/descriptor; Experience owns its Hindsight screens, tools, and runtime consumption. |
| H-5 / H-6 | Memory Completion | Goal-outcome retention and authoritative scoped recall. |

Execution is ordered: **Runtime Core → H-3 Foundation Hardening → H-2/H-5/H-6 Memory Completion → H-4 Experience**. The existing *Hindsight Memory* child is operator-paused until Foundation Hardening merges. The non-parent scheduler is degraded and could not add that new cross-edge to the existing child; the parent must record this manual pause/dependency in its PR and must not resume the child merely because its original scheduler dependency list is satisfiable.

### H-3 — generic foundation hardening and provenance audit

H-3 is the remaining host/extension foundation portion of the audited 37-commit package rooted at `05158df267fd8635843a4e3ef1504e4a6b279f17`, semantic reference tree `60103cd8610b618574eba022a7d66e80be9ac6f0` / final head `3207eb9fcd117e62fd82f8aeef82b5cea1a703ce`, and bundle digest `d3c5d24b96835607a7d4c97902e7a37bdc531f823a20dd685f2c1756294c81d9`. It is a reference to reconcile, never a cherry-pick series. The audit's stated 20 generic-foundation commits are classified by **semantic outcome**, not mechanically replayed commit-by-commit; every commit maps to exactly one GF row below and the parent PR records that commit-to-row map.

The matrix is finite. `delivered` has an identified current implementation and regression; `superseded` has a named current contract that is stricter or replaces the old mechanism; `implement` is an approved H-3 change; `missing` means the source/audit cannot be mapped or evidenced and blocks H-3 completion; `not-applicable` belongs to another explicitly named stream and is not H-3 work. A row may not be silently dropped or reclassified without the listed evidence.

| ID | Generic-foundation outcome audited from the reference package | Initial classification | Required evidence / completion disposition |
|---|---|---|---|
| GF-01 | Distinguish absent, readable-empty, corrupt, and I/O-failed PackStore reads; recover before queue CAS/sequence/quota decisions. | delivered | #1106 (`73da91431`) and its PackStore durable-read tests; H-3 must prove no new primitive collapses a failed read to empty. |
| GF-02 | Surface failed retain-plus-durable-enqueue persistence rather than returning success. | delivered | #1091 (`4aba79b60`) and the current durable-outcome provider path; H-3 may consume, never revert, its non-`void` failure result. |
| GF-03 | Typed PackStore mutation results and error fidelity for read/write/compare/commit operations used by extensions. | implement | Reconcile the reference semantics into the exact `PackStore` contract; map every error to a stable host result, retain cause for diagnostics, and add focused core/integration tests. |
| GF-04 | Mutation fences: validate/preflight before mutation and record a durable commit outcome so failed or racing writes never look committed. | implement | Add only reusable host-store fencing; tests cover preflight failure, write failure, concurrent fence conflict, and recovery without a false success. |
| GF-05 | A single bounded deadline and `AbortSignal` cross the host → worker → extension/store/client boundary. | implement | Tests prove timeout cancellation reaches each injected boundary, late completion cannot commit, and the caller receives a bounded classified result. |
| GF-06 | Durable retry, idempotency, and lifecycle seams expose retryable/non-retryable outcomes without duplicating work after restart or repeated lifecycle delivery. | implement | Host seams are generic; tests prove restart/replay, duplicate invocation, and terminal failure. H-5 consumes them for goal outcomes but is not implemented here. |
| GF-07 | Old provider-owned scope/lifecycle context plumbing assumed by the reference package. | superseded | #1099 (`c9f230529`) is the authoritative `HookCtx.scopeContext` contract. H-3 does not change scope algorithms; H-6 alone consumes it. |
| GF-08 | Reference-package test locations and legacy harness conventions. | superseded | New/ported assertions are registered in `tests2/tests-map.json`; legacy `tests/` placement is not acceptance evidence. |
| GF-09 | Prefix-ID allocation, sweep cadence/checkpoints, and stranded-record scope privacy. | not-applicable | H-2 / Memory Completion owns these pack algorithms and their Hindsight-only tests. H-3 must not alter their algorithm or storage format. |
| GF-10 | Managed modes, supervisor/runner/endpoint injection, runtime status, panels, agent tools, and deployment assets. | not-applicable | H-4 / Runtime Core + Experience owns these consumers. H-3 may expose generic error/lifecycle seams but cannot add service modes, UI, tools, or a Hindsight branch. |
| GF-11 | An audited generic-foundation commit/outcome with no GF-01…GF-10 mapping, source path, reference assertion, and current-main comparison. | missing | This row must be empty before H-3 is accepted. Until then, record the commit SHA, path/behavior, chosen classification, and proving `tests2` test in the parent PR. |

H-3 may change only these host/extension contracts, with the listed ownership boundaries:

| Area | Exact files/contracts H-3 may change | Boundary |
|---|---|---|
| Pack-store primitives and fidelity | `src/server/extension-host/pack-store.ts`, `src/server/extension-host/server-host-api.ts`, and their exported `PackStore`/store-result/error contracts | Preserve #1106 read states and #1091 durable outcome semantics; no Hindsight-specific queue logic. |
| Worker mutation boundary | `src/server/extension-host/{module-host-bootstrap,module-host-worker,action-dispatcher,route-dispatcher}.ts` and the serialized host API request/result contract | Carry typed mutation/fence outcomes; no route/tool-specific policy or private permission path. |
| Deadlines and cancellation | `src/server/agent/lifecycle-hub.ts`, `src/server/agent/provider-bridge-extension.ts`, `src/server/extension-host/module-host-worker.ts`, and `HookCtx`/host-call deadline-plus-abort contract | Propagate a host-owned remaining deadline and abort signal; do not change H-2 sweep scheduling or create a service supervisor. |
| Durable retry/idempotency/lifecycle seams | `src/server/agent/lifecycle-hub.ts`, `src/server/agent/pack-contributions.ts`, `src/server/extension-host/pack-contribution-registry.ts`, and generic provider invocation result/lifecycle delivery contracts | Expose reusable result/idempotency seams only. H-5 remains sole owner of `goalCompleted` content/key algorithm. |
| Tests and mapping | `tests2/core/{pack-store,extension-host,lifecycle-hub}-*.test.ts`, `tests2/integration/{extension-host,lifecycle-hub}-*.test.ts`, and `tests2/tests-map.json` | Port assertions as v2 coverage. No production Hindsight pack, runtime, screen, tool, or EP-6/EP-7 file is in H-3 scope. |

H-3 acceptance requires a parent-PR provenance appendix containing: the 20 generic commit SHAs mapped once each to GF-01…GF-10 (or GF-11 until resolved); current-main path/contract comparison; the cited reference assertion; classification and rationale; resulting current commit(s); and exact `tests2` test IDs. `missing` and `implement` are allowed only while the subgoal is in progress; at merge they must be respectively empty and reclassified as `delivered` or `superseded`. The parent PR also records that #1091/#1106 were preserved and why no H-2/H-4/EP-6/EP-7 code was pulled into this subgoal.

### H-2 — audited hardening package

Treat the unlanded audited package as a behavioral reference, not a patch. Reimplement its three remaining independent outcomes in the current pack shape:

| Outcome | Exact production change | Durable/control flow | Regression coverage |
|---|---|---|---|
| Prefix-ID race | `market-packs/hindsight/src/shared.ts` exports one collision-safe `memoryDocumentId()`/prefix allocator; `provider.ts`, routes, and tools call it instead of independently truncating/deriving ids. IDs include a stable scope namespace plus collision-resistant suffix; a prefix lookup never aliases a different full id. | Resolve/validate scoped identity before retain/update/invalidate; a competing same-prefix operation returns an explicit conflict/ambiguous outcome and does not overwrite the other memory. | `tests2/core/hindsight-durability-concurrency.test.ts`: concurrent same-prefix retains/updates/invalidation, deterministic collisions, no cross-scope overwrite. |
| Sweep cadence/deadline | `provider.ts` owns one injected-clock cadence gate for pending/stranded retry sweeps; `shared.ts` persists only the successful sweep checkpoint. Every remote/store call shares the lifecycle hook's remaining deadline and abort signal. | A sweep is skipped until due, never overlaps an in-flight sweep, and stops at the hook deadline. It advances its checkpoint only after the corresponding durable mutation; timeout/failure leaves recoverable work for the next due sweep. | `tests2/core/hindsight-beforecompact-deadline.test.ts` and `tests2/core/hindsight-retention-lifecycle.test.ts`: due/not-due, exact-once overlap suppression, deadline cancellation, checkpoint-after-commit, later recovery. |
| Stranded-scope privacy | `shared.ts` centralizes `scopeTags`/`scopeFilter`; `provider.ts`, routes, and tools use it for retain, recall, reflect, retry replay, and invalidate. | A queued/stranded record carries its original project/goal/session scope and target bank/namespace. Replay/invalidation never uses the current caller's scope. Missing authoritative `scopeContext` narrows to the existing project-safe default; it never broadens to all. | `tests2/core/hindsight-stranded-privacy.test.ts`: project/goal/session changes, queue replay after config change, no other-project read/write/delete, and sanitized diagnostics. |

The functions take injected clock/client/store seams already used by the direct Hindsight provider tests. They make no service-runtime calls and retain the #1091/#1106 durable outcome behavior.

### H-5 — goalCompleted outcome retention

`src/server/agent/lifecycle-hub.ts`, `src/server/agent/pack-contributions.ts`, and the Hindsight provider declaration extend the landed goal-completion event to the active provider set; `TeamManager`/the current goal-completion dispatcher remains the sole event source. Add `goalCompleted` to the validated provider hook union and pass only the existing safe event fields: `projectId`, `goalId`, completed goal title/status, `headSha`, `completedAt`, and the #1099 `scopeContext`. Do not create a bespoke provider method or let a route/tool forge the event.

`market-packs/hindsight/src/provider.ts::goalCompleted` builds one bounded outcome document (goal identity, completion state, head SHA, task/gate summary if already present in the event), tags it through `scopeTags`, and calls the same retain-with-durable-queue path as ordinary retention. Its idempotency key is `goal-completed:<projectId>:<goalId>:<headSha>` in the pack store. An in-memory single-flight set prevents duplicate concurrent invocation; the durable marker is written **only** after remote retain succeeds or a queue entry is confirmed durable. A failed remote retain plus failed enqueue therefore reports the existing #1091 diagnostic and writes no success marker. Repeating a delivered/queued-identical outcome is a no-op; a new head SHA creates a new outcome.

Add `tests2/core/hindsight-goalcompleted.test.ts` for event wiring, content/tags, duplicate concurrent and restart invocation, remote failure + durable queue, compound failure/no marker, and scope privacy; add `tests2/integration/hindsight-goalcompleted.test.ts` for the actual lifecycle hub → ModuleHost → pack-store route. The browse/detail UI and `hindsight_retain_outcome` tool below show the stored/remote outcome without exposing arbitrary cross-goal data.

### H-6 — scoped recall using #1099

`market-packs/hindsight/src/shared.ts` exports a pure `resolveRecallScope(cfg, ctx.scopeContext, requestedScope?)` with the only supported values `project`, `goal`, `session`, and `all`. The provider's configured default remains `project`; an explicit route/tool scope can only **narrow** it unless EP-6 grants the separately declared cross-project `memory.read.all` capability. The resolver derives tags from #1099's frozen `scopeContext` (`project.id`, goal ancestry/leaf, and current session id), not caller-provided ids. It returns an exact Hindsight tag filter and a stable scope descriptor used for diagnostic/audit text.

- `project` returns this project's tagged records plus documented global records, never another project's tagged record.
- `goal` restricts to the authoritative goal/ancestry tags and global records allowed by the configured policy; absent goal context fails closed to `project`, never `all`.
- `session` restricts to this session plus the policy-permitted project/global context; absent session fails closed to `project`.
- `all` is available only when the effective settings and EP-6 grant permit it; otherwise route/tool/provider returns `MEMORY_SCOPE_DENIED` with no remote call.

Apply this resolver in `provider.ts` recall/reflect and retry paths, `routes.ts` recall/reflect/detail/invalidate handlers, and `tools/hindsight/extension.ts`. H-2's retained original scope tags are used for every queued replay. Add `tests2/core/hindsight-scope-recall.test.ts` for all scope inputs, broken/absent context, goal ancestry, denied all, and no cross-project query; add the same real worker assertion in `tests2/integration/hindsight-external.test.ts`.

### Native memory screens and explicit agent tools

Import/reconcile #820's panel/tool source only after EP-6/EP-7 is available:

- `market-packs/hindsight/panels/hindsight-memory.yaml` and `entrypoints/hindsight-session-menu.yaml` expose one native **Memory** panel through the normal pack panel/session-menu registry. `src/panel.js` renders status, browse/search results, selected-memory detail/history, reflect result, and destructive invalidate confirmation. It queries only pack routes; it reads generic `ServiceRuntimeStatus` and EP-7 settings state rather than starting Docker or storing secrets/client-side.
- Extend `market-packs/hindsight/src/routes.ts` and its route allowlist with typed `memories`, `memory`, `invalidate`, `reflect`, and `outcome` handlers. `memories` accepts a bounded query and resolved permitted scope; `memory` requires an id returned by that result; `invalidate` requires a matching scoped id and a server-side confirmation token; `reflect` uses the resolved scope; `outcome` reads the H-5 marker/result. Every handler uses `resolveRecallScope`, `isActive`, the generic runtime endpoint, and a bounded client timeout. Down/unhealthy state returns `{ configured, runtime: ServiceRuntimeContext, memories: [] }` (or a typed non-mutating error) without hanging.
- Restore `market-packs/hindsight/tools/hindsight/{extension.ts,hindsight_recall.yaml,hindsight_retain.yaml,hindsight_reflect.yaml,hindsight_invalidate.yaml,hindsight_retain_outcome.yaml}`. The extension is a thin schema/route adapter; it does not create an HTTP client or service manager. EP-6 grants `memory.read`, `memory.write`, `memory.reflect`, and `memory.invalidate`; absence removes or denies the corresponding agent tool through the central grant/tool activation path. `memory.read.all` controls the H-6 broad scope exception. EP-7 supplies all configuration/secrets; tool results contain redacted runtime/diagnostic state only.

The panel's destructive button is keyboard accessible, has an explicit confirmation dialog, disables while the request is outstanding, invalidates its selected row only after a successful response, and restores normal focus. Pack update/uninstall/disable invalidates panel and tool availability through the existing registry cache path; no Hindsight-specific browser state store is added.

Required browser journeys are `tests2/browser/e2e/hindsight-memory.spec.ts` and `tests2/browser/e2e/hindsight-agent-tools.spec.ts`: configure without echoing a key; grant/deny each tool; browse/search → select detail/history → scoped reflect → invalidate confirmation; denied/broken/down state; settings/mode reload; session reload with a selected panel; panel close/uninstall cleanup; and keyboard/focus assertions. The tools journey drives a real agent-facing tool invocation and verifies grant denial, scoped results, outcome retention, reload, and no secret in transcript/tool output.

## 8. LangFlow authoring recipe

A LangFlow author does exactly this:

1. Add `runtimes/langflow.yaml` and list `langflow` in `contents.runtimes`.
2. Declare LangFlow's HTTP service port and a real readiness endpoint, bounded probe timings, `local` argv plus its normal `portEnv`, digest-pinned Docker image, and a contained Compose file/service. The local runner supplies that normal port variable; Docker/Compose use loopback dynamic publication. No LangFlow code emits or understands Bobbit-specific readiness messages.
3. Declare every setting/secret through the provider or pack EP-7 schema, and map each process environment variable via `environment`. Add `storage` only if LangFlow must persist data. Never read raw environment/config or construct a Docker command in the pack module.
4. Set a provider's `runtime: langflow`; provider/routes/tools read only `ctx.runtime.endpoint`. If absent/not ready, return their documented graceful no-service behavior.
5. Request `service.manage` in the manifest capability metadata. EP-6 displays/audits the grant; the generic supervisor only checks the resolved grant before control actions.
6. Add the same runner-contract fixtures and mode matrix described below. No new server integration, settings screen, permission system, endpoint injection, port logic, or lifecycle code is authored.

If a service cannot bind its ordinary declared `local.portEnv` or expose the declared HTTP readiness endpoint, it is not compatible with local mode and must declare no local mode; it does not receive a bespoke exception. Docker and Compose support alone is insufficient for this goal's mode-independence promise.

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
| `src/server/server.ts` | Construct supervisor after state/settings/grant dependencies; implement authenticated control/status/log/purge routes and lifecycle resolver. Avoid a Hindsight-specific plan switch. |
| `market-packs/hindsight/{pack.yaml,providers/memory.yaml,runtimes/hindsight.yaml,runtime/compose.yaml,src/shared.ts,src/provider.ts,src/routes.ts}` | Declare/consume runtime, add mode-independent endpoint selection and config redaction; implement H-2 collision/cadence/privacy, H-5 outcome retention, H-6 #1099 scope filters, typed memory/detail/invalidate/reflect/outcome routes; regenerate `lib/*.mjs` via existing pack build. |
| `market-packs/hindsight/{tools/hindsight/extension.ts,tools/hindsight/hindsight_{recall,retain,reflect,invalidate,retain_outcome}.yaml,panels/hindsight-memory.yaml,entrypoints/hindsight-session-menu.yaml,src/panel.js}` | Reconcile #820's explicit tools and native panel with EP-6 grants, EP-7 settings, generic runtime status, and the pack route API; build panel artifacts through the existing pack build. |
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
| `tests2/core/{hindsight-durability-concurrency,hindsight-beforecompact-deadline,hindsight-retention-lifecycle,hindsight-stranded-privacy}.test.ts` | H-2 prefix collision/no-alias, sweep cadence/overlap/deadline/checkpoint, and stranded queued privacy coverage, preserving #1091/#1106 durable outcomes. |
| `tests2/core/{hindsight-goalcompleted,hindsight-scope-recall}.test.ts` | H-5 exactly-once completed-outcome marker/queue semantics and H-6 #1099-derived project/goal/session/all scope authorization, including missing-context fail-closed behavior. |
| `tests2/integration/{service-runtime-api,hindsight-goalcompleted}.test.ts` | Gateway with injected supervisor and EP-6/EP-7 fixtures: grant denial, write-only secret setting, stale revision, start/status/log/stop/purge HTTP mapping, lifecycle hub → worker goal outcome, no endpoint while down, and a session remains responsive when the runtime is unhealthy. |
| `tests2/browser/e2e/service-runtime-settings.spec.ts` | EP-7 settings → EP-6 consent/grant → start status/diagnostics → reload → stop; inaccessible/down service is displayed with an actionable state and the normal session UI continues. Includes keyboard/accessibility and cleanup. |
| `tests2/browser/e2e/{hindsight-service-runtime,hindsight-memory,hindsight-agent-tools}.spec.ts` | Mode-independent Hindsight start/retain/recall; then configure-without-key-echo, memory browse/search/detail/history, scoped reflect, invalidate confirmation, each tool grant/deny, completed outcome readback, reload, keyboard focus, panel close, uninstall cleanup, and down/unhealthy no-hang behavior. |
| `tests2/_e2e/service-runtime-docker.test.ts` (registered as `vitest-e2e`) | The automated Docker proof. Build a tiny purpose-built HTTP fixture image and Compose fixture locally (no external pull), start the **same unmodified fixture service** in local/Docker/Compose through real adapters, assert identical `/health`, retain/recall fixture behavior, dynamic loopback ports, graceful stop, and data persistence. Force one candidate-port bind conflict to prove the bounded local retry; a deliberately down health endpoint must reach `degraded` within `startupTimeoutMs` and a session request completes within its ordinary provider timeout. Docker absence is reported by the E2E coordinator as unavailable rather than silently skipping the contract. |

The existing legacy #820 unit/API/manual tests are an assertion inventory, not acceptance evidence. Translate their useful intent into the above fixtures and reject stale assertions such as fake web containers, fixed/probed ports, manual-only Docker proof, and Hindsight-specific server switches. `npm run check`, `npm run test:unit`, `npm run test:browser`, and `npm run test:e2e` are required before integration; the Docker matrix belongs in E2E, not `test:manual`.

## 12. #820 absorption/reconciliation checklist

1. On the Hindsight parent, cherry-pick only the exact ordered #820 SHA list in §2, using `-m 1` only for its merge commits. Do not substitute a revision range or include an `origin/master` merge; do not skip the mandatory provenance import merely because a semantic is later replaced. Record empty/redundant picks rather than silently omitting them.
2. Rebase the imported parent on current `origin/main`, resolve each conflict in favor of current durable-read behavior (#1091/#1106) and landed scope context (#1099), then classify every imported runtime change: retained, refactored, or individually superseded with a reason.
3. Refactor retained mechanics into the generic contract: safe descriptor/Compose containment, argv-only calls, service-scoped inspection/control, no-auto-start, HTTP readiness, stable identity, env-file permissions, and explicit teardown/data survival. Replace #820's raw fields, persistent probe-allocated ports, Compose-only abstraction, Hindsight branch in `server.ts`, manual-only Docker acceptance, and best-effort state writes.
4. Reconcile #820 panel/tools and memory-v2 changes only after EP-6/EP-7: make them consumers of `ServiceRuntimeStatus`, typed settings, and resolved grants; retain/port their behavioral tests to `tests2`, not their old private setup/permission surfaces.
5. In the parent PR body, list each imported #820 SHA and any dropped-empty result, conflicts and resolution, retained/refactored/superseded behavior, EP-6/EP-7 SHA strategy, direct dependency rationale, and end with the required Bobbit footer.
