# Subgoals (Experimental) toggle — design doc

Status: design — implementation pending.
Goal: `audit-subg-225e4d3d` (parent) → `subgoals-e-d4554c66` (this child).

## 1. Goal & motivation

The parent goal is landing the full nested-goals stack in PR #497. Before
that PR can merge to `master` we want a single named system-scope flag that
keeps the entire feature surface invisible to users until we promote it
out of experimental status. Default OFF. When OFF, the agent and user
experience must be byte-for-byte identical to pre-subgoals `master`.
ON behaviour matches what `master` becomes after PR #497 lands. No data
migration, no schema change — pure feature flag with ~6 gating sites.

## 2. State shape

### Server side (single source of truth)

System-scope flags already round-trip through the existing
`PreferencesStore`
(`src/server/agent/preferences-store.ts`) via `GET/PUT /api/preferences`
(`src/server/server.ts:4404` and `:4410`). The two existing toggles
(`showTimestamps`, `playAgentFinishSound`) live there as flat keys; we
follow the same convention.

- New key: `"subgoalsEnabled"` (boolean, default `false`).
- Persisted at `<stateDir>/preferences.json`.
- No migration: missing key → treated as `false` (the safer default).
- `broadcastPreferencesChanged()` already fires after every
  `PUT /api/preferences`; UI reactions get the new value automatically.

### Client side

The two existing toggles are **module-level vars** in
`src/app/settings-page.ts` (lines 93–95) loaded lazily by
`loadGeneralSettings()` (line 1818). They are NOT in `state.ts`. We mirror
that pattern for symmetry:

- Add `let settingsSubgoalsEnabled = false;` next to the existing two
  vars at `src/app/settings-page.ts:93–95`.
- Extend `loadGeneralSettings()` (around line 1828) to read
  `prefs.subgoalsEnabled === true`.
- Add `toggleSubgoalsEnabled()` mirroring `togglePlayFinishSound()`
  (line 1866).

### Eager mirror to `document.documentElement.dataset` + UI-state hot path

Several gate sites need a synchronous read with no `await`. We mirror
the value the same way `playAgentFinishSound` does
(`src/app/main.ts:399`):

```ts
document.documentElement.dataset.subgoalsEnabled = prefs.subgoalsEnabled === true ? "true" : "false";
```

Set on initial preferences load (`src/app/main.ts:382`), the
`preferences_changed` WS event handler (`src/app/remote-agent.ts:1203`)
and the toggle handler itself (synchronous, before the `gatewayFetch`).

We **do not** add a field to `state.ts` — keeping the flag a thin
read of `dataset.subgoalsEnabled` matches the existing toggle pair and
keeps the diff small.

## 3. Helper API

### Client: `src/app/subgoals-flag.ts` (new, ~10 lines)

```ts
/** Read the system-scope Subgoals (Experimental) flag. Sync, defaults to false. */
export function isSubgoalsEnabled(): boolean {
  return document.documentElement.dataset.subgoalsEnabled === "true";
}
```

Imported by every UI gate site (six call sites — see §5). One
single-purpose module so we can unit-test it later if we want.

### Server: in-line read against `preferencesStore`

No new module needed — the nine REST routes are all in
`src/server/server.ts` and already have `preferencesStore` in scope. A
small private helper colocated with the routes keeps the diff local:

```ts
// src/server/server.ts — near the other route helpers
function requireSubgoalsEnabled(res: ServerResponse): boolean {
  if (preferencesStore.get("subgoalsEnabled") === true) return true;
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "Subgoals are disabled", code: "SUBGOALS_DISABLED" }));
  return false;
}
```

For the tool-activation path the same boolean is read directly from the
preferences store passed into `computeToolPolicies` — see §7.

## 4. Settings page change

File: `src/app/settings-page.ts`.

Insertion point: between the **"Play sound when an agent finishes"**
block (lines 1899–1913) and the **"System prompt"** block (lines
1914–1928) inside `renderGeneralTab()`.

