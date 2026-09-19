import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BROWSER_CANONICAL_PROJECT,
	BROWSER_MCP_PROJECT,
	BROWSER_PROJECT_NAMES,
	createBrowserProjects,
	MCP_BROWSER_SPEC_PATHS,
	MCP_BROWSER_TEST_MATCHES,
} from "../../../scripts/testing-v2/browser-project-schedule.mjs";
import { discoverTests } from "../../../scripts/testing-v2/test-discovery.mjs";
import { TEST_LAYOUT } from "../../../scripts/testing/layout-policy.mjs";

type ScheduledBrowserProject = {
	name: string;
	testMatch: readonly string[];
	testIgnore?: readonly string[];
	fullyParallel: boolean;
	workers?: number;
	use: { browserName: string };
};

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const canonicalBrowserMatches = (TEST_LAYOUT as readonly { semantic: string; suffix: string }[])
	.filter(({ semantic }) => semantic === "browser-fixture" || semantic === "browser-journey")
	.map(({ suffix }) => `**/*${suffix}`);

function configuredProjects(): { use: { browserName: string }; projects: ScheduledBrowserProject[] } {
	const use = { browserName: "chromium" };
	const projects = createBrowserProjects({ canonicalBrowserMatches, use }) as ScheduledBrowserProject[];
	return { use, projects };
}

describe("browser project scheduling", () => {
	it("runs the MCP project first with a one-worker cap without changing the global grant", () => {
		const { use, projects } = configuredProjects();
		const configSource = readFileSync(join(REPO_ROOT, "playwright-v2.config.ts"), "utf8");

		expect(BROWSER_PROJECT_NAMES).toEqual([BROWSER_MCP_PROJECT, BROWSER_CANONICAL_PROJECT]);
		expect(projects.map(({ name }) => name)).toEqual(BROWSER_PROJECT_NAMES);
		expect(projects[0]).toMatchObject({
			name: BROWSER_MCP_PROJECT,
			workers: 1,
			fullyParallel: true,
			use,
		});
		expect(projects[1]).toMatchObject({
			name: BROWSER_CANONICAL_PROJECT,
			fullyParallel: true,
			use,
		});
		expect(projects[1]).not.toHaveProperty("workers");
		expect(projects.every((project) => !("retries" in project))).toBe(true);
		expect(configSource).toContain("workers: playwrightWorkers");
		expect(configSource).toContain("projects: createBrowserProjects({");
	});

	it("keeps the literal real-MCP inventory exact, disjoint, and complete", () => {
		const { projects } = configuredProjects();
		const browserSpecs = discoverTests({ repoRoot: REPO_ROOT }).browser as readonly string[];
		const literalRealMcpSpecs = browserSpecs.filter((path) => {
			const source = readFileSync(join(REPO_ROOT, ...path.split("/")), "utf8");
			return /enableMcp\s*:\s*true/.test(source);
		});

		expect(literalRealMcpSpecs).toHaveLength(4);
		expect(literalRealMcpSpecs).toEqual(MCP_BROWSER_SPEC_PATHS);
		expect(projects[0].testMatch).toEqual(MCP_BROWSER_TEST_MATCHES);
		expect(projects[1].testMatch).toEqual(canonicalBrowserMatches);
		expect(projects[1].testIgnore).toEqual(MCP_BROWSER_TEST_MATCHES);

		const mcpSpecs = browserSpecs.filter((path) => MCP_BROWSER_SPEC_PATHS.includes(path));
		const canonicalSpecs = browserSpecs.filter((path) => !MCP_BROWSER_SPEC_PATHS.includes(path));
		expect(mcpSpecs).toEqual(MCP_BROWSER_SPEC_PATHS);
		expect(new Set([...mcpSpecs, ...canonicalSpecs])).toEqual(new Set(browserSpecs));
		expect(mcpSpecs.filter((path) => canonicalSpecs.includes(path))).toEqual([]);
	});
});
