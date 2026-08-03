// v2-native — semantic and fail-closed selective-unit classification contract.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	affectedTests,
	REPO_ROOT,
} from "../../scripts/affected/graph.mjs";
import {
	PACKAGE_EXECUTION_KEYS,
	TEST_MAP_CONTRACT_TESTS,
	classifyExecutionMapSourceChange,
	packageExecutionProjection,
} from "../../scripts/affected/classification.mjs";
import { AFFECTED_GRAPH as graph } from "./helpers/affected-graph-fixture.js";

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

	it("keeps a scripts-only package modification bounded", () => {
		const plan = packageChange(
			{ name: "fixture", dependencies: { alpha: "1" }, scripts: { test: "old" } },
			{ name: "fixture", dependencies: { alpha: "1" }, scripts: { test: "new" } },
		);
		expect(plan.kind).toBe("bounded");
		expect(plan.cachePolicy).toBe("eligible");
		expect(plan.affected.has("tests2/core/package-files.test.ts")).toBe(true);
		expect(plan.affected.size).toBeLessThan(graph.testFiles.length);
	});

	it.each([
		["rename out", "package.saved.json", "package.json"],
		["rename in", "package.json", "package.saved.json"],
	] as const)("runs all for root package %s even when the execution projection is equal", (_label, path, oldPath) => {
		const before = JSON.stringify({ dependencies: { alpha: "1" }, scripts: { test: "old" } });
		const after = JSON.stringify({ dependencies: { alpha: "1" }, scripts: { test: "new" } });
		expectRunAll(affectedTests(graph, [{
			path,
			oldPath,
			status: "R100",
			before,
			after,
		}]), /root package topology change/);
	});

	it("treats a case-only root package rename as the same semantic boundary", () => {
		const scriptsOnly = affectedTests(graph, [{
			path: "Package.json",
			oldPath: "package.json",
			status: "R100",
			before: JSON.stringify({ dependencies: { alpha: "1" }, scripts: { test: "old" } }),
			after: JSON.stringify({ dependencies: { alpha: "1" }, scripts: { test: "new" } }),
		}]);
		expect(scriptsOnly.kind).toBe("bounded");
		expect(scriptsOnly.cachePolicy).toBe("eligible");
		expect(scriptsOnly.affected.has("tests2/core/package-files.test.ts")).toBe(true);

		expectRunAll(affectedTests(graph, [{
			path: "Package.json",
			oldPath: "package.json",
			status: "R100",
			before: JSON.stringify({ dependencies: { alpha: "1" } }),
			after: JSON.stringify({ dependencies: { alpha: "2" } }),
		}]), /package execution projection changed/);
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

	it.each([
		"tests2/harness/run-isolation.ts",
		"scripts/testing-v2/environment-policy.mjs",
		"tests2/harness/unit-file-budget-reporter.ts",
	])("runs all for transitive Vitest configuration dependency %s", (path) => {
		expect(graph.meta.vitestConfigFiles).toContain(path);
		expectRunAll(affectedTests(graph, [path]), /Vitest config dependency change/);
	});

	it("keeps Vitest configuration renames and deletes suite-wide", () => {
		expectRunAll(affectedTests(graph, [{
			path: "tests2/harness/run-isolation-renamed.ts",
			oldPath: "tests2/harness/run-isolation.ts",
			status: "R100",
		}]), /Vitest config dependency change/);
		expectRunAll(affectedTests(graph, [{
			path: "scripts/testing-v2/environment-policy.mjs",
			status: "D",
		}]), /Vitest config dependency change/);
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
	const executionMapPath = "scripts/testing-v2/test-map-execution.mjs";
	const source = readFileSync(resolve(REPO_ROOT, "scripts/testing-v2/test-map-execution.mjs"), "utf8");
	const approvedOpen = "export const APPROVED_E2E_VITEST_PATHS = Object.freeze([\n";
	const isolatedOpen = "export const ISOLATED_VITEST_FILES = Object.freeze({\n";

	function replaceRequired(input: string, search: string, replacement: string): string {
		const output = input.replace(search, replacement);
		if (output === input) throw new Error(`Execution-map test fixture did not contain ${JSON.stringify(search)}`);
		return output;
	}

	function addApproved(input: string, entry: string): string {
		return replaceRequired(input, approvedOpen, `${approvedOpen}\t${entry}\n`);
	}

	function addIsolated(input: string, property: string): string {
		return replaceRequired(input, isolatedOpen, `${isolatedOpen}\t${property}\n`);
	}

	function executionMapPlan(before: string, after: string) {
		return affectedTests(graph, [{
			path: executionMapPath,
			status: "M",
			before,
			after,
		}]);
	}

	const unsupportedTableEdits: Array<[string, (input: string) => string]> = [
		["computed object keys", (input) => addIsolated(input, '["tests2/core/affected-test-runner.test.ts"]: "computed",')],
		["array spreads", (input) => addApproved(input, "...approvedPaths,")],
		["object spreads", (input) => addIsolated(input, "...isolatedPaths,")],
		["call expressions", (input) => addApproved(input, "testPath(),")],
		["interpolated templates", (input) => addApproved(input, "`tests2/core/${testName}.test.ts`,")],
		["array holes", (input) => addApproved(input, ",")],
		["shorthand properties", (input) => addIsolated(input, "isolatedTest,")],
		["method properties", (input) => addIsolated(input, '"tests2/core/affected-test-runner.test.ts"() {},')],
		["accessor properties", (input) => addIsolated(input, 'get "tests2/core/affected-test-runner.test.ts"() { return "reason"; },')],
		["duplicate declarations", (input) => `${input}\nexport const APPROVED_E2E_VITEST_PATHS = Object.freeze([]);\n`],
		["duplicate object keys", (input) => addIsolated(input, '"tests2/core/bobbit-dir-agent-dir.test.ts": "duplicate",')],
		["malformed parse input", (input) => `${input}\nexport const malformed = ;\n`],
		["nonliteral reason values", (input) => addIsolated(input, '"tests2/core/affected-test-runner.test.ts": reason,')],
		["aliased freeze calls", (input) => replaceRequired(input, approvedOpen, "export const APPROVED_E2E_VITEST_PATHS = freeze([\n")],
		["computed freeze access", (input) => replaceRequired(input, approvedOpen, 'export const APPROVED_E2E_VITEST_PATHS = Object["freeze"]([\n')],
		["optional freeze access", (input) => replaceRequired(input, approvedOpen, "export const APPROVED_E2E_VITEST_PATHS = Object?.freeze([\n")],
		["optional freeze calls", (input) => replaceRequired(input, approvedOpen, "export const APPROVED_E2E_VITEST_PATHS = Object.freeze?.([\n")],
		["multi-argument freeze calls", (input) => replaceRequired(input, approvedOpen, "export const APPROVED_E2E_VITEST_PATHS = Object.freeze(undefined, [\n")],
	];

	it.each(unsupportedTableEdits)("fails closed for execution-map %s", (_label, mutate) => {
		const after = mutate(source);
		const classified = classifyExecutionMapSourceChange(source, after);
		expect(classified.recognized).toBe(false);
		expect(classified.paths).toEqual(new Set());
		expectRunAll(executionMapPlan(source, after), /test execution-map algorithm/);
	});

	it("bounds literal additions and removals across both tables to their old/new tests and contracts", () => {
		const oldApproved = "tests2/core/package-files.test.ts";
		const newApproved = "tests2/core/aigw-user-agent.test.ts";
		const oldIsolated = "tests2/core/affected-test-runner.test.ts";
		const newIsolated = "tests2/core/agents-md-budget.test.ts";
		const before = addIsolated(addApproved(source, `"${oldApproved}",`), `"${oldIsolated}": "old reason",`);
		const after = addIsolated(addApproved(source, `"${newApproved}",`), `"${newIsolated}": "new reason",`);
		const classified = classifyExecutionMapSourceChange(before, after);
		expect(classified.recognized).toBe(true);
		for (const path of [oldApproved, newApproved, oldIsolated, newIsolated]) {
			expect(classified.paths.has(path), `classifier includes ${path}`).toBe(true);
		}

		const plan = executionMapPlan(before, after);
		expect(plan.kind).toBe("bounded");
		expect(plan.cachePolicy).toBe("eligible");
		for (const path of [oldApproved, newApproved, oldIsolated, newIsolated, ...TEST_MAP_CONTRACT_TESTS]) {
			expect(plan.affected.has(path), `selection includes ${path}`).toBe(true);
		}
		expect(plan.affected.size).toBeLessThan(graph.testFiles.length);
	});

	it("keeps #1072's literal E2E ownership-table addition bounded", () => {
		const addedPath = "tests2/integration/base-path-cli-entrypoint.test.ts";
		const before = replaceRequired(source, `\t"${addedPath}",\n`, "");
		const classified = classifyExecutionMapSourceChange(before, source);
		expect(classified.recognized).toBe(true);
		expect(classified.paths.has(addedPath)).toBe(true);

		const plan = executionMapPlan(before, source);
		expect(plan.kind).toBe("bounded");
		expect(plan.cachePolicy).toBe("eligible");
		for (const contract of TEST_MAP_CONTRACT_TESTS) expect(plan.affected.has(contract), contract).toBe(true);
		expect(plan.affected.size).toBeLessThan(graph.testFiles.length);
	});

	it("rejects execution-map algorithm edits", () => {
		const algorithmEdit = `${source}\nexport const changedAlgorithm = true;`;
		expect(classifyExecutionMapSourceChange(source, algorithmEdit).recognized).toBe(false);
		expectRunAll(executionMapPlan(source, algorithmEdit), /test execution-map algorithm/);
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
		for (const contract of TEST_MAP_CONTRACT_TESTS) expect(plan.affected.has(contract), contract).toBe(true);
		expect(plan.affected.size).toBeLessThan(graph.testFiles.length);
		expectRunAll(affectedTests(graph, ["tests2/tests-map.json"]), /semantic comparison unavailable/);
	});
});
