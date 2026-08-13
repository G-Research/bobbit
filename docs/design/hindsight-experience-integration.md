# Hindsight experience integration

**Status:** historical implementation design for H-4. H-4 is delivered; use the operational [Hindsight memory pack](../hindsight-memory.md), [managed service runtimes](../managed-runtimes.md), and [project extension settings](../extension-settings.md) as the current contract. This record preserves the design rationale and must not override those references.

## Decision

Use **typed Hindsight pack routes**, the existing generic runtime, EP-6 exact pack grants, and EP-7 project settings. The native panel is a consumer of those projections; it owns no durable authority or configuration. Agent tools are thin, capability-checked adapters over the same typed routes.

| Same-scope approach | Result |
|---|---|
| Port PR #820’s Hindsight-specific panel/supervisor/configuration and permission logic | Reject. It duplicates runtime ownership, has Compose-centric state, and cannot safely coexist with EP-6/EP-7. Its UX and tool inventory are reference material only. |
| Add Hindsight-only REST, grants, secret storage, and panel state beside the platform | Reject. It creates conflicting revisions, secret redaction, activation, and cleanup semantics. |
| **Compose EP-6 + EP-7 + `ServiceRuntimeSupervisor` + pack routes** | **Choose.** One grant owner, one settings revision/secret owner, one runtime state machine, and one route protocol for panel and tools. A later LangFlow descriptor/provider uses the same boundaries with no host branch. |

No setting save, panel open, status/log read, provider hook, memory route, or tool starts a service. Only an explicitly consented, EP-6-authorized control route may call `start`, `stop`, `restart`, or destructive migration/purge work.

## Ownership and additions

### Existing seams to compose

| Owner | Existing seam | H-4 use |
|---|---|---|
| EP-6 | `src/server/agent/extension-grant-policy.ts::createExtensionCapabilityGrantResolver`; project routes in `src/server/server.ts` | Resolve the live `{ kind: "pack", packId: "hindsight" }` grant immediately before every protected route/tool operation. Revocation wins over cached UI state. |
| EP-7 | `ExtensionSettingsStore`, `extensionSettingsTargetKey`, `getForRuntime`, and the settings GET/PATCH routes | Declare all typed values in `market-packs/hindsight/providers/memory.yaml`; persist per-project non-secrets/revision and write-only secrets only through EP-7. |
| Generic runtime | `src/server/service-runtime/service-supervisor.ts::{status,context,start,stop,purge,diagnostics,reconcile}` and `ServiceRuntimeStatus` | Add a host bridge that resolves Hindsight’s EP-7 runtime settings and delegates lifecycle. Provider receives only `ServiceRuntimeContext`. |
| Typed pack routes | `RouteRegistry`, `RouteDispatcher.dispatch`, `/api/ext/route/:name`, `host.callRoute` | Pack routes validate request shape, resolve authoritative route scope, check a centrally injected grant decision, and call pack/client/runtime adapters. |
| Native pack UI | `src/app/{pack-panels,pack-entrypoints,host-api}.ts` | Add one session-menu launcher and one panel; use its pack-bound host and `host.callRoute`, never raw privileged fetch. |

### New files and state

| File | Responsibility |
|---|---|
| `market-packs/hindsight/panels/hindsight-memory.yaml` | Declares `hindsight.memory` panel, singleton per session, served panel bundle. |
| `market-packs/hindsight/entrypoints/hindsight-session-menu.yaml` | Declares the `session-menu` launcher targeting `hindsight.memory`. |
| `market-packs/hindsight/src/panel.ts` and built `market-packs/hindsight/lib/panel.mjs` | Accessible overview/settings, memories, and access tabs; ephemeral request/search/selection/modal state only. |
| `market-packs/hindsight/src/routes.ts` | Replaces legacy mutable `config` behavior with typed, grant-aware Hindsight route adapters described below. |
| `market-packs/hindsight/src/memory-routes.ts` | Request validators and route-to-client mapping; no runtime control, settings persistence, or grant store. |
| `market-packs/hindsight/src/tools.ts` and `market-packs/hindsight/tools/hindsight/*.yaml` | Five agent tool action adapters and their manifest descriptions. They call the same route handlers, not a second client protocol. |
| `market-packs/hindsight/src/runtime-settings.ts` | `HindsightRuntimeSettingsAdapter`: resolves declared EP-7 values/secrets, validates OCI/local model fields, selects managed mode, and supplies the generic runtime settings resolver. |
| `market-packs/hindsight/src/migration.ts` | Logical PostgreSQL backup, compatibility check, restore/rollback plan and external-database validation. |
| `market-packs/hindsight/runtime/compose.yaml` | Revised Compose asset: durable named volume by default, optional external DB only through materialized secret env, no live `pg0` bind mount. |
| `src/server/agent/hindsight-runtime-bridge.ts` | Host integration seam: projects `ServiceRuntimeStatus`, implements EP-6 control authorization, and wires `HindsightRuntimeSettingsAdapter` into the generic supervisor. No Hindsight lifecycle branch in `server.ts`. |
| `src/server/server.ts` | Constructs/injects the bridge, exposes generic typed runtime control/status/log routes, and passes an ephemeral route capability resolver to the Hindsight pack route context. |
| `src/app/api.ts` | Adds typed runtime, migration, and Hindsight route-client wires; retains the redacted EP-7 types rather than creating a parallel settings response. |
| `scripts/build-market-packs.mjs` | Builds Hindsight server modules and `panel.ts`; `scripts/copy-builtin-packs.mjs` ships the new assets. |

