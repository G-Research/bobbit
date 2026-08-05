# Service-extension runtime

**Status:** implementation design for Hindsight and the reusable external-service contract.

## 1. Decision, boundaries, and acceptance criteria

A pack may declare a **runtime**: an operator-consented, gateway-supervised service that its provider/routes/tools consume only through a resolved endpoint. Runtime selection is host-owned. Pack code receives the same `ctx.runtime.endpoint` in all modes and never invokes Docker, Compose, a child process, port allocation, or restart logic.

This is deliberately a service contract, not a Hindsight-specific Docker integration. A second author can implement LangFlow by authoring one descriptor, its container/Compose assets, provider configuration, and endpoint consumer; no new supervisor, lifecycle API, or deployment-mode code is required.

### Scope ledger

| Must ship | Allowed to change | Deferred / prohibited |
|---|---|---|
| Schema-2 runtime descriptor and loader; local-process, Docker-container, and Docker-Compose runners; one lifecycle state machine; config/secrets/storage/diagnostics contracts; Hindsight descriptor and wiring; mode-independent tests including unavailable/unhealthy behavior. | Add direct runtime dependencies; new server runtime modules and REST routes; pack manifest/provider fields; generated pack artifacts; extensions to EP-6/EP-7 consumption points after their work lands. | A LangFlow pack; a private settings or permission UI; arbitrary remote-service management; Kubernetes; automatic install/enable start; host-port choice in user settings; durable job queues; applying the old #820 implementation or its legacy tests unchanged. |

Acceptance means all of the following are true.

1. The same Hindsight client operation (`health`, retain, recall) is reachable through `local`, `docker`, and `compose` modes and produces the same response contract; client/provider code does not branch on the mode.
2. Start returns only after the declared HTTP readiness condition passes. A down, refused, crashed, or unhealthy service returns a bounded diagnostic and leaves the calling session usable; no hook, route, or tool waits indefinitely or starts a service implicitly.
3. An explicit start is required once. The persisted desired state then permits bounded crash recovery and gateway-restart reconciliation; install, discovery, configuration reads, status, and provider invocation never start a service.
4. Config and secret provenance is explicit, secrets never appear in settings reads, status, log events, command arguments, or images, and rendered secret files are owner-read/write only.
5. Host ports are loopback-only, dynamically assigned, rediscovered after start, and never reallocated by a read path. Service data survives restart/disable/update; destructive data removal requires an explicit purge of a declared, contained data directory.
6. EP-6 owns authorization/grants and EP-7 owns settings rendering/storage. This feature consumes their public contracts; it does not recreate them.

## 2. Comparative design

### Option A — port #820's Compose supervisor

#820 has useful reference work: a `runtimes/*.yaml` contribution, strict path checks, `execFile` Compose calls, HTTP readiness, stateful ports/secrets, an API seam, and extensive legacy tests. It is not suitable as the implementation baseline:

- it supports Docker Compose only; the goal requires local process, Docker container, and Compose with a mode-invariant extension contract;
- `probeFreePort()` closes the probe socket before Docker binds it, leaving a TOCTOU conflict window and persisting a port that can churn;
- its raw-manifest `startPolicy` and healthcheck fields bypass the typed manifest;
- local state writes are best effort, including data needed to address a live service;
- it contains Hindsight/deployment special cases in `server.ts` (`resolveRuntimeStartPlan`, capability cards, mode names) rather than a generic endpoint/runner abstraction;
- it does not define a service crash policy, lifecycle state machine, or a real automated Docker E2E contract; its real-Docker test is manual and skips.

Use #820 only as a semantic reference: port valuable assertions after translating them to `tests2`, particularly containment, no-auto-start, service-scoped Compose commands, HTTP readiness, redaction, teardown, and data survival. Do not cherry-pick it; it diverged from `7459c10b` and its 104-file/26k-line diff also predates EP-6/EP-7.

### Option B — one generic supervisor with three adapters (chosen)

Add a small, typed runtime nucleus that owns declared desired state and delegates launch/inspection/stop to a runner selected by a descriptor mode. All adapters return one `StartedService` (`endpoint`, runner identity, service rows); the supervisor applies identical readiness, restart, diagnostics, storage, and endpoint exposure rules.

This has one new state owner (`ServiceRuntimeStore`), one public runtime context, one lifecycle state machine, and one adapter interface. It adds adapters because their resource ownership is inherently different: a local child needs a PID/tree and ready-line parser, a Docker container needs container identity/port inspection, and Compose needs project/service identity and `compose port`. Forcing them through a single list of command strings would obscure validation, leaks, and stop semantics.

