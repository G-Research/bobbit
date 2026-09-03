import { describe, expect, it } from "vitest";
import {
	TEST_LAYOUT,
	classifyTestPath,
	normalizeTestPath,
	patternsFor,
	validateTestInventory,
	validateTestPath,
} from "../../../scripts/testing/layout-policy.mjs";

type Convention = { semantic: string; pattern: string };
type Diagnostic = { code: string };

const VALID_PATHS = [
	["tests/unit/core/path/math.unit.test.ts", "unit-core", "unit", "vitest"],
	["tests/unit/isolated/env.isolated.test.ts", "unit-isolated", "unit", "vitest"],
	["tests/dom/panel.dom.test.ts", "dom", "unit", "vitest"],
	["tests/integration/gateway/api.gateway.test.ts", "gateway-integration", "unit", "vitest"],
	["tests/browser/fixtures/pr-walkthrough-panel-parity.fixture.spec.ts", "browser-fixture", "browser", "playwright"],
	["tests/browser/journeys/create-goal.journey.spec.ts", "browser-journey", "browser", "playwright"],
	["tests/e2e/node/worktree.node-e2e.test.ts", "node-e2e", "e2e", "node"],
	["tests/e2e/vitest/restart.vitest-e2e.test.ts", "vitest-e2e", "e2e", "vitest"],
	["tests/e2e/api/mcp.api-e2e.spec.ts", "api-e2e", "e2e", "playwright"],
	["tests/e2e/browser/docker.browser-e2e.spec.ts", "browser-e2e", "e2e", "playwright"],
	["tests/manual/real-model.manual.spec.ts", "manual", "manual", "playwright"],
] as const;

describe("test layout classification", () => {
	it.each(VALID_PATHS)("classifies %s exactly once", (filePath, semantic, lane, runner) => {
		expect(classifyTestPath(filePath)).toEqual({
			semantic,
			lane,
			runner,
			pattern: (TEST_LAYOUT as readonly Convention[]).find((entry) => entry.semantic === semantic)?.pattern,
		});
		expect(validateTestPath(filePath)).toEqual([]);
	});

	it("normalizes Windows separators without hiding traversal or absolute paths", () => {
		expect(normalizeTestPath(".\\tests\\dom\\nested\\panel.dom.test.ts")).toBe("tests/dom/nested/panel.dom.test.ts");
		expect(classifyTestPath("tests\\dom\\nested\\panel.dom.test.ts")?.semantic).toBe("dom");
		expect(validateTestPath("tests/dom/../dom/panel.dom.test.ts")[0]?.code).toBe("path-traversal");
		expect(validateTestPath("C:\\repo\\tests\\dom\\panel.dom.test.ts")[0]?.code).toBe("absolute-path");
		expect(validateTestPath("tests/dom/bad\0name.dom.test.ts")[0]?.code).toBe("nul-path");
	});

	it("derives owner patterns without a file registry", () => {
		expect(patternsFor("unit")).toHaveLength(4);
		expect(patternsFor("playwright")).toHaveLength(5);
		expect(patternsFor("api-e2e")).toEqual(["tests/e2e/api/**/*.api-e2e.spec.ts"]);
		expect(patternsFor("unknown-owner")).toEqual([]);
	});

	it("rejects duplicate and case-folded inventory paths", () => {
		const diagnostics = validateTestInventory([
			"tests/dom/panel.dom.test.ts",
			"tests/dom/panel.dom.test.ts",
			"tests/dom/Panel.dom.test.ts",
		]);
		expect(diagnostics.map(({ code }: Diagnostic) => code)).toEqual(expect.arrayContaining(["duplicate-path", "case-collision"]));
	});
});
