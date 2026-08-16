# Service runtimes

A service runtime lets a schema-2 pack describe a local HTTP service without
making pack code responsible for processes, Docker, ports, secrets, or recovery.
The host owns lifecycle; a provider receives only a mode-free endpoint context.
This keeps the same provider/client protocol usable for an externally hosted
service and for the `local`, `docker`, and `compose` adapters.

This is an authoring and host-integration reference for the generic runtime
nucleus. It documents the current contracts in `src/server/service-runtime/`.
The nucleus does not own a UI, route catalogue, grant store, or settings store;
a host integration composes it with the public EP-6 capability-grant, EP-7
extension-settings, and pack typed-route contracts described below.

## Architecture and ownership

A runtime moves through these boundaries:

```text
schema-2 pack declaration
  -> strict RuntimeContribution loader
  -> authorized explicit ServiceRuntimeSupervisor control
  -> selected ServiceRunner
  -> persisted ready endpoint
  -> read-only ServiceRuntimeContext injected into a provider
```

| Owner | Responsibility |
|---|---|
| Pack author | Descriptor, static launch assets, provider configuration schema, and graceful behavior when no endpoint is ready. |
| Contribution loader | Loads only declared descriptor files and exposes a validated `RuntimeContribution`. |
| Settings and authorization integration | Selects the runner mode, supplies a revision and declared values/secrets, canonicalizes storage, and authorizes controls. |
| `ServiceRuntimeSupervisor` | Desired state, readiness, health monitoring, bounded restart, diagnostics, and lifecycle serialization. |
| `ServiceRuntimeStore` | Atomic durable metadata, environment/log artifacts, generated secrets, and contained purge. |
| `ServiceRunner` | Starts, inspects, stops, and removes only resources it owns. |
| Provider/client | Uses a ready endpoint; it cannot start, stop, allocate, or select an adapter. |

This separation is intentional: a pack descriptor is untrusted authored input,
while lifecycle side effects and secret resolution are host-owned operations.

## Declaring a runtime

Runtime contributions are available only to schema-2 packs. Add a safe basename
to `contents.runtimes`; it loads `runtimes/<name>.yaml` (or `.yml`). The loader
never discovers arbitrary files from that directory.

```yaml
# pack.yaml
schema: 2
name: example-service
version: 1.0.0
contents:
  roles: []
  tools: []
  skills: []
  entrypoints: []
  providers: [example]
  runtimes: [example]
```

`contents.runtimes` entries must be unique safe basenames. The loader:

- requires the descriptor file to remain inside the pack's `runtimes/`
  directory, including after symlink resolution;
- parses it with `parseServiceManifest` before exposing it;
- warn-and-drops missing, malformed, or invalid descriptors so discovery does
  not expose an unsafe launch surface; and
- rejects duplicate descriptor basenames or canonical runtime ids in one pack.

The resulting `RuntimeContribution` is:

```ts
interface RuntimeContribution {
  id: string;                       // canonical lower-case descriptor id
  manifest: ServiceRuntimeManifest; // validated; never raw YAML
  listName: string;                 // contents.runtimes entry
  sourceFile: string;
  packRoot: string;
}
```

A provider links to a runtime with its normalized id:

```yaml
# providers/example.yaml
id: example
kind: generic
runtime: example-service
module: ../lib/provider.mjs
hooks: [beforePrompt]
budget: { maxTokens: 400, timeoutMs: 1500 }
```

The provider declaration grants no lifecycle capability. `LifecycleHub` calls
an injected `RuntimeContextResolver` only for providers declaring `runtime`.
Resolver errors become `{ state: "unavailable", diagnostic: { code:
"SERVICE_UNAVAILABLE" } }`, rather than failing an ordinary lifecycle hook.

## Descriptor schema

`parseServiceManifest(raw, { sourceFile, packRoot }, problems?)` accepts the
following exact shape. Every object is closed: unknown keys are rejected.

