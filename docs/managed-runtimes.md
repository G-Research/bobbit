# Managed runtimes (P1 — pure manifest + helper layer)

Bobbit packs can ship **managed runtimes**: a declarative description of a
containerised service stack (images, env, secrets, ports, launch modes) that
Bobbit prepares and — in a later phase — runs via Docker Compose on the user's
behalf. The motivating example is the **Hindsight** stack (API + web UI +
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

```yaml
id: hindsight                       # REQUIRED. /^[a-z0-9][a-z0-9_.-]*$/i
title: Hindsight                    # OPTIONAL.
description: >-                     # OPTIONAL.
  Managed Hindsight stack — API + web UI backed by Postgres.

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

`market-packs/hindsight/` is the first managed-runtime pack and exercises every
schema feature. Its compose template (`runtime/compose.yaml`) is **static and
digest-pinned** (`image@sha256:<64 hex>` for `api`, `web`, and `db`) for
reproducibility, and is **never executed in P1** — it is only ever selected from
and resolved as a path.

The descriptor declares two **generated** secrets (`HINDSIGHT_DB_PASSWORD`,
`HINDSIGHT_API_SECRET`), two **ports** (`HINDSIGHT_WEB_PORT` → container 3000,
`HINDSIGHT_API_PORT` → container 8080), and wires the LLM API key from a
**user-configured** secret via `HINDSIGHT_API_LLM_API_KEY: { secret: ... }` —
the only user-supplied secret; everything else is generated.

### Managed vs external Postgres

The two modes differ only in how the database is provided:

- **`managed-postgres`** — includes the `db` service. The data directory is a
  host **bind mount** that defaults to `${dataDir:-~/.hindsight}` (the
  `dataDir` var, or `~/.hindsight` when unset). The connection string is built
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

## Related

- [marketplace.md](marketplace.md) — packs, `contents`, activation, precedence.
- [extension-host-authoring.md](extension-host-authoring.md) — the sibling
  contribution kinds (entrypoints, panels, routes) whose loader patterns the
  runtime loader follows.
