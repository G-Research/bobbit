const BROWSER_TEST_ROOT = "tests/browser/";

export const BROWSER_MCP_PROJECT = "browser-mcp";
export const BROWSER_ISOLATED_PROJECT = "browser-isolated";
export const BROWSER_CANONICAL_PROJECT = "browser-canonical";
export const BROWSER_PROJECT_NAMES = Object.freeze([
	BROWSER_MCP_PROJECT,
	BROWSER_ISOLATED_PROJECT,
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

/** Non-MCP specs whose worker-scoped fixture options give them distinct worker hashes. */
export const ISOLATED_BROWSER_SPEC_PATHS = Object.freeze([
	"tests/browser/fixtures/request-admission-preview-compatibility.fixture.spec.ts",
	"tests/browser/journeys/base-path-mounting.journey.spec.ts",
	"tests/browser/journeys/debug-mode-toggle.journey.spec.ts",
	"tests/browser/journeys/explicit-gateway-base-path.journey.spec.ts",
	"tests/browser/journeys/pack-hot-reload.journey.spec.ts",
]);

export const ISOLATED_BROWSER_TEST_MATCHES = Object.freeze(ISOLATED_BROWSER_SPEC_PATHS.map(
	(path) => `**/${path.slice(BROWSER_TEST_ROOT.length)}`,
));

const NON_CANONICAL_BROWSER_TEST_MATCHES = Object.freeze([
	...MCP_BROWSER_TEST_MATCHES,
	...ISOLATED_BROWSER_TEST_MATCHES,
]);

/**
 * Keep all lanes in one Playwright invocation. The narrow one-worker project
 * caps let MCP and isolated worker identities start early without consuming
 * the coordinator's global worker grant or starving ordinary browser work.
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
			name: BROWSER_ISOLATED_PROJECT,
			testDir: "./tests/browser",
			testMatch: ISOLATED_BROWSER_TEST_MATCHES,
			fullyParallel: true,
			workers: 1,
			use,
		},
		{
			name: BROWSER_CANONICAL_PROJECT,
			testDir: "./tests/browser",
			testMatch: canonicalBrowserMatches,
			testIgnore: NON_CANONICAL_BROWSER_TEST_MATCHES,
			fullyParallel: true,
			use,
		},
	];
}