```yaml
# runtimes/example.yaml
apiVersion: 1
id: example-service
title: Example service
endpoint:
  protocol: http
  servicePort: 8080
  health:
    path: /health
    expectedStatus: 200
    requestTimeoutMs: 1000
    intervalMs: 500
    startupTimeoutMs: 30000
lifecycle:
  startPolicy: manual
  restart:
    policy: on-failure
    maxAttempts: 3
    windowMs: 30000
    initialBackoffMs: 500
    maxBackoffMs: 5000
environment:
  EXAMPLE_PORT:
    endpointPort: true
  EXAMPLE_HOST:
    value: 127.0.0.1
  EXAMPLE_DATA_DIR:
    setting: dataDir
  EXAMPLE_API_TOKEN:
    secret: apiToken
  EXAMPLE_INTERNAL_PASSWORD:
    generatedSecret: databasePassword
  EXAMPLE_LOG_LEVEL:
    value: info
storage:
  setting: dataDir
  target: /var/lib/example
  survival: preserve
modes:
  local:
    command: node
    args: [./runtime/service.mjs]
    cwd: .
    portEnv: EXAMPLE_PORT
    hostEnv: EXAMPLE_HOST
  docker:
    image: ghcr.io/example/service:1.2.3
    command: [node, service.mjs]
  compose:
    file: ../runtime/compose.yaml
    service: api
    projectName: bobbit-${packId}-${runtimeId}-${serverIdentity}
```

`src/server/service-runtime/index.ts` re-exports `ServiceRunMode`,
`ServiceRuntimeManifest`, and the validation `ServiceManifestSourceContext`. The helper types
shown below are defined in `src/server/service-runtime/service-manifest.ts`:

```ts
export type ServiceRunMode = "local" | "docker" | "compose";
export type RestartPolicy = "never" | "on-failure";

export type ServiceEnvSource =
  | { value: string }
  | { setting: string }
  | { secret: string }
  | { generatedSecret: string }
  | { endpointPort: true };

export interface ServiceRuntimeManifest {
  apiVersion: 1;
  id: string;
  title: string;
  endpoint: {
    protocol: "http" | "https";
    servicePort: number;
    health: {
      path: string;
      expectedStatus: number;
      requestTimeoutMs: number;
      intervalMs: number;
      startupTimeoutMs: number;
    };
  };
  lifecycle: {
    startPolicy: "manual";
    restart: {
      policy: RestartPolicy;
      maxAttempts: number;
      windowMs: number;
      initialBackoffMs: number;
      maxBackoffMs: number;
    };
  };
  environment: Record<string, ServiceEnvSource>;
  storage?: { setting: string; target: string; survival: "preserve" };
  modes: {
    local: { command: string; args: string[]; cwd?: string; portEnv: string; hostEnv: string };
    docker: { image: string; command?: string[] };
    compose: { file: string; service: string; projectName: string };
  };
}
```

### Endpoint and restart policy

- `endpoint.protocol` is `http` or `https`; `servicePort` is an integer from 1
  through 65535.
- `health.path` must be an absolute path without a host, query, fragment,
  backslash, or traversal. `expectedStatus` is 100 through 599.
- Health request timeout and interval are 100 through 10,000 ms. Startup
  timeout is 1,000 through 300,000 ms.
- `lifecycle.startPolicy` is exactly `manual`. A descriptor cannot opt itself
  into automatic start.
- `restart.policy` is `never` or `on-failure`; its attempt limit is 0 through
  10, its window is 1,000 through 3,600,000 ms, initial backoff is 100 through
  60,000 ms, and maximum backoff is at least that initial value and at most
  300,000 ms.

### Environment provenance

Every environment entry declares exactly one source. There is no process-env
inheritance, interpolation, or arbitrary settings lookup in a descriptor.
Exactly one entry in the whole map must be `{ endpointPort: true }`; local
`portEnv` must name that entry. Local `hostEnv` is required, must name a
distinct literal `{ value: "127.0.0.1" }` entry, and is reassigned after all
resolved settings when the child starts.

| Source | Host behavior |
|---|---|
| `value` | Fixed non-secret string from the descriptor. Likely secret names or values are rejected. |
| `setting` | A declared non-secret value from the injected settings resolver. |
| `secret` | A write-only user secret resolved only while materializing an explicit start. |
| `generatedSecret` | A generated secret held by the store's separate generated-secret owner. |
| `endpointPort` | The service port supplied to the process; it is not a user-chosen host port. |

