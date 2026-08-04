// v2-native — sound selective-unit graph, inventory, repository-read, and cache-dependency contract.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
	SHIPPED_INPUT_FAMILIES,
	impactRulesForPath,
	inventoryRepositoryScanInputs,
	inventoryShippedInputs,
	repositoryScanRulesForPath,
	validateImpactInventory,
	validateRepositoryScanInventory,
} from "../../scripts/affected/impact-rules.mjs";
import { AFFECTED_GRAPH as graph } from "./helpers/affected-graph-fixture.js";
import { createRunChild, removeOwnedRunChild } from "../harness/run-isolation.js";

function expectBounded(path: string, expectedTest: string): void {
	const plan = affectedTests(graph, [path]);
	expect(plan.kind, path).toBe("bounded");
	expect(plan.cachePolicy, path).toBe("eligible");
	expect(plan.affected.size, path).toBeGreaterThan(0);
	expect(plan.affected.size, path).toBeLessThan(graph.testFiles.length);
	expect(plan.affected.has(expectedTest), path).toBe(true);
}

describe("affected graph inventory and boundaries", () => {
	it("uses a revision-local execution loader without leaking the current unit inventory", () => {
		const revisionA = createRunChild("affected-revision-a");
		const revisionB = createRunChild("affected-revision-b");
		const unitsA = ["tests2/core/revision-a-only.test.ts"];
		const unitsB = [
			"tests2/core/revision-b-first.test.ts",
			"tests2/core/revision-b-second.test.ts",
		];
		const writeRevisionMap = (root: string, unit: string[]) => {
			for (const file of unit) {
				const absolute = join(root, ...file.split("/"));
				mkdirSync(dirname(absolute), { recursive: true });
				writeFileSync(absolute, "export {};\n", "utf8");
			}
			mkdirSync(join(root, "tests2"), { recursive: true });
			writeFileSync(join(root, "tests2", "tests-map.json"), JSON.stringify({
				v2Native: unit.map((path) => ({
					path,
					execution: { runner: "vitest", tier: "unit", project: "core" },
				})),
			}), "utf8");
		};
		const revisionUnits = new Map([
			[revisionA, unitsA],
			[revisionB, unitsB],
		]);
		const revisionLoader = vi.fn(({ repoRoot }: { repoRoot: string; mapPath: string }) => {
			const unit = revisionUnits.get(repoRoot);
			if (!unit) throw new Error(`unexpected revision root: ${repoRoot}`);
			return { core: unit, dom: [], integration: [], isolated: [], e2e: [], unit, all: unit };
		});
		try {
			writeRevisionMap(revisionA, unitsA);
			writeRevisionMap(revisionB, unitsB);
			const graphA = buildGraph({
				repoRoot: revisionA,
				executionMapLoader: revisionLoader,
				serverRuntimeFiles: [],
				vitestConfigFiles: [],
				strictImpactInventory: false,
			});
			const graphB = buildGraph({
				repoRoot: revisionB,
				executionMapLoader: revisionLoader,
				serverRuntimeFiles: [],
				vitestConfigFiles: [],
				strictImpactInventory: false,
			});

			expect(graphA.testFiles).toEqual(unitsA);
			expect(graphA.meta.projects.unit).toEqual(unitsA);
			expect(graphB.testFiles).toEqual(unitsB);
			expect(graphB.meta.projects.unit).toEqual(unitsB);
			expect(graphA.testFiles).not.toContain(unitsB[0]);
			expect(graphB.testFiles).not.toContain(unitsA[0]);
			expect(graphA.testFiles).not.toContain(graph.testFiles[0]);
			expect(revisionLoader).toHaveBeenNthCalledWith(1, {
				repoRoot: revisionA,
				mapPath: join(revisionA, "tests2", "tests-map.json"),
			});
			expect(revisionLoader).toHaveBeenNthCalledWith(2, {
				repoRoot: revisionB,
				mapPath: join(revisionB, "tests2", "tests-map.json"),
			});
		} finally {
			removeOwnedRunChild(revisionA);
			removeOwnedRunChild(revisionB);
		}
	});

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

	it("inventories every declared computed scan and maps every input-consumer pair", () => {
		const inventory = inventoryRepositoryScanInputs(REPO_ROOT);
		const validation = validateRepositoryScanInventory(REPO_ROOT, graph.testFiles);
		expect(inventory.length).toBeGreaterThan(0);
		expect(validation.issues).toEqual([]);
		expect(inventory).toContain("src/app/api.ts");
		expect(inventory).toContain("src/ui/ChatPanel.ts");
		for (const input of inventory) {
			const rules = repositoryScanRulesForPath(input);
			expect(rules.length, input).toBeGreaterThan(0);
			for (const rule of rules) {
				for (const consumer of rule.consumers) {
					expect(graph.testDeps.get(consumer)?.has(input), `${rule.id}: ${input} -> ${consumer}`).toBe(true);
				}
			}
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
