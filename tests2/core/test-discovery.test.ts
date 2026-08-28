// v2-native — focused contract coverage for convention-based test discovery.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	classifyTestPath,
	discoverTests,
	normalizeTestPath,
	validateIntroducedTestPaths,
} from "../../scripts/testing-v2/test-discovery.mjs";

const ISOLATED_TEST_CAP = 14;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bobbit-test-discovery-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function materialize(...paths: string[]): void {
	for (const path of paths) {
		const target = join(root, ...normalizeTestPath(path).split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "", "utf8");
	}
}

const CLASSIFICATIONS = [
	["tests2/core/deep/core.test.ts", { lane: "core", phase: "unit", runner: "vitest", project: "v2-core" }],
	["tests2/dom/deep/dom.test.ts", { lane: "dom", phase: "unit", runner: "vitest", project: "v2-dom" }],
	["tests2/integration/deep/integration.test.ts", { lane: "integration", phase: "unit", runner: "vitest", project: "v2-integration" }],
	["tests2/core/deep/state.isolated.test.ts", { lane: "isolated", phase: "unit", runner: "vitest", project: "v2-isolated" }],
	["tests2/integration/deep/process.e2e.test.ts", { lane: "vitestE2E", phase: "e2e", runner: "vitest", project: "v2-e2e-vitest", e2eGroup: "D" }],
	["tests2/browser/deep/journey.spec.ts", { lane: "browser", phase: "browser", runner: "playwright", project: "browser-v2" }],
	["tests2/browser/e2e/deep/journey.spec.ts", { lane: "browserE2E", phase: "e2e", runner: "playwright", project: "browser-v2-e2e", e2eGroup: "C" }],
	["tests/worktree.e2e.test.ts", { lane: "e2eNode", phase: "e2e", runner: "tsx", project: "e2e-node", e2eGroup: "A" }],
	["tests/e2e/deep/restart.e2e.spec.ts", { lane: "e2ePlaywright", phase: "e2e", runner: "playwright", project: "e2e-playwright", e2eGroup: "B" }],
	["tests/manual-integration/deep/real.spec.ts", { lane: "manual", phase: "manual", runner: "playwright", project: "manual-integration" }],
	["tests/manual-integration/deep/real.test.ts", { lane: "manual", phase: "manual", runner: "playwright", project: "manual-integration" }],
] as const;

describe("classifyTestPath", () => {
	it.each(CLASSIFICATIONS)("classifies %s from POSIX and Windows paths", (path, expected) => {
		const posixOwner = classifyTestPath(path);
		const windowsOwner = classifyTestPath(path.replaceAll("/", "\\"));

		expect(posixOwner).toEqual(expected);
		expect(windowsOwner).toBe(posixOwner);
		expect(Object.isFrozen(posixOwner)).toBe(true);
	});

	it("normalizes separators and a repository-relative prefix", () => {
		expect(normalizeTestPath(".\\tests2\\core\\nested\\one.test.ts")).toBe("tests2/core/nested/one.test.ts");
	});

	it.each([
		["tests2/core/wrong.spec.ts", "tests2/browser"],
		["tests2/integration/wrong.spec.ts", "tests2/browser"],
		["tests2/browser/wrong.test.ts", "tests2/core, tests2/dom, or tests2/integration"],
		["tests2/dom/wrong.isolated.test.ts", "tests2/core or tests2/integration"],
		["tests2/dom/wrong.e2e.test.ts", "tests2/core or tests2/integration"],
		["tests2/unsupported/wrong.test.ts", "tests2/core|dom|integration"],
		["tests2/core/wrong.isolated.e2e.test.ts", "exactly one semantic suffix"],
		["../tests2/core/traversal.test.ts", "without '..' traversal"],
	])("rejects unsupported or ambiguous placement %s actionably", (path, remedy) => {
		expect(() => classifyTestPath(path)).toThrow(remedy);
	});

	it("leaves non-test sources and pre-existing unmarked legacy tests inactive", () => {
		expect(classifyTestPath("tests2/core/helper.ts")).toBeNull();
		expect(classifyTestPath("tests/legacy.test.ts")).toBeNull();
		expect(classifyTestPath("tests/e2e/legacy.spec.ts")).toBeNull();
	});
});

