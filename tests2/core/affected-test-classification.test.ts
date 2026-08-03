// v2-native — semantic and fail-closed selective-unit classification contract.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	affectedTests,
	buildGraph,
	REPO_ROOT,
} from "../../scripts/affected/graph.mjs";
import {
	PACKAGE_EXECUTION_KEYS,
	classifyExecutionMapSourceChange,
	packageExecutionProjection,
} from "../../scripts/affected/classification.mjs";

type Graph = ReturnType<typeof buildGraph>;
let graph: Graph;

beforeAll(() => {
	// Runtime attribution is independently pinned by affected-test-runner.test.ts.
	// Avoid resolving that unrelated closure in this classifier-only partition.
	graph = buildGraph({ serverRuntimeFiles: [] });
});

function packageChange(before: Record<string, unknown>, after: Record<string, unknown>) {
	return affectedTests(graph, [{
		path: "package.json",
		status: "M",
		before: JSON.stringify(before),
		after: JSON.stringify(after),
	}]);
}

function expectRunAll(plan: ReturnType<typeof affectedTests>, reason: RegExp): void {
	expect(plan.kind).toBe("run-all");
	expect(plan.runAll).toBe(true);
	expect(plan.cachePolicy).toBe("bypass");
	expect(plan.affected).toEqual(new Set(graph.testFiles));
	expect(plan.reasons.join("\n")).toMatch(reason);
}

function expectBounded(path: string, expectedTest: string): void {
	const plan = affectedTests(graph, [path]);
	expect(plan.kind, path).toBe("bounded");
	expect(plan.cachePolicy, path).toBe("eligible");
	expect(plan.affected.size, path).toBeGreaterThan(0);
	expect(plan.affected.size, path).toBeLessThan(graph.testFiles.length);
	expect(plan.affected.has(expectedTest), path).toBe(true);
}

