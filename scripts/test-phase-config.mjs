/**
 * Single source of truth for the unit-phase node-runner globs.
 *
 * Consumed by BOTH:
 *   - scripts/run-unit.mjs            — the actual unit runner (gate `unit:`)
 *   - tests/test-phase-invariant.e2e.test.ts — the guard that pins the invariant
 *
 * Keeping the globs here (rather than duplicated in the runner script and the
 * guard) means the guard can never silently drift from what the runner runs:
 * if you add a new node-test directory, you change this list once and both the
 * runner and the guard's "unit node" bucket update together.
 *
 * Globs are repo-root-relative and are passed VERBATIM to node's test runner
 * (which expands them itself). They must never be expanded by the shell — on
 * Windows the top-level `tests/*.test.ts` glob alone expands to 340+ paths and
 * blows the ~32k command-line limit (see docs/testing-strategy.md).
 */
import { TEST_LAYOUT } from "./testing/layout-policy.mjs";

export const NODE_UNIT_GLOBS = ["tests/*.test.ts", "tests/contract/*.test.ts"];

/** Pure Playwright path selection for legacy unit-browser fixtures. */
export function createUnitBrowserPhaseSelection() {
	return {
		testDir: ".",
		testMatch: "**/*.spec.ts",
		testIgnore: ["e2e/**", "manual-integration/**"],
	};
}

function canonicalMatch(semantic) {
	const convention = TEST_LAYOUT.find((entry) => entry.semantic === semantic);
	if (!convention) throw new Error(`Canonical ${semantic} test convention is missing`);
	return `**/*${convention.suffix}`;
}

/** Pure Playwright path selection shared by the E2E config and phase invariant. */
export function createE2EPhaseSelection() {
	return {
		api: {
			name: "api",
			testDir: "./tests/e2e",
			testIgnore: [
				"**/ui/**",
				"**/session-lifecycle-ui*",
				"**/mcp-tool-permission*",
				"**/mcp-integration*",
				"**/per-project-config-dirs*",
				"**/port-auto-increment*",
				"**/api/**",
				"**/browser/**",
				"**/node/**",
				"**/vitest/**",
				"**/goal-archive-branch-cleanup*",
			],
		},
		apiCanonical: {
			name: "api-canonical",
			testDir: "./tests/e2e/api",
			testMatch: [canonicalMatch("api-e2e")],
		},
		browserCanonical: {
			name: "browser-canonical",
			testDir: "./tests/e2e/browser",
			testMatch: [canonicalMatch("browser-e2e")],
		},
		apiRealpush: {
			name: "api-realpush",
			testDir: "./tests/e2e",
			testMatch: ["**/goal-archive-branch-cleanup.e2e.spec.ts"],
		},
		browser: {
			name: "browser",
			testDir: "./tests/e2e",
			testMatch: [
				"**/ui/*.spec.ts",
				"**/session-lifecycle-ui*.spec.ts",
				"**/mcp-tool-permission*.spec.ts",
				"**/mcp-integration*.spec.ts",
				"**/per-project-config-dirs*.spec.ts",
				"**/port-auto-increment*.spec.ts",
			],
		},
	};
}
