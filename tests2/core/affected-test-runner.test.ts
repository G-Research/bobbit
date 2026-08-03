// v2-native — sound selective-unit graph, inventory, repository-read, and cache-dependency contract.
import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testHash } from "../../scripts/affected/cache.mjs";
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
	IMPACT_RULES,
	INDIRECT_REPOSITORY_READ_RULES,
	SHIPPED_INPUT_FAMILIES,
	UNRESOLVED_REPOSITORY_READ_AUDIT,
	impactRulesForPath,
	inventoryRepositoryScanInputs,
	inventoryShippedInputs,
	repositoryScanRulesForPath,
	validateImpactInventory,
	validateIndirectRepositoryReadRegistry,
	validateRepositoryScanInventory,
	validateUnresolvedRepositoryReadAudit,
} from "../../scripts/affected/impact-rules.mjs";

const INDIRECT_READ_PAIRS = [
	{ consumer: "tests2/core/reviewer-archive-metadata.test.ts", input: "src/server/agent/session-manager.ts" },
	{ consumer: "tests2/core/reviewer-archive-metadata.test.ts", input: "src/server/agent/session-setup.ts" },
	{ consumer: "tests2/core/reviewer-archive-metadata.test.ts", input: "src/server/agent/verification-harness.ts" },
	{ consumer: "tests2/core/error-modal-call-sites.test.ts", input: "src/app/dialogs.ts" },
	{ consumer: "tests2/core/error-modal-call-sites.test.ts", input: "src/app/proposal-panels.ts" },
	{ consumer: "tests2/core/error-modal-call-sites.test.ts", input: "src/app/role-manager-page.ts" },
	{ consumer: "tests2/core/error-modal-call-sites.test.ts", input: "src/app/session-manager.ts" },
	{ consumer: "tests2/core/error-modal-call-sites.test.ts", input: "src/app/tool-manager-page.ts" },
	{ consumer: "tests2/core/source-pin-merge-invariants.test.ts", input: "src/app/api.ts" },
	{ consumer: "tests2/core/source-pin-merge-invariants.test.ts", input: "src/app/proposal-panels.ts" },
	{ consumer: "tests2/core/source-pin-merge-invariants.test.ts", input: "src/server/server.ts" },
	{ consumer: "tests2/core/headset-accessory.test.ts", input: "src/ui/app.css" },
	{ consumer: "tests2/core/headset-accessory.test.ts", input: "src/ui/bobbit-render.ts" },
	{ consumer: "tests2/core/headset-accessory.test.ts", input: "src/ui/components/StreamingMessageContainer.ts" },
	{ consumer: "tests2/core/headset-accessory.test.ts", input: "src/app/role-manager.css" },
	{ consumer: "tests2/core/nurse-cap-accessory.test.ts", input: "src/ui/app.css" },
	{ consumer: "tests2/core/nurse-cap-accessory.test.ts", input: "src/ui/bobbit-render.ts" },
	{ consumer: "tests2/core/nurse-cap-accessory.test.ts", input: "src/ui/components/StreamingMessageContainer.ts" },
	{ consumer: "tests2/core/nurse-cap-accessory.test.ts", input: "src/app/role-manager.css" },
	{ consumer: "tests2/core/delegate-helper-policy-plumbing.test.ts", input: "src/server/agent/session-store.ts" },
	{ consumer: "tests2/core/delegate-helper-policy-plumbing.test.ts", input: "src/server/agent/session-setup.ts" },
	{ consumer: "tests2/core/delegate-helper-policy-plumbing.test.ts", input: "src/server/skills/git.ts" },
	{ consumer: "tests2/core/base-path-preview-contract.test.ts", input: "src/server/preview/mount.ts" },
	{ consumer: "tests2/core/base-path-preview-contract.test.ts", input: "src/server/preview/artifacts.ts" },
	{ consumer: "tests2/core/base-path-preview-contract.test.ts", input: "src/app/panel-workspace.ts" },
	{ consumer: "tests2/core/base-path-preview-contract.test.ts", input: "src/app/side-panel-workspace.ts" },
	{ consumer: "tests2/core/enforce-headless-qa.test.ts", input: ".claude/.mcp.json" },
	{ consumer: "tests2/core/affected-test-classification.test.ts", input: "scripts/testing-v2/test-map-execution.mjs" },
	{ consumer: "tests2/core/run-isolation.test.ts", input: "playwright-e2e.config.ts" },
	{ consumer: "tests2/core/run-isolation.test.ts", input: "playwright-v2.config.ts" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "package.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "package-lock.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/advisory-floor.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/wrapper/package.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/wrapper/package-lock.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/consumer/package.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/consumer/package-lock.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/packages/protobufjs-vulnerable/package.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/packages/protobufjs-fixed/package.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/packages/published-agent/package.json" },
	{ consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts", input: "tests2/core/fixtures/pi-published-shrinkwrap-security/packages/published-agent/npm-shrinkwrap.json" },
] as const;

const DIRECT_DYNAMIC_FAMILY_IDS = [
	"builtin-roles",
	"builtin-tools",
	"market-packs",
	"committed-config-cascade",
] as const;

type Graph = ReturnType<typeof buildGraph>;
type UnresolvedRead = { expression: string; status: string };
type UnresolvedReadAuditEntry = {
	consumer: string;
	allowReason?: string;
	declarations?: readonly string[];
	reads: readonly { expression: string; count: number }[];
};
let graph: Graph;

beforeAll(() => {
	graph = buildGraph();
});

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

	it("declares the complete exact indirect repository-read table", () => {
		const declared = INDIRECT_REPOSITORY_READ_RULES.flatMap((rule: {
			consumer: string;
			inputs: readonly string[];
		}) => rule.inputs.map((input) => ({ consumer: rule.consumer, input })));
		expect(declared).toEqual(INDIRECT_READ_PAIRS);
		expect(graph.meta.indirectRepositoryReadValidation.issues).toEqual([]);
	});

	it.each(INDIRECT_READ_PAIRS)("maps $input to $consumer through the shared dependency graph", ({ input, consumer }) => {
		const plan = affectedTests(graph, [input]);
		if ([
			"package.json",
			"package-lock.json",
			"scripts/testing-v2/test-map-execution.mjs",
		].includes(input)) {
			expect(plan.kind, input).toBe("run-all");
			expect(plan.cachePolicy, input).toBe("bypass");
		} else {
			expect(plan.kind, input).toBe("bounded");
			expect(plan.affected.size, input).toBeGreaterThan(0);
			expect(plan.affected.size, input).toBeLessThan(graph.testFiles.length);
		}
		expect(plan.affected.has(consumer), `${input} -> ${consumer}`).toBe(true);
		expect(graph.testDeps.get(consumer)?.has(input), `${consumer} hash closure includes ${input}`).toBe(true);
	});

	it("invalidates each indirect reader hash when any exact source input changes", () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-indirect-read-hash-"));
		try {
			for (const { input, consumer } of INDIRECT_READ_PAIRS) {
				const fixtureInput = join(root, ...input.split("/"));
				const fixtureConsumer = join(root, ...consumer.split("/"));
				mkdirSync(dirname(fixtureInput), { recursive: true });
				mkdirSync(dirname(fixtureConsumer), { recursive: true });
				writeFileSync(fixtureInput, "before\n", "utf8");
				writeFileSync(fixtureConsumer, "test fixture\n", "utf8");

				// Graph membership and hashing are independent contracts. Pin the real
				// closure above, then hash only the dependency under mutation here. Passing
				// the entire closure made every case repeat hundreds of irrelevant missing
				// file probes in this isolated root without exercising additional behavior.
				const dependencies = graph.testDeps.get(consumer);
				expect(dependencies?.has(input), `${consumer} closure includes ${input}`).toBe(true);
				const focusedDependencies = new Set([input]);
				const before = testHash(consumer, focusedDependencies, { repoRoot: root });
				writeFileSync(fixtureInput, "after\n", "utf8");
				expect(testHash(consumer, focusedDependencies, { repoRoot: root }), `${input} invalidates ${consumer}`)
					.not.toBe(before);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("pins every unresolved unit read to a live declaration or reviewed generated path", () => {
		expect(graph.meta.unresolvedRepositoryReadAudit.issues).toEqual([]);
		expect(graph.meta.unresolvedRepositoryReadAudit.actual.size).toBeGreaterThan(100);
		expect(UNRESOLVED_REPOSITORY_READ_AUDIT).toHaveLength(graph.meta.unresolvedRepositoryReadAudit.actual.size);
		for (const entry of UNRESOLVED_REPOSITORY_READ_AUDIT as readonly UnresolvedReadAuditEntry[]) {
			expect(Boolean(entry.allowReason) !== Boolean(entry.declarations?.length), entry.consumer).toBe(true);
		}
	});

	it("rejects a new unresolved read and a declaration that no longer supplies edges", () => {
		const consumer = "tests2/core/headset-accessory.test.ts";
		const unresolved = graph.meta.unresolvedRepositoryReads as Map<string, UnresolvedRead[]>;
		const actual = new Map<string, UnresolvedRead[]>(unresolved);
		actual.set(consumer, [
			...(actual.get(consumer) ?? []),
			{ expression: "newRepositoryPath", status: "unresolved" },
		]);
		const unexpected = validateUnresolvedRepositoryReadAudit(
			actual,
			graph.testFiles,
			graph.meta.unresolvedReadDeclarations,
		);
		expect(unexpected.issues).toContain(
			`${consumer}: new unresolved repository read requires audit: newRepositoryPath (1)`,
		);

		const missingDeclaration = validateUnresolvedRepositoryReadAudit(
			new Map([[consumer, unresolved.get(consumer) ?? []]]),
			[consumer],
			new Map([[consumer, new Set()]]),
			(UNRESOLVED_REPOSITORY_READ_AUDIT as readonly UnresolvedReadAuditEntry[])
				.filter((entry: UnresolvedReadAuditEntry) => entry.consumer === consumer),
		);
		expect(missingDeclaration.issues).toContain(
			`${consumer}: unresolved-read declaration is not live: indirect:accessory-rendering-contracts`,
		);
	});

	it("rejects missing indirect inputs and non-unit consumers", () => {
		const validRule = {
			id: "windows-normalized-fixture",
			consumer: "tests2\\core\\reviewer-archive-metadata.test.ts",
			inputs: ["src\\server\\agent\\session-manager.ts"],
		};
		const normalized = validateIndirectRepositoryReadRegistry(REPO_ROOT, graph.testFiles, [validRule]);
		expect(normalized.issues).toEqual([]);
		expect(normalized.pairs).toEqual([{
			ruleId: validRule.id,
			consumer: "tests2/core/reviewer-archive-metadata.test.ts",
			input: "src/server/agent/session-manager.ts",
		}]);

		const missingInput = validateIndirectRepositoryReadRegistry(REPO_ROOT, graph.testFiles, [{
			id: "missing-input",
			consumer: "tests2/core/reviewer-archive-metadata.test.ts",
			inputs: ["src/server/agent/does-not-exist.ts"],
		}]);
		expect(missingInput.issues).toContain(
			"missing-input: repository input is missing: src/server/agent/does-not-exist.ts",
		);

		const missingConsumer = validateIndirectRepositoryReadRegistry(REPO_ROOT, graph.testFiles, [{
			id: "missing-consumer",
			consumer: "tests2/core/does-not-exist.test.ts",
			inputs: ["src/server/agent/session-manager.ts"],
		}]);
		expect(missingConsumer.issues).toContain(
			"missing-consumer: unit consumer is missing or not unit-owned: tests2/core/does-not-exist.test.ts",
		);
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

	it("maps every audited dynamic-family validator into selection and hash closure", () => {
		const representatives: Record<(typeof DIRECT_DYNAMIC_FAMILY_IDS)[number], string> = {
			"builtin-roles": "defaults/roles/reviewer.yaml",
			"builtin-tools": "defaults/tools/bobbit/bobbit_read.yaml",
			"market-packs": "market-packs/pr-walkthrough/roles/pr-reviewer.yaml",
			"committed-config-cascade": ".bobbit/config/roles/spec-auditor.yaml",
		};
		for (const id of DIRECT_DYNAMIC_FAMILY_IDS) {
			const rule = IMPACT_RULES.find((candidate: { id: string; canaries: readonly string[] }) => candidate.id === id)!;
			const input = representatives[id];
			const plan = affectedTests(graph, [input]);
			expect(plan.kind, id).toBe("bounded");
			expect(plan.affected.size, id).toBeGreaterThan(0);
			expect(plan.affected.size, id).toBeLessThan(graph.testFiles.length);
			for (const consumer of rule.canaries) {
				expect(plan.affected.has(consumer), `${input} -> ${consumer}`).toBe(true);
				expect(graph.testDeps.get(consumer)?.has(input), `${consumer} hash closure includes ${input}`).toBe(true);
			}
		}
	});

	it.each([
		["defaults/roles/reviewer.yaml", "tests2/core/reviewer-diff-scope-prompts.test.ts"],
		["defaults/roles/reviewer.yaml", "tests2/core/reviewer-read-session-policy.test.ts"],
		["defaults/roles/reviewer.yaml", "tests2/core/reviewer-cannot-team-delegate.test.ts"],
		["defaults/roles/reviewer.yaml", "tests2/core/role-children-tools-policy.test.ts"],
		["defaults/roles/reviewer.yaml", "tests2/core/role-team-tools-policy.test.ts"],
		["defaults/roles/reviewer.yaml", "tests2/core/role-gate-signal-policy.test.ts"],
		[".bobbit/config/roles/spec-auditor.yaml", "tests2/core/reviewer-read-session-policy.test.ts"],
		["market-packs/pr-walkthrough/roles/pr-reviewer.yaml", "tests2/core/reviewer-read-session-policy.test.ts"],
	])("pins direct role input %s to authoritative validator %s", (input, consumer) => {
		expectBounded(input, consumer);
		expect(graph.testDeps.get(consumer)?.has(input)).toBe(true);
	});

	it.each([
		["defaults/roles/reviewer.yaml", "tests2/core/reviewer-read-session-policy.test.ts"],
		[".bobbit/config/roles/spec-auditor.yaml", "tests2/core/reviewer-read-session-policy.test.ts"],
		["market-packs/pr-walkthrough/roles/pr-reviewer.yaml", "tests2/core/reviewer-read-session-policy.test.ts"],
	])("invalidates audited dynamic reader hash for %s", (input, consumer) => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-direct-family-hash-"));
		try {
			const inputPath = join(root, ...input.split("/"));
			const consumerPath = join(root, ...consumer.split("/"));
			mkdirSync(dirname(inputPath), { recursive: true });
			mkdirSync(dirname(consumerPath), { recursive: true });
			writeFileSync(inputPath, "before\n", "utf8");
			writeFileSync(consumerPath, "test fixture\n", "utf8");
			expect(graph.testDeps.get(consumer)?.has(input), `${consumer} closure includes ${input}`).toBe(true);
			const dependencies = new Set([input]);
			const before = testHash(consumer, dependencies, { repoRoot: root });
			writeFileSync(inputPath, "after\n", "utf8");
			expect(testHash(consumer, dependencies, { repoRoot: root })).not.toBe(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
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