```ts
<div class="flex flex-col gap-1.5">
  <label class="flex items-center gap-2 cursor-pointer">
    <input
      type="checkbox"
      class="w-4 h-4 rounded border-input accent-primary cursor-pointer"
      data-testid="general-subgoals-enabled"
      .checked=${settingsSubgoalsEnabled}
      @change=${toggleSubgoalsEnabled}
    />
    <span class="text-sm font-medium text-foreground">Subgoals</span>
    <span
      class="ml-1 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      data-testid="experimental-pill"
    >Experimental</span>
  </label>
  <p class="text-xs text-muted-foreground ml-6">
    Enable nested goals (parent / child / DAG subgoals). Surfaces the
    <code>parent</code> workflow, the nine <code>Children</code> tools,
    the Plan tab DAG, and the Children tab on the goal dashboard.
    Currently experimental — behaviour may change.
  </p>
</div>
```

### Badge component

Grep confirms there is no shared `Experimental` / `Beta` pill component
in `src/ui/components/` — the only `Experimental` matches in the repo
are unrelated (`DocxArtifact.ts:122`, `AttachmentOverlay.ts:416`). We
inline the pill with Tailwind classes (the repo's prevailing approach
for one-off badges; see e.g. the inline `rev N` chip at
`src/app/render.ts:813`). If the surface grows we can promote it to a
component later.

## 5. UI gates

Every gate consults `isSubgoalsEnabled()` from the new helper module.
With the flag OFF and no goal having a `parentGoalId` (because no
spawn-child path runs), several gates are dead code anyway — we still
add explicit gates so the **server** flag flip is sufficient even on a
hypothetical pre-existing nested tree (e.g. someone toggled OFF after
toggling ON).

| # | Site | File | Edit |
|---|------|------|------|
| 1 | New-goal workflow picker | `src/app/render.ts:855` (the `_cachedWorkflows.map(...)` inside `renderGoalForm`) | Filter `_cachedWorkflows` through `w => w.id !== "parent" \|\| isSubgoalsEnabled()` before the `.map`. Single-line change. |
| 2 | Plan tab visibility | `src/app/goal-dashboard-tab-visibility.ts::shouldShowPlanTab` (line 29) | Add `if (!isSubgoalsEnabled()) return goal.workflow?.gates.some(g => g.id === "goal-plan") ?? false;` to keep formal `goal-plan` gates visible (legacy workflows might still have them) but suppress the "living plan from children" branch. Even simpler form: `if (!isSubgoalsEnabled()) { return goal.workflow?.gates.some(g => g.id === "goal-plan") ?? false; }`. **Open question:** do any non-`parent` workflows ship a `goal-plan` gate? Quick grep shows `goal-plan` only in the parent workflow (`seed-default-workflows.ts`). If confirmed, the gate becomes the simpler `if (!isSubgoalsEnabled()) return false;`. |
| 3 | Children tab visibility | same file, `shouldShowChildrenTab` (line 53) | `if (!isSubgoalsEnabled()) return false;` at top. |
| 4 | Sidebar nesting | `src/app/sidebar-nesting.ts::buildNestedGoalForest` (line 190) | At top of function, when `!isSubgoalsEnabled()`, return a flat list — every goal becomes its own root with no `children`. Simplest implementation: synthesise a `parentGoalId`-free copy of the input or wrap and bypass the indexing pass. |
| 5 | Mutation-pending message renderer | `src/app/custom-messages.ts:91` (`mutationPendingRenderer`) | The card is only rendered when a `mutation_pending` event arrives. With the server-side gate (§6) the event can't fire when the flag is OFF, so this gate is a *belt-and-braces*. Simplest: in the renderer, return `nothing` if `!isSubgoalsEnabled()`. |
| 6 | Tree-cost row on dashboard | `src/app/goal-dashboard.ts:1430` (the `renderTreeCostRow` block) | Already self-suppresses when `!hasChildren && !isChild`. With flag OFF no goals are children → naturally returns `nothing`. **No edit required.** Documented for completeness. |

### Cascade dialogs (no edit required)

