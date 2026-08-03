// v2-native — sound selective-unit graph and fail-closed classifier contract.
import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadVitestExecutionMap } from "../../scripts/testing-v2/test-map-execution.mjs";
import {
	affectedTests,
	buildGraph,
	DOM_ENV,
	extractRepositoryReadDependencies,
	FILE_BOUNDARY_RUNNER,
	GATEWAY_HARNESS,
	REPO_ROOT,
	TIER1_SETUP,
} from "../../scripts/affected/graph.mjs";
import {
	PACKAGE_EXECUTION_KEYS,
	classifyExecutionMapSourceChange,
	packageExecutionProjection,
} from "../../scripts/affected/classification.mjs";
import {
	SHIPPED_INPUT_FAMILIES,
	impactRulesForPath,
	inventoryRepositoryScanInputs,
	inventoryShippedInputs,
	repositoryScanRulesForPath,
	validateImpactInventory,
	validateRepositoryScanInventory,
} from "../../scripts/affected/impact-rules.mjs";

type Graph = ReturnType<typeof buildGraph>;
let graph: Graph;

beforeAll(() => {
	graph = buildGraph();
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

describe("affected graph inventory and boundaries", () => {
	it("uses only authoritative unit ownership and reports Playwright separately", () => {
		const execution = loadVitestExecutionMap();
		expect(graph.testFiles).toEqual([...execution.unit]);
		expect(graph.testFiles).not.toEqual(expect.arrayContaining(execution.e2e));
		expect(graph.testFiles.every((path: string) => path.endsWith(".test.ts"))).toBe(true);
		expect(graph.browserFiles.length).toBeGreaterThan(0);
		expect(graph.browserFiles.every((path: string) => path.startsWith("tests2/browser/") && path.endsWith(".spec.ts"))).toBe(true);

		const browser = graph.browserFiles[0];
		const plan = affectedTests(graph, [browser]);
		expect(plan.kind).toBe("bounded");
		expect(plan.affected.size).toBe(0);
		expect(plan.browserAffected.has(browser)).toBe(true);
	});

	it("models Vitest-owned setup and runner dependencies by project", () => {
		const execution = graph.meta.projects;
		for (const test of graph.testFiles) expect(graph.testDeps.get(test)?.has(TIER1_SETUP)).toBe(true);
		for (const test of [...execution.core, ...execution.integration]) {
			expect(graph.testDeps.get(test)?.has(FILE_BOUNDARY_RUNNER)).toBe(true);
		}
		for (const test of execution.dom) expect(graph.testDeps.get(test)?.has(DOM_ENV)).toBe(true);
		expect(graph.testDeps.get(execution.dom[0])?.has(FILE_BOUNDARY_RUNNER)).toBe(false);
	});

	it("models cwd-relative literal source reads as selection and cache dependencies", () => {
		const test = "tests2/core/run-isolation.test.ts";
		for (const dependency of [
			GATEWAY_HARNESS,
			"scripts/testing-v2/run-e2e-v2.mjs",
			"playwright-e2e.config.ts",
			"playwright-v2.config.ts",
		]) expect(graph.testDeps.get(test)?.has(dependency), dependency).toBe(true);

		const plan = affectedTests(graph, [GATEWAY_HARNESS]);
		expect(plan.kind).toBe("bounded");
		expect(plan.affected.has(test)).toBe(true);
		expect(plan.affected.size).toBeLessThan(graph.testFiles.length);
	});

	it("uses the shared runtime-entry closure for gateway attribution", () => {
		const sharedRuntime = graph.meta.runtimeFiles.find((path: string) => path.startsWith("src/shared/"));
		expect(sharedRuntime, "the bundled server runtime must include an imported src/shared dependency").toBeTruthy();
		const sharedPlan = affectedTests(graph, [sharedRuntime!]);
		expect(sharedPlan.kind).toBe("bounded");
		expect(sharedPlan.affected.size).toBeGreaterThan(0);
		for (const test of graph.meta.bootTests) expect(sharedPlan.affected.has(test)).toBe(true);

		const unrelated = "src/ui/utils/attachment-utils.ts";
		expect(graph.meta.runtimeFiles).not.toContain(unrelated);
		const unrelatedPlan = affectedTests(graph, [unrelated]);
		const unrelatedBootTests = [...graph.meta.bootTests].filter((test) => unrelatedPlan.affected.has(test));
		expect(unrelatedBootTests.length, "unrelated UI source must not gain the whole gateway bucket")
			.toBeLessThan(graph.meta.bootTests.size);
		expect(graph.testDeps.get([...graph.meta.bootTests][0])?.has(GATEWAY_HARNESS)).toBe(true);
	});

	it.each([
		[
			"src/app/api.ts",
			["tests2/core/api-sidebar-expansion-regression.test.ts", "tests2/core/base-path-source-guards.test.ts"],
		],
		[
			"src/app/render.ts",
			["tests2/core/bobbit-loading-animation-regression.test.ts", "tests2/core/base-path-source-guards.test.ts"],
		],
		[
			"src/ui/ChatPanel.ts",
			["tests2/core/bobbit-loading-animation-regression.test.ts", "tests2/core/base-path-source-guards.test.ts"],
		],
	])("attributes computed source read %s to its readers and cache closures", (dependency, readers) => {
		const plan = affectedTests(graph, [dependency]);
		expect(plan.kind).toBe("bounded");
		expect(plan.affected.size).toBeGreaterThan(0);
		expect(plan.affected.size).toBeLessThan(graph.testFiles.length);
		expect(graph.meta.repositoryReads.get(readers[0])?.has(dependency), `${readers[0]} static-read inventory`).toBe(true);
		for (const reader of readers) {
			expect(plan.affected.has(reader), `${dependency} -> ${reader}`).toBe(true);
			expect(graph.testDeps.get(reader)?.has(dependency), `${reader} hash closure includes ${dependency}`).toBe(true);
		}
	});

	it("extracts only safe repository-contained static read operands", () => {
		const source = String.raw`
			import fs, { readFileSync } from "node:fs";
			import path, { resolve } from "node:path";
			import { fileURLToPath } from "node:url";
			const __dirname = fileURLToPath(new URL(".", import.meta.url));
			const PROJECT_ROOT = resolve(__dirname, "..", "..");
			const tempRoot = makeTemporaryRoot();
			const dynamicPath = getDynamicPath();
			readFileSync(new URL("../../src/app/api.ts", import.meta.url));
			readFileSync("src\\app\\api.ts");
			readFileSync(path.resolve("src/app/render.ts"));
			fs.readFileSync(path.join(process.cwd(), "src", "ui", "ChatPanel.ts"));
			readFileSync(resolve(PROJECT_ROOT, "package.json"));
			readFileSync(path.join(tempRoot, "fixture.txt"));
			readFileSync(dynamicPath);
			readFileSync("../outside-repository.txt");
		`;
		const extracted = extractRepositoryReadDependencies({
			repoRoot: REPO_ROOT,
			importerPath: "tests2/core/static-read-fixture.test.ts",
			source,
		});
		expect([...extracted.dependencies].sort()).toEqual([
			"package.json",
			"src/app/api.ts",
			"src/app/render.ts",
			"src/ui/ChatPanel.ts",
		]);
		expect(extracted.reads.filter((read: { status: string }) => read.status === "unresolved")).toHaveLength(2);
		expect(extracted.reads.some((read: { status: string }) => read.status === "outside-repository")).toBe(true);
	});
});

describe("shipped dynamic input ownership", () => {
	it("exhaustively claims every inventoried family with live owners and unit canaries", () => {
		const inventory = inventoryShippedInputs(REPO_ROOT);
		const validation = validateImpactInventory(REPO_ROOT, graph.testFiles);
		expect(inventory.length).toBeGreaterThan(0);
		expect(validation.issues).toEqual([]);
		for (const family of SHIPPED_INPUT_FAMILIES) {
			const familyInputs = inventory.filter((path: string) => family.qualifies(path));
			expect(familyInputs.length, family.id).toBeGreaterThan(0);
			for (const input of familyInputs) {
				expect(impactRulesForPath(input).map((rule: { id: string }) => rule.id), input).toContain(family.id);
			}
		}
	});

	it("inventories every executable declared computed-scan input", () => {
		const inventory = inventoryRepositoryScanInputs(REPO_ROOT);
		const validation = validateRepositoryScanInventory(REPO_ROOT, graph.testFiles);
		expect(inventory.length).toBeGreaterThan(0);
		expect(validation.issues).toEqual([]);
		expect(inventory).toContain("src/app/api.ts");
		expect(inventory).toContain("src/ui/ChatPanel.ts");
		for (const input of inventory) {
			expect(repositoryScanRulesForPath(input).map((rule: { id: string }) => rule.id), input)
				.toContain("client-source-guards");
			expect(graph.testDeps.get("tests2/core/base-path-source-guards.test.ts")?.has(input), input).toBe(true);
		}
	});

	it("fails inventory validation when a new shipped family is unowned", () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-affected-inventory-"));
		try {
			mkdirSync(join(root, "defaults", "new-family"), { recursive: true });
			writeFileSync(join(root, "defaults", "new-family", "config.yaml"), "enabled: true\n", "utf8");
			const validation = validateImpactInventory(root, []);
			expect(validation.issues).toContain("defaults/new-family/config.yaml: shipped input has no declared impact family");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		["defaults/roles/coder.yaml", "tests2/core/default-role-policy.test.ts"],
		["defaults/tools/filesystem/read.yaml", "tests2/core/tool-description-budget.test.ts"],
		["market-packs/pr-walkthrough/pack.yaml", "tests2/core/builtin-packs.test.ts"],
		[".claude/skills/qa-test/SKILL.md", "tests2/core/system-prompt-skills-budget.test.ts"],
		["workflows/test-fast.yaml", "tests2/core/workflow-validator.test.ts"],
		[".bobbit/config/project.yaml", "tests2/core/config-cascade.test.ts"],
		["AGENTS.md", "tests2/core/agents-md-budget.test.ts"],
	])("maps %s to a nonzero bounded relevant set", (path, expectedTest) => {
		expectBounded(path, expectedTest);
		expect(graph.testDeps.get(expectedTest)?.has(path)).toBe(true);
	});
});

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
