/**
 * Sync read of the system-scope **Subgoals (Experimental)** feature flag.
 *
 * The flag is mirrored to `document.documentElement.dataset.subgoalsEnabled`
 * on initial preferences load (`main.ts`), on the `preferences_changed` WS
 * broadcast (`remote-agent.ts`), and synchronously by the toggle handler in
 * `settings-page.ts`. Callers consult this helper from UI gate sites without
 * having to await preferences.
 *
 * Default OFF — only an explicit stored `true` (mirrored as the string
 * `"true"`) reads as enabled. A missing/undefined dataset value reads as
 * disabled, matching the server's unset → disabled default.
 * See docs/nested-goals.md.
 */

let testOverride: boolean | undefined;

export function isSubgoalsEnabled(): boolean {
	if (testOverride !== undefined) return testOverride;
	if (typeof document === "undefined") return false;
	return document.documentElement.dataset.subgoalsEnabled === "true";
}

/**
 * Test-only override. Pass `true`/`false` to force the flag in unit tests
 * that don't run in a browser, or `undefined` to clear the override and
 * fall back to the dataset read.
 */
export function _setSubgoalsEnabledForTesting(value: boolean | undefined): void {
	testOverride = value;
}

let maxNestingDepthOverride: number | undefined;

/** Read the system-scope max-nesting-depth pref. Default 3 when missing/invalid. */
export function getSystemMaxNestingDepth(): number {
	if (maxNestingDepthOverride !== undefined) return maxNestingDepthOverride;
	if (typeof document === "undefined") return 3;
	const raw = document.documentElement.dataset.maxNestingDepth;
	const n = raw ? Number(raw) : NaN;
	if (!Number.isFinite(n) || n < 1) return 3;
	return Math.floor(n);
}

export function _setMaxNestingDepthForTesting(value: number | undefined): void {
	maxNestingDepthOverride = value;
}