Environment names use conventional shell-variable syntax. Setting and secret
names are constrained tokens. Keep sensitive data in `secret` or
`generatedSecret`, never in `value`, arguments, image names, or compose assets.

### Storage

`storage` is optional. When present, it declares one non-secret setting and an
absolute POSIX container target with `survival: preserve`. The settings
integration supplies a canonical `RuntimeStorageDeclaration`:

```ts
interface RuntimeStorageDeclaration {
  dataPath: string; // absolute resolved data directory
  ownedRoot: string; // absolute descriptor-owned parent
}
```

Routine stop and removal preserve declared data. Only `purge` may remove it,
after verifying an exact identity confirmation, ownership containment, and
non-symlink paths. A request cannot supply a path to delete.

### Launch modes

All three mode blocks are required so an adapter switch cannot change provider
semantics.

- `local.command` is a constrained executable token, `args` is a non-empty
  string array, and `cwd` is optional and pack-relative. `hostEnv` declares
  the upstream listener-host variable; the runner always supplies
  `127.0.0.1` after settings, so a local child cannot become a wildcard
  listener. Shell interpreter command forms such as `sh -c`, `cmd /c`, and
  PowerShell command flags are rejected.
- `docker.image` is a constrained image reference. Optional `command` is argv,
  not a command string, and has the same shell-interpreter rejection.
- `compose.file` is pack-relative; `service` is a constrained service token;
  `projectName` is a constrained literal/template and must include
  `${serverIdentity}`. The only substitutions are `${packId}`, `${runtimeId}`,
  and `${serverIdentity}`.

Both `local.cwd` and `compose.file` are resolved from the descriptor directory.
Absolute paths, traversal, and realpath/symlink escapes from the pack root are
rejected.

## Runner behavior and safety boundary

`ServiceRunner` is the common adapter interface:

```ts
interface ServiceRunner {
  readonly mode: ServiceRunMode;
  start(input: ServiceRunnerStartInput): Promise<StartedService>;
  inspect(input: ServiceRunnerInspectInput): Promise<StartedService | undefined>;
  stop(input: ServiceRunnerControlInput): Promise<void>;
  remove(input: ServiceRunnerControlInput): Promise<void>;
}

interface StartedService {
  endpoint: string;
  runnerIdentity: { kind: ServiceRunMode; id: string; composeProject?: string };
  services: Array<{ id: string; name: string }>;
}
```

`inspect` is read-only. It must not allocate a port, resolve a setting or
secret, render an environment file, or start a service.

### Local process

`LocalServiceRunner` runs `execa(command, args, { shell: false })` with a
minimal loader environment rather than inheriting the gateway environment. It
uses `get-port` to select a `127.0.0.1` port and supplies it in `local.portEnv`.
Because a port probe has a normal probe-close race, an immediate bind conflict
is detected and a new candidate is tried at most three times. Stop sends
`SIGTERM`, waits up to 10 seconds, then sends `SIGKILL` and reports a bounded
failure if the child remains alive.

### Docker container

`DockerServiceRunner` uses Docker Engine through `dockerode`. It asks Docker to
assign host port `0` on `127.0.0.1`, then discovers the actual binding through
container inspection. Resources carry stable server and service labels; later
inspection, stop, and removal require those labels to match. Docker receives
only the materialized environment and an optional declared bind mount.

### Docker Compose

`ComposeServiceRunner` invokes the Docker Compose plugin through `execa` with
validated argv and `shell: false`. Each invocation includes a contained compose
file, a validated project name, and an owner-only environment-file path. It
uses `docker compose port` and accepts only `127.0.0.1:<dynamic-port>`.