The only added durable state is generic runtime state under `ServiceRuntimeStore`, EP-7’s project `extension_settings` row and secret store, and migration artifacts under the runtime-owned state directory (`backup` manifest and temporary logical dump). The panel holds no durable state. It clears its selected memory, search text, pending requests, abort controllers, focus return target, and secret input text on close, session/project change, pack disable/uninstall, or route registry reconciliation.

## Settings and capability contract

### EP-7 Hindsight provider fields

`memory.yaml` keeps existing memory settings and adds the following flat descriptors. `runtimeMode` remains `external | local | docker | compose`; choosing it saves configuration only. `externalUrl` remains the only endpoint source in external mode.

| Field | Type | Meaning / validation |
|---|---|---|
| `localLlmProvider` | enum `openai-compatible | ollama` | Default `openai-compatible`; provider-generic. |
| `localLlmModelId` | string | Required for managed local inference; bounded token/string, shown in diagnostics. |
| `localLlmBaseUrl` | string | Valid HTTP(S) URL. Loopback `http://127.0.0.1`, `localhost`, or `::1` requires no key; never probe on save. |
| `localLlmApiKey` | secret, optional | Write-only only; required only by a non-loopback endpoint policy. Never exposed in config/status/logs. |
| `localLlmContextTokens`, `localLlmMaxOutputTokens` | number | Positive bounded limits passed only as declared runtime environment/settings. |
| `localLlmResidency` | enum `resident | request` | Default and supported deployment target is `resident`; `request` is rejected for Hindsight managed mode because it violates sequential reuse. |
| `localLlmKeepAlive` | number | Positive keep-alive duration; forwarded to a provider that supports it, otherwise shown as unsupported/blocked before start. |
| `ociImage` | string | Optional Docker/Compose Hindsight OCI reference; defaults to the reviewed 0.8.6 digest reference. |
| `registryCredentials` | secret, optional | Write-only registry credential material used only immediately before explicit Docker/Compose pull/start; never written to image, argv, logs, or status. |
| `databaseMode` | enum `managed-volume | external` | `managed-volume` is default. External mode requires the secret `externalDatabaseUrl`. |
| `externalDatabaseUrl` | secret, optional | Write-only PostgreSQL connection URL, required only in external mode. |

`llmApiKey` is retired in favor of `localLlmApiKey`; old values may be read only through the existing EP-7 legacy fallback before a target row exists, then are excluded. `apiKey` remains Hindsight external-service authorization, not a model key. The panel uses `getExtensionSettings`/`patchExtensionSettingsTarget` and current `expectedRevision`; it never calls the old pack `config` write route. A save updates the current revision and redacted target, invalidates runtime/provider resolution, and does **not** call health, model discovery, Docker, Compose, or a pull.

### Exact EP-6 mapping

All are pack-principal grants for `hindsight`, one per project, displayed and changed through the existing grants UI. A denied action returns structured `403 EXTENSION_CAPABILITY_DENIED`; an absent grant returns `403 EXTENSION_CAPABILITY_REQUIRED`. The panel explains the grant and offers the existing grant UI; it does not mint grants itself.