### Option C — make each pack implement a supervisor/provider branch

Rejected. It duplicates permission, redaction, readiness, ports, teardown, diagnostics, and test behavior for every service; LangFlow would require a second bespoke integration. It fails the stated generalisation deliverable.

### Existing composition and dependency choice

Use the existing schema-2 `contents.runtimes` key, safe-basename validation (`pack-manifest.ts::isSafeBasename`), contained contribution loading pattern (`pack-contributions.ts` plus `path-guard.ts`), pack identity, `SecretsStore`, `LifecycleHub` provider context, and route/module isolation. Existing protecting tests include `tests2/core/extension-host-module-isolation.test.ts`, `tests2/core/hindsight-provider.test.ts`, `tests2/integration/hindsight-external.test.ts`, and `tests2/core/guard-v2.test.ts`.

Add **direct** dependencies `execa` (local process and Compose CLI, argv-only/no shell, cancellation/output handling) and `dockerode` (Docker daemon lifecycle/inspect/port binding). Do not depend on the currently transitive `execa@1`, and do not hand-roll child-process or Docker HTTP clients. Docker Compose has no maintained Docker Engine API equivalent; invoke the user-installed Compose plugin through `execa("docker", ["compose", ...])` with validated argv. Native `fetch` plus `AbortController` is the small, standards-based bounded HTTP probe; adding a polling library is not justified. Dynamic port assignment (`0`) is selected instead of a `get-port`-style probe because probe-then-close cannot reserve a port for a later process/container.

The remaining policy loop (desired state, terminal reasons, backoff, and reconciliation) is intentionally narrow host orchestration, not a reimplementation of process supervision.

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
  /** Listener in the local process/container. Local runner reports its actual port. */
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

export interface LocalLaunch { command: string; args: string[]; cwd?: string; }
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

Validation rejects unknown keys, duplicate env names, unsafe ids/images/service names, non-array argv, shell metacharacter-bearing Compose project template values, `..`/absolute/symlink-escaping `file` and `local.cwd` paths, secret strings in `value`, an unreferenced `endpointPort`, malformed probe paths, and storage targets that are not absolute container paths. `environment` is a map, not string interpolation: an authored descriptor can only source a literal, EP-7 non-secret setting, EP-7 write-only secret, generated secret, or the runtime endpoint port. No descriptor can copy arbitrary process environment values.

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
| Local | `execa(command, args, { cwd, env, reject:false })`; runner supplies `SERVICE_PORT=0`. A service must emit exactly one JSON stdout ready line `{"bobbitService":"ready","port":49152}` after its listener is bound. The runner validates 1..65535, forms `http://127.0.0.1:<port>`, then probes. | Kernel assigns the port while the service owns its listener; no probe-close race. Missing/malformed ready event or early exit is degraded. |
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
- `local` command/package entry suitable for the audited upstream Hindsight service, emitting the required ready event;
- digest-pinned `ghcr.io/vectorize-io/hindsight` Docker image and a Compose stack with only the verified API plus `pgvector/pgvector`; `SERVICE_PORT` is dynamically published on loopback;
- a generated Postgres password, write-only Hindsight LLM key, and the declared bind storage path;
- `lifecycle.restart: { policy: on-failure, maxAttempts: 3, windowMs: 300000, initialBackoffMs: 1000, maxBackoffMs: 30000 }`.

The Hindsight compose template contains `restart: "no"`; Bobbit owns recovery so Docker and the supervisor cannot race or hide a crash. Existing Hindsight memory semantics (bank/tags, durable-read hardening, queue behavior, scoped recall, agent tools, panel) remain separate implementation work and must consume this endpoint contract rather than reintroducing runtime management.

## 7. LangFlow authoring recipe

A LangFlow author does exactly this:

1. Add `runtimes/langflow.yaml` and list `langflow` in `contents.runtimes`.
2. Declare LangFlow's HTTP service port and a real readiness endpoint, bounded probe timings, `local` argv, digest-pinned Docker image, and a contained Compose file/service. Use `SERVICE_PORT=0` locally and loopback dynamic publication in Docker/Compose.
3. Declare every setting/secret through the provider or pack EP-7 schema, and map each process environment variable via `environment`. Add `storage` only if LangFlow must persist data. Never read raw environment/config or construct a Docker command in the pack module.
4. Set a provider's `runtime: langflow`; provider/routes/tools read only `ctx.runtime.endpoint`. If absent/not ready, return their documented graceful no-service behavior.
5. Request `service.manage` in the manifest capability metadata. EP-6 displays/audits the grant; the generic supervisor only checks the resolved grant before control actions.
6. Add the same runner-contract fixtures and mode matrix described below. No new server integration, settings screen, permission system, endpoint injection, port logic, or lifecycle code is authored.