Before `up`, the runner validates the static Compose file as a deliberately
small contract. Every interpolation name must be declared in the runtime
manifest. An omitted `optional: true` secret is permitted only with one of
Compose's explicit default/alternate forms (`-`, `:-`, `+`, `:+`); nested
references in that fallback are validated too. This uses a bounded scanner:
Docker Engine has no Compose interpolation API, and the maintained YAML parser
intentionally parses YAML rather than Compose CLI substitution semantics. It permits only a `services` mapping with the supported image,
restart, environment, ports, volumes, and dependencies fields. The endpoint
service must publish exactly one dynamic loopback port; only that service may
publish a port. Compose-side restart is disabled (`restart: "no"` or `false`),
so the supervisor remains the one restart owner. Declared storage must be the
single declared setting mount. Compose inspection does not mutate; project
teardown is scoped to the declared project and does not use `-v`.

## Supervisor lifecycle

`ServiceRuntimeSupervisor` is the only generic lifecycle state machine. Host
construction injects the registry, store, adapters, authorization, settings,
and server identity:

```ts
new ServiceRuntimeSupervisor({
  registry,       // getRuntime(projectId, packId, runtimeId)
  store,
  runners: [new LocalServiceRunner(), new DockerServiceRunner(), new ComposeServiceRunner()],
  authorizer,     // authorize({ packId, runtimeId, projectId?, action })
  settings,       // resolves { mode, revision, values, storage? }
  serverIdentity,
});
```

`settings.mode` is authoritative. A requested `mode` conflicting with it fails
with `SERVICE_MODE_CONFLICT`; it is never a provider/client mode switch.

### Control operations

- `start(request)` authorizes every caller before joining a same-runtime
  in-flight operation. Concurrent compatible starts deduplicate; conflicting
  explicit modes fail.
- A start resolves the contribution and settings, persists desired `running`
  with no endpoint **before** launch effects, materializes environment/storage,
  starts the selected runner, persists its identity, waits for readiness, then
  persists the endpoint as ready.
- Readiness uses native `fetch`, a fresh `AbortController` per request, and a
  bounded `p-retry` budget derived from the descriptor's interval and startup
  timeout. A response body is not retained.
- `stop(request)` cancels restart/health work and durably writes desired
  `stopped` with no endpoint before graceful teardown. The runner identity is
  retained until teardown succeeds, allowing safe retry after a failure.
- `purge({ ..., confirmation })` authorizes, requires an exact `{ packId,
  runtimeId }` confirmation, stops/removes owned resources, deletes runtime
  artifacts, removes declared contained storage, and removes declared generated
  secrets. User-provided secrets are never removed.

`reconcile()` restarts only durable desired-running **local** services because a
child process cannot survive a gateway restart. It only inspects persisted
Docker and Compose identities, which may have survived. Discovery, status,
context, diagnostics, and provider dispatch do not reconcile or start a
runtime.

### States and diagnostics

`ServiceRuntimeContext` is deliberately the entire consumer contract:

```ts
interface ServiceRuntimeContext {
  endpoint?: string;
  state: "stopped" | "starting" | "ready" | "degraded" | "blocked" | "unavailable";
  diagnostic?: { code: string; retryAt?: string };
}
```

`endpoint` appears only in `ready`. The public status projection adds identity,
desired state, and the selected adapter without exposing settings or secrets:

```ts
interface ServiceRuntimeStatus extends ServiceRuntimeContext {
  identity: { packId: string; runtimeId: string };
  desired: "stopped" | "running";
  mode?: "external" | "local" | "docker" | "compose";
}
```

`external` is a ready/not-ready endpoint configuration, not a generic runner
mode and is never accepted by a generic control request. `status()` loads
persisted metadata and may inspect an already-owned resource, but never
resolves secrets, allocates a port, starts a runner, or writes state. Its
failure categories are stable and non-verbatim:

| State | Meaning |
|---|---|
| `stopped` | No desired running record exists, or desired state is stopped. |
| `starting` | Desired running has not yet gained a durable ready endpoint. |
| `ready` | The persisted ready endpoint and inspected owned resource agree. |
| `blocked` | Authorization, manifest, setting, secret, or mode precondition cannot be satisfied. |
| `unavailable` | Store or Docker/adapter inspection is unavailable. |
| `degraded` | A runner, port, health, stop, or observed-down failure occurred. |