| Capability | Protected operations |
|---|---|
| `service.manage` | Runtime status logs are readable without it; start, stop, restart, migration execution, rollback, destructive replacement, and purge require it plus explicit operator confirmation. |
| `memory.read` | Scoped browse, search, item detail, ordinary `hindsight_recall`. |
| `memory.write` | `hindsight_retain`, retained/manual memory creation, completed outcome write. |
| `memory.reflect` | Scoped panel reflection and `hindsight_reflect`. |
| `memory.invalidate` | Confirmed panel invalidation and `hindsight_invalidate`. |
| `memory.read.all` | Only an explicitly requested all-scope browse/search/recall. It never substitutes for the ordinary project/goal scope grant. |

The route context’s authoritative `scopeContext` determines project/goal tags. Request bodies cannot select another project or broaden scope. A normal read requires `memory.read` and uses strict project + available goal tags. All-scope is available only when both the caller explicitly asks for it and the live EP-6 resolver permits `memory.read.all`; otherwise fail closed without a Hindsight request.

## Route, tool, and panel flow

### Typed routes

Add these names to `market-packs/hindsight/pack.yaml::routes.names`; each returns a typed discriminated result with sanitized `code`, never an upstream error body or secret. They run in the existing confined route worker but receive host-provided adapters, not Docker access.

| Route | Input / result | Grant and behavior |
|---|---|---|
| `runtime-status` | `{}` → `{ runtime: ServiceRuntimeStatus, model?: RedactedModelDiagnostic }` | Read-only `supervisor.status`; no secret resolution or start. |
| `runtime-control` | `{ action: start|stop|restart }` → status | `service.manage`, modal-confirmed by UI; delegates bridge → generic supervisor. |
| `runtime-logs` | `{ tail }` → sanitized bounded lines | Runtime diagnostics only; no control side effect. |
| `migration-plan` | `{ source, target }` → redacted plan/compatibility/rollback steps | `service.manage`; computes only, never dumps/restores. |
| `migration-execute` | `{ planId, confirmation }` → progress/outcome | `service.manage`; exact confirmation and saved plan fingerprint required. |
| `browse` / `detail` / `recall` | cursor/query/id/scope → redacted memory rows/detail | `memory.read`, plus `memory.read.all` only for `scope: all`. |
| `retain` | `{ content, kind? }` → `{ ok, outcomeId? }` | `memory.write`; server derives tags, bank, namespace, and document identity. |
| `reflect` | `{ prompt, memoryIds? }` → scoped reflection | `memory.reflect`; IDs must belong to the resolved scope. |
| `invalidate` | `{ id, confirmation }` → result | `memory.invalidate`; exact selected-id confirmation. |
| `retain-outcome` | `{ outcome }` → `{ ok, outcomeId }` | `memory.write`; accepts only bounded completed goal/task/gate summary supplied by the host lifecycle context, not arbitrary cross-project metadata. |

Route handlers call the current `HindsightClient` only after `isActive(config, runtime)` is true. A stopped, starting, degraded, blocked, unavailable, down, or unhealthy service returns a prompt bounded `configured/inactive` or `SERVICE_UNHEALTHY` result; it neither waits for recovery nor selects an external endpoint. Retain continues to use the established durable queue only when its existing queue persistence succeeds.

### Tools

Declare exactly `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`, `hindsight_invalidate`, and `hindsight_retain_outcome` in the Hindsight pack tool group. Their `actions` module maps arguments one-to-one to the corresponding typed route adapter, validates only tool shape/size, and serializes the route result. It does not import `HindsightClient`, `ServiceRuntimeSupervisor`, Docker, Compose, settings, or secret stores. Tool descriptions state their scope and grant requirements; `hindsight_recall` exposes `scope: project` by default and `scope: all` only as an explicit value that hits the EP-6 all-read check.

### Panel

The session-menu item opens the singleton `hindsight.memory` panel for the active session. Its tabs match `docs/design/hindsight-service-runtime.prototype.html`:

1. **Overview and settings** reads EP-7’s redacted target and `runtime-status`; edits declared settings through revisioned EP-7 PATCH; presents mode cards, model/endpoint diagnostics, status icon+text, start/stop/restart, logs, and migration plan. A secret password input starts blank and is cleared after every save outcome.
2. **Memory** debounces/cancels browse/search, has an accessible result list and detail pane, and invokes typed `detail`, `reflect`, and the two-confirmation invalidation flow. It supports loading, empty, unavailable, stale, unhealthy, and error states without colour-only meaning.
3. **Agent access** displays the six EP-6 capability rows from the existing grant projection and links to the normal grant/deny flow rather than duplicating it.