The spec claim is correct. `showArchiveGoalDialog` (line 1721) and
`showPauseGoalDialog` are only invoked from `deleteGoal()` /
`handlePauseGoal()` *after* a server pre-flight reports descendants
(`HAS_DESCENDANTS` 409). With subgoals OFF no goal can have descendants,
so the pre-flight returns 200 and the cascade dialog code path is never
reached. The existing `confirmAction("Archive Goal", …)` flow handles
single-goal archival as it always has.

## 6. Server gates

All nine routes live in `src/server/server.ts`. Each gets one extra
line: `if (!requireSubgoalsEnabled(res)) return;` at the very top of
the handler (after the path/method match, before any body parsing).

| Route | Method | Path | Handler line |
|-------|--------|------|--------------|
| spawn-child | POST | `/api/goals/:id/spawn-child` | `:3443` |
| plan PATCH | PATCH | `/api/goals/:id/plan` | `:3620` |
| plan GET | GET | `/api/goals/:id/plan` | `:3768` |
| integrate-child | POST | `/api/goals/:id/integrate-child/:childId` | `:3816` |
| pause | POST | `/api/goals/:id/pause` | `:3880` |
| resume | POST | `/api/goals/:id/resume` | `:3907` |
| mutation decision | POST | `/api/goals/:id/mutation/:requestId/decision` | `:3933` |
| policy | PATCH | `/api/goals/:id/policy` | `:4002` |
| tree-cost | GET | `/api/goals/:goalId/tree-cost` | `:7940` |

### Response shape

```http
HTTP/1.1 403 Forbidden
content-type: application/json

{ "error": "Subgoals are disabled", "code": "SUBGOALS_DISABLED" }
```

### Cascade routes that stay UNCHANGED

`DELETE /api/goals/:id` and `POST /api/goals/:id/team/teardown` exist
independently of subgoals (single-goal archive / team teardown). Their
existing `cascade: boolean` contract and `HAS_DESCENDANTS` / `422
CASCADE_REQUIRED` semantics are not gated.

### Open question: pause / resume

`pause` and `resume` exist in the codebase as part of the nested-goals
work but are *also* useful for single goals (cancelling in-flight
verifications). The spec lists them in the nine. I'm following the
spec — gated. If we later want them callable on single goals with the
flag OFF we can remove the gate from these two without affecting the
others.

## 7. Tool-activation gate

The nine `Children` tools all live in `defaults/tools/children/` and
declare `group: Children` (verified by grep). This is a normal tool
group, **not** an MCP namespace — confirmed by reading
`defaults/tools/children/extension.ts` and the tool YAMLs (no `mcp__`
prefix anywhere).

`computeToolPolicies` and `computeEffectiveAllowedTools` live in
`src/server/agent/tool-activation.ts`. Both consult
`resolveGrantPolicy(toolName, toolGroup, role, toolManager,
groupPolicyStore)` (line 132). The cleanest gate is one extra layer
inside `resolveGrantPolicy`:

```ts
// Step 0 (top of resolveGrantPolicy): system-scope feature gate.
if (toolGroup === "Children" && !subgoalsEnabled) return "never";
```

This forces every Children-group tool to `never` regardless of role
overrides or group policies. The `subgoalsEnabled` boolean is plumbed
via the existing `groupPolicyStore` parameter — since
`groupPolicyStore` is constructed in the same place
(`session-setup.ts`) where `preferencesStore` is in scope, we either:

**Option A (preferred — minimal):** Read `preferencesStore` directly
from a closure. Add a `getSubgoalsEnabled?: () => boolean` field to
the call signature of `resolveGrantPolicy` (and the two computers that
wrap it). Pass `() => preferencesStore.get("subgoalsEnabled") === true`
from each call site. Three call sites total
(`src/server/agent/tool-activation.ts`).

**Option B:** Bake `Children: never` into a synthetic group-policy
overlay layered on top of `groupPolicyStore`. Slightly larger blast
radius (the synthetic store has to compose with project-scope group
policies) but no signature change. Reject — Option A is simpler.

### Why this is sufficient

`computeEffectiveAllowedTools` filters out any tool whose resolved
policy is `never` (line 302: `if (!isNeverPolicy(policy)) result.push(tool.name)`).
So when the flag is OFF, the agent never sees the nine Children tools
in its tool registry — same as if the project's
`tool-group-policies.yaml` declared `Children: never`. Combined with
the server REST gate (§6), the surface is fully closed even if a
malicious agent hard-codes the route name.

