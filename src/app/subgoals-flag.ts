/**
 * Sync read of the system-scope **Subgoals (Experimental)** feature flag.
 *
 * The flag is mirrored to `document.documentElement.dataset.subgoalsEnabled`
 * on initial preferences load (`main.ts`), on the `preferences_changed` WS
 * broadcast (`remote-agent.ts`), and synchronously by the toggle handler in
 * `settings-page.ts`. Callers consult this helper from UI gate sites without
 * having to await preferences.
 *
 * Default OFF — undefined or anything other than the string `"true"` reads
 * as disabled. See docs/design/subgoals-experimental-toggle.md.
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
