// src/server/agent/lifecycle-hooks.ts
//
// SINGLE SOURCE OF TRUTH for the Extension Platform's lifecycle-hook contract
// (finding EXT-02). Before this file existed, the accepted/dispatched/bridged
// hook set was hand-copied as FOUR independent literals:
//
//   1. lifecycle-hub.ts        `LifecycleHook` union (typed the generic
//                               dispatch()/hasProvidersForHooks() surface)
//   2. pack-contributions.ts   `PROVIDER_HOOKS` Set (gates which hook names a
//                               providers/<id>.yaml manifest may declare)
//   3. provider-bridge-extension.ts `TURN_BRIDGE_HOOKS` (which hooks require
//                               the in-process per-turn bridge extension)
//   4. server.ts                inline `["goalCompleted"]` array passed to
//                               `hasProvidersForHooks()` to gate TeamManager's
//                               `hasGoalCompletedProviders` presence check
//
// Any hook add/remove that missed one of the four silently broke pack
// loading, dispatch, or the goalCompleted presence gate (this is exactly how
// the goalCompleted outage in EXT-01 happened: added to the union, forgotten
// in PROVIDER_HOOKS). All four now derive from the arrays below so an edit is
// a conscious decision made in exactly ONE place.
//
// This lives in its own module (not inside lifecycle-hub.ts) to avoid an
// import cycle: lifecycle-hub.ts already imports `packIdFromRoot` from
// pack-contributions.ts, so pack-contributions.ts cannot import lifecycle-hub.ts
// back without creating one. Both import this leaf module instead.
//
// Wave 0(a) of the Classifier Framework lane: this derived hook list is also
// the planned input to a future `dispatchDecision()` interception-point
// registry, so collapsing it to one source matters beyond hygiene here.

/**
 * Hook names that appear as a `LifecycleHook`-typed value somewhere in
 * LifecycleHub's public surface: `dispatch(hook: LifecycleHook, ...)`,
 * `hasProvidersForHooks(..., hooks: readonly LifecycleHook[], ...)`, and
 * `HubDiagnostic.hook`. `sessionSetup`/`beforePrompt`/`afterTurn`/
 * `beforeCompact`/`sessionShutdown` flow through the generic `dispatch()`;
 * `goalCompleted` has its own dedicated `dispatchGoalCompleted()` method (it
 * needs richer, goal-specific ctx and returns `{ diagnostics }`) but is
 * PASSED as a `LifecycleHook` at its `hasProvidersForHooks(..., ["goalCompleted"], ...)`
 * call site (server.ts) and pushed into `HubDiagnostic.hook`, so it must be
 * part of this union too. This is the `LifecycleHook` union (see
 * lifecycle-hub.ts).
 */
export const LIFECYCLE_HOOKS = [
	"sessionSetup",
	"beforePrompt",
	"afterTurn",
	"beforeCompact",
	"sessionShutdown",
	"goalCompleted",
] as const;

/**
 * Hooks a provider may declare in `providers/<id>.yaml` `hooks:` that are
 * NEVER passed through a `LifecycleHook`-typed parameter anywhere — they're
 * referenced only as a raw string literal inside their own dedicated
 * dispatch method, so they don't need to (and don't) belong to
 * `LIFECYCLE_HOOKS`/`LifecycleHook`.
 *
 * `goalProvisioned`: fired once per worktree provisioning in a goal's
 * subtree via `LifecycleHub.dispatchGoalProvisioned()`, which hardcodes the
 * `"goalProvisioned"` string literal directly (fire-and-forget, produces no
 * `HubDiagnostic` entries — unlike `goalCompleted` above) — see
 * lifecycle-hub.ts.
 */
export const GOAL_ONLY_HOOKS = ["goalProvisioned"] as const;

/**
 * Every hook name a `providers/<id>.yaml` manifest is allowed to declare —
 * the acceptance list `PROVIDER_HOOKS` (pack-contributions.ts) validates
 * against at load time. Union of the generic-dispatch hooks and the
 * goal-only, dedicated-dispatch hooks.
 */
export const ALL_PROVIDER_HOOKS = [...LIFECYCLE_HOOKS, ...GOAL_ONLY_HOOKS] as const;

/** A hook accepted by `LifecycleHub.dispatch()` / `hasProvidersForHooks()`. */
export type LifecycleHook = (typeof LIFECYCLE_HOOKS)[number];

/**
 * The `hasProvidersForHooks()` gate array for TeamManager's
 * `hasGoalCompletedProviders` presence check (server.ts) — whether any
 * enabled provider declares `goalCompleted` at all, checked before bothering
 * to dispatch. A named, derived array (not an inline `["goalCompleted"]`
 * literal at the call site) so consumer #4 above can't drift from
 * `LIFECYCLE_HOOKS`.
 */
export const GOAL_COMPLETED_PRESENCE_HOOKS: readonly LifecycleHook[] = LIFECYCLE_HOOKS.filter(
	(h) => h === "goalCompleted",
);
