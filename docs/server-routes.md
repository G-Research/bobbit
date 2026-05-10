# REST routes — module layout

`src/server/server.ts` is a thin boot/dispatch shell. Every REST route lives in
a per-domain module under `src/server/routes/<domain>.ts` and is registered
into a single anchored-regex dispatcher.

This page is the practitioner reference: where each domain lives, how to add a
new endpoint, the error-handling contract, and the pinning tests that catch
regressions. The migration history (problem statement, commit-by-commit plan)
is in [`design/server-routes-split.md`](design/server-routes-split.md).

## Architecture

```
requestHandler (server.ts)
  ├─ TLS / cookie / bearer / sandbox-token auth
  ├─ static + manifest serving
  └─ dispatch(url, req, res, deps, sandboxScope)   ──►  routes/dispatcher.ts
                                                          │
                          matchRoute(method, pathname)    │
                                  │                        │
                  ┌───────────────┴────────────────┐
                  │                                │
            routes/<domain>.ts: Route[]    Per-request RouteContext
            (literal or anchored regex)    (json, jsonError, readBody, deps, params)
```

- **Dispatcher** (`routes/dispatcher.ts`) — concatenates every domain's
  exported `Route[]` into one `allRoutes` array and linearly scans on each
  request. Linear scan is fine: a few hundred routes, anchored regexes,
  sub-millisecond.
- **Matcher** (`routes/match-route.ts`) — `matchRoute(method, pathname, routes)`
  returns the first matching route plus its capture groups.
- **Per-request context** (`routes/types.ts::RouteContext`) — every handler
  receives `{ req, res, url, pathname, params, sandboxScope, readBody, json,
  jsonError, deps }`.
- **Singleton bag** (`routes/route-deps.ts::RouteDeps`) — holds every server
  singleton (`sessionManager`, `teamManager`, `projectRegistry`, broadcast
  hooks, …). Constructed once in `createGateway()` and passed by reference.
- **Auth and sandbox-scope checks happen before dispatch.** The dispatcher only
  routes; it does not authenticate. `sandboxScope` (when present) is forwarded
  via `RouteContext.sandboxScope` for handlers that need to gate behaviour by
  caller identity.

## Domain map

One module per `/api/<segment>` namespace. The `sessions` and `goals` namespaces
are split further by responsibility — a single `sessions.ts` would be
~3,000 lines and lump unrelated subsystems together.

| Module | API surface |
|---|---|
| `routes/health.ts` | `/api/health`, `/api/setup-status*`, `/api/connection-info`, `/api/shutdown`, `/api/internal/test/replay-buffered-events/:id` |
| `routes/sandbox.ts` | `/api/sandbox-pool`, `/api/worktree-pool`, `/api/sandbox-status`, `/api/ca-cert`, sandbox image build, host-tokens |
| `routes/oauth.ts` | `/api/oauth/{status,start,complete,flow-status}` |
| `routes/image-generation.ts` | `/api/image-generation/generate` |
| `routes/models.ts` | `/api/models*`, `/api/image-models`, `/api/aigw/*`, custom-providers, provider-keys |
| `routes/preferences-config.ts` | `/api/preferences`, `/api/project-config*`, `/api/config-directories`, `/api/config/cwd`, `/api/system-prompt/customise` |
| `routes/roles.ts` | `/api/roles*`, `/api/roles/assistant/prompts*` |
| `routes/tools.ts` | `/api/tools*`, `/api/tool-group-policies*` |
| `routes/skills.ts` | `/api/slash-skills*`, `/api/activate-skill` |
| `routes/workflows.ts` | `/api/workflows*` |
| `routes/staff.ts` | `/api/staff*` |
| `routes/mcp.ts` | `/api/mcp-servers*`, `/api/internal/mcp-call`, `/api/internal/mcp-describe` |
| `routes/maintenance.ts` | `/api/search/*`, `/api/maintenance/*` |
| `routes/cost.ts` | `/api/sessions/:id/cost`, `/api/goals/:id/cost`, `/api/tasks/:id/cost`, breakdowns |
| `routes/projects.ts` | `/api/projects*`, `/api/projects/:id/config*`, `/api/projects/:id/qa-testing-config` |
| `routes/tasks.ts` | `/api/tasks/*`, `/api/goals/:id/tasks` |
| `routes/gates.ts` | `/api/goals/:id/gates*` (list, inspect, signal, content, workflow-context, cancel-verification) |
| `routes/goals.ts` | `/api/goals*` core CRUD + team/swarm endpoints |
| `routes/goals-git.ts` | `/api/goals/:id/{commits,git-status,pr-status,pr-merge}`, `/api/pr-status-cache` |
| `routes/sessions.ts` | `/api/sessions*` core CRUD + `/api/search` |
| `routes/sessions-bg.ts` | `/api/sessions/:id/bg-processes*` (`bash_bg` sub-API) |
| `routes/sessions-review.ts` | `/api/sessions/:id/review/{annotations,submitted}*` |
| `routes/sessions-git.ts` | `/api/sessions/:id/{file-content,git-status,git-diff,commits,pr-status,git-pull,git-push,git-squash-push,git-merge-primary,pr-merge}` |
| `routes/sessions-content.ts` | `/api/sessions/:id/{wait,output,transcript,tool-content,abort,mark-read}` |
| `routes/sessions-proposals.ts` | `/api/sessions/:id/proposal/:type*`, drafts, titles, prompt-sections |
| `routes/preview.ts` | `/api/preview/mount` (POST/GET), `/api/sessions/:id/preview-events` (SSE) |
| `routes/verifications.ts` | `/api/verifications/active`, cancel, `/api/internal/verification-result`, user-question/submit |
| `routes/cross-project.ts` | (helpers, not routes) cross-project goal/task/config resolvers |