If a service cannot emit the local ready JSON event or cannot bind a supplied/dynamic port, it is not compatible with local mode and must declare no local mode; it does not receive a bespoke exception. Docker and Compose support alone is insufficient for this goal's mode-independence promise.

## 8. File-level implementation plan and control flow

| File | Change |
|---|---|
| `src/server/agent/pack-types.ts`, `pack-manifest.ts` | Retain/strictly document schema-2 `contents.runtimes`; reject duplicate safe basenames. |
| `src/server/agent/pack-contributions.ts` | Add `RuntimeContribution`, `loadRuntimes`, deep path-safe file anchoring, and normalize provider `runtime`. |
| `src/server/extension-host/pack-contribution-registry.ts` | Add `getRuntime`/active runtime listing. Activation filtering and EP-6 grants remain centralized here; raw descriptor is never exposed to a worker. |
| `src/server/service-runtime/service-manifest.ts` | Exact schema/types, strict validator, contained path resolution, endpoint/environment/storage checks. |
| `src/server/service-runtime/service-runners.ts` | `ServiceRunner` interface plus Local/Docker/Compose adapters. Uses `execa`/`dockerode`; each adapter returns the shared `StartedService` and scopes operations by identity. |
| `src/server/service-runtime/service-runtime-store.ts` | Versioned atomic state, `0600` env/log files, generated-secret namespacing, server identity, recovery record reads. Failed durable writes stop control operations rather than claiming success. |
| `src/server/service-runtime/service-supervisor.ts` | State machine, start dedupe, readiness/periodic health, restart/backoff, graceful stop, startup reconciliation, redacted diagnostics, and injectable clock/probe/runners/store seams. |
| `src/server/service-runtime/index.ts` | Narrow public exports for server wiring/tests. |
| `src/server/agent/lifecycle-hub.ts` | Inject the read-only `ServiceRuntimeContext` resolver before module invocation. Resolver only reads status; never starts. |
| `src/server/server.ts` | Construct supervisor after state/settings/grant dependencies; implement authenticated control/status/log/purge routes and lifecycle resolver. Avoid a Hindsight-specific plan switch. |
| `market-packs/hindsight/{pack.yaml,providers/memory.yaml,runtimes/hindsight.yaml,runtime/compose.yaml,src/shared.ts,src/provider.ts,src/routes.ts}` | Declare/consume runtime, add mode-independent endpoint selection and config redaction; regenerate `lib/*.mjs` via existing pack build. |
| `package.json`, lockfile | Add direct `execa`, `dockerode`, and types needed by Dockerode. |
| `tests2/tests-map.json` | Register every new v2 test and affected-reader edges. |

**Start flow:** authenticated user action → EP-6 grant check → EP-7 resolved/revision-checked config → registry descriptor → strict parse → atomically persist `desired:running/starting` → resolve in-memory secrets/storage → selected runner start → discover loopback endpoint → bounded probe → atomically persist ready record → lifecycle resolver injects endpoint → provider/client uses it.

**Failure flow:** validation/grant/settings fault → `blocked`; dependency missing → `unavailable`; runner exit/probe fault → redacted diagnostic + `degraded`; optional bounded recovery; provider observes absent endpoint and returns no-op/queue behavior. No error path runs a fallback mode or dials an old endpoint.

**Stop/update flow:** disable/uninstall/purge sets desired stopped before runner operation → graceful scoped teardown → clear endpoint → preserve or explicitly purge data according to verb. Pack update never owns/moves service state/storage; a later reconciliation reads the latest descriptor and either retains the known-running service if compatible or marks a manifest incompatibility degraded.

## 9. EP-6/EP-7 dependency plan

This goal is blocked on the relevant extension-platform slices. **Preferred integration:** wait for EP-6 and EP-7 to merge to their parent integration branch, then rebase this branch and implement against their exported resolver/settings contracts. The parent PR records the exact parent SHA(s) used.

If schedule requires it, cherry-pick only the additive, reviewed EP-6 grant and EP-7 settings commits onto the Hindsight parent branch, recording commit SHAs and conflicts in the parent PR body. Do not cherry-pick #820 as a shortcut. If the needed exported interface is absent from EP-6/EP-7, record it as a blocking finding and request an additive platform slice; do not create a parallel grants store, private settings form, or secret store.

The runtime consumes, but does not define:

- EP-6 `ExtensionGrantResolver.isGranted(projectId, packId, "service.manage")` and its audit/revoke semantics. Revoke takes effect on the next control action and immediately stops scheduled restart; it does not silently kill a ready service without an explicit EP-6 policy decision.
- EP-7 resolved typed values/secrets, revision token, schema validation, scoped configuration, and write-only redaction. Settings mutations invalidate the registry/runtime resolver cache; the next explicit restart applies them.

## 10. Test plan (tests2 only)

Every new test is registered in `tests2/tests-map.json`; fixtures live below the test run root and use no ambient credential, port, Docker resource, or user data. Qualification uses the repository wrappers with `BOBBIT_V2_RETRY_FREE=1`; tests synchronize on readiness/exit events, not sleeps.

| Tier/file family | Seams and assertions |
|---|---|
| `tests2/core/service-runtime-manifest.test.ts` | Descriptor strictness, duplicate ids, contained paths/symlink escape rejection, env provenance, secret-in-literal rejection, valid Hindsight/LangFlow-shaped fixture parsing. |
| `tests2/core/service-runtime-supervisor.test.ts` | Fake runner/probe/clock/store: all state transitions, same-start dedupe/conflicting-mode rejection, bounded readiness, no-auto-start reads, recovery cap/backoff, stop cancellation, restart reconciliation, durable-write failure, redaction, and endpoint absence in degraded/unavailable states. |
| `tests2/core/service-runtime-runners.test.ts` | Injected `execa`/Dockerode/Compose seams: argv only, loopback dynamic ports, local ready-line validation, correct container/Compose identity and service scoping, graceful escalation, and no port allocation/read mutation. No daemon/process is launched. |
| `tests2/core/hindsight-service-runtime.test.ts` | Hindsight descriptor maps all three modes to the same provider client config; external remains dormant/no Docker; provider never calls supervisor; config GET has `*Set` booleans only. |
| `tests2/integration/service-runtime-api.test.ts` | Gateway with injected supervisor and EP-6/EP-7 fixtures: grant denial, write-only secret setting, stale revision, start/status/log/stop/purge HTTP mapping, no endpoint while down, and a session remains responsive when the runtime is unhealthy. |
| `tests2/browser/e2e/service-runtime-settings.spec.ts` | EP-7 settings → EP-6 consent/grant → start status/diagnostics → reload → stop; inaccessible/down service is displayed with an actionable state and the normal session UI continues. Includes keyboard/accessibility and cleanup. |
| `tests2/browser/e2e/hindsight-service-runtime.spec.ts` | User configures Hindsight without echoed key, starts each available mode through the same UI, invokes retain/recall through a real session, reloads, and verifies stop/data-preservation copy. |
| `tests2/_e2e/service-runtime-docker.test.ts` (registered as `vitest-e2e`) | The automated Docker proof. Build a tiny purpose-built HTTP fixture image and Compose fixture locally (no external pull), start the **same fixture service** in local/Docker/Compose through real adapters, assert identical `/health`, retain/recall fixture behavior, dynamic loopback ports, graceful stop, and data persistence. A deliberately down health endpoint must reach `degraded` within `startupTimeoutMs` and a session request completes within its ordinary provider timeout. Docker absence is reported by the E2E coordinator as unavailable rather than silently skipping the contract. |

The existing legacy #820 unit/API/manual tests are an assertion inventory, not acceptance evidence. Translate their useful intent into the above fixtures and reject stale assertions such as fake web containers, fixed/probed ports, manual-only Docker proof, and Hindsight-specific server switches. `npm run check`, `npm run test:unit`, `npm run test:browser`, and `npm run test:e2e` are required before integration; the Docker matrix belongs in E2E, not `test:manual`.

## 11. #820 absorption/reconciliation checklist

1. Diff #820 from its merge base and classify every runtime change: reusable assertion, reusable isolated helper idea, superseded/unsafe implementation, or unrelated Hindsight UI/tool work.
2. Reimplement only the generic pieces selected above: safe descriptor/Compose containment, argv-only calls, service-scoped inspection/control, no-auto-start, HTTP readiness, stable identity, env-file permissions, and explicit teardown/data survival semantics.
3. Replace #820's runtime-specific raw fields, port probing/persistence, Compose-only abstraction, `server.ts` Hindsight deployment plan, manual Docker acceptance, and best-effort state writes with this contract.
4. Integrate #820's held Hindsight panel/tools only after EP-6/EP-7 and only by making them consumers of `ServiceRuntimeStatus` and the typed settings APIs; do not merge their old setup/permission surfaces.
5. In the parent PR body, list the #820 commits/behaviors absorbed and rejected, the EP-6/EP-7 SHA strategy, direct dependency rationale, and end with the required Bobbit footer.
