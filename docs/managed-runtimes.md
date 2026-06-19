# Managed runtimes

> This page covers three layers: **P1**, the pure manifest + helper layer
> (no Docker); **P2**, the Docker-backed supervisor + REST surface that runs
> the prepared inputs; and **P3**, the deployment-mode / consent / lifecycle
> wiring that decides *when* a runtime starts and links it to a provider. P1 is
> documented first; jump to
> [P2 — the Docker-backed supervisor + REST](#p2--the-docker-backed-supervisor--rest)
> for lifecycle, routes, and command discipline, or to
> [P3 — deployment modes, consent & lifecycle](#p3--deployment-modes-consent--lifecycle)
> for modes, explicit-consent start, disable/uninstall/purge, and `ctx.runtime`
> injection.

Bobbit packs can ship **managed runtimes**: a declarative description of a
containerised service stack (images, env, secrets, ports, launch modes) that
Bobbit prepares and — in a later phase — runs via Docker Compose on the user's
behalf. The motivating example is the **Hindsight** stack (data-plane API +
Postgres): a user installs the pack, supplies an LLM API key, and Bobbit brings
up the whole thing with generated credentials and free host ports, no manual
`docker compose` wrangling.

This page documents **P1**, which is deliberately scoped to the **pure layer**:
the manifest schema, the contribution loader, and the helper utilities that
*prepare* everything a later Docker phase will consume. **Nothing in P1 executes
Docker.** No `docker` CLI, no Docker API, no compose expansion, no reading of the
compose file. The only side effects are local filesystem writes (the `.env`
file) and persisted state through injected stores. This keeps the whole layer
unit-testable against temp dirs and makes the security-sensitive parsing /
path-containment logic verifiable in isolation, before any process is spawned.

## Where it fits

A managed runtime is a new **pack contribution kind**, alongside roles, tools,
skills, entrypoints, panels, and routes (see [marketplace.md](marketplace.md)
and the [Extension Host authoring guide](extension-host-authoring.md)). A pack
declares which runtime descriptors it ships in `pack.yaml` under
`contents.runtimes`, and the descriptors themselves live in `runtimes/*.yaml`
inside the pack root.

The P1 code splits into three pure seams:

| Concern | Module |
|---|---|
| Load `runtimes/<name>.yaml` for the names a pack lists | `src/server/agent/pack-contributions.ts` (`loadRuntimes`, `RuntimeContribution`) |
| Parse + deep-validate a runtime descriptor (incl. compose-path containment) | `src/server/runtime/manifest.ts` |
| Pure prep helpers: secrets, `.env`, ports, env resolution, mode invocation | `src/server/runtime/helpers.ts` |

`src/server/runtime/index.ts` is a barrel that re-exports the manifest and
helper modules. The pack-contribution registry exposes
`PackContributionRegistry.getRuntime(projectId, packId, runtimeId)` to resolve a
loaded descriptor.

The Hindsight reference pack lives at `market-packs/hindsight/`:

```
market-packs/hindsight/
  pack.yaml                       # contents.runtimes: [hindsight]
  runtimes/hindsight.yaml         # the runtime descriptor (manifest)
  runtime/compose.yaml            # static, digest-pinned compose template
```

Note the two similarly named directories are distinct: `runtimes/` (plural)
holds descriptor manifests listed in `contents.runtimes`; `runtime/` (singular)
is just where this pack happens to keep its compose template. The descriptor
points at the compose file with a pack-relative `composeFile` path.

## Pack declaration: `contents.runtimes`

A pack opts into shipping runtimes by listing descriptor basenames (no
extension) in `pack.yaml`:

```yaml
name: hindsight
version: 1.0.0
contents:
  roles: []
  tools: []
  skills: []
  entrypoints: []
  runtimes:
    - hindsight        # loads runtimes/hindsight.yaml (or .yml)
```

`contents.runtimes` is **optional** and normalized to `[]` when absent, so packs
that ship no runtimes stay valid (`validateManifest` in
`src/server/agent/pack-manifest.ts`). When present it must be an array of
**safe basenames** — the same path-traversal guard (`isSafeBasename`) used for
`contents.entrypoints`: each entry must match `/^[A-Za-z0-9._-]+$/` with no path
separators and no `..` segments. This is enforced at manifest-validation time so
a malicious basename can never reach the filesystem join in the loader.

The type is `PackManifest.contents.runtimes?: string[]` in
`src/server/agent/pack-types.ts`.

## The contribution loader

`loadRuntimes(packRoot, manifest)` in `src/server/agent/pack-contributions.ts`
loads `runtimes/<name>.yaml` (or `.yml`) **only** for the basenames listed in
`contents.runtimes`. It mirrors the existing G1.1 entrypoint loader pattern
(`loadEntrypoints`) so the two behave identically:

- **Safe-basename + realpath containment before read.** Each `listName` is
  re-checked with `isSafeBasename` (defense-in-depth even though
  `validateManifest` already guards it), and the resolved path is asserted to
  stay within `runtimes/` via `isPackPathWithinRoot`
  (`src/server/extension-host/path-guard.ts`). A name resolving outside the dir
  is dropped with a warning rather than read.
- **Tolerant warn-and-drop** for a missing file, malformed YAML, a non-mapping
  document, or a missing/invalid `id`. A broken descriptor never aborts the
  pack's load — it is logged and skipped. This is the same tolerant-loader
  contract the rest of the contribution system uses, so one bad file can't take
  down an otherwise-good pack.
- **Hard error on a duplicate `id` within a pack.** A second descriptor reusing
  an `id` throws `PackContributionError`, which aborts the pack's load so the
  registry surfaces a loud conflict rather than silently shadowing.

The loader is **intentionally shallow**: it enforces a valid `id` (matching the
panel-id shape `/^[a-z0-9][a-z0-9_.-]*$/i`) and intra-pack id uniqueness, then
carries the **raw parsed YAML** as `RuntimeContribution.manifest`. Deep manifest
validation — compose-path containment, env / secrets / ports / modes — is the
**runtime manifest parser's** job (`src/server/runtime/manifest.ts`), applied by
later orchestration phases. Keeping deep validation out of the loader keeps the
load phase pure and cheap.

`RuntimeContribution` carries: `id`, optional `title` / `description`, the raw
`manifest`, the `listName` (the `contents.runtimes` basename — the activation
key), `sourceFile` (absolute path to the descriptor, the anchor for resolving
`composeFile`), and `packRoot` (the containment root).

## Runtime manifest schema

A descriptor (`runtimes/<name>.yaml`) parses into a `RuntimeManifest`
(`src/server/runtime/manifest.ts`). `parseRuntimeManifest(raw, sourceFile,
packRoot, problems?)` parses YAML then calls `validateRuntimeManifest(...)`.

Validation is **tolerant in the same spirit as the loaders**: problems are
pushed onto an optional `problems[]` string sink and the parse returns `null`
for an unusable manifest rather than throwing.

> The YAML below is an **illustrative** schema walkthrough that exercises every
> field kind (multiple ports, a second generated secret, a `value` ref,
> `omitServices`). The **actual shipped** `market-packs/hindsight` descriptor is
> trimmer — see [The Hindsight reference pack](#the-hindsight-reference-pack).

```yaml
id: hindsight                       # REQUIRED. /^[a-z0-9][a-z0-9_.-]*$/i
title: Hindsight                    # OPTIONAL.
description: >-                     # OPTIONAL.
  Managed Hindsight stack — data-plane API backed by Postgres.

composeFile: ../runtime/compose.yaml   # REQUIRED. Pack-relative; see containment below.

# Generated-and-persisted secrets (idempotent). NOT user-supplied.
secrets:
  - key: HINDSIGHT_DB_PASSWORD       # SecretsStore key. REQUIRED, unique.
    generate: true                   # OPTIONAL bool. true ⇒ generated+persisted.
  - key: HINDSIGHT_API_SECRET
    generate: true
    # env: SOME_VAR                  # OPTIONAL — env var name to expose under.

# Host ports allocated via bind :0, persisted, re-validated on boot.
ports:
  - key: HINDSIGHT_WEB_PORT          # Persistence key. REQUIRED, unique.
    container: 3000                  # OPTIONAL — informational container-side port (1..65535).
    # env: SOME_VAR                  # OPTIONAL — env var to expose chosen port under.

# Base environment shared by all modes. Each value is exactly ONE ref kind.
env:
  HINDSIGHT_API_LLM_API_KEY:
    secret: HINDSIGHT_API_LLM_API_KEY  # resolve from a USER-CONFIGURED secret
  HINDSIGHT_API_SECRET:
    generate: HINDSIGHT_API_SECRET     # resolve from a GENERATED+persisted secret
  HINDSIGHT_WEB_PORT:
    port: HINDSIGHT_WEB_PORT           # resolve from an allocated host port
  SOME_LITERAL:
    value: ${dataDir:-~/.hindsight}    # literal with ${var} / ${var:-default} substitution

# Launch modes — mode-specific argument construction.
modes:
  managed-postgres:
    title: Managed Postgres
    services: [api, web, db]           # compose services to bring up
    # profiles: [...]                  # OPTIONAL — compose profiles to activate
    # omitServices: [...]              # OPTIONAL — services to exclude from `services`
    # requireEnv: [...]                # OPTIONAL — env names that MUST resolve non-empty
    env:                               # OPTIONAL — mode env overlay (merged over manifest.env)
      HINDSIGHT_API_DATABASE_URL:
        value: postgres://hindsight:${HINDSIGHT_DB_PASSWORD}@db:5432/hindsight
```

### Env value refs

An env value is either a **plain string** (treated as a literal with placeholder
substitution) or a **ref object** that declares **exactly one** of:

| Ref | Resolves from |
|---|---|
| `secret: <key>` | a **user-configured** secret (never generated) — e.g. the LLM API key |
| `generate: <key>` | a **generated + persisted** secret of that key (idempotent) |
| `port: <key>` | an **allocated host port** (rendered as a string) |
| `value: <literal>` | a literal, with `${var}` / `${var:-default}` substitution |

Declaring zero or more than one of these is a validation error. Numbers and
booleans are coerced to strings. Env names must match conventional shell-env
identifiers (`/^[A-Za-z_][A-Za-z0-9_]*$/`); secret/port keys use a safe key
token (`/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/`) and must be unique within their list.

### Modes

`modes` is a map of mode id → `RuntimeModeSpec`. A mode selects which compose
services to run and overlays mode-specific env over the manifest-level `env`:

- `services` — compose services to bring up.
- `profiles` — compose profiles to activate.
- `omitServices` — services removed from `services` (lets a mode list the full
  service set then subtract — e.g. external-postgres lists `db` then omits it).
- `requireEnv` — env names that **must** resolve to a non-empty value; checked
  when building the invocation.
- `env` — a mode-level overlay merged **over** `manifest.env` (mode wins).

## Compose path containment / escape rejection

The single most security-sensitive field is `composeFile`. It is **pack-relative
and resolved relative to the descriptor's directory** (`sourceFile`), and the
result must stay inside the pack root. `resolveContainedComposePath(composeFile,
sourceFile, packRoot)` performs this check **purely and lexically** — it never
touches the filesystem:

1. Reject anything that is not a safe relative path (`isSafeRelativePath` from
   `src/server/agent/tool-contributions.ts` — rejects absolute paths and `..`
   escapes).
2. Resolve `composeFile` against `dirname(sourceFile)`.
3. Compute `path.relative(packRoot, resolved)` and reject if it is empty, starts
   with `..`, or is absolute.

It returns the resolved absolute compose path when contained, else `null`. A
descriptor whose `composeFile` escapes the pack root fails
`validateRuntimeManifest` with a recorded problem and parses to `null`.

This is enforced **twice** (defense-in-depth): once at parse/validation time, and
again at invocation-build time in `buildRuntimeInvocation`, which re-derives the
absolute compose path and throws if it would escape. A pack can therefore never
steer Bobbit into reading or composing a file outside its own directory, even via
a crafted relative path like `../../../etc/...`.

## Pure helper utilities

`src/server/runtime/helpers.ts` holds the prep helpers. All stores are injected
(an interface with `get`/`set`), so the helpers run against `SecretsStore` in
production and against in-memory fakes in unit tests.

### Idempotent secret generation

```ts
generateSecretValue();                       // crypto.randomBytes(24).toString("base64url")
getOrCreateRuntimeSecret(store, key, gen?);  // returns existing or generates+persists
```

`generateSecretValue()` is the canonical generated-secret format used across the
runtime layer: 24 random bytes encoded as URL-safe base64.
`getOrCreateRuntimeSecret` is **idempotent**: if a non-empty value already exists
under `key` it is returned unchanged; otherwise a fresh value is generated,
persisted via `store.set`, and returned. Repeated calls are stable — this is what
lets the runtime re-prepare on every boot without rotating credentials. The
generator is an injectable seam (`SecretGenerator`) so tests can assert exact
values.

### `.env` rendering (mode 0600)

```ts
renderRuntimeEnvFile(filePath, env);   // sorted keys, mode 0600
escapeDotenvValue(value);              // conservative double-quote escaping
```

`renderRuntimeEnvFile` writes a dotenv file with **stable, sorted key order**
(deterministic output) and creates parent directories as needed. Because the
file contains secrets, it is written with **file mode `0600`** (owner
read/write only). `writeFileSync`'s `mode` option only applies when the file is
*created*, so the helper also calls `chmodSync(filePath, 0o600)` afterward to
correct the mode on a pre-existing file. Values are escaped with
`escapeDotenvValue`, which always double-quotes and escapes backslash, double
quote, CR, and LF — so a value can never break out of its line or inject another
assignment.

### Host-port allocation (bind :0), persistence, revalidation

```ts
probeFreePort(host?);                   // bind :0, read the assigned ephemeral port
isPortAvailable(port, host?);           // can this port be bound right now?
allocateHostPort(store, key, opts?);    // persisted-or-allocate
revalidateHostPort(store, key, opts?);  // boot-path alias of allocateHostPort
```

A free host port is found by **binding `:0`** (`net.createServer().listen(0,
host)`) and reading back the OS-assigned ephemeral port. `allocateHostPort`
**persists** the chosen port under `key`: if a valid port is already stored *and*
is still bindable, it is kept; otherwise a fresh port is probed and persisted.
The default probe host is `127.0.0.1`.

`revalidateHostPort` is the **boot path's** alias with an identical contract: keep
the persisted port if it is still valid and available, otherwise allocate and
persist a new one. The motivation is stability with self-healing — a runtime
keeps the same host port across restarts (so bookmarks/URLs stay valid), but if
something else has since claimed that port, it transparently moves to a new one
rather than failing to bind.

### Placeholder substitution

```ts
substitutePlaceholders(input, vars?);   // ${name} and ${name:-default}
buildPlaceholderVars(ctx);              // exposes ports/secrets/generated/vars by key
```

`substitutePlaceholders` expands `${name}` and `${name:-default}`. A missing or
empty var falls back to its `:-default`; with **no** default it resolves to the
**empty string** — never left as a literal `${...}`. This guarantees unresolved
values can't leak into the env file, and it lets `requireEnv` detect a missing
required value (it shows up as empty). `buildPlaceholderVars` builds the var map
from a `RuntimeResolveContext`, exposing allocated ports, user secrets, and
generated secrets under their own keys — so a literal `value` can interpolate,
say, a generated DB password by its secret key
(`postgres://u:${HINDSIGHT_DB_PASSWORD}@db/...`). Explicit `vars` win on a key
collision.

### Env resolution + mode invocation

```ts
resolveRuntimeEnv(manifest, mode, ctx);      // merge manifest+mode env, resolve all refs
buildRuntimeInvocation(manifest, mode, inputs);  // data-only, NO Docker
```

`resolveRuntimeEnv` merges `manifest.env` with the mode overlay (mode wins),
resolves every ref/placeholder against the `RuntimeResolveContext`, and returns a
plain `Record<string,string>` with sorted keys. A `secret`/`generate`/`port` ref
whose value is missing from the context throws — these are programmer/config
errors, not tolerant cases.

`buildRuntimeInvocation` produces the **data-only** `RuntimeInvocation` that a
later Docker phase consumes — and runs **no Docker itself**. It:

1. Re-validates compose-path containment (throws on escape — see above).
2. Resolves the mode env and enforces `requireEnv` (throws if any required name
   resolves empty).
3. Subtracts `omitServices` from `services`, and collects `profiles`.

The result carries `runtimeId`, `mode`, the resolved absolute `composeFile`, the
`envFile` path, the selected `services`/`profiles`, and the fully resolved
`env`.

## The Hindsight reference pack

`market-packs/hindsight/` is the first managed-runtime pack. Its compose template
(`runtime/compose.yaml`) is **static and digest-pinned**
(`name:tag@sha256:<64 hex>`) for reproducibility, and is **never executed in P1**
— it is only ever selected from and resolved as a path. The images are the
**verified upstream coordinates**: the data-plane API
`ghcr.io/vectorize-io/hindsight` and the pgvector-enabled Postgres
`pgvector/pgvector:pg18`. Managed Bobbit integration only needs the data-plane
API (container port **8888**) plus Postgres — there is **no** separate
web/control-plane container.

The descriptor declares one **generated** secret (`HINDSIGHT_DB_PASSWORD`), one
**port** (`HINDSIGHT_API_PORT` → container 8888), and wires the LLM API key from a
**user-configured** secret via `HINDSIGHT_API_LLM_API_KEY: { secret: ... }` —
the only user-supplied secret; the DB password is generated. It also declares a
`healthcheck` (`path: /health`, `port: HINDSIGHT_API_PORT`) that the supervisor
polls over HTTP before reporting the runtime `running`.

### Managed vs external Postgres

The two modes differ only in how the database is provided:

- **`managed-postgres`** — includes the `db` service. The data directory is a
  host **bind mount** that defaults to `${dataDir:-~/.hindsight}` (the
  `dataDir` var, or `~/.hindsight` when unset). A leading `~` / `~/` in the
  resolved value is **expanded to the absolute home directory** by the env
  resolver (`expandTilde` in `helpers.ts`) before it reaches the env file:
  Docker Compose does **not** expand `~` in `.env` values or bind-mount sources,
  so an unexpanded `~/.hindsight` would otherwise create a literal `~`-named
  directory next to the project. The connection string is built
  from the **generated** password and the in-compose `db` hostname via a
  `value` ref:
  `HINDSIGHT_API_DATABASE_URL: postgres://hindsight:${HINDSIGHT_DB_PASSWORD}@db:5432/hindsight`
  — the `${HINDSIGHT_DB_PASSWORD}` placeholder resolves from the generated
  secret of the same key.
- **`external-postgres`** — lists `db` in `services` but `omitServices: [db]`,
  so no managed database is started. It declares `requireEnv:
  [HINDSIGHT_API_DATABASE_URL]` and injects that URL from a **user-configured**
  `secret` ref. The operator supplies their own Postgres connection string.

Both behaviours are expressed **purely declaratively** in the manifest; the
helpers contain no Hindsight-specific logic.

## The pure / no-Docker boundary

P1 stops at preparing inputs. To be explicit about what is and isn't in scope:

| In P1 (pure) | Deferred to a later Docker phase |
|---|---|
| Parse + validate descriptors | `docker compose up` / process spawning |
| Compose-path containment checks | Reading / expanding the compose file |
| Generate + persist secrets | Pulling images |
| Render the `.env` file (mode 0600) | Mounting the bind volume |
| Allocate / persist / revalidate host ports | Health checks, lifecycle, teardown |
| Resolve env + build the data-only `RuntimeInvocation` | Executing the invocation |

The boundary exists so the trust-critical logic (pack-authored YAML parsing,
path containment, secret handling) is fully unit-testable without Docker, and so
a bug in that logic is caught long before anything is launched. Unit coverage
lives in `tests/runtime-manifest.test.ts` and `tests/runtime-helpers.test.ts`.

## P2 — the Docker-backed supervisor + REST

P1 stops at preparing inputs; **P2 runs them**. The `PackRuntimeSupervisor`
(`src/server/runtimes/pack-runtime-supervisor.ts`) is the **single place** that
shells out to Docker for managed pack runtimes, and the REST surface in
`server.ts` exposes its lifecycle to the UI/API. The split exists for the same
reason as the P1/P2 boundary itself: all trust-critical *preparation* stays pure
and unit-testable, and the one module that touches a real daemon is small,
audited, and fully mockable.

`src/server/runtimes/index.ts` is the barrel that re-exports the supervisor and
its public types/helpers.

### Supervisor lifecycle

The supervisor is constructed once per server with a
`PackContributionResolver` (to look up active runtimes by project scope) plus
the injectable seams below. Its surface:

| Method | Docker command | Returns |
|---|---|---|
| `list(projectId?)` | one `compose ps` per active runtime | `PackRuntimeStatus[]` |
| `status(packId, runtimeId, projectId?)` | `compose ps --format json` | `PackRuntimeStatus` |
| `ensureRuntime(packId, runtimeId, {projectId, mode})` | fast-path `ps`, else `up -d` | `PackRuntimeStatus` |
| `start(packId, runtimeId, {projectId, mode})` | `compose up -d` + health poll | `PackRuntimeStatus` |
| `stop(packId, runtimeId, {projectId})` | `compose stop` | `PackRuntimeStatus` |
| `restart(packId, runtimeId, {projectId, mode})` | `stop` then `start` | `PackRuntimeStatus` |
| `logs(packId, runtimeId, {projectId, tail})` | `compose logs --tail N` | `string` |

**`ensureRuntime` is idempotent and the intended entry point** for "make sure
this is up". It first calls `status`; if the runtime is already `running` it
returns immediately without touching Docker again, and if Docker is unavailable
it returns the `docker-unavailable` status verbatim rather than falling through
to a noisier `start`. Otherwise it delegates to a **deduplicated** start.

**Concurrent starts collapse to one `compose up`, keyed by runtime identity.**
A `_startInFlight` map keyed by the **runtime identity alone**
(`packId\0runtimeId`) holds the in-flight start promise; later callers for the
same key await the same promise, and the entry is cleared on settle so a
subsequent call can retry. This mirrors `sandbox-manager.ts`'s `_ensureInFlight`
discipline and prevents a burst of UI calls from racing multiple `up -d`
invocations.

The key deliberately **omits both `projectId` and `mode`**, because a runtime
identity owns **one** rendered `.env` file and **one** compose project, and
*neither is project-scoped* (`composeProjectFor`/`_envFilePath` are derived from
pack + runtime + server suffix only). Including `projectId` would let two starts
for the same pack/runtime from different project scopes bypass the guard and race
two `compose up`s clobbering one env file; including `mode` would let two
different-mode starts each `renderRuntimeEnvFile` to the same path and race.
Instead the in-flight **mode is tracked alongside the promise**: a concurrent
start requesting the **same** mode shares the promise (one `compose up`), while a
concurrent start requesting a **conflicting** mode is **rejected** with
`PackRuntimeBadRequestError` (rather than silently collapsing onto the first
mode's promise) so the race is impossible and the caller learns its mode was not
honoured. Mode-agnostic `ensureRuntime` callers pass the same (usually
`undefined`) mode and still share one key.

**Idempotent fast-path via a `_started` set.** A per-instance `Set` of runtime
keys the supervisor has brought up to `running` drives `start`'s fast-path: a
repeat `start` of a still-running runtime must not re-render the invocation,
`compose up` again, or rotate its host port. The set is cleared on `stop`/`down`
(the runtime is no longer up) and is per-instance (not disk-backed) so it never
leaks across the unit fixtures' shared data dir. After a server restart the flag
is empty, so the first post-restart `start` falls back to the `reusePersisted`
port path (no rotation) rather than the in-memory shortcut.

**Startup health polling.** After `up -d`, `start` polls every `pollIntervalMs`
(default 1 s) until the runtime is ready or `startupTimeoutMs` (default 60 s)
elapses. Each poll first reads `compose ps`, mapped to a single state by
`mapServicesToState`:

- any service `unhealthy` → `unhealthy`
- all services `running` and (no healthcheck **or** `healthy`) → `running`
- any service `running`/`created`/`restarting`/`starting` → `starting`
- otherwise → `stopped`

A `docker-unavailable` (ENOENT) or a Docker-reported `unhealthy` short-circuits
the loop immediately.

**HTTP readiness gate.** When the manifest declares a `healthcheck`
(`{ service?, port, path }`, where `port` names a declared `ports[].key`),
`start`/`ensureRuntime` do **not** report `running` off a `compose ps` "running"
alone — a container is often up well before its HTTP server accepts requests. The
supervisor additionally polls
`http://127.0.0.1:<resolved host port for `port`><path>` (via an injectable
`httpProbe` seam, defaulting to a `fetch` GET) and only completes as `running`
once it returns **HTTP 200**. Runtimes with no declared `healthcheck` keep the
`compose ps`-only readiness behaviour. `status()` always reflects the
`compose ps` mapping regardless.

If the timeout is hit while still `starting` (or HTTP health never returns 200),
the result is `unhealthy` with a `"runtime did not become healthy within <N>ms"`
message — startup never blocks forever.

### Status states

`PackRuntimeStatus.status` is one of:

| State | Meaning |
|---|---|
| `docker-unavailable` | the Docker executable was not found (`ENOENT`) |
| `stopped` | no services running (or `ps` returned none) |
| `starting` | services created/running but not yet healthy |
| `running` | all owned services running and healthy |
| `unhealthy` | a service reported `unhealthy`, or startup timed out |

The status also carries the descriptor (`id`, `packId`, `runtimeId`,
`packName?`, `title?`, `description?`), the resolved `composeProject`, the
selected `mode?`, the parsed `services?`, and an optional human `message`.

### REST routes

Wired in `server.ts::handleApiRoute()`, **admin-bearer only** (gated before the
route runs). The `:id` path segment is the URL-safe
`encodePackRuntimeId(packId, runtimeId)` (`encodeURIComponent(packId) + ":" +
encodeURIComponent(runtimeId)`), which the route reverses via
`decodePackRuntimeId`.

| Route | Method | Response |
|---|---|---|
| `/api/pack-runtimes?projectId=` | GET | `{ runtimes: PackRuntimeStatus[] }` |
| `/api/pack-runtimes/:id/start` | POST | `PackRuntimeStatus` (after ensure/start) |
| `/api/pack-runtimes/:id/stop` | POST | `PackRuntimeStatus` (after stop) |
| `/api/pack-runtimes/:id/restart` | POST | `PackRuntimeStatus` (after restart) |
| `/api/pack-runtimes/:id/logs?tail=` | GET | `{ logs, status?, message? }` |

- The optional `projectId` query param scopes the runtime lookup to a project.
- `start`/`restart` accept an **optional** `mode` in the JSON body. An **empty**
  body is valid (default mode). A non-empty but malformed-JSON body, or a
  present-but-non-string/empty `mode`, is a client error → **400** (the route
  never silently treats garbage as `{}` and mutates the default mode). `stop`
  ignores `mode`.
- Error mapping: `PackRuntimeNotFoundError` → **404**, `PackRuntimeBadRequestError`
  (malformed id/mode/tail, invalid manifest, failed invocation) → **400**, other
  errors → **500**. When the supervisor failed to construct at boot, every route
  answers **503** (`"pack runtime supervisor unavailable"`).
- The GET-list and mutation routes always re-derive the returned `id` from
  `{packId, runtimeId}` so it round-trips cleanly through `decodePackRuntimeId`.

**Docker-unavailable behavior.** Status-returning methods (`list`, `status`,
`ensureRuntime`, `start`, `stop`) translate an `ENOENT` from the executor into a
`docker-unavailable` status — they never throw for a missing Docker install. The
`logs` method is the exception: it returns a raw string, so it throws
`PackRuntimeDockerUnavailableError` on `ENOENT`. The logs route catches that and
answers a **200** with a consistent shape `{ logs: "", status:
"docker-unavailable", message }` rather than hiding the missing install behind an
empty body or a generic 500. `tail` is validated/clamped by the supervisor
(`clampTail`): non-numeric → 400, otherwise clamped to `[1, 5000]`, default 200.

### Docker Compose command discipline

Every Docker invocation goes through one private `_exec` seam, and the
discipline is uniform:

- **`execFile`, never a shell string.** Args are passed as an array via the
  injectable `DockerExecutor` (defaults to a promisified `execFile`), so
  pack-authored values can never be interpreted by a shell. This matches the
  project-wide sandbox `execFile` discipline.
- **`DOCKER_BIN` override.** The executable defaults to
  `process.env.DOCKER_BIN || "docker"`, so a non-standard Docker location can be
  configured without code changes.
- **MSYS env neutralization.** Each call sets `MSYS_NO_PATHCONV=1` and
  `MSYS2_ARG_CONV_EXCL=*` in the child env so Git-Bash/MSYS on Windows does not
  rewrite `:`-bearing arguments (compose project names, ports, paths) into
  mangled Windows paths.
- **Compose project name + collision guard.** Every command carries `-p
  bobbit-pack-<packId>-<serverIdentitySuffix>` (`composeProjectFor`). The
  per-server `serverIdentitySuffix` (sanitized, or a random 4-byte hex when
  unset) is appended so two gateways — or two servers sharing a host — never
  collide on the same compose project for the same pack (design §15.5). Tokens
  are sanitized to `[a-z0-9_-]` and length-capped by `sanitizeComposeToken`.
- **Compose file + env file on every call.** Commands always pass `-f
  <composeFile> --env-file <envFile>`, not just `up`. Both are derived from the
  **validated** `RuntimeInvocation`, so `status`/`stop`/`logs` inspect/control
  the exact same compose context `start` used — regardless of the gateway's
  current working directory.
- **Per-runtime service scoping.** `ps`/`stop`/`logs` are scoped to the
  services this runtime owns (the union of every mode's `services`, from
  `_servicesForManifest`), so sibling runtimes that share one pack-scoped compose
  project can never read, stop, or have their health reflected by another
  runtime. The empty (project-wide) service list is reserved **exclusively** for
  a successfully validated manifest that genuinely declares no services — a
  manifest validation/invocation failure propagates (→ 400/500) instead of
  silently degrading to an unscoped whole-pack command.

**Read/control paths reuse persisted ports verbatim.** When building the compose
context for `status`/`stop`/`logs`, the supervisor resolves env with
`reusePersisted: true`: the stored host port is used **without** a bindability
probe. While a runtime is running its ports are bound, so a revalidating
allocation would find them un-bindable, rotate to fresh ports, and rewrite
`ports.json` + the env file — desyncing the persisted port from the live
container and breaking the next restart.

### Runtime state persistence

Production state lives under `<stateDir>/state/pack-runtimes/`:

- **Rendered `.env` files**, one per compose project, at
  `<runtimeDataDir>/<composeProject>/<runtimeId>.env` (mode 0600 — see P1's
  `renderRuntimeEnvFile`).
- **`ports.json`** — the file-backed `FilePortStore` of allocated host ports.
  Read/write errors are swallowed (best-effort), so a corrupt file degrades to
  fresh allocation rather than crashing the supervisor.
- **Generated secrets** persist through the production `SecretsStore`.

**Pack/runtime-namespaced persistence keys.** Generated secrets and allocated
ports persist under `packRuntimePersistKey(packId, runtimeId, rawKey)` =
`pack-runtime:<packId>:<runtimeId>:<rawKey>`. Two unrelated runtimes that both
declare, say, `PORT` or `DB_PASSWORD` would otherwise collide on the raw
manifest key in the shared global store and overwrite each other's value. The
**raw** manifest key is still used for the rendered env-var name and for reading
**user-configured** secrets (intentionally global/shared — a user configures one
LLM key once across runtimes); only the persisted storage slot for
auto-generated secrets and allocated ports is namespaced.

**Archive allowlist.** `state/pack-runtimes/` is listed in
`GATEWAY_OWNED_FILES` (`src/server/agent/bobbit-archive.ts`). When a user's
chosen project root happens to be the gateway's own working directory, the
archiver skips this subtree because it holds the rendered env files and
`ports.json` for **live** Docker runtimes — archiving it out from under a running
container would desync the persisted ports/secrets from the live stack.

### Testing & mocking

**Docker is never executed in automated tests** — only in manual integration.
Two seams make this enforceable:

- **Injectable executor.** `PackRuntimeSupervisorOptions.executor` replaces the
  real `execFile` with a mock that returns canned `{ stdout, stderr }` (or throws
  an `ENOENT`-shaped error) per command, so unit tests drive every status walk
  without a daemon. `now`/`sleep` are also injectable for deterministic timeout
  tests, and `serverIdentitySuffix` is injected so the compose project name is
  predictable.
- **Supervisor factory seam.** `registerPackRuntimeSupervisorFactory(factory)`
  in `server.ts` lets API E2E tests inject a fully-mocked supervisor so the
  `/api/pack-runtimes/*` routes can be exercised end-to-end with no Docker. The
  factory is consulted fresh per request (never cached), so passing `null`
  immediately reverts to the production instance — no stale mock leaks across
  in-process E2E tests.

Coverage:

- `tests/pack-runtime-supervisor.test.ts` (unit) — status walk (empty → stopped,
  running/healthy → running, unhealthy → unhealthy), health timeout → unhealthy,
  `ENOENT` → docker-unavailable (never throws), concurrent `ensureRuntime` → one
  `compose up`, `stop` → `compose stop`, compose project name contains the
  injected suffix, MSYS env on the exec, plus id encode/decode, tail clamp, ps
  parse, and up-invocation arg/env-file shape.
- `tests/e2e/pack-runtimes-api.spec.ts` (API E2E) — the REST surface against the
  injected fake supervisor: list with round-trippable ids, start/stop/restart,
  logs with tail clamping, and the 400/404 error mappings.

## P3 — deployment modes, consent & lifecycle

P1 prepares inputs and P2 runs them, but neither answers two product questions:
*when* may Bobbit start a container on the user's machine, and *how* does the
memory provider reach the managed stack once it is up? **P3 wires the runtime to
the Hindsight memory provider, gates every start behind explicit user consent,
and defines the disable / uninstall / purge semantics.** It is the layer that
turns the raw supervisor into a safe, opt-in managed deployment.

The governing principle is **explicit consent**: an installed or enabled pack
must *never* spin up Docker on its own — not on boot, install, update, or any
read. A container starts only from a deliberate user action. This matters
because a managed runtime pulls images, binds host ports, and writes to a host
data directory; doing any of that implicitly (e.g. just because a first-party
pack ships enabled by default) would be a surprising, resource-consuming side
effect the user never asked for.

### Deployment modes

The Hindsight memory provider exposes a single `mode` config field
(`market-packs/hindsight/providers/memory.yaml`) with three **deployment
modes**. These are distinct from the runtime manifest's **launch modes**
(`managed-postgres` / `external-postgres`); P3 maps one onto the other so the
provider config is the single user-facing knob.

| Deployment mode (`config.mode`) | What Bobbit runs | Runtime launch mode | Docker? |
|---|---|---|---|
| `external` (default) | nothing — points at a Hindsight you already host | — | No |
| `managed` | Hindsight API + web **+ Postgres** | `managed-postgres` | Yes |
| `managed-external-postgres` | Hindsight API + web only; DB is yours | `external-postgres` | Yes |

- **`external`** — the unchanged, no-Docker data-plane path documented in
  [hindsight-memory.md](hindsight-memory.md). The provider talks directly to
  `externalUrl` with an optional `apiKey`, `namespace`, and `bank`. No runtime is
  started; all managed side effects are skipped.
- **`managed`** — Bobbit brings up the whole stack (`api`, `web`, `db`) with a
  generated Postgres password and a host **bind mount** for the data dir
  (default `~/.hindsight`, overridable via `dataDir`).
- **`managed-external-postgres`** — Bobbit runs only `api` + `web` (the
  `external-postgres` launch mode omits `db`) and injects the operator-supplied
  `HINDSIGHT_API_DATABASE_URL` from the `externalDatabaseUrl` config secret.

The deployment-mode → launch-mode mapping lives in `resolveRuntimeStartPlan`
(`server.ts`), which also decides whether a start is even attempted:

```text
external                  → { start: false }            # no Docker
managed                   → { start: true,  mode: managed-postgres }
managed-external-postgres → { start: true,  mode: external-postgres }
```

`start: false` for `external` is what makes the external path a pure *setup*
flow: the **start** path and the consent card branch on it to avoid forcing a
managed compose invocation that an external setup never configured. (The
*teardown* path no longer branches on it — see
[Disable / uninstall / purge](#disable--uninstall--purge-semantics) — so a
managed→external reconfiguration can never leak containers.)

### Deployment-surface classification (raw vs activation-filtered contributions)

Deciding *which* deployment surface a pack exposes — and therefore which mode to
disclose/start — must read the pack's **raw, activation-unfiltered**
contributions, not the runtime-filtered ones. The capabilities / start / restart
REST routes (and the marketplace activation path) build their `deploymentConfig`
+ `hasDeploymentSurface` from `PackContributionRegistry.getRawPack(projectId,
packId)`, which returns the winning pack's contributions **without** dropping
config-gated providers.

**Why raw?** Hindsight's memory provider is **dormant until `externalUrl` is
configured** (its `requiresConfig` gate). The activation-filtered `getPack`
therefore omits the provider on a fresh/default install, which would misclassify
Hindsight as a *provider-less* pack and disclose/start the Docker default mode
instead of the **external (no-Docker) setup path**. Reading the raw pack keeps
the dormant provider visible so a fresh Hindsight is correctly classified as
`external`.

A provider "carries a deployment mode" (`providerCarriesDeploymentMode`) when its
effective config has a non-empty `mode` **or** its `activation.activeWhenConfig`
declares a `mode` key. `hasDeploymentSurface` is the OR of that across the pack's
raw providers.

**No-deployment-surface fallback.** A pack with **no** provider — or whose only
provider carries no deployment mode (a runtime-only pack) — has no
external/managed concept, so `resolveRuntimeStartPlan({})` defaulting to
`external`/no-start would wrongly suppress its `on-enable` runtime. Both the REST
start path and marketplace activation apply the same fallback: when
`!hasDeploymentSurface`, the `on-enable` runtime starts in the **runtime's
default mode** rather than being gated by the external-default plan. This keeps
activation and `/api/pack-runtimes/:id/start` from diverging.

**Availability filtering stays activation-aware.** Raw contributions are used
*only* to classify the deployment surface. Actual runtime *availability* — a
runtime explicitly disabled via `pack_activation` (`DisabledRefs.runtimes`) — is
still enforced by the supervisor's **activation-filtered** registry lookups
(`getPack`/`getRuntime`), so a disabled runtime is absent from `list`/`status`
and cannot be started. See
[marketplace.md → activation controls](marketplace.md#activation-controls).

### Activation policy — `startPolicy: on-enable`

A runtime descriptor declares **when enabling it is allowed to start it** via
`startPolicy` (parsed by `readRuntimeStartPolicy` in
`src/server/runtimes/pack-runtime-supervisor.ts`):

- **`manual`** (the default for any descriptor that omits the field, and the
  only value a non-literal/garbage value resolves to) — the runtime *never*
  starts implicitly. A user must call `POST /api/pack-runtimes/:id/start`.
- **`on-enable`** — flipping the pack's marketplace activation toggle from
  **disabled → enabled** counts as the explicit user start. This is the **only**
  implicit-start trigger, and it still fires only for a managed deployment mode
  (`plan.start === true`); an `external` enable starts nothing.

The shipped Hindsight runtime sets `startPolicy: on-enable`. Crucially, boot,
built-in pack discovery, install, update, `list`, and `status` must **never**
`compose up`. This is pinned, not just asserted in prose:
`tests/pack-runtime-supervisor.test.ts` ("no-auto-start (P3)") proves `status()`
and `list()` issue zero `compose up`, and
`tests/e2e/marketplace-runtime-activation.spec.ts` proves reads (GET
pack-activation / GET pack-runtimes) and an `external`-mode enable issue no
start.

### `ctx.runtime` injection — linking the provider to the managed stack

A provider links to a runtime descriptor via the `runtime:` key in its YAML
(`providers/memory.yaml` → `runtime: hindsight`). For a **managed** deployment
mode the host injects a `ctx.runtime` object into every provider hook so the
provider knows where the managed API is listening:

```ts
ctx.runtime = {
  baseUrl: "http://127.0.0.1:<apiHostPort>",  // loopback only
  headers: { Authorization: "Bearer <apiKey>" } | {},
  status: "running" | "starting" | "stopped" | "unhealthy" | "docker-unavailable",
}
```

This is resolved by the `runtimeResolver` wired into the `LifecycleHub`
(`server.ts`). It is **read-only with respect to Docker**: it calls the
supervisor's `status` and the **pure** `capabilitySummary` to read the
already-persisted API host port, and **never starts a container**. The resolver
returns `undefined` when the mode is `external`, when no supervisor is present,
or when the API port is not yet known — so a provider can ask for memory before
the stack is up without triggering a start.

Activation linkage closes the loop. External mode activates the provider via the
`requiresConfig: [externalUrl]` gate (dormant until a URL is set); the two
managed modes activate it via the `activeWhenConfig: { mode: [managed,
managed-external-postgres] }` escape hatch, which bridges the provider regardless
of `externalUrl`. The provider's own `isActive(cfg, ctx.runtime)` gate
(`market-packs/hindsight/src/shared.ts`) then keeps every hook dormant — no
client, no network — until `ctx.runtime.status` reports the managed stack is
actually `running`. The provider **never** starts Docker itself.

### Disable / uninstall / purge semantics

The three teardown verbs differ deliberately in how much they remove, because a
user's accrued memory lives in a host bind mount that must survive routine
operations:

| Action | Docker command | Bind-mounted data | Supervisor state (env/ports/secrets) |
|---|---|---|---|
| **Disable** (enabled → disabled toggle) | `compose stop` | Kept | Kept |
| **Uninstall** (`down`, default) | `compose down` | **Kept** (bind mount is outside compose volumes) | Kept |
| **Purge** (`down -v` + `removeState`) | `compose down -v` | **Kept** (bind mount is not a compose volume) | **Removed** |

- **Disable** stops the containers but leaves the compose project, networks,
  anonymous volumes, and all state in place, so re-enabling is fast and lossless.
- **Uninstall** removes the project's containers + networks but **not** named or
  anonymous compose volumes, and the bind-mounted Postgres data dir lives
  *outside* compose-managed volumes entirely — so an uninstall → reinstall keeps
  the user's memory.
- **Purge** (`POST /api/marketplace/purge-runtime`, or the supervisor's
  `down({ volumes: true, removeState: true })`) is the explicit destructive
  path: `compose down -v` plus deletion of the supervisor's own bookkeeping (the
  rendered `.env`, persisted generated secrets, and allocated host ports,
  all namespaced by `packRuntimePersistKey`). Even purge **never** deletes the
  bind-mounted data dir — that is the user's data, removed only by them.

**Teardown is unconditional — it never gates on the current saved deployment
mode.** Disable and uninstall call `stop` / `down` for **every** runtime
contribution regardless of the pack's current `config.mode`. This is a
deliberate **leak guard**: a runtime started in a managed mode and *later*
reconfigured to `external` would otherwise — if teardown branched on
`resolveRuntimeStartPlan(currentConfig).start` — skip teardown and leak its
still-running containers. The teardown verbs are safe to call unconditionally
because `stop` / `down` are **read-only / minimal / idempotent**: they never
resolve start-only inputs (e.g. `HINDSIGHT_API_LLM_API_KEY`), reuse an
already-rendered `.env` only when one exists, and map a missing Docker install to
a `docker-unavailable` *status* rather than throwing. So calling them for an
external-only, never-started runtime is a harmless no-op (`compose down`/`stop` on
an absent project exits 0). Note `resolveRuntimeStartPlan`'s `start: false` for
`external` still governs *starting* (an external setup never triggers a managed
`compose up`); only the *teardown* path was decoupled from it.

**Side effects run before activation is persisted.** In the marketplace
activation `PUT`, the Docker start/stop runs *before* the new activation state is
written, and a side effect that matters aborts the whole request without
persisting — so Bobbit never records "enabled" while the container failed to come
up, or "disabled" while a `stop` threw. A graceful `docker-unavailable` status is
tolerated (nothing to start/stop on a Docker-less host; the provider is
defensive), so it persists and is reported rather than treated as a hard failure.
These branches are pinned across `tests/e2e/marketplace-runtime-activation.spec.ts`
(enable-failure → 502 + no persist, stop-failure → 502, docker-unavailable
tolerated, **disable/uninstall tear down unconditionally** — including a runtime
started managed then reconfigured to `external` — managed uninstall tears down
without volumes, purge runs `down -v` + state removal).

### Secrets & config mapping

Managed modes pull two extra fields off the provider config and map them onto the
runtime's env (`resolveRuntimeStartPlan`):

| Provider config key | Runtime env | Notes |
|---|---|---|
| `llmApiKey` | `HINDSIGHT_API_LLM_API_KEY` | The managed API's LLM key — the runtime's *only* user-configured secret. Required to start a managed mode; never used by the provider client itself. A value set directly in the global secret store under the same key also works (the direct value wins). |
| `externalDatabaseUrl` | `HINDSIGHT_API_DATABASE_URL` | Operator Postgres URL for `managed-external-postgres`; unused in `external`/`managed`. |

Both, plus `apiKey`, are **secrets** and are redacted on the `config` GET surface
(`redactConfig` in `market-packs/hindsight/src/shared.ts`): the raw value is never
echoed and collapses to a boolean — `apiKeySet`, `externalDatabaseUrlSet`,
`llmApiKeySet`. The managed Postgres password (`HINDSIGHT_DB_PASSWORD`) is
**generated and persisted** by the supervisor, never user-supplied.

The **data directory** (`dataDir`, default `~/.hindsight`) and the **allocated
host ports** are *disclosed*, not secret — they are surfaced on the consent card
below so the user sees exactly what will be bound and where data will be written.

### Enable-card capability summary (consent disclosure, §8)

Before the user consents to a start, the Market UI renders a **capability
summary** from `GET /api/pack-runtimes/:id/capabilities` (the supervisor's
`capabilitySummary`). It is **pure** — derived only from the validated manifest,
the selected/effective deployment mode, and any *already-persisted* host ports —
so it **never starts Docker and never allocates new ports or secrets**, making it
safe to render pre-consent. It discloses, per design §8:

- **Images / services** brought up for the selected mode (after `omitServices`).
- **Host ports** that will be bound (with the persisted host port when known, or
  "allocated on enable" otherwise — never a loopback URL on the container port).
- **Volume path** — the effective managed-Postgres bind-mount path, reflecting a
  custom `dataDir` exactly as activation will mount it (not a schema default).
- **Start policy** (`on-enable` vs `manual`) and the **memory/trust disclosure**
  copy (a first-party trust note explaining what is stored and that disable keeps
  data while purge removes volumes + state).

For **external** mode the route returns the descriptor/trust copy but **no**
services/ports/volume and `dockerRequired: false`, so the UI shows no-Docker
setup guidance instead of a Docker start disclosure.

**The disclosure is refetched on every marketplace (re)load.** The Market UI
caches the capability disclosure per `scope`/`packId`/`runtimeId`/`projectId` —
but that key cannot encode the pack's current config revision, so a stale
`external` disclosure could be shown right before an enable after the user
switched the mode to `managed`. To prevent disclosing the wrong mode at the
moment of consent, `invalidateRuntimeCapabilities()` (`src/app/marketplace-page.ts`)
drops the whole disclosure cache on every marketplace view (re)load, so the
consent card always refetches against current server config before the enable
toggle. Coverage: `tests/marketplace-runtime-consent.spec.ts` (managed discloses
services/ports/volume/trust; external shows setup guidance; missing summary falls
back to static copy; the UI refetch drops a stale disclosure; master-toggle
counts include the `runtimes` array).

### `updatePack` and data survival

Updating a managed pack must not cost the user their memory. `updatePack` swaps
only the pack **contents** dir (atomic rename: stage → swap → drop), never the
bind-mounted Postgres data dir nor the supervisor's runtime-state dir. So across
a disable → `updatePack` → re-enable cycle the persisted host port, generated
secrets, and Postgres data all survive, and a re-enable reuses them. The
supervisor state subtree (`state/pack-runtimes/`) is additionally on the
`GATEWAY_OWNED_FILES` archive allowlist (see P2) so the archiver never moves live
runtime bookkeeping out from under a running container.

### Manual Docker integration test

Automated tests never touch Docker — `ctx.runtime` injection, the no-auto-start
invariant, mode mapping, and consent disclosure are all driven against mocks. The
full managed lifecycle against **real Docker** is verified manually by
`tests/manual-integration/hindsight-runtime.test.ts`. It drives the real
supervisor over the shipped manifest/compose through:

```text
enable (compose up, managed-postgres) → wait healthy → retain/recall round-trip
  → disable (compose stop) → bind data survives → updatePack → state + data survive
  → re-enable → recall still finds the marker
```

It isolates everything under a per-run temp dir (rendered env, generated secrets,
allocated ports, the Postgres bind dir) with a unique bank/namespace/marker, and
tears down (`down -v` + `rm`) in `finally` — so it never touches the user's
`~/.hindsight` or the production `bobbit` bank. It **skips cleanly** (never fails)
when Docker is unavailable, when `HINDSIGHT_API_LLM_API_KEY` is unset, or when the
digest-pinned images are not pullable — keeping the manual suite green everywhere
while doing real work only where a managed Hindsight can actually start.

```bash
HINDSIGHT_API_LLM_API_KEY=<key> npm run build \
  && node --import tsx --test tests/manual-integration/hindsight-runtime.test.ts
```

### P3 REST surface

Beyond the P2 routes above, P3 adds (admin-bearer only):

| Route | Method | Purpose |
|---|---|---|
| `/api/pack-runtimes/:id/capabilities?projectId=&mode=` | GET | Pure pre-start consent disclosure. Deployment-mode aware; `external` ⇒ `dockerRequired: false` + empty services/ports. |
| `/api/pack-runtimes/:id/down` | POST | `compose down`. Body `{ volumes?, removeState? }`: default preserves bind data (uninstall primitive); `volumes:true + removeState:true` is purge. |
| `/api/marketplace/purge-runtime` | POST | `{ packName, scope, runtimeId, projectId? }` → `down -v` + state removal. |
| `PUT /api/marketplace/pack-activation` | PUT | Toggling an `on-enable` runtime's pack disabled→enabled starts it (managed modes only); enabled→disabled stops it. Side effects run before persistence; a real failure → **502** with the prior activation so the UI reverts the toggle. |

## Related

- [marketplace.md](marketplace.md) — packs, `contents`, activation, precedence.
- [hindsight-memory.md](hindsight-memory.md) — the memory provider this runtime
  backs: deployment modes, config keys, dormancy, and the provider lifecycle.
- [lifecycle-hub.md](lifecycle-hub.md) — the hub that injects `ctx.runtime` and
  dispatches the provider hooks.
- [extension-host-authoring.md](extension-host-authoring.md) — the sibling
  contribution kinds (entrypoints, panels, routes) whose loader patterns the
  runtime loader follows.