`/api/internal/*` endpoints land in their natural domain rather than a single
`internal.ts` — they are distinguished only by the trust model (sandbox-token
auth), which is enforced uniformly before dispatch.

`POST /api/sessions/:id/preview-events` physically lives under `/api/sessions/`
but its handler logic is preview-mount plumbing — co-located in `preview.ts`.

For the per-route HTTP contract (request / response shapes, error codes), see
[`docs/rest-api.md`](rest-api.md). This page covers the module layout only.

## Adding a REST endpoint

1. Pick the right module from the table above. If the new route doesn't fit
   any existing namespace, create `routes/<segment>.ts` and add an import +
   spread in `routes/dispatcher.ts::allRoutes`.
2. Append a `Route` entry to that module's exported array. Use a literal
   string for exact paths and an **anchored** `RegExp` (`^…$`) when you need
   capture groups:

   ```ts
   {
     method: "GET",
     pattern: /^\/api\/widgets\/([^/]+)$/,
     handler: async ({ params, deps, json, jsonError }) => {
       const widget = deps.widgetStore.get(params[1]);
       if (!widget) { jsonError(404, new Error("Widget not found")); return; }
       json(widget);
     },
   },
   ```

3. List more-specific patterns before generic ones in the same module's array.
   Anchored regexes mean only one route can match a pathname, so ordering is a
   robustness measure rather than a correctness one — but keeping it specific
   first protects future copy-paste edits.
4. If the handler needs a new server singleton, add the field to
   `routes/route-deps.ts::RouteDeps` and populate it in `createGateway()` in
   `server.ts`.
5. Document the endpoint in [`docs/rest-api.md`](rest-api.md).
6. Add an API-level E2E test under `tests/e2e/` (in-process harness — see
   `tests/e2e/gates-api.spec.ts` for the pattern).

### Cross-project resolution

Endpoints that look up a goal / task / project across all registered projects
should use the helpers in `routes/cross-project.ts` (`getGoalAcrossProjects`,
`getGoalManagerForGoal`, `getTaskManagerForTask`, …) rather than reaching into
`projectContextManager` directly. These were the closures captured at the top
of the legacy `handleApiRoute()` and are kept as free functions so handlers
remain side-effect-free and unit-testable.

## Error handling

**Every error response goes through `ctx.jsonError(status, err, extra?)`.**

```ts
handler: async ({ readBody, deps, json, jsonError }) => {
  const body = await readBody();
  if (!body || typeof body.title !== "string") {
    jsonError(400, new Error("title required"));
    return;
  }
  try {
    json(deps.goalManager.create(body));
  } catch (e) {
    jsonError(500, e);
  }
}
```

`ctx.jsonError` is a thin wrapper around the `jsonError` helper in
`routes/route-helpers.ts`. It coerces non-`Error` values to `Error`, then
writes:

```
{ error: <message>, stack: <stack>, ...extra }
```

Do **not** write `ctx.json({ error: "…" }, status)` — that path skips the
`stack` field that the client error UI expects, and there is no exception for
"validation 4xx". The contract is uniform: client API wrappers in
`src/app/api.ts` always parse `error` + `code` + `stack` and forward them to
`<error-details>` modal rendering.

`extra` carries optional structured fields. Examples in tree:

- `code: "symlink_root", canonical, rootPath` — `POST /api/projects` rejecting a
  symlinked rootPath.