The panel performs an initial read only after mounting; no mount action mutates, starts, probes, reflects, retains, or invalidates. It uses a live region for load/action outcomes, `role=tablist` with linked `tabpanel`s, labelled inputs/buttons, visible focus outlines, Escape/close focus restoration, modal focus trap and return, and disabled buttons with explanatory text. At `<900px` it stacks runtime/settings and browse/detail; at `<620px` controls stack while retaining keyboard order. Close/uninstall/disable/session switch aborts requests and subscriptions, drops transient text and focus state, and prevents late promises from repainting a disposed panel.

## Managed deployment details

### Local Qwen MLX service

The supported local deployment is the separate Apple Model Lab’s resident Qwen3-Coder MLX OpenAI-compatible service. Hindsight integrates it generically as a configured OpenAI-compatible or Ollama endpoint; it does not start, probe, or own that model service on save.

At explicit Hindsight start, `HindsightRuntimeSettingsAdapter` materializes the selected provider/base URL/model/limits/keep-alive into declared runtime environment values. For a loopback OpenAI-compatible service, omitted `localLlmApiKey` is valid. For a non-loopback service, a missing required key blocks start with a redacted code. Status identifies provider, redacted/safe endpoint host, model id, residency setting, and keep-alive—not a credential. It must never route an unavailable local request to an external or paid model: absent/unhealthy local model leaves the Hindsight runtime `blocked`/`degraded`; retain/reflect returns promptly and preserves ordinary queue behavior. The runtime test fixture records process/load identity; two sequential retain/reflect calls must use the same model-service process/load while resident.

### Offline OCI configuration

`parseOciReference` in `runtime-settings.ts` accepts registry/repository names, private-registry ports, tags, and `@sha256:<64 hex>` digest references; it rejects whitespace, shell/control characters, URL schemes, traversal, and malformed digest/tag syntax. A digest is pinned. A tag without a digest is accepted with an explicit **mutable tag** warning, never rejected. The default is the reviewed Hindsight 0.8.6 digest/reference, replacing the current `latest` label while retaining a user’s manual override.

Saving an OCI setting is syntax validation and EP-7 persistence only: no discovery, registry login, image inspection, network resolution, Docker call, or pull. Explicit start/restart is the only point that resolves/pulls it. Registry credentials are resolved from EP-7 only in memory at that point, supplied through an owner-only mechanism, redacted from command output, and never included in `ServiceRuntimeStatus`, runtime state, logs, route errors, or UI DOM. Offline discovery failure leaves the manually entered syntactically valid reference usable.

### PostgreSQL preservation and migration

Never bind-mount a live legacy `pg0` data directory into a container. The managed Compose default owns a durable named volume labelled by server/pack/runtime identity; `down -v` is forbidden for ordinary stop/restart/uninstall. External database mode injects only the write-only `externalDatabaseUrl` at explicit start and shows a redacted target summary.

A mode switch that can replace storage must first create a `migration-plan` with source/target identities, free-space estimate, Hindsight/PostgreSQL schema/version checks, backup location, and rollback command. `migration-execute` requires an exact phrase plus plan fingerprint, stops writers, runs `pg_dump --format=custom` from the source, validates dump/schema compatibility before touching target, restores into a newly created target database/volume, performs a Hindsight health plus retain/recall verification, then switches the active endpoint. The old database/volume is retained until the operator separately confirms deletion. Any failure keeps the previous endpoint/storage authoritative; rollback stops the new service, restores the old routing record, and retains the dump and error manifest. A restart/mode change must verify the expected bank/known marker before declaring success; it must never silently initialize a fresh empty bank.

## Error, lifecycle, and cleanup rules

- Runtime state is rendered directly from generic `ServiceRuntimeStatus`: `stopped`, `starting`, `ready`, `degraded`, `blocked`, and `unavailable`, with explicit variants for service down, unhealthy readiness, Docker unavailable, port conflict, retained data, stale settings, and migration-required. Text and icon convey every state.
- All health, Hindsight, route, model, Docker, and migration operations use their declared bounded deadline and `AbortSignal`. UI cancellation is not treated as success. A down/unhealthy session remains usable and no caller waits for automatic recovery.
- Settings revision mismatch returns `EXTENSION_SETTINGS_REVISION_CONFLICT`; panel reloads the redacted target and keeps no entered secret. Stale runtime settings return `SERVICE_SETTINGS_STALE`; save then explicit restart is required.
- Pack disable/uninstall closes the panel, unregisters its session-menu entrypoint, aborts panel work, stops only explicitly requested runtime resources, and preserves storage by default. Purge and destructive migration replacement require separate exact confirmation. Removing the pack never leaks secrets or leaves a live panel route/launcher.
- LangFlow is not implemented. Its author declares a descriptor/provider/settings and consumes the same bridge; no server change is needed.

