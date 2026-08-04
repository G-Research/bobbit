// v2-native — nested documentation skip-all classification regression.
import { describe, expect, it } from "vitest";
import {
	classifyAffectedTests,
	isDocumentationOnly,
	isKnownDocumentation,
} from "../../scripts/affected/classification.mjs";

const TESTS = [
	"tests2/core/prompt-owner.test.ts",
	"tests2/core/skill-owner.test.ts",
	"tests2/core/config-owner.test.ts",
	"tests2/core/pack-owner.test.ts",
	"tests2/core/control.test.ts",
];

const GRAPH_OWNED_MARKDOWN = new Map([
	["defaults/system-prompt.md", new Set([TESTS[0]])],
	[".claude/skills/release/SKILL.md", new Set([TESTS[1]])],
	[".bobbit/config/example/README.md", new Set([TESTS[2]])],
	["market-packs/example/README.md", new Set([TESTS[3]])],
]);

function fixtureGraph() {
	return {
		testFiles: [...TESTS],
		testDeps: new Map(TESTS.map((test) => [test, new Set()])),
		browserDeps: new Map(),
		srcToTests: GRAPH_OWNED_MARKDOWN,
		srcToBrowser: new Map(),
		meta: {},
	};
}

function expectSkipAll(changes: Parameters<typeof classifyAffectedTests>[1]): void {
	const graph = fixtureGraph();
	expect(isDocumentationOnly(graph, changes)).toBe(true);
	const plan = classifyAffectedTests(graph, changes);
	expect(plan.kind).toBe("skip-all");
	expect(plan.cachePolicy).toBe("eligible");
	expect(plan.affected).toEqual(new Set());
}

describe("nested documentation classification", () => {
	it.each([
		"scripts/affected/README.md",
		"packages/widget/README.md",
		"packages/widget/README.fr.md",
		"packages/widget/CHANGELOG.md",
		"packages/widget/CONTRIBUTING.md",
		"packages/widget/CODE_OF_CONDUCT.md",
		"packages/widget/SECURITY.md",
		"third-party/widget/LICENSE",
		"third-party/widget/LICENSE.md",
		"third-party/widget/NOTICE.txt",
	])("recognizes the established documentation basename in %s", (path) => {
		expect(isKnownDocumentation(path)).toBe(true);
		expectSkipAll([{ path, status: "M", before: "old", after: "new" }]);
	});

	it.each([
		["committed modification", { path: "scripts/affected/README.md", status: "M", before: "old", after: "new" }],
		["staged addition", { path: "packages/new-component/README.md", status: "A", after: "new" }],
	] as const)("skips a %s change record", (_source, change) => {
		expectSkipAll([change]);
	});

	it("checks both sides of documentation renames and deletes", () => {
		expectSkipAll([{
			path: "packages/new-name/README.md",
			oldPath: "packages/old-name/README.md",
			status: "R100",
		}]);
		expectSkipAll([{ path: "packages/old-name/README.md", status: "D" }]);

		for (const change of [
			{ path: "src/new-name.ts", oldPath: "packages/old-name/README.md", status: "R100" },
			{ path: "packages/new-name/README.md", oldPath: "src/old-name.ts", status: "R100" },
		]) {
			const graph = fixtureGraph();
			expect(isDocumentationOnly(graph, [change])).toBe(false);
			const plan = classifyAffectedTests(graph, [change]);
			expect(plan.kind).toBe("run-all");
			expect(plan.cachePolicy).toBe("bypass");
		}
	});

	it("does not blanket-skip arbitrary Markdown", () => {
		expect(isKnownDocumentation("notes/implementation-plan.md")).toBe(false);
		const plan = classifyAffectedTests(fixtureGraph(), ["notes/implementation-plan.md"]);
		expect(plan.kind).toBe("run-all");
	});
});

describe("graph-owned Markdown precedence", () => {
	it.each([...GRAPH_OWNED_MARKDOWN])("keeps %s bounded and nonzero", (path, expectedTests) => {
		const graph = fixtureGraph();
		expect(isDocumentationOnly(graph, [{ path, status: "M" }])).toBe(false);
		const plan = classifyAffectedTests(graph, [{ path, status: "M" }]);
		expect(plan.kind).toBe("bounded");
		expect(plan.cachePolicy).toBe("eligible");
		expect(plan.affected).toEqual(expectedTests);
		expect(plan.affected.size).toBeGreaterThan(0);
		expect(plan.affected.size).toBeLessThan(TESTS.length);
	});

	it.each([
		["deleted from", { path: "market-packs/example/README.md", status: "D" }],
		["renamed into", { path: "market-packs/example/README.md", oldPath: "packages/example/README.md", status: "R100" }],
		["renamed out of", { path: "packages/example/README.md", oldPath: "market-packs/example/README.md", status: "R100" }],
	] as const)("keeps Markdown %s graph ownership bounded", (_direction, change) => {
		const graph = fixtureGraph();
		expect(isDocumentationOnly(graph, [change])).toBe(false);
		const plan = classifyAffectedTests(graph, [change]);
		expect(plan.kind).toBe("bounded");
		expect(plan.cachePolicy).toBe("eligible");
		expect(plan.affected).toEqual(GRAPH_OWNED_MARKDOWN.get("market-packs/example/README.md"));
	});
});