- `code: "search-unavailable", state, reason` — search service disabled.

The full error response shape is documented in
[`docs/rest-api.md#error-response-shape`](rest-api.md#error-response-shape).

### Body parsing contract

`ctx.readBody()` returns the parsed JSON body, **or `null` on malformed JSON**.
Many handlers test `if (!body) { jsonError(400, new Error("Invalid JSON")); }`.
This null-on-error contract is load-bearing across the codebase — do not
change it.

## Route ordering and the anchoring contract

Plain Node `http`, no framework — there is no Express-style mounting and no
trie. The dispatcher walks `allRoutes` in order and returns the first match.

To make this safe, **every `RegExp` pattern must be anchored `^…$`**. Anchoring
guarantees at most one route can match a given pathname, so the linear walk is
correct regardless of registration order. An unanchored pattern (e.g.
`/^\/api\/sessions\/([^/]+)/`) would silently swallow specific subpaths like
`/api/sessions/:id/git-status` because the leading-prefix match would win.

Within each module, list more-specific patterns first; in `dispatcher.ts`,
register more-specific session sub-modules (`sessions-git.ts`, `sessions-bg.ts`,
…) before `sessions.ts` core. Both layers are robustness against future drift,
not correctness.

## Pinning tests

Three unit tests under `tests/` enforce the architecture and prevent
regressions:

| Test | Pins |
|---|---|
| `tests/server-size.test.ts` | `src/server/server.ts` line count ≤ budget. Ratchet down in the same commit as any further extraction. |
| `tests/routes-no-leak.test.ts` | Count of `req.method ===` references in `server.ts` ≤ budget. New REST handlers MUST live in `src/server/routes/<domain>.ts` — `server.ts` does not grow direct branches. |
| `tests/routes-anchor-pinned.test.ts` | Every `pattern: /…/` literal in `src/server/routes/*.ts` starts with `^` and ends with `$`. Catches the copy-paste-an-unanchored-regex regression. |

If you legitimately need to raise a budget (e.g. a route file genuinely needs a
new top-level branch in `server.ts`), update the test in the same commit and
explain why in the commit message.

## Helper-extraction map

The route-split landed alongside extractions of co-located non-route helpers
that previously squatted in `server.ts`. Use these new homes:

| What | Old home | New home |
|---|---|---|
| `execGit`, `execGitSafe` (low-level git shell-out, container-aware) | `server.ts` | `src/server/git/git-exec.ts` |
| `batchGitStatus`, caching, fakes, test hooks (`__getGitStatusInvocationCount`, `__setGitStatusFake`, `invalidateGitStatusCache`, …) | `server.ts` | `src/server/git/git-status.ts` |
| `getGitDiff` | `server.ts` | `src/server/git/git-diff.ts` |
| `_fetchPrStatus`, `getCachedPrStatus`, `getViewerIsAdmin` | `server.ts` | `src/server/git/pr-status.ts` |
| `deleteRemoteGoalBranches` | `server.ts` | `src/server/git/goal-branches.ts` |
| `redactSandboxSecrets`, `mergeSandboxTokensStructured`, `mergeSandboxSecrets`, `mergeSecretsIntoTokens`, `redactSandboxSecretsResolved` | `server.ts` | `src/server/agent/sandbox-secrets.ts` |
| `validateComponentsConfig` | `server.ts` | `src/server/agent/project-config-store.ts` |
| `hasTransitiveDep` (workflow gate dependency check) | `server.ts` | `src/server/agent/workflow-validator.ts` |
| `readBody`, `json`, `jsonError` | `server.ts` | `src/server/routes/route-helpers.ts` |
| `MIME_TYPES`, `loadManifest`, `serveStatic` | `server.ts` | `src/server/static.ts` |

`server.ts` re-exports the git-status test hooks (`__getGitStatusInvocationCount`,
`__resetGitStatusInvocationCount`, `__setGitStatusFake`, `__clearGitStatusFake`,
`invalidateGitStatusCache`, `__forceGitStatusCacheExpiry`) and the
`GitStatusResult` type so existing imports from `"./server.js"` keep working.
New code should import from `src/server/git/*` directly.

## Out of scope

- WebSocket protocol — `src/server/ws/` is unchanged. See
  [`docs/websocket-protocol.md`](websocket-protocol.md).
- Static asset serving — moved to `src/server/static.ts` but otherwise
  byte-identical. SPA shell + `manifest.json` flow unchanged.
- Auth — `requestHandler` in `server.ts` still handles bearer / cookie /
  sandbox-token resolution before dispatch.