For `on-failure`, restarts use exponential delay bounded by the descriptor's
attempt window and maximum attempts. A failed health check clears the endpoint,
persists a diagnostic, removes the failed owned resource, and schedules only an
allowed recovery. Stop cancels pending health and restart work.

## Durable state, secrets, and diagnostics

`ServiceRuntimeStore` persists state below:

```text
<stateDir>/service-runtimes/<base64url(packId)>/<runtimeId>/
  state.json
  runtime.env
  runtime.log
```

It uses temporary files, `fsync`, and rename rather than best-effort metadata
writes. Runtime directories are owner-only (`0700` where supported); environment
and log artifacts are owner read/write only (`0600`). Failed persistence fails
control work rather than reporting an undurable lifecycle outcome.

Persisted metadata is versioned and contains desired state, selected mode,
settings revision, runner identity, ready endpoint, restart attempts, a stable
diagnostic code, and update time. It contains neither environment values nor
secrets.

Generated secrets are namespaced by service identity and belong to the injected
`GeneratedSecretOwner`. User secrets come from `UserSecretResolver` or the
settings resolver's `resolveSecret` seam and are used only in memory while an
explicit start materializes the runtime. They never become metadata, arguments,
image references, endpoint/status data, or exposed diagnostics.

Runner output is sanitized with the resolved secret values and `KEY=value`
forms, then bounded to 64 KiB and 200 trailing lines before storage. Consumers
read the bounded artifact through `diagnostics()`; raw subprocess or upstream
response text is not a public runtime contract.

## Consumer contract

Providers should receive a host-injected `ServiceRuntimeContext` and must be
usable when it is absent or not ready:

```ts
function endpointForRuntime(runtime?: ServiceRuntimeContext): string | undefined {
  return runtime?.state === "ready" && runtime.endpoint?.trim()
    ? runtime.endpoint
    : undefined;
}
```

A client accepts endpoint/client configuration, not a `ServiceRunMode`, runner,
or supervisor. Reads and provider hooks must not call lifecycle control APIs.
If a managed service is down, providers should return their ordinary bounded
dormant/degraded behavior so unrelated session work continues.

## Platform composition: EP-6, EP-7, and typed routes

The supervisor is reusable because it consumes narrow host-owned interfaces. A
service integration must compose them rather than recreating them in a pack:

1. **EP-7 settings** own the project-local typed values, monotonic revision, and
   write-only secrets. A settings save is inert: validate syntax and persist the
   redacted state, but do not probe an endpoint, discover a model, contact a
   registry, pull an image, allocate a port, or start/restart a runtime. Resolve
   the exact public/secret settings snapshot only for explicit control.
2. **EP-6 capability grants** authorize sensitive control against the active
   pack principal on every use. `service.manage` is the pack capability for
   start, stop, restart, migration, and purge. A valid setting, descriptor, or
   open panel never substitutes for the grant; an inactive, disabled, shadowed,
   or revoked principal is denied.
3. **Typed pack routes** are the UI/data-plane adapter. A panel or entrypoint
   calls its own declared route via `host.callRoute(name, init)`. It does not
   construct a URL, choose a pack/project identity, or pass an authorization
   token. The host derives that scope and may expose `{ settingsRevision,
   runtime: ServiceRuntimeStatus }` for status/control UI. Control additionally
   requires explicit user consent in the route request.
4. **Consumers** receive only `ServiceRuntimeContext` (or the status projection
   above). A provider, route, tool, or panel must work when it is missing or not
   `ready`; read paths never auto-start or trigger a fallback provider.

This division prevents a configuration read from becoming a deployment action,
prevents a route from forging project scope, and keeps credentials out of
runtime diagnostics. It also means a service integration can use the same
runtime semantics in every adapter mode.

### Hindsight reference pack

Hindsight is the reference composition, not a Hindsight-specific runtime type:

- `market-packs/hindsight/pack.yaml` declares `runtimes: [hindsight]` and a
  finite typed-route allowlist.
- `runtimes/hindsight.yaml` declares a `http://` endpoint at service port
  `8888`, probes `/health`, requires manual start, and uses bounded
  `on-failure` recovery. Its local, Docker, and Compose blocks only choose an
  adapter; Compose dynamically publishes a loopback port and disables
  Compose-owned restart.
