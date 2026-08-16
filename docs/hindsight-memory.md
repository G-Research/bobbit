# Hindsight memory

The built-in **Hindsight** pack gives agents durable, project-scoped memory. It uses the
Extension Platform rather than its own control plane:

- **EP-7 project settings** own configuration, revisions, and write-only secrets.
- **EP-6 capability grants** decide each privileged action at the time it runs.
- The generic **service runtime** owns managed-service state, lifecycle, readiness, and logs.
- Typed pack routes are the shared data plane for the native panel and the five agent tools.

This separation keeps a configuration save harmless, prevents a panel or tool from escalating
its own authority, and makes the external, local, Docker, and Compose paths behave consistently.

## Open and configure Hindsight

Hindsight is shipped in the built-in Marketplace band. Enable it for the project, then configure
the **Hindsight / memory** provider in that project's Marketplace settings. Settings are
project-local: changing one project's URL, database, image, or secret never changes another
project's configuration.

To work with memories interactively, open **Hindsight Memory** from the session menu. The
singleton panel belongs to the current session. It is a workbench, not a settings editor; use
Marketplace for configuration and grants.

Opening the panel, saving settings, reading status, reading logs, automatic recall, and every
memory read do **not** start a service. A managed service starts only after an operator with a live
`service.manage` grant and a verified signed `bobbit_session` prompt-operator cookie confirms
**Start** or **Restart** in the panel. The confirmation is required but is not authentication.

### Settings and secrets

Marketplace saves each change against the current EP-7 revision. Reload the settings view and
try again if a save reports a revision conflict. A secret field is always blank in the form and
only reports whether a value is stored. Leaving an untouched secret blank preserves its stored
value; clearing it removes the stored value. API keys, registry credentials, and database URLs
are never returned in settings, runtime status, diagnostics, route results, or logs.

| Setting group | Settings | Notes |
|---|---|---|
| Service endpoint | `runtimeMode`, `externalUrl`, `apiKey` | `externalUrl` is used in `external` mode. `apiKey` is an optional **external-service-only** Hindsight bearer token: it is never sent to a local, Docker, or Compose runtime, and is never shown after saving. |
| Memory behavior | `bank`, `namespace`, `autoRecall`, `autoRetain`, `recallBudget`, `timeoutMs`, `retainEveryNTurns`, `retainMaxDelayMs` | Defaults are bank `bobbit`, namespace `default`, automatic recall/retain enabled, a 1200-token recall request budget, a 1500 ms client timeout, one turn per retain batch, and a 60-second maximum batch delay. |
| Local inference | `localLlmProvider`, `localLlmModelId`, `localLlmBaseUrl`, `localLlmApiKey`, `localLlmContextTokens`, `localLlmMaxOutputTokens`, `localLlmResidency`, `localLlmKeepAlive` | The provider is `openai-compatible` or `ollama`. Settings select a model; saving them does not contact it. |
| Image and registry | `ociImage`, `registryCredentials` | Used by Docker or Compose only when an explicit start/restart resolves the image. |
| PostgreSQL storage | `databaseMode`, `externalDatabaseUrl` | Select the Compose-owned durable volume or an independently operated PostgreSQL database. |
| Compatibility setting | `dataDir` | A generic runtime-owned state path. It must **not** point at a live legacy PostgreSQL `pg0` directory and is not evidence that Hindsight uses that directory for database storage. |

All numeric limits must be positive. Empty optional URL and secret fields clear their override.

## Choose a runtime mode

`runtimeMode` selects an endpoint source. It does not start, probe, pull, or allocate anything.
A provider is active only with a usable endpoint.

| Mode | Endpoint and start behavior | Storage requirements |
|---|---|---|
| `external` | Set a valid HTTP(S) `externalUrl`. It is used directly; managed runtime controls do not apply. | The operator owns the remote service and database. |
| `local` | An explicit start runs the local `hindsight serve` adapter. Set a local model ID and HTTP(S) local-model URL first. | Configure `databaseMode: external` and a write-only `externalDatabaseUrl` before starting. A local managed volume is deliberately not accepted because storage continuity cannot be proven. |
| `docker` | An explicit start resolves/pulls the configured OCI image and runs the Docker adapter. | Configure an external PostgreSQL database before starting for the same continuity reason as local mode. |
| `compose` | An explicit start uses the Hindsight Compose asset and publishes the API on a dynamically allocated loopback port. | `managed-volume` is supported: Compose owns a durable `hindsight-postgres` named volume. An external database is also supported when its secret URL is configured. |

For every managed mode, the runtime status is one of `stopped`, `starting`, `ready`, `degraded`,
`blocked`, or `unavailable`. Only `ready` supplies an endpoint to the memory provider. A down,
unhealthy, blocked, or unavailable runtime does not fall back to an external or paid provider;
reads return an explicit unavailable result and writes fail or use their existing durable
provider queue where applicable. The agent session stays usable instead of waiting for recovery.