describe("discoverTests", () => {
	it("recursively discovers, sorts, and assigns every active convention exactly once", () => {
		const activePaths = [
			"tests2/core/z-last.test.ts",
			"tests2/core/nested/a-first.test.ts",
			"tests2/dom/z-dom.test.ts",
			"tests2/integration/a-integration.test.ts",
			"tests2/core/z-state.isolated.test.ts",
			"tests2/integration/a-state.isolated.test.ts",
			"tests2/core/z-process.e2e.test.ts",
			"tests2/integration/a-process.e2e.test.ts",
			"tests2/browser/z-browser.spec.ts",
			"tests2/browser/nested/a-browser.spec.ts",
			"tests2/browser/e2e/z-e2e.spec.ts",
			"tests2/browser/e2e/nested/a-e2e.spec.ts",
			"tests/z-node.e2e.test.ts",
			"tests/a-node.e2e.test.ts",
			"tests/e2e/z-playwright.e2e.spec.ts",
			"tests/e2e/nested/a-playwright.e2e.spec.ts",
			"tests/manual-integration/z-manual.test.ts",
			"tests/manual-integration/nested/a-manual.spec.ts",
		];
		materialize(...activePaths, "tests2/core/helper.ts", "tests/legacy.test.ts", "tests/e2e/legacy.spec.ts");

		const discovery = discoverTests({ repoRoot: root });

		expect(discovery.core).toEqual(["tests2/core/nested/a-first.test.ts", "tests2/core/z-last.test.ts"]);
		expect(discovery.dom).toEqual(["tests2/dom/z-dom.test.ts"]);
		expect(discovery.integration).toEqual(["tests2/integration/a-integration.test.ts"]);
		expect(discovery.isolated).toEqual(["tests2/core/z-state.isolated.test.ts", "tests2/integration/a-state.isolated.test.ts"]);
		expect(discovery.vitestE2E).toEqual(["tests2/core/z-process.e2e.test.ts", "tests2/integration/a-process.e2e.test.ts"]);
		expect(discovery.browser).toEqual(["tests2/browser/nested/a-browser.spec.ts", "tests2/browser/z-browser.spec.ts"]);
		expect(discovery.browserE2E).toEqual(["tests2/browser/e2e/nested/a-e2e.spec.ts", "tests2/browser/e2e/z-e2e.spec.ts"]);
		expect(discovery.manual).toEqual(["tests/manual-integration/nested/a-manual.spec.ts", "tests/manual-integration/z-manual.test.ts"]);
		expect(discovery.e2eGroups).toEqual({
			A: ["tests/a-node.e2e.test.ts", "tests/z-node.e2e.test.ts"],
			B: ["tests/e2e/nested/a-playwright.e2e.spec.ts", "tests/e2e/z-playwright.e2e.spec.ts"],
			C: discovery.browserE2E,
			D: discovery.vitestE2E,
		});
		expect(discovery.unit).toEqual([
			...discovery.core,
			...discovery.dom,
			...discovery.integration,
			...discovery.isolated,
		].sort());
		expect(discovery.vitest).toEqual([...discovery.unit, ...discovery.vitestE2E].sort());
		expect(discovery.all).toEqual([...activePaths].sort());
		expect(new Set(discovery.all).size).toBe(discovery.all.length);
		expect(discovery.browser).not.toContain("tests2/browser/e2e/z-e2e.spec.ts");
		expect(discovery.core).not.toContain("tests2/core/z-state.isolated.test.ts");
		expect(discovery.integration).not.toContain("tests2/integration/a-process.e2e.test.ts");
		expect(Object.isFrozen(discovery)).toBe(true);
		expect(Object.isFrozen(discovery.all)).toBe(true);
		expect(Object.isFrozen(discovery.e2eGroups)).toBe(true);
		expect(() => discovery.all.push("tests2/core/mutation.test.ts")).toThrow();
	});

	it("returns an immutable empty inventory when active roots are missing", () => {
		const discovery = discoverTests({ repoRoot: root });

		expect(discovery.all).toEqual([]);
		expect(discovery.e2eGroups).toEqual({ A: [], B: [], C: [], D: [] });
		expect(Object.isFrozen(discovery.unit)).toBe(true);
	});

	it("does not follow symlinked directories", () => {
		const external = join(root, "external-tests");
		mkdirSync(external, { recursive: true });
		writeFileSync(join(external, "linked.test.ts"), "", "utf8");
		const core = join(root, "tests2", "core");
		mkdirSync(core, { recursive: true });
		symlinkSync(external, join(core, "linked"), process.platform === "win32" ? "junction" : "dir");

		expect(discoverTests({ repoRoot: root }).all).toEqual([]);
	});

	it("rejects managed-root suffix mismatches found during traversal", () => {
		materialize("tests2/browser/api.test.ts", "tests2/core/journey.spec.ts");

		expect(() => discoverTests({ repoRoot: root })).toThrow("Unsupported test placement");
	});

	it(`enforces the numeric isolated-test cap of ${ISOLATED_TEST_CAP}`, () => {
		materialize(...Array.from({ length: ISOLATED_TEST_CAP }, (_, index) => `tests2/core/state-${index}.isolated.test.ts`));
		expect(discoverTests({ repoRoot: root }).isolated).toHaveLength(ISOLATED_TEST_CAP);

		materialize("tests2/integration/one-too-many.isolated.test.ts");
		expect(() => discoverTests({ repoRoot: root })).toThrow(`maximum is ${ISOLATED_TEST_CAP}`);
	});
});

describe("validateIntroducedTestPaths", () => {
	it("accepts every active convention, Windows paths, duplicates, and non-test sources", () => {
		expect(() => validateIntroducedTestPaths([
		...CLASSIFICATIONS.map(([path]) => path),
		"tests2\\core\\windows.test.ts",
		"tests2/core/windows.test.ts",
		"src/server/helper.ts",
	])).not.toThrow();
	});

	it("aggregates actionable errors for newly introduced inactive legacy paths", () => {
		expect(() => validateIntroducedTestPaths([
		"tests/new.test.ts",
		"tests\\e2e\\new.spec.ts",
		"tests2/unsupported/new.test.ts",
	])).toThrowError(expect.objectContaining({
		message: expect.stringContaining("tests/new.test.ts"),
	}));
		try {
			validateIntroducedTestPaths(["tests/new.test.ts", "tests/e2e/new.spec.ts"]);
			expect.unreachable("invalid introduced paths should fail");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("tests2/core|dom|integration/**/*.test.ts");
			expect(message).toContain("tests/e2e/new.spec.ts");
			expect(message).toContain("*.e2e.spec.ts");
		}
	});

	it("does not alter filesystem discovery", () => {
		materialize("tests2/core/automatic.test.ts");
		const before = discoverTests({ repoRoot: root });

		validateIntroducedTestPaths(["tests2/browser/automatic.spec.ts"]);

		expect(discoverTests({ repoRoot: root })).toEqual(before);
	});
});