## 8. Tests

### Browser E2E — required by AGENTS.md "E2E coverage requirement"

`tests/e2e/ui/subgoals-experimental-toggle.spec.ts` (new). Pattern:
mirror `tests/e2e/ui/settings.spec.ts`. Four scenarios:

1. **Navigation**: open Settings → System → General; assert the
   `general-subgoals-enabled` checkbox is present and unchecked, the
   `experimental-pill` is rendered.
2. **Happy path**: toggle ON; create a parent-workflow goal; navigate
   to the goal dashboard; assert the Plan tab is visible.
3. **Persistence across reload**: toggle ON; reload; assert checkbox
   still ON. Toggle OFF; reload; assert OFF and the Plan tab on a
   goal with a `goal-plan` gate is hidden (or only visible when the
   gate is formally present, depending on the §5 #2 decision).
4. **Cleanup/undo**: toggle OFF mid-session; assert the parent option
   disappears from the new-goal workflow picker, the sidebar tree
   collapses to a flat list of goals, and the dashboard's Children
   tab is no longer rendered.

### Unit — `tests/subgoals-flag.test.ts` (new)

Asserts:
- `isSubgoalsEnabled()` returns `false` when
  `document.documentElement.dataset.subgoalsEnabled` is unset.
- Returns `true` when set to `"true"`.

### Server unit — `tests/api-subgoals-disabled.test.ts` (new)

Hits each of the nine routes with the flag OFF; asserts HTTP 403 and
`{ code: "SUBGOALS_DISABLED" }` body. Hits one route with the flag ON
and asserts the gate doesn't trip (the request can fail for unrelated
reasons; we just assert non-403). In-process harness pattern, mirror
`tests/e2e/gates-api.spec.ts`.

### Tool-activation unit — `tests/tool-activation-subgoals-flag.test.ts` (new)

Asserts that with the flag OFF every tool in `group: Children` resolves
to `never` even when the role grants them, and that with the flag ON
the existing role-policy cascade applies unchanged.

## 9. Test setup for existing nested-goal tests

**Strategy: default-on harness flag for E2E + per-test
beforeAll for unit tests that exercise the nested code paths.**

Rationale: the existing E2E suites (`tests/e2e/ui/cascade-archive.spec.ts`,
`plan-tab.spec.ts`, `cascade-pause.spec.ts`, `sidebar-nesting.spec.ts`,
`tree-cost-rollup.spec.ts`, `parent-breadcrumb.spec.ts`,
`api-goals-spawn-child-route.spec.ts`) all assume the nested feature
surface exists. Flipping every spec to set the flag manually is N
edits. Instead, set `subgoalsEnabled: true` in the in-process / spawned
gateway harness setup (`tests/e2e/in-process-harness.ts` and
`tests/e2e/gateway-harness.ts`) — the harness already writes test
preferences at startup, so this is a one-line addition. The new
toggle-spec explicitly toggles OFF for its scenarios.

Unit tests under `tests/` that call into `goal-manager.ts` /
`verification-harness.ts` directly don't go through the REST gate, so
they're unaffected by the server flag. Tests that exercise the
tool-activation cascade (e.g. `tests/role-children-tools-policy.test.ts`)
*do* need the flag ON; add a `beforeAll(() => preferences.set("subgoalsEnabled", true))`
to those specs explicitly. There are <10 such files based on grep —
small, surgical edits.

I prefer this hybrid (default-on at the harness layer, opt-in at the
unit layer) to a "default-on everywhere" policy because it makes the
flag's *off* path the explicit-test-required path, which is the
default that ships to users.

## 10. Docs touch

### `AGENTS.md` recipe

Add one entry under **Recipes**, alphabetised near other "Settings"
entries:

> - **Subgoals (Experimental) toggle** → system-scope flag persisted as
>   `subgoalsEnabled` in `<stateDir>/preferences.json`. Read on the
>   client via `isSubgoalsEnabled()` from `src/app/subgoals-flag.ts`;
>   on the server via `preferencesStore.get("subgoalsEnabled")`. Default
>   OFF. When OFF: the `parent` workflow is hidden from the goal
>   workflow picker, the nine `Children`-group tools resolve to `never`
>   in `tool-activation.ts`, and the nine nested-goal REST routes
>   return `403 { code: "SUBGOALS_DISABLED" }`. UI surfaces (Plan tab,
>   Children tab, sidebar nesting, mutation-pending card) gate on the
>   client helper. Toggle UI lives in Settings → System → General
>   between "Play sound" and "System prompt".

### `docs/nested-goals.md`

Add one paragraph at the very top under the existing intro:

> **Status: experimental.** The nested-goals feature is gated behind a
> system-scope toggle ("Subgoals" in Settings → System → General),
> default OFF. With the toggle off the entire feature surface — the
> `parent` workflow, the `Children` tool group, the Plan / Children
> tabs, sidebar nesting, mutation-pending cards, and the nested-goal
> REST routes — is hidden or returns `403 SUBGOALS_DISABLED`. The
> toggle will be retired and the feature promoted out of experimental
> status once the parent goal's audit completes.

## 11. Acceptance criteria (verbatim from goal spec)

1. Toggle visible in Settings → System → General between Play sound
   and System prompt, default OFF.
2. Persists across reload like the other toggles in that block.
3. Off-by-default invariant: fresh install shows no nested-goal UI,
   no parent workflow option, no Children tools, no nested REST
   routes accessible.
4. On invariant: feature behaves identically to current branch HEAD;
   no regression in existing tests.
5. Server gate: nine nested-goal routes return 403 SUBGOALS_DISABLED
   when off; cascade routes unaffected.
6. Tests: browser E2E covering 4 scenarios + unit test for helper
   default and 403 behaviour. Existing nested-goals tests still pass
   (with whatever setup adjustment is needed).
7. Docs: one-line `AGENTS.md` recipe entry describing the toggle +
   one paragraph in `docs/nested-goals.md` saying the feature is
   gated behind a system-scope toggle (default OFF) until promoted
   out of experimental status.
8. `npm run check` clean. `npm run test:unit` green. The new E2E test
   green.

## 12. Risks / open questions

1. **`shouldShowPlanTab` short-circuit shape.** Does any non-`parent`
   workflow ship a `goal-plan` gate? Grep against `seed-default-workflows.ts`
   suggests no, but I haven't audited every project workflow that may
   exist on disk. If confirmed empty, gate #2 collapses to
   `if (!isSubgoalsEnabled()) return false;`. If a stray workflow does
   carry the gate, the nuanced form keeps it visible. Easy to reverse.
2. **Pause / resume gating.** The spec lists them in the nine. They
   work for single goals too — gating them removes the ability to
   pause an in-flight verification on a non-nested goal. Worth a
   quick sanity check with the team-lead before implementation. If the
   answer is "ungate them", that's two lines deleted from §6.
3. **Per-role policy precedence.** Today some roles declare
   `goal_spawn_child: never` etc. explicitly (per AGENTS.md
   "Contributor-role policy"). Step 0 in §7 returns `never` regardless,
   so those overrides become redundant when the flag is OFF — and
   redundant in the safe direction when ON. Pinned by
   `tests/role-children-tools-policy.test.ts`; verify that test still
   passes with the new step 0 in place.
4. **Bundle-size impact.** Near-zero. We add ~10 lines of helper, ~30
   lines of settings-page UI, ~6 single-line gates. No new components,
   no new dependencies. The 600 kB / 500 kB budget asserted by
   `tests/bundle-size.test.ts` is unaffected.
5. **`preferences_changed` propagation latency.** When the user
   toggles, the WS broadcast updates the `dataset` on every connected
   client. Existing dashboards re-render via `renderApp()` already
   wired into the existing toggles. No additional plumbing needed.
6. **Server restart doesn't re-broadcast.** On restart the dataset
   value is set from the initial `/api/preferences` fetch in
   `main.ts:382`. Same as the other two toggles — no drift risk.