`apiKey` has no managed-mode fallback. The Hindsight client attaches it only when
`runtimeMode: external`; local, Docker, and Compose use their ready runtime endpoint without
that bearer token. Managed credentials are limited to their separately declared write-only model,
registry, and database secret fields.

The service descriptor probes `/health` with a bounded request and has manual start policy. It
may retry a failed managed start within its bounded runtime policy, but it never begins work merely
because a setting or panel was read.

### Local model configuration and residency

Hindsight supports the resident Qwen3-Coder MLX OpenAI-compatible service delivered separately
by Apple Model Lab, but the integration is provider-generic. Configure either an
OpenAI-compatible or Ollama HTTP(S) endpoint and its model ID. The Hindsight pack neither starts
nor probes that model service when settings are saved.

A managed start requires:

- a model ID and valid local-model HTTP(S) endpoint;
- `localLlmResidency: resident` (request-scoped residency is rejected);
- a positive context limit, output limit, and keep-alive value; and
- `localLlmApiKey` only for a non-loopback endpoint.

A loopback HTTP endpoint (`localhost`, `127.0.0.1`, or `::1`) needs no placeholder key. Runtime
diagnostics can identify the selected provider, safe endpoint host, model ID, limits, residency,
keep-alive, and a post-start observed load ID. They never expose a URL path, query, credential, or
secret. Resident operation is configured to reuse the selected local model across sequential
requests; no fallback model is configured.

### OCI images and offline deployments

The default image is the reviewed Hindsight 0.8.6 digest reference:

```text
ghcr.io/vectorize-io/hindsight:0.8.6@sha256:274704505b2720ac9a5c816c559044c1e8c6b51d47017317ae049ed2952f5ab1
```

You may replace it with a syntactically valid private-registry reference, tag, or SHA-256 digest.
Saving validates syntax only; it does not discover a release, log in to a registry, inspect or
pull an image, or start a container. This makes an offline manual reference usable even when
online discovery is unavailable.

A reference with a digest is pinned. A tag without a digest is accepted but surfaces the
`OCI_REFERENCE_MUTABLE_TAG` warning because a later pull can produce different bytes. Registry
credentials are write-only and are used only in memory for an explicit Docker/Compose start or
restart.

## Protect existing memories and PostgreSQL data

Do not bind-mount a live PostgreSQL `pg0` data directory into Hindsight. The supplied Compose
configuration uses its own named `hindsight-postgres` volume, which ordinary stop, restart, and
pack cleanup retain. It does not use `down -v`.

Changing a mode or database target must preserve the bank already in use. The Service tab can
create a redacted logical migration plan that identifies source and target storage, a custom dump
artifact, compatibility checks, rollback routing, and an exact confirmation phrase. Plan creation
is non-destructive and requires `service.manage`.

**Current execution limit:** the installed runtime intentionally has no PostgreSQL migration
connector. Applying a plan returns `HINDSIGHT_MIGRATION_CONNECTOR_UNAVAILABLE`; no source,
target, or backup is changed. Do not treat a planned migration as completed and do not switch to a
new managed store expecting memories to appear. Keep the existing external database configured,
or perform an audited logical `pg_dump`/restore using your database operations procedure before
changing the active storage. The intended logical sequence is: stop writers, make and validate a
custom-format dump, create the target, restore it, verify Hindsight health plus retain/recall/
reflect, then switch routing. On failure, retain the source and backup and restore source routing.

This fail-closed behavior is intentional: it is safer to block a potentially destructive switch
than silently begin with an empty bank.

## Grants and scope

Grant capabilities to the `hindsight` pack for the project in Marketplace. The route boundary
checks the live EP-6 decision before dispatch and again before remote work where a grant could
have changed. A previous allow does not survive a later revoke.

| Capability | Required for |
|---|---|
| `service.manage` | Start, stop, restart, create a migration plan, and attempt migration execution. |
| `memory.read` | Project/goal-scoped browse, search, detail, history, and ordinary recall. |
| `memory.write` | Manual retain and retaining a completed goal outcome. |
| `memory.reflect` | Scoped reflection. |
| `memory.invalidate` | Confirmed invalidation of a selected memory. |
| `memory.read.all` | An explicit `scope: all` browse, search, detail, history, or recall request. |

Normal memory operations derive the project and, when available, goal from the authenticated
session. A request body cannot select another project. Normal reads use strict matching tags for
that project and goal; all-scope is never an implicit fallback. `memory.read.all` is required only
when the caller explicitly requests all scope, and it does not replace the ordinary read grant
needed by reflection.

