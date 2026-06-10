/**
 * Pure helper: decide whether a `refreshSessions()` invocation should be
 * treated as an *initial* load — i.e. whether it should flip
 * `state.sessionsLoading = true` and blank the sidebar to a "Loading…"
 * placeholder while it fetches.
 *
 * This decision was previously inlined in `refreshSessions()` (src/app/api.ts)
 * as `state.gatewaySessions.length === 0 && !state.sessionsError`. That module
 * pulls the DOM-bound app-shell graph (via `renderApp`) and so is not
 * runtime-importable in node:test. Following the established pattern
 * (`safe-storage.ts`/`error-helpers.ts` + their tests), the decision is
 * extracted here as a tiny dependency-free function that can be unit-tested
 * directly in node — fast and DOM-free.
 *
 * Contract: initial-load is keyed off whether a fetch has ever COMPLETED —
 * `state.sessionsGeneration` is -1 until the first successful fetch and >= 0
 * thereafter — not off list emptiness. List length is the wrong proxy for
 * "never fetched": a user whose `gatewaySessions` is legitimately empty
 * (projects/goals but no live sessions, or no projects at all) keeps
 * `length === 0` true forever, which previously re-entered "initial load" on
 * every 5s poll tick and re-blanked the sidebar. We still suppress the spinner
 * while an error is on screen so background poll retries stay silent under the
 * error/Retry UI. Pinned by tests/sidebar-loading-flash.test.ts.
 */
export interface SessionLoadStateArgs {
	/** Current length of `state.gatewaySessions`. */
	gatewaySessionsLength: number;
	/** `state.sessionsGeneration`: -1 until the first successful fetch, then >= 0. */
	sessionsGeneration: number;
	/** `state.sessionsError`: empty string when there is no error. */
	sessionsError: string;
}

/**
 * Returns true when `refreshSessions()` should show the one-time "Loading…"
 * spinner for this invocation.
 */
export function isInitialSessionsLoad(args: SessionLoadStateArgs): boolean {
	return args.sessionsGeneration < 0 && !args.sessionsError;
}
