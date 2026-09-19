const BROWSER_TEST_ROOT = "tests/browser/";

export const BROWSER_MCP_PROJECT = "browser-mcp";
export const BROWSER_CANONICAL_PROJECT = "browser-canonical";
export const BROWSER_PROJECT_NAMES = Object.freeze([
	BROWSER_MCP_PROJECT,
	BROWSER_CANONICAL_PROJECT,
]);

/** Browser specs that start a real MCP subprocess and therefore must not overlap. */
export const MCP_BROWSER_SPEC_PATHS = Object.freeze([
	"tests/browser/journeys/mcp-preview-gateway-isolation.journey.spec.ts",
	"tests/browser/journeys/mcp-project-approval.journey.spec.ts",
	"tests/browser/journeys/mcp-runtime-error-redaction.journey.spec.ts",
	"tests/browser/journeys/mcp-worktree-approval.journey.spec.ts",
]);

export const MCP_BROWSER_TEST_MATCHES = Object.freeze(MCP_BROWSER_SPEC_PATHS.map(
	(path) => `**/${path.slice(BROWSER_TEST_ROOT.length)}`,
));

/**
 * Keep both lanes in one Playwright invocation while applying the narrow
 * per-project worker cap supported by the repository's locked Playwright 1.60.
 */
export function createBrowserProjects({ canonicalBrowserMatches, use }) {
	return [
		{
			name: BROWSER_MCP_PROJECT,
			testDir: "./tests/browser",
			testMatch: MCP_BROWSER_TEST_MATCHES,
			fullyParallel: true,
			workers: 1,
			use,
		},
		{
			name: BROWSER_CANONICAL_PROJECT,
			testDir: "./tests/browser",
			testMatch: canonicalBrowserMatches,
			testIgnore: MCP_BROWSER_TEST_MATCHES,
			fullyParallel: true,
			use,
		},
	];
}