describe("semantic and fail-closed classification", () => {
	it("keeps package scripts, publication metadata, and version consumers bounded", () => {
		const before = { name: "fixture", version: "1.0.0", scripts: { test: "old" }, files: ["dist/"] };
		const after = { name: "renamed", version: "1.0.1", scripts: { test: "new" }, files: ["dist/", "docs/"] };
		const plan = packageChange(before, after);
		expect(plan.kind).toBe("bounded");
		for (const consumer of [
			"tests2/core/package-files.test.ts",
			"tests2/core/aigw-user-agent.test.ts",
			"tests2/core/unit-file-budget-reporter.test.ts",
			"tests2/integration/aigw-configure.test.ts",
			"tests2/integration/aigw-title-generator.test.ts",
			"tests2/integration/app-info-api.test.ts",
		]) {
			expect(plan.affected.has(consumer), consumer).toBe(true);
			expect(graph.testDeps.get(consumer)?.has("package.json"), `${consumer} hash closure includes package.json`).toBe(true);
		}
		expect(plan.affected.size).toBeLessThan(graph.testFiles.length);
	});

	it.each([...PACKAGE_EXECUTION_KEYS] as string[])("runs all when package execution key %s changes", (key: string) => {
		const values = key === "type"
			? ["module", "commonjs"]
			: key === "packageManager"
				? ["npm@10", "npm@11"]
				: key === "workspaces" || ["os", "cpu", "libc"].includes(key)
					? [["old"], ["next"]]
					: key === "exports"
						? ["./old.js", "./next.js"]
						: [{ old: "1" }, { next: "2" }];
		const before = { name: "fixture", [key]: values[0] };
		const after = { name: "fixture", [key]: values[1] };
		expectRunAll(packageChange(before, after), /package execution projection changed/);
	});

	it("uses a stable package projection and fails closed without valid comparison bytes", () => {
		expect(packageExecutionProjection({ dependencies: { z: "1", a: "2" }, scripts: { test: "x" } }))
			.toEqual({ dependencies: { a: "2", z: "1" } });
		expectRunAll(affectedTests(graph, ["package.json"]), /semantic comparison unavailable/);
		expectRunAll(affectedTests(graph, [{ path: "package.json", before: "{}", after: "{" }]), /malformed JSON/);
		expectRunAll(affectedTests(graph, [{
			path: "package.json",
			before: '{"dependencies":[]}',
			after: '{"dependencies":[]}',
		}]), /dependencies must be an object/);
	});

	it.each([
		["package-lock.json", /lockfile change/],
		["npm-shrinkwrap.json", /lockfile change/],
		["pnpm-lock.yaml", /lockfile change/],
		["yarn.lock", /lockfile change/],
		["bun.lock", /lockfile change/],
		["bun.lockb", /lockfile change/],
		["tsconfig.server.json", /TypeScript config change/],
		["vitest.config.ts", /Vitest config change/],
		["scripts/affected/graph.mjs", /affected runner implementation change/],
		["scripts/testing-v2/repo-source-closure.mjs", /unit runtime implementation change/],
		["unknown-build-input.toml", /unknown executable\/infrastructure input/],
	])("pins broad fallback for %s", (path, reason) => {
		expectRunAll(affectedTests(graph, [path]), reason);
	});

	it("reports known broad triggers before earlier unknown infrastructure", () => {
		const vitest = affectedTests(graph, [
			".github/workflows/build-unit-gate.yml",
			"vitest.config.ts",
		]);
		expectRunAll(vitest, /Vitest config change/);
		expect(vitest.reasons).toEqual(["Vitest config change: vitest.config.ts"]);

		const lockfile = affectedTests(graph, [".npmrc", "package-lock.json"]);
		expectRunAll(lockfile, /lockfile change/);
		expect(lockfile.reasons).toEqual(["lockfile change: package-lock.json"]);

		const dependency = affectedTests(graph, [
			".npmrc",
			{
				path: "package.json",
				status: "M",
				before: "{}",
				after: '{"dependencies":{"fixture":"1"}}',
			},
		]);
		expectRunAll(dependency, /package execution projection changed/);
		expect(dependency.reasons).toEqual(["package execution projection changed: package.json"]);
	});

	it("fails closed for unresolved deletes/renames and normalizes Windows paths/case", () => {
		expectRunAll(affectedTests(graph, [{ path: "src/server/deleted.ts", status: "D" }]), /unresolved deleted dependency/);
		expectRunAll(affectedTests(graph, [{
			path: "src/server/renamed.ts",
			oldPath: "src/server/old-name.ts",
			status: "R100",
		}]), /unresolved renamed dependency/);
		const windowsPlan = affectedTests(graph, ["DEFAULTS\\ROLES\\CODER.YAML"]);
		expect(windowsPlan.kind).toBe("bounded");
		expect(windowsPlan.affected.has("tests2/core/default-role-policy.test.ts")).toBe(true);
	});

	it("distinguishes true docs skip-all from shipped markdown", () => {
		const docs = affectedTests(graph, ["docs/testing-strategy.md", "README.md"]);
		expect(docs.kind).toBe("skip-all");
		expect(docs.affected.size).toBe(0);
		expect(docs.runAll).toBe(false);
		expectBounded("defaults/system-prompt.md", "tests2/core/system-prompt-merged-branch.test.ts");
	});
});

describe("test-map semantic classification", () => {
	it("recognizes ownership-table-only execution-map edits but rejects algorithm edits", () => {
		const source = readFileSync(resolve(REPO_ROOT, "scripts/testing-v2/test-map-execution.mjs"), "utf8");
		const tableEdit = source.replace(
			'export const APPROVED_E2E_VITEST_PATHS = Object.freeze([',
			'export const APPROVED_E2E_VITEST_PATHS = Object.freeze([\n\t"tests2/core/example.test.ts",',
		);
		const classified = classifyExecutionMapSourceChange(source, tableEdit);
		expect(classified.recognized).toBe(true);
		expect(classified.paths.has("tests2/core/example.test.ts")).toBe(true);
		expect(classifyExecutionMapSourceChange(source, `${source}\nexport const changedAlgorithm = true;`).recognized).toBe(false);
	});

	it("bounds ownership-only map changes to mentioned tests and scheduling contracts", () => {
		const target = graph.meta.projects.core.find((path: string) => !path.includes("test-map-execution"));
		const execution = { runner: "vitest", tier: "unit", project: "core" };
		const before = { v2Native: [], entries: [] };
		const after = { v2Native: [{ path: target, reason: "fixture", execution }], entries: [] };
		const plan = affectedTests(graph, [{
			path: "tests2/tests-map.json",
			status: "M",
			before: JSON.stringify(before),
			after: JSON.stringify(after),
		}]);
		expect(plan.kind).toBe("bounded");
		expect(plan.affected.has(target)).toBe(true);
		expect(plan.affected.has("tests2/core/test-map-execution.test.ts")).toBe(true);
		expect(plan.affected.size).toBeLessThan(graph.testFiles.length);
		expectRunAll(affectedTests(graph, ["tests2/tests-map.json"]), /semantic comparison unavailable/);
	});
});