## Acceptance and verification

### Acceptance criteria

1. All Hindsight configuration is revisioned EP-7 state; GET/PATCH/UI/log/WS/test diagnostics never expose `apiKey`, model key, registry credential, or DB URL.
2. Each protected operation is denied/granted by the current EP-6 exact pack grant; project scope cannot be forged, normal recall is narrow, and all-scope recall needs `memory.read.all`.
3. A selected managed mode remains inert until a user-consented `service.manage` start. `ServiceRuntimeStatus` is the sole runtime status wire and provider/client code branches only on endpoint readiness, not local/Docker/Compose.
4. Panel, tools, and pack routes agree on retain/recall/reflect/invalidate/outcome results; tools are route adapters, not a second service client.
5. A loopback resident Qwen MLX OpenAI-compatible endpoint needs no fake key, retains residency across sequential retain/reflect, and never falls back to an external/paid provider. Down/unhealthy behavior completes within the declared bound.
6. Manual private/offline OCI references save without network access; unpinned tags warn; only explicit start/restart pulls; credentials remain write-only.
7. Migration uses logical dump/restore or external DB, rejects incompatible schema/version, supports rollback, preserves existing memory across restart/mode switch, and never bind-mounts legacy `pg0` or silently creates an empty bank.
8. The panel meets the prototype’s responsive, keyboard, focus, colour-independent, confirmation, loading/error, close/uninstall cleanup, and no-auto-action behavior.

### Registered tests

All new tests are registered in `tests2/tests-map.json`.

| Layer | File | Coverage |
|---|---|---|
| Core | `tests2/core/hindsight-experience-routes.test.ts` | Typed validators, scope/grant matrix, adapter-only tools, redaction, bounded unavailable states. |
| Core | `tests2/core/hindsight-runtime-settings.test.ts` | EP-7 revision/secret resolution, loopback no-key rule, OCI parser/warning/no-save-pull, model diagnostics, no-paid-fallback. |
| Core | `tests2/core/hindsight-migration.test.ts` | Plan fingerprints, pg_dump/restore sequence, compatibility rejection, rollback, named-volume/external-DB ownership, no `pg0` mount. |
| Integration | `tests2/integration/hindsight-experience-api.test.ts` | Settings revisions, grant/deny/control routes, redacted errors/WS, status/log bounds, tools/routes use one route contract. |
| Integration | `tests2/integration/hindsight-local-residency.test.ts` | Two retain/reflect operations reuse fixture MLX process/load; down/unhealthy no-hang and no fallback. |
| Browser | `tests2/browser/e2e/hindsight-experience.spec.ts` | Configure without secret echo; grant/deny; all runtime states; mode-independent retain/recall; browse/search/detail/reflect/confirmed invalidate/outcome; reload/focus/close/uninstall cleanup; down/unhealthy session usability. |
| E2E | `tests/e2e/hindsight-runtime-matrix.test.ts` | Real local, Docker, and Compose modes: retain/recall/reflect, restart persistence, stop/start, mode switch migration, cleanup, dynamic loopback, and model residency witness. |

The real matrix is environment-gated only when its named dependency is unavailable; CI/local qualification reports an explicit skipped prerequisite, never a false green substitute. It uses a dedicated bank and temporary owned volume/database, exercises a real local Qwen-compatible fixture plus actual Docker and Compose, and performs cleanup without deleting a user’s pre-existing data.

Focused implementation commands:

```bash
npm run check
npm run test:unit -- tests2/core/hindsight-experience-routes.test.ts tests2/core/hindsight-runtime-settings.test.ts tests2/core/hindsight-migration.test.ts tests2/integration/hindsight-experience-api.test.ts tests2/integration/hindsight-local-residency.test.ts
npm run test:browser -- tests2/browser/e2e/hindsight-experience.spec.ts --retries=0
npm run test:e2e -- tests/e2e/hindsight-runtime-matrix.test.ts
```