A denied or missing grant fails closed with a structured capability error. `runtime-control` and
`migration-execute` additionally require a verified signed `bobbit_session` prompt-operator cookie:
bearer-only, sandbox, and agent-session callers receive
`403 PROMPT_EXTENSION_OPERATOR_REQUIRED`. Their body `consent` or `confirmation` is required but
is not authentication. `migration-plan` is non-destructive and remains `service.manage` grant-only.
The Hindsight panel's **Access** tab shows these six capabilities and links back to Marketplace; it
cannot create its own grants.

## Use the Hindsight Memory panel

The session-menu entry opens the `hindsight.memory` panel for the active session. The panel uses
only pack-bound typed routes and keeps its request, selection, search, dialog, and focus state in
memory. Closing it, changing sessions, disabling the pack, or uninstalling the pack clears that
state and prevents a late route result from painting into another session.

### Service tab

The **Service** tab shows the generic runtime state, configured mode, desired state, ready
endpoint, and bounded diagnostic logs. Refreshing status and reading logs are read-only. Start,
stop, and restart open a confirmation dialog; the resulting control route requires a live
`service.manage` grant, a verified signed `bobbit_session` prompt-operator cookie, and
`consent: true`. Consent is not authentication; bearer-only, sandbox, and agent-session callers
receive `403 PROMPT_EXTENSION_OPERATOR_REQUIRED`. External mode has no managed service to control.