- The provider declares `runtime: hindsight`. Its `runtimeMode` selects
  `external`, `local`, `docker`, or `compose`; `external` uses `externalUrl`
  and has no managed runner. The client consumes either that configured external
  endpoint or the injected ready endpoint, never a runner implementation.
- EP-7 declares local-model provider, model id, base URL, context/output
  limits, resident keep-alive behavior, OCI image reference, and database mode.
  Hindsight's `apiKey` is an external-service-only bearer token; it is never
  materialized for local, Docker, or Compose. Local-model keys, registry
  credentials, and external database URLs are separately declared write-only
  secrets. A loopback HTTP model endpoint needs no placeholder API key.
- OCI references are syntax-validated at save time. An unpinned tag produces a
  mutable-tag warning but is not rejected; only explicit start/restart may
  resolve or pull it. The shipped default is the reviewed Hindsight `0.8.6`
  digest reference.

The Hindsight data plane maps its declared typed routes to exact EP-6 memory
capabilities, returns bounded no-service results when the runtime is down, and
uses the same client protocol across modes. It does not bind-mount a live
legacy PostgreSQL `pg0` directory. Any storage replacement must use an
explicit, confirmed logical migration with backup, compatibility validation, and
rollback that preserves the source; it must never silently create an empty bank.

### LangFlow reuse

A LangFlow pack follows the same public composition: declare
`runtimes/langflow.yaml`, link a provider with `runtime: langflow`, place its
endpoint/model/credential fields in EP-7, use EP-6 `service.manage` for
explicitly consented control, and consume only the ready endpoint and
`ServiceRuntimeStatus` through typed routes. It requires no LangFlow-specific
supervisor, runner, permission store, settings store, secret store, port
allocator, or deployment-mode branch in the server. If LangFlow is down or
unhealthy, its provider/routes must return their documented bounded no-service
result instead of starting it or falling back to a different provider.

## Host integration checklist

When adding a host integration, preserve these boundaries:

1. Construct one `ServiceRuntimeStore` with a stable server identity and
   separate generated-secret and user-secret owners.
2. Supply all three runners and a `PackContributionRegistry.getRuntime` resolver.
3. Implement authorization outside the supervisor through
   `ServiceRuntimeAuthorizer`; do not let a provider or descriptor authorize
   itself.
4. Make the settings resolver own runner selection, revision, declared
   non-secret values, write-only secret lookup, and canonical storage paths.
5. Expose control only from an explicit authorized action. Read/status/provider
   paths may call `context()` or `status()` only.
6. Pass `supervisor.context(...)` (or an equivalently read-only resolver) to
   `LifecycleHub.runtimeContextResolver` for runtime-declaring providers.
7. Reconcile at host startup only after store, registry, settings, and
   authorization dependencies are ready.

## Explicit deferrals

The runtime nucleus intentionally does **not** supply on its own:

- a route catalogue, settings screen, consent dialog, status UI, or private
  pack UI; the host composes these through typed pack routes and EP-7;
- authorization/grant persistence or settings/secret storage; it consumes the
  EP-6/EP-7-owned interfaces instead;
- automatic starts from install, discovery, configuration reads, status,
  provider dispatch, or endpoint resolution;
- fixed host ports, arbitrary command strings, arbitrary environment
  inheritance, Kubernetes, or remote-service management;
- provider/client protocol branches based on `local`, `docker`, or `compose`.

Those capabilities must be added through their owning platform surfaces while
keeping this descriptor, supervisor, and read-only consumer contract intact.

## Related references

- [Extension Host authoring](extension-host-authoring.md) — schema-2 pack
  contributions and contained module assets.
- [Marketplace](marketplace.md) — pack installation and activation concepts.
- [Service-extension runtime design](design/service-extension-runtime.md) —
  provenance and broader design rationale.
- `tests2/core/service-runtime-*.test.ts` — strict parser, store, runner,
  supervisor, health, and security contract coverage.
- `tests2/integration/service-runtime-docker.test.ts` — same-fixture local,
  Docker, and Compose adapter behavior.
