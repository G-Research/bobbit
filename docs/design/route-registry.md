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
  (`src/server/routes/projects-routes.ts`). See
  [Cohort list](#cohort-1-projects) below.
- **Cohort 2: `/api/projects/:id/config(...)`** — the per-project config
  family (`src/server/routes/project-config-routes.ts`). See
  [Cohort 2](#cohort-2-per-project-config) below.
- Everything else in `handleApiRoute` is unchanged, still in the legacy
  if/else chain (the marketplace family is being migrated in a parallel
  cohort branch).

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
  the new `REGISTRY_ROUTE_MODULE_PATHS` (currently just
  `projects-routes.ts`), compiling `:param` segments to a `[^/]+` regex and
  `/*` suffixes to a prefix match — mirroring `route-table.ts`'s own
  semantics exactly — and merges the result into `getServerRoutes()`. Add a
  future cohort's route module path to this list; no other change needed.
  Method attribution for registry routes is exact (read directly from the
  `register()` call's first argument) rather than the legacy extractor's
  best-effort statement-window heuristic.
  - `tests/prompt-api-drift.test.ts` carries its own separate inline copy of
    the extractor (pre-existing, documented in that file) and was NOT
    extended — none of cohort 1's routes are referenced by any prompt
    template, so it stays green unchanged. A future cohort whose routes ARE
    prompt-advertised will need to either extend that inline copy too or
    (better, pre-existing TODO in that file) refactor it to import the
    shared `server-route-surface.ts` helper.
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
4. Delete the corresponding `if` blocks from the legacy chain in the SAME
   commit. Add `registerXxxRoutes(coreRouteTable)` next to the existing
   registration call(s) in `server.ts`.
5. Add the new module's path to `REGISTRY_ROUTE_MODULE_PATHS` in
   `tests/helpers/server-route-surface.ts`.
6. Run `npm run check`, `npm run test:unit`, `npm run test:e2e` (API phase).
   No new failures against the current baseline.
7. If the cohort's routes are advertised in any `defaults/*.md`/`*.yaml`
   prompt template, also update `tests/prompt-api-drift.test.ts`'s scan list
   (or do the shared-extractor refactor it's already been deferring).

### What's NOT done yet (left for future cohorts)

- The other ~410 routes, including the largest/highest-traffic families
  (sessions, goals inline in `server.ts`, marketplace, tools/roles/skills
  customization, MCP). Marketplace in particular needs the `/*` prefix kind
  `RouteTable` already supports (built and unit-tested in cohort 1, but
  unused until a cohort needs it) since its routes are behind one wrapping
  `startsWith("/api/marketplace/")` guard with nested exact matches.
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