The tab also exposes migration planning. It explains that migration is logical rather than a live
PostgreSQL-directory mount and shows the exact confirmation text on a successful plan. See
[Protect existing memories and PostgreSQL data](#protect-existing-memories-and-postgresql-data)
for the current execution limitation.

### Memories tab

The **Memories** tab provides:

- browse/search within the current project and goal;
- a selected-memory detail request;
- a quick manual retain field;
- a scoped reflection prompt for the active project/goal;
- a required invalidation reason followed by a confirmation dialog; and
- **Retain completed outcome**, which asks the host for the current completed goal's bounded
  outcome rather than accepting manually supplied outcome text.

The panel's invalidation request carries the selected ID as the exact confirmation value. The
route verifies that the memory belongs to the current project/goal before invalidating it. A
completed-outcome request succeeds only when the session has a completed goal and the host can
produce its trusted goal/task/gate snapshot; otherwise it returns `OUTCOME_UNAVAILABLE`.

The panel does not automatically read memories on open. Its empty state asks the user to search
or browse. It provides a live status region for results and errors, keyboard-operable tabs, visible
focus styling, and a focus-trapped confirmation dialog that supports Escape and restores focus on
close.

## Automatic provider behavior

When enabled and granted `memory.read`, the memory provider adds a bounded **Relevant memory**
context block during session setup and before prompts. It remains inactive until external mode has
a URL or a managed runtime is ready. Setting `autoRecall: false` disables those blocks. Automatic
turn and compaction retention also needs `memory.write`; `autoRetain: false` disables it.

Hindsight does not create a bank per project. Projects that use the same configured bank and
namespace (by default, `bobbit` and `default`) share that Hindsight bank; authoritative tags keep
normal project and goal operations narrow:

| Tag | Use |
|---|---|
| `project:<projectId>` | Required for normal retain and recall. |
| `goal:<goalId>` | Added when the session has a resolved goal. |
| `agent:<role>` and `session:<sessionId>` | Retention provenance when available. |
| `kind:turn`, `kind:compaction`, `kind:outcome` | Automatic retention record type. |
| `kind:manual` | Typed manual retain route record type. |

The provider batches primary-turn summaries according to the configured cadence and persists its
queue so work is not lost when a short-lived worker exits. It retains a host-built completion
outcome on goal completion. Remote failure is non-fatal only after the retry item has been written
durably; unreadable durable state is reported as unavailable rather than mistaken for an empty
queue.

### Epic completion map

| Item | Delivered surface | Key invariant |
|---|---|---|
| H-2 — IDs, cleanup, stray memories | Collision-safe, project-partitioned pending/queue identities; deadline-bound sweep and scope-preserving stranded recovery. | A prefix/list result is revalidated against the complete identity, so records cannot cross projects, goals, banks, or namespaces. |
| H-3 — remaining hardening | Generic Extension Host mutation, deadline, lifecycle-delivery, and tri-state-read foundations. | A failed or unreadable durable operation is never reported as a committed or empty result. See [foundation provenance](design/hindsight-foundation-provenance.md). |
| H-4 — panel, tools, managed runtime | This panel, the five tools, typed routes, and the mode-independent local/Docker/Compose runtime. | UI and tools consume redacted EP-7 settings, live EP-6 grants, and the shared ready-endpoint contract; they do not own a client lifecycle. |
| H-5 — goal completion | Host-originated `goalCompleted` delivery and `hindsight_retain_outcome`. | The durable completion marker follows remote success or a confirmed durable queue entry, never a failed/unknown write. |
| H-6 — goal recall | Authoritative session project/goal scope for normal browse, recall, and reflection. | Missing scope fails closed before a remote call; `scope: all` is explicit and needs `memory.read.all`. |

The H-2, H-5, and H-6 mechanics are detailed in [Hindsight memory completion](design/hindsight-memory-completion.md). H-3 is an outcome audit rather than a replay of the old hardening package; H-4 is the operational surface documented here.

## Agent tools

Hindsight contributes exactly these data-plane tools. Each is a thin adapter over the same
authenticated typed route used by the panel; it has no direct Hindsight client, settings, secret,
Docker, runtime-control, or migration implementation. None of the five tools invokes
`runtime-control`, `migration-plan`, or `migration-execute`.

| Tool | Parameters | Behavior |
|---|---|---|
| `hindsight_recall` | `query`, optional `scope: project | all` | Recalls scoped memories. `project` is the default; `all` requires `memory.read.all`. |
| `hindsight_retain` | `content`, optional `kind` | Retains text in the current project/goal and requires `memory.write`. The current route derives the stored `kind:manual` tag; `kind` is accepted by the tool adapter but does not choose route tags. |
| `hindsight_reflect` | `prompt`, optional `memoryIds` | Produces a reflection over the authoritative current project/goal and requires `memory.reflect` plus ordinary read access. The current route scopes the whole resolved project/goal; supplied IDs do not broaden or select a different scope. |
| `hindsight_invalidate` | `id`, `confirmation`, optional `reason` | Invalidates one in-scope memory only when `confirmation` exactly equals `id`; requires `memory.invalidate`. |
| `hindsight_retain_outcome` | none | Retains the host-supplied outcome of the current completed goal; requires `memory.write`. It ignores caller-supplied outcome content. |

Tool and route requests have bounded text and result sizes. A missing session credential or
pack-surface token yields `HINDSIGHT_ROUTE_UNAVAILABLE`; service-down data operations return
structured unavailable/unhealthy results instead of hanging.

## Typed route reference

The Hindsight pack registers the following routes for its bound panel and tool surfaces. These are
not a second public lifecycle API: callers receive the current session's authenticated project
scope, EP-7 settings projection, runtime context, and live capability decision from the host.

| Route | Purpose |
|---|---|
| `runtime-status` | Returns the project runtime projection and settings revision without secrets. |
| `runtime-control` | Takes `{ action: "start" | "stop" | "restart", consent: true }`; requires a live `service.manage` grant and a verified signed `bobbit_session` prompt-operator cookie. Consent is not authentication. |
| `runtime-logs` | Returns a bounded trailing log list; `tail` is clamped to 1–200 lines. |
| `migration-plan` | Creates a redacted logical migration plan; requires `service.manage` only. |
| `migration-execute` | Attempts a confirmed plan; requires a live `service.manage` grant, a verified signed `bobbit_session` prompt-operator cookie, and the exact plan confirmation. Confirmation is not authentication. |
| `browse` / `search` | Lists current-scope memories with optional query, cursor, and limit. `scope: "all"` requires `memory.read.all`. |
| `detail` / `history` | Reads one memory or its history only after scope validation. The current panel uses `detail`; `history` is available to typed route consumers. |
| `recall` | Requires a non-empty query and returns recalled memories under the resolved scope. |
| `retain` | Requires non-empty content and derives the project/goal/manual tags server-side. |
| `reflect` | Requires a prompt and produces a current project/goal-scoped reflection. |
| `invalidate` | Requires an in-scope ID and exact ID confirmation. |
| `retain-outcome` | Retains only the host-derived completed-goal snapshot. |

Data-plane routes stop within their bounded route deadline. An inactive external configuration
returns an empty inactive result for reads; a managed runtime that is not ready returns
`SERVICE_UNHEALTHY`. Neither case constructs a client, starts a runtime, or falls back to a
different endpoint.

## Release hold: human managed-mode verification

Automated coverage proves the generic adapter matrix and degraded behavior, but this epic must
not merge to `main` until a human has tested **both Hindsight Docker and Hindsight Compose** on
the target environment. For each mode, explicitly start the service, verify a ready state and a
retain/recall round trip, stop and restart it, and confirm the expected storage survives. Record
that result in the parent PR. A Docker/Compose prerequisite failure or an automated skip is not a
substitute for this hold.

## See also

- [Project extension settings](extension-settings.md) — revisions, field semantics, and write-only
  secrets.
- [Extension capability grants](rest-api.md#extension-capability-grants) — project-owned EP-6
  grants and administrative API.
- [Managed service runtimes](managed-runtimes.md) — generic runtime state and lifecycle contract.
- [Lifecycle Hub](lifecycle-hub.md) — how provider context blocks are delivered.
- [Historical external-mode design](design/hindsight-pack-external.md) — REST mapping and original
  bank-topology rationale; it is not the current configuration or authorization contract.
