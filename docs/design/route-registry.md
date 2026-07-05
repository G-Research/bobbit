# Core route registry (STR-01)

Finding: `~/Documents/dev/bobbit-fable-refactor/FINDINGS.md` STR-01 — `handleApiRoute`
is a ~12,500-line, ~424-branch linear if/else chain in `src/server/server.ts`.
Route precedence is an emergent property of source-line order rather than an
explicit table, so shadowing bugs (a new route silently dead behind an
earlier, broader `startsWith`/regex branch) are invisible to the compiler and
to unit tests.

This document describes the seam introduced to fix that, the migration
protocol future cohorts should follow, and what's left after cohort 1.

## Status

- **Cohort 1: `/api/projects*` CRUD** — 14 routes migrated
  (`src/server/routes/projects-routes.ts`), plus (as of cohort 4)
  `GET /api/projects/:id/qa-testing-config`. See
  [Cohort list](#cohort-1-projects) below.
- **Cohort 2: `/api/projects/:id/config(...)`** — the per-project config
  family (`src/server/routes/project-config-routes.ts`). See
  [Cohort 2](#cohort-2-per-project-config) below.
- **Cohort 3 (labelled "cohort 2" in its own file headers; merged from a
  parallel branch): `/api/marketplace/*` + `GET /api/packs/conflicts`** — see
  [Cohort 2: marketplace](#cohort-2-marketplace) below.
- **Cohort 5: staff inbox** — `GET`/`POST` `/api/staff/:id/inbox`,
  `POST /api/staff/:id/inbox/:entryId/{complete,dismiss}`,
  `DELETE /api/staff/:id/inbox/:entryId` — see
  [Cohort 5: staff inbox](#cohort-5-staff-inbox) below.
- **Cohort 4: `/api/pack-runtimes*`**
  (`src/server/routes/pack-runtimes-routes.ts`) and the **server-scope
  `/api/project-config` trio**
  (`src/server/routes/project-config-server-routes.ts`), plus the
  qa-testing-config one-liner above. See
  [Cohort 4](#cohort-4-pack-runtimes--server-scope-project-config) below.
- **Cohort 6: workflows + review-annotations** — `GET`/`POST`
  `/api/workflows`, `POST /api/workflows/:id/customize`,
  `DELETE /api/workflows/:id/override`, `GET`/`PUT`/`DELETE`
  `/api/workflows/:id` (`src/server/routes/workflows-routes.ts`); and
  `POST /api/sessions/:id/review/annotations/bulk`,
  `GET`/`POST`/`DELETE /api/sessions/:id/review/annotations`,
  `DELETE /api/sessions/:id/review/annotations/:annotationId`,
  `GET`/`PUT /api/sessions/:id/review/submitted`
  (`src/server/routes/review-annotations-routes.ts`) — see
  [Cohort 6: workflows + review-annotations](#cohort-6-workflows--review-annotations)
  below.
- Everything else in `handleApiRoute` (~361 remaining routes) is unchanged,
  still in the legacy if/else chain.

## The seam

Two new files, both under `src/server/routes/`:

- **`route-table.ts`** — a generic `RouteTable<Ctx>` class: `register(method,
  pattern, handler)` + `match(method, pathname)`. Framework-agnostic, no
  dependency on server.ts or any gateway state.
- **`core-route-ctx.ts`** — the `CoreRouteCtx` interface: the per-request
  context object handed to every migrated core-route handler (see
  [Why ctx is data, not imports](#why-ctx-is-data-not-imports) below).

Each cohort gets its own route module (e.g. `projects-routes.ts`) exporting a
single `registerXxxRoutes(table)` function that calls `table.register(...)`
for every route in that cohort. `server.ts` builds ONE `RouteTable<CoreRouteCtx>`
at module load time and calls every cohort's `registerXxxRoutes()` once:

```ts
const coreRouteTable = new RouteTable<CoreRouteCtx>();
registerProjectRoutes(coreRouteTable);
// future cohorts: registerMarketplaceRoutes(coreRouteTable); etc.
```

Inside `handleApiRoute`, right after the existing pack/goal/PR-walkthrough
delegate-route calls and before the legacy if/else chain, one dispatch block
consults the table:

```ts
const coreMatch = coreRouteTable.match(req.method || "GET", url.pathname);
if (coreMatch) {
	const coreCtx: CoreRouteCtx = { /* built fresh, this request */ };
	await coreMatch.handler(coreCtx, coreMatch.params);
	return;
}
```

If nothing matches, execution falls through into the (now slightly shorter)
legacy chain, unchanged. **This is the whole migration mechanism**: a route
is "migrated" the moment its `if (url.pathname === ...)` block is deleted
from the legacy chain and an equivalent `table.register(...)` call exists —
both changes land in the same commit, so the union of "in the registry" +
"still in the legacy chain" is always the complete, correct route surface.
There is never a moment where a route exists in both places (double-handled)
or neither (silently dropped).

### Precedence is explicit, not source-order

The bug class STR-01 flagged: two overlapping matchers (e.g. an exact
`/api/projects/order` and a catch-all `/api/projects/:id`) where which one
"wins" depends on which `if` appears first in the file — invisible in review,
and only gets worse as routes accumulate. `RouteTable.match()` fixes this by
matching in a **fixed kind order**, regardless of registration order:

1. **exact** literal patterns (`/api/projects`) — O(1) map lookup, tried first.
2. **`:param` patterns** (`/api/projects/:id`) — first registered match wins.
3. **`/*` prefix patterns** (`/api/marketplace/*`) — first registered match wins.

This is why cohort 1 needed no negative-lookahead regex (the legacy code's
`/^\/api\/projects\/(?!(?:preflight|archive-bobbit|detect|scan|order)$)([^/]+)$/`)
to keep `/api/projects/order` from being swallowed by the `:id` catch-all:
registering `/api/projects/order` as its own exact pattern is automatically
tried before the `/api/projects/:id` param pattern, unconditionally.

`register()` also throws immediately (at table-construction time, i.e. at
module load, not at request time) if the same `(method, pattern)` is
registered twice — the exact kind of silent shadowing STR-01 exists to make
impossible now fails loudly and immediately instead of silently picking
whichever branch happened to come first.

#### Reserved literal segments under a `:param` catch-all

One legacy wrinkle `RouteTable` has to reproduce exactly: the original
`projectGetMatch` regex used a hand-written negative lookahead —
`/^\/api\/projects\/(?!(?:preflight|archive-bobbit|detect|scan|order)$)([^/]+)$/`
— so that e.g. a stray `DELETE /api/projects/order` (no exact registration
for `DELETE` on that literal path) falls all the way through to the legacy
chain's generic 404, instead of being swallowed by the generic `:id` handler
(which would call `projectRegistry.get("order")`, itself a DIFFERENT,
project-scoped 404 body — a real, if obscure, response-shape regression;
pinned by `tests/project-route-specificity.test.ts`). `RouteTable.register`
supports this via an explicit `excludeParamValues` option instead of a
hand-rolled regex:

```ts
table.register("DELETE", "/api/projects/:id", handleProjectDelete, {
	excludeParamValues: { id: ["preflight", "archive-bobbit", "detect", "scan", "order"] },
});
```

The excluded param must be the pattern's LAST segment (throws otherwise);
this is intentionally narrow rather than a general-purpose exclusion
mechanism — it exists to reproduce one specific legacy behavior, not to
encourage new negative-lookahead routes. Every literal excluded here already
has (or will have) its own exact registration for the method it's actually
used with — see the `RESERVED_PROJECTS_SEGMENTS` constant in
`projects-routes.ts`.

### Why ctx is data, not imports

A tempting shortcut would have `projects-routes.ts` import helpers directly
from `server.ts` (e.g. `import { isHeadquartersOwnedPath } from "../server.js"`).
That would recreate the exact `server.ts <-> leaf-module` import cycle that
[STR-04's git/gh extraction](../../src/server/skills/git-gh.ts) deliberately
removed (see that commit's message). `server.ts` is the one module every
route file needs to be importED BY, never TO import FROM.

Instead, everything a migrated handler needs that isn't already a leaf-module
export (project registry, project-context manager, session manager, git
helpers, etc. — all imported directly, no cycle) is threaded through as a
plain function reference on the per-request `CoreRouteCtx` object, built
fresh inside `handleApiRoute` from state it already has in scope. This
mirrors the pattern the existing delegate-route modules
(`src/server/agent/nested-goal-routes.ts`'s `NestedGoalRouteDeps`,
`src/server/side-panel-workspace-routes.ts`) already use, and costs nothing —
these closures (`json`, `jsonError`, `isHeadquartersOwnedPath`,
`listProjectsForApi`, `writeSpecialProjectMutationError`,
`wireGoalManagerResolvers`, `validateComponentsConfig`,
`isValidBaseRefBranchGrammar`, `detectedRefExistsInAllComponents`) already
existed in `handleApiRoute`'s scope for the legacy chain's own use (several
are shared with not-yet-migrated routes elsewhere in `server.ts` and must
stay defined exactly once).

`resolveBaseRefDetectRepoPath` was the one cohort-1 helper with NO caller
outside the migrated routes — it moved into `projects-routes.ts` outright
(deleted from `server.ts`) rather than being threaded through `ctx`, since
there was no sharing concern.

### Table lifetime

`coreRouteTable` is a single module-level instance, built once when
`server.ts` loads. This is safe because every registered handler is a pure
function of `(ctx, params)` — it closes over nothing gateway-instance-specific;
all such state arrives via `ctx`, freshly built per request from whichever
gateway's `handleApiRoute` call is in flight. So the same table safely serves
every gateway instance created in a process (relevant for e2e tests, which
construct multiple gateways in one process) — unlike a design that closed
over `sessionManager`/`projectRegistry` etc. at registration time, which
would go stale the moment a second gateway is constructed.

## Cohort 1: projects

`src/server/routes/projects-routes.ts`. 14 routes, moved verbatim (same auth
— handled upstream of `handleApiRoute`, untouched; same validation; same
status codes; same error shapes):

| Method | Path |
|---|---|
| GET | `/api/projects/preflight` |
| POST | `/api/projects/archive-bobbit` |
| POST | `/api/projects/detect` |
| POST | `/api/projects/scan` |
| GET | `/api/projects/:id/structured` |
| POST | `/api/projects/:id/rescan-repos` |
| GET | `/api/projects` |
| POST | `/api/projects` |
| PUT | `/api/projects/order` |
| GET | `/api/projects/:id` |
| PUT | `/api/projects/:id` |
| DELETE | `/api/projects/:id` |
| POST | `/api/projects/:id/promote` |
| GET | `/api/projects/:id/base-ref/detect` |

**Deliberately NOT migrated in cohort 1** (still in the legacy chain), even
though lexically adjacent to the family above in `server.ts`:

- `GET`/`PUT` `/api/projects/:id/config`, `/config/defaults`, `/config/resolved`
  — its own, much larger review unit (base_ref validation, secrets
  redaction, legacy-key migration — hundreds of lines of branching logic);
  **migrated as cohort 2, below**.
- `POST /api/create-directory`, `GET /api/browse-directory` — lexically
  interleaved with the projects family but not part of it (generic
  filesystem helpers).
- `GET /api/projects/:id/qa-testing-config` — unrelated feature, happens to
  share the `/api/projects/:id/...` path shape.

## Cohort 2: per-project config

`src/server/routes/project-config-routes.ts`. The four real routes, moved
verbatim:

| Method | Path |
|---|---|
| GET | `/api/projects/:id/config` |
| PUT | `/api/projects/:id/config` |
| GET | `/api/projects/:id/config/defaults` |
| GET | `/api/projects/:id/config/resolved` |

Two cohort-2 wrinkles worth knowing for future cohorts:

- **Legacy fall-through parity shims.** The legacy block matched the PATH
  first (`if (projectConfigMatch)`), resolved the project context (404
  `"Project not found"` when missing) and only then branched on
  method/suffix — an unhandled combination (e.g. `DELETE .../config`,
  `PUT .../config/defaults`) fell out of the block and continued down the
  whole remaining legacy chain to its terminal 404 `"Not found"`. A
  method-keyed registry can't "fall through after matching", so those
  method/path combinations are registered explicitly against a shim that
  reproduces the exact terminal behavior. Pinned by
  `tests/project-config-route-parity.test.ts` (every representable method
  on every family pattern must be registered). When migrating a future
  path-first/method-inside legacy block, audit its unhandled-method
  fall-through the same way — and write the shims as LITERAL
  `register("METHOD", ...)` calls (not a loop) so the route-surface
  extractor sees them.
- **Helper disposition.** The five sandbox-secret helpers
  (`redactSandboxSecrets`, `redactSandboxSecretsResolved`,
  `mergeSecretsIntoTokens`, `mergeSandboxTokensStructured`,
  `mergeSandboxSecrets`) had their only call sites in this family and moved
  with it. `LEGACY_QA_TOP_LEVEL_KEYS` is also used by the not-yet-migrated
  `PUT /api/project-config` legacy route, so it stays defined once in
  `server.ts` and flows through the new `ctx.legacyQaTopLevelKeys`; the
  server-scope store flows through `ctx.serverProjectConfigStore`. New ctx
  fields are **append-only** (each cohort appends its block at the end of
  the interface/literal) so parallel cohort branches merge without
  conflicts.

Still not migrated from this region: `GET /api/projects/:id/qa-testing-config`
(unrelated feature) and the server-level `/api/project-config` trio (its PUT
is lexically adjacent to the marketplace block being migrated in a parallel
cohort; deferred to stay conflict-free).
## Cohort 2: marketplace

`src/server/routes/marketplace-routes.ts`. Unlike cohort 1 (14 small,
independent handlers), this family was already behind ONE wrapping
`if (url.pathname.startsWith("/api/marketplace/") || url.pathname === "/api/packs/conflicts")`
guard in the legacy chain, with ~15 route-local closures (`parseScope`,
`resolveScopeTarget`, `buildActivationCatalogue`, `resolvePackRuntimeContext`,
etc.) shared across its ~12 nested exact-match sub-routes, and a shared
trailing `{ error: "not found" }` 404 for any `/api/marketplace/*` path
matching none of them. Splitting that into ~12 independent `table.register()`
handlers would mean threading the same ~15 closures through every one of
them (or duplicating them) — worse than registering the whole guard as a
`/*` prefix (this is the cohort the `/*` prefix kind was built for — see
[Precedence is explicit](#precedence-is-explicit-not-source-order) above)
with ONE handler that preserves every nested exact `if (url.pathname === ...)`
check, and the shared 404 fallback, byte-for-byte the same as the block it
replaces:

```ts
table.register("GET", "/api/marketplace/*", handleMarketplaceRequest);
table.register("POST", "/api/marketplace/*", handleMarketplaceRequest);
table.register("PUT", "/api/marketplace/*", handleMarketplaceRequest);
table.register("DELETE", "/api/marketplace/*", handleMarketplaceRequest);
table.register("PATCH", "/api/marketplace/*", handleMarketplaceRequest);
table.register("GET", "/api/packs/conflicts", handleMarketplaceRequest);
```

(`/api/packs/conflicts` is a distinct literal path lexically interleaved with
the marketplace family in the legacy code — same "marketplace not available"
500 guard, same closure scope — so it shares the handler via its own exact
registration.)

Free variables that used to be `handleApiRoute`'s own params/closures (`json`,
`sessionManager`, `marketplaceInstaller`, `configCascade`, `projectConfigStore`,
...) are destructured from `ctx` under IDENTICAL names, so the ~990-line body
needed ZERO further edits beyond that destructure and the import list.
`CoreRouteCtx` grew by ~20 fields (append-only, after cohort 1's fields) —
every one of them a function or singleton this family shares with
not-yet-migrated legacy code elsewhere in `server.ts` (`/api/pack-runtimes/*`,
`/api/slash-skills*`, the roles/tools cascade). `PackRuntimeSupervisorLike` is
a structural copy of the same-named interface in `server.ts` (it lives there,
not in a leaf module, so importing it would recreate the cycle this file
exists to avoid) — a pure type, kept in sync by TS itself: any divergence is a
compile error at the `coreCtx` construction site, not silent drift.

Same auth (handled upstream of `handleApiRoute`, untouched), same validation,
same status codes, same error shapes, including the shared 404. Parity
evidence: all 57 API E2E specs across `market-pack-roles-api.spec.ts`,
`marketplace-mcp.spec.ts`, `marketplace-pi-extension.spec.ts`,
`marketplace-provider-activation.spec.ts`,
`marketplace-runtime-activation.spec.ts`, `pack-default-disabled.spec.ts`,
`pack-runtimes-start-config.spec.ts` pass unchanged; so do the browser E2E
specs (`market-activation`, `marketplace-conflicts`, `marketplace-mcp`,
`marketplace`, `hindsight-marketplace`, `hindsight-pack`, `hindsight-wizard`,
`artifacts-pack`) except one pre-existing flake
(`marketplace.spec.ts`'s "Sources menu filters..." package-count assertion,
confirmed to fail identically on the unmigrated baseline).

## Cohort 5: staff inbox

`src/server/routes/staff-inbox-routes.ts`. The five staff-inbox routes,
moved verbatim:

| Method | Path |
|---|---|
| GET | `/api/staff/:id/inbox` |
| POST | `/api/staff/:id/inbox` |
| POST | `/api/staff/:id/inbox/:entryId/complete` |
| POST | `/api/staff/:id/inbox/:entryId/dismiss` |
| DELETE | `/api/staff/:id/inbox/:entryId` |

Chosen for this cohort because it's small (5 handlers, ~150 lines),
lexically self-contained (its own comment-delimited block, distinct from the
surrounding `/api/staff` CRUD family), and has the strongest test coverage
of any candidate in the remaining chain: unit coverage
(`tests/inbox-manager.test.ts`, `tests/inbox-nudger.test.ts`,
`tests/inbox-store.test.ts`), a dedicated API E2E spec
(`tests/e2e/inbox-api.spec.ts`, 11 cases covering every route's happy path,
404/403/409 branches, and the deleted `/wake` shim), and a browser E2E spec
(`tests/e2e/ui/staff-inbox.spec.ts`). It's also explicitly NOT a
session/steer/WS hot path — it's an async task-queue CRUD surface staff
agents poll, not part of live session streaming.

**No unhandled-method parity shim needed** (unlike cohort 2's
project-config family): every legacy block here gated on the path regex AND
the method in the SAME `if` condition (e.g.
`if (staffInboxListMatch && req.method === "GET")`), so a method mismatch
never even entered the "path matched" branch — it fell straight through to
the same generic terminal 404 as a wholly-unmatched path. `RouteTable`'s
`:param` entries are method-scoped the same way (`match()` filters by method
before testing the regex), so simply not registering other methods on these
path shapes reproduces that fall-through exactly.

**Scope note**: only the inbox sub-family was migrated, not the rest of
`/api/staff*` (list, create, get/patch/put/delete by `:id` — its own larger
review unit involving project reassignment, worktree/sandbox provisioning,
and role-cascade validation) or the lexically-adjacent deprecated
`GET /api/staff/:id/sessions` 410 stub (unrelated one-liner that merely
sits next to the inbox block in `server.ts`).

`staffManager` and `inboxManager` were appended to `CoreRouteCtx` — both
already existed as `handleApiRoute` params shared with the not-yet-migrated
rest of the `/api/staff*` family, so they're threaded through by reference
rather than duplicated.

## Cohort 4: pack-runtimes + server-scope project-config

Two new modules plus one addition to an existing one, all registered after
cohort 3's in `server.ts`:

### `src/server/routes/pack-runtimes-routes.ts`

The P2 pack managed-runtime (Docker-backed supervisor) REST family, moved
verbatim:

| Method | Path |
|---|---|
| GET | `/api/pack-runtimes` |
| GET | `/api/pack-runtimes/:id/capabilities` |
| POST | `/api/pack-runtimes/:id/down` |
| POST | `/api/pack-runtimes/:id/start` |
| POST | `/api/pack-runtimes/:id/stop` |
| POST | `/api/pack-runtimes/:id/restart` |
| GET | `/api/pack-runtimes/:id/logs` |

The legacy `start|stop|restart|logs` alternation regex became four literal
`:id`-param registrations sharing one handler (`RouteTable` has no
in-segment alternation; the shared body is byte-identical, with the action
passed explicitly).

**Fall-through parity, the 405 variant.** Unlike cohort 2's family (which
fell through to the terminal 404 on unhandled methods), each `:id`-scoped
sub-route here matched the PATH first and answered any mismatched method
with an immediate `405 "method not allowed"` inside its own block. Those
combinations are registered explicitly against a `handleMethodNotAllowed`
shim (literal `register()` calls, not a loop — extractor-visible). The bare
`GET /api/pack-runtimes` list route gated path+method together (cohort-1
shape), so its other methods fall through exactly as before, and are NOT
registered. Pinned by `tests/pack-runtimes-route-parity.test.ts`.

**Helper disposition.** `encodePackRuntimeId`/`decodePackRuntimeId` and the
three `PackRuntime*Error` classes are leaf-module exports
(`src/server/runtimes/index.ts`) — imported directly by the new module and
REMOVED from server.ts's import list (its remaining code no longer uses
them). Two new `CoreRouteCtx` fields (append-only, cohort-4 block):
`packContributionRegistry` (per-gateway singleton, needed for
`getRawPack`) and `readBodyText` (still used by the not-yet-migrated
sessionless `/api/ext/pack-route/...` route, so it stays defined once in
server.ts). `resolveRuntimeStartPlan`/`providerCarriesDeploymentMode`
were already threaded through by cohort 3.

### `src/server/routes/project-config-server-routes.ts`

The server-scope trio cohort 2 deliberately deferred (its PUT was lexically
adjacent to the then-in-flight marketplace cohort; that's merged, so the
adjacency concern is moot), moved verbatim:

| Method | Path |
|---|---|
| GET | `/api/project-config` |
| GET | `/api/project-config/defaults` |
| PUT | `/api/project-config` |

All three gated path+method together in the legacy chain (cohort-1 shape) —
no parity shims needed; unmatched methods fall through exactly as before.
Uses cohort 2/3's existing ctx fields (`projectConfigStore`,
`legacyQaTopLevelKeys`) — `LEGACY_QA_TOP_LEVEL_KEYS` stays defined in
server.ts (the projects-family GET/PUT config routes' shim threading
already references it). Pinned by
`tests/project-config-server-route-parity.test.ts`.

### `GET /api/projects/:id/qa-testing-config`

A single trivial handler folded into cohort 1's `projects-routes.ts`
(rather than a dedicated one-route file) — it shares the family's path
shape and uses only ctx fields that module already destructures. GET-only
in the legacy chain (path+method gated together), so no shims; pinned in
`tests/project-config-server-route-parity.test.ts` alongside the trio.

Parity evidence: `tests/e2e/pack-runtimes-api.spec.ts`,
`tests/e2e/pack-runtimes-start-config.spec.ts`,
`tests/e2e/marketplace-runtime-activation.spec.ts`,
`tests/e2e/project-config-component-config.spec.ts`,
`tests/e2e/headquarters-api.spec.ts` and the four sandbox API specs (the
`/api/project-config` writers) — 107 tests — pass unchanged.

## Cohort 6: workflows + review-annotations

Two new modules, registered after cohort 4's in `server.ts`:

### `src/server/routes/workflows-routes.ts`

The workflows family, moved verbatim:

| Method | Path |
|---|---|
| GET | `/api/workflows` |
| POST | `/api/workflows` |
| POST | `/api/workflows/:id/customize` |
| DELETE | `/api/workflows/:id/override` |
| GET | `/api/workflows/:id` |
| PUT | `/api/workflows/:id` |
| DELETE | `/api/workflows/:id` |

No new `CoreRouteCtx` fields needed — `configCascade` and
`projectContextManager` were already threaded through by cohort 1/2.

### `src/server/routes/review-annotations-routes.ts`

The review-annotation family, moved verbatim:

| Method | Path |
|---|---|
| POST | `/api/sessions/:id/review/annotations/bulk` |
| GET | `/api/sessions/:id/review/annotations` |
| POST | `/api/sessions/:id/review/annotations` |
| DELETE | `/api/sessions/:id/review/annotations` |
| DELETE | `/api/sessions/:id/review/annotations/:annotationId` |
| GET | `/api/sessions/:id/review/submitted` |
| PUT | `/api/sessions/:id/review/submitted` |

The legacy code matched this family with `startsWith`/`endsWith`/`includes`
plus manual `pathname.split("/")` indexing rather than the capture-group
regexes cohorts 1-5 dealt with, and its single DELETE block branched at
runtime (`parts.length >= 7 && parts[6]`) to distinguish "delete one
annotation" from "clear all/by docTitle". That single block is now two
`RouteTable` registrations (`.../annotations` and
`.../annotations/:annotationId`) — `RouteTable`'s regex is anchored
(`^...$`) so the two path shapes (different segment counts) never collide,
reproducing the runtime branch exactly for every shape exercised by
`tests/e2e/review-annotations-api.spec.ts`. One `CoreRouteCtx` field added
(append-only, cohort-6 block): `reviewAnnotationStore`, optional exactly as
`handleApiRoute`'s own param is.

**Fall-through parity: no shim needed for either module** (cohort 5's shape,
not cohort 2/4's). Every legacy block in both families gated on the path
AND the method in the SAME `if` condition, with no shared pre-branch
resolution step (unlike project-config's path-first project lookup) — a
method mismatch never entered any block, falling straight through to the
same generic terminal 404 any unmatched path would hit. `RouteTable`'s
`:param`/exact entries are method-scoped the same way, so leaving other
methods unregistered on these path shapes reproduces that fall-through
exactly.

**Known non-bit-for-bit edge case (untested, documented in the module
header):** the legacy DELETE block matched via
`url.pathname.includes("/review/annotations")` (not `endsWith`), so a
DELETE with a trailing slash or extra segments past the annotation id fell
into the same block with different `parts[]` indexing than the two shapes
above. No test exercises this; both migrated shapes are pinned by
`tests/e2e/review-annotations-api.spec.ts`.

Parity evidence: `tests/e2e/review-annotations-api.spec.ts` (all cases) and
`tests/e2e/ui/mobile-review-commenting.spec.ts` pass unchanged for the
review-annotation family. For workflows:
`tests/e2e/workflows-api.spec.ts`, `tests/e2e/workflows-project-scope.spec.ts`,
`tests/e2e/goal-workflow-api.spec.ts`,
`tests/e2e/projects-no-default-workflows.spec.ts`,
`tests/e2e/inline-workflow-goal-flow.spec.ts`,
`tests/e2e/proposal-goal-workflow-validation.spec.ts`, and the browser specs
`tests/e2e/ui/workflow-page-scope.spec.ts`,
`tests/e2e/ui/workflow-editor.spec.ts`,
`tests/e2e/ui/goal-proposal-invalid-workflow.spec.ts`,
`tests/e2e/ui/goal-empty-workflows-banner.spec.ts`,
`tests/e2e/ui/goal-proposal-workflow-tab.spec.ts` all pass unchanged.

## Pins

- **`tests/route-table.test.ts`** (new) — unit coverage of the registry
  mechanics itself: exact/param/prefix pattern compilation, the
  exact > param > prefix precedence (including the "registered in the
  `:param`-first order but the exact route still wins" case — the specific
  regression class STR-01 flagged), method-mismatch fallthrough (a path
  registered for `DELETE` must NOT match a `GET` request — 404, not 405),
  and duplicate-registration guards.
- **`tests/helpers/server-route-surface.ts`** (extended) — the shared
  route-surface extractor used by `tests/client-api-orphan-pinning.test.ts`
  (PR #23) and `tests/orient-api-route-families.test.ts` now also
  understands the registry idiom: `extractRegistryRoutes()` scans
  `table.register("METHOD", "pattern", ...)` calls in every path listed in
  the new `REGISTRY_ROUTE_MODULE_PATHS` (`projects-routes.ts` and, as of
  cohort 2, `marketplace-routes.ts`), compiling `:param` segments to a
  `[^/]+` regex and
  `/*` suffixes to a prefix match — mirroring `route-table.ts`'s own
  semantics exactly — and merges the result into `getServerRoutes()`. Add a
  future cohort's route module path to this list; no other change needed.
  Method attribution for registry routes is exact (read directly from the
  `register()` call's first argument) rather than the legacy extractor's
  best-effort statement-window heuristic.
  - `tests/prompt-api-drift.test.ts` carried its own separate inline copy of
    the extractor through cohorts 1-5 (none of their routes were referenced
    by any prompt template, so it stayed green unchanged). Cohort 6's
    `GET /api/workflows` IS referenced by `defaults/system-prompt.md`, so
    its inline copy going stale would have been a real, user-visible false
    negative (a live route silently reported as missing) rather than a
    theoretical gap — cohort 6 paid down the deferred refactor and now
    imports `getServerRoutes()`/`concretize()`/`isRouted()` directly from
    `server-route-surface.ts`, same as `orient-api-route-families.test.ts`
    and `client-api-orphan-pinning.test.ts`. No future cohort needs to touch
    this file for path drift — only if it adds a NEW prompt-advertised
    template file to `PROMPT_FILES`.
- Existing `tests/e2e/*.spec.ts` project-CRUD/base-ref specs run unchanged
  against the migrated routes (parity evidence — see PR description).

## Migration protocol for future cohorts

1. Pick a cohort: a lexically-contiguous, self-contained route family with
   existing test coverage. Avoid routes with open, in-flight PRs touching
   the same lines; avoid session/steer/WS hot paths for early cohorts (higher
   blast radius, more fragile timing coupling).
2. Create `src/server/routes/<cohort>-routes.ts` exporting
   `register<Cohort>Routes(table: RouteTable<CoreRouteCtx>)`.
3. Move each handler body verbatim. Reuse the pattern in
   `projects-routes.ts`:
   - `url.pathname.match(...)[1]` → `:param` in the registered pattern +
     `params.xxx` in the handler.
   - Anything already a leaf-module export (git helpers, project registry,
     etc.) → import directly in the new file.
   - Anything that's a `handleApiRoute`-local closure ALSO used by
     not-yet-migrated legacy routes → add it to `CoreRouteCtx` and pass it
     through (do not duplicate, do not import back from `server.ts`).
   - Anything used ONLY by the routes being migrated → move it into the new
     route file outright.
   - If the family is already behind ONE wrapping `startsWith(...)` guard
     with many closures shared across its nested exact matches (cohort 2's
     shape — see [Cohort 2: marketplace](#cohort-2-marketplace)), don't
     force-split it into one `table.register()` per nested route: register
     the whole guard as a `/*` prefix (one registration per HTTP method the
     family actually uses) with a single handler that preserves the nested
     `if`s and the shared trailing 404 verbatim.
4. Delete the corresponding `if` blocks from the legacy chain in the SAME
   commit. Add `registerXxxRoutes(coreRouteTable)` next to the existing
   registration call(s) in `server.ts`.
5. Add the new module's path to `REGISTRY_ROUTE_MODULE_PATHS` in
   `tests/helpers/server-route-surface.ts`.
6. Run `npm run check`, `npm run test:unit`, `npm run test:e2e` (API phase).
   No new failures against the current baseline.
7. If the cohort's routes are advertised in any `defaults/*.md`/`*.yaml`
   prompt template, run `tests/prompt-api-drift.test.ts` (it imports the
   shared, registry-aware `server-route-surface.ts` extractor as of cohort
   6, so newly-migrated registry routes are already visible to it — no
   per-cohort update needed unless a NEW prompt file is added to
   `PROMPT_FILES`).

### What's NOT done yet (left for future cohorts)

- The other ~361 routes, including the largest/highest-traffic families
  (sessions, goals inline in `server.ts`, tools/roles/skills customization,
  MCP). `/api/pack-runtimes/*` and the server-scope `/api/project-config`
  trio were migrated in cohort 4, the staff-inbox family in cohort 5, and
  the workflows + review-annotation families in cohort 6 (all above).
  Cohort 2 migrated marketplace using the `/*`
  prefix kind `RouteTable` already supports (built and unit-tested in cohort
  1, unused until cohort 2 needed it for exactly this shape — see
  [Cohort 2: marketplace](#cohort-2-marketplace) above); a future cohort
  behind a similar single wrapping `startsWith(...)` guard with shared
  closures across its nested exact matches should follow the same pattern
  (one prefix registration + one handler preserving the nested `if`s)
  rather than force-splitting into many small `table.register()` calls.
- `GET`/`PUT` `/api/projects/:id/config(...)` — the large sibling deliberately
  left out of cohort 1 (see above).
- Session/steer/WS hot paths — intentionally deferred to a later, more
  carefully-staged cohort given their higher risk profile (per the STR-01
  finding's own "staged/high-risk" disposition).
- Hoisting `coreRouteTable` construction so cohort route modules receive
  gateway-instance-scoped deps at `createGateway()` construction time
  (mirroring how `routeDispatcherArg`/`routeRegistryArg` are already threaded
  into `handleApiRoute` for the pack-routing seam) instead of per-request
  `ctx` — not needed yet since the per-request-ctx approach has no
  correctness or measurable performance cost at cohort-1 scale, but worth
  revisiting once enough cohorts migrate that ctx's field count grows large.
