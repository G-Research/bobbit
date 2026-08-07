# Managed service-extension contract

Schema-2 packs can declare a small, declarative managed-service contract. It separates a pack's description of a service from the core-owned process lifecycle so packs cannot smuggle commands, paths, ports, or secrets through a general runtime API.

**Current status:** the declaration loader, active registry, lifecycle manager, and its
`service.manage` authorization seam are implemented and covered by focused tests, but the gateway
does not yet instantiate the manager or call `reconcile()`. The surface is dormant until Hindsight
or another explicit core consumer wires it. Declaring a runtime today starts no process, adds no
endpoint, and changes no existing provider behavior. The existing Hindsight external-provider
configuration remains unchanged.

## Declare a service

List a runtime basename in a schema-2 manifest, then place the declaration in `runtimes/<name>.yaml`:

```yaml
# pack.yaml
schema: 2
contents:
  roles: []
  tools: []
  skills: []
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

The manifest is the catalogue: an unlisted file is not loaded. Runtime ids and manifest basenames must be unique within a pack. Winner/precedence, install activation, per-runtime activation, and project settings filtering happen before the active registry returns a declaration. A disabled runtime, malformed settings declaration, unsatisfied `requiresConfig`, unreadable settings, or duplicate active identity is fail-closed. Merely listing a declaration never starts it.

### Closed declaration schema

The top-level runtime file permits only `id`, `service`, `config`, and `activation`. Top-level `id` is a lowercase safe, pack-local identifier of 1–64 characters. The nested `service` mapping is closed:

| Field | Contract |
|---|---|
| `runMode` | Exactly `local`, `docker`, or `compose`; core chooses the corresponding launcher. |
| `readiness` | Exactly one of a loopback `http:`/`https:` `url` or a core-recognized shell-free command identifier, plus `timeoutMs` from 100 to 60,000. Remote URLs, credentials, fragments, templates, shell names, and arbitrary command lines are rejected. |
| `stopGraceMs` | Integer from 100 to 60,000. |
| `restart` | `never` or `on-failure`. |
| `ports` | Optional, unique integer ports from 1 to 65,535; at most 32. |
| `dataDir` | Optional relative path made of safe segments. Core resolves it below a project-owned root; packs cannot select an absolute path, `..`, or backslash path. |

Unknown fields are validation failures, rather than forward-compatible pass-throughs. This is intentional: a newer pack must not silently request authority from an older host.

## Settings target and secrets

A runtime is an extension-settings target with identity `{ packId, kind: "runtime", id }`. Its optional `config` uses the same descriptor schema as providers and hooks. The project settings catalogue exposes only declared fields, redacted secret presence, enablement, and validation state; it never exposes secret bytes. See [Project extension settings](extension-settings.md).

At runtime, core reads effective settings immediately before launch and passes them only to its own launcher/probe seams. The read-only registry never receives settings values or a process handle. Settings/secret read failures are not treated as defaults and stop that declaration from becoming active. A manager that cannot obtain configuration publishes only the bounded `configuration-unavailable` status.

There is no runtime-specific public launch, stop, log, or status endpoint. Do not build UI or automation that assumes one exists.

## Lifecycle ownership

When a future core consumer explicitly constructs `ServiceExtensionRuntimeManager`, the manager owns lifecycle behavior. It receives the shared `ExtensionCapabilityGrantResolver` through its structural authorization seam and calls it with the server-derived `{ kind: "pack", packId }` principal and `service.manage`; it never reads YAML grants itself.

1. It obtains active declarations for one project, validates and copies them, requires the current exact `service.manage` grant, and keys each service by `(projectId, packId, serviceId)`.
2. It resolves an owned data directory, obtains each declared port lease, reads settings, launches through a core adapter, and probes readiness. It rechecks authorization at asynchronous lifecycle fences, so a revoke stops stale work from becoming a running service. Pack code receives none of these capabilities or the process handle.
3. It publishes only `{ id, state, updatedAt, detail? }`. Valid states are `stopped`, `starting`, `ready`, `unhealthy`, and `failed`; details are the fixed values `starting`, `readiness-timeout`, `port-conflict`, `process-exited`, and `configuration-unavailable`. Logs, paths, command lines, settings, and secrets are deliberately absent.
4. It stops the whole adapter-owned process/container with the declared grace period and releases leases on removal, failed start, project stop, and global shutdown. `on-failure` permits one restart for the current active declaration; `never` does not restart.

A status lookup refuses an ambiguous same-id result across packs. Consumers must keep the full service identity internally instead of treating an id as globally unique.

## Race safety

Lifecycle reconciliation is asynchronous, so the manager fences it with both a global generation and a per-project generation. Every asynchronous boundary—active-declaration read, settings read, directory creation, port lease, launch, and readiness probe—checks that its reconciliation generation is still current. A stale completion stops/abandons its just-created process and releases any lease instead of overwriting a newer desired state.

Operations for one service identity are serialized; unrelated projects and services can progress concurrently. Process-exit callbacks carry the running generation, so an exit from an old process cannot restart or stop its replacement. A project stop fences only that project; global shutdown fences all future reconciliation.

## Testing the contract

Use the focused tests while evolving this dormant surface:

```bash
npm run test:unit -- tests2/core/service-extension-contract.test.ts tests2/core/service-extension-runtime.test.ts tests2/integration/service-extension-registry.test.ts
```

The tests cover strict declaration rejection, status redaction, adapter selection, readiness and lease cleanup, bounded restart, active-registry settings filtering, and delayed reconcile/stop races. They do not imply gateway wiring: adding a production consumer requires its own lifecycle, configuration, observability, and shutdown coverage.
