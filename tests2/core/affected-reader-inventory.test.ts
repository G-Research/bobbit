// v2-native — exhaustive indirect and dynamic repository-reader audit contract.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testHash } from "../../scripts/affected/cache.mjs";
import {
	affectedTests,
	REPO_ROOT,
} from "../../scripts/affected/graph.mjs";
import {
	IMPACT_RULES,
	INDIRECT_REPOSITORY_READ_RULES,
	UNRESOLVED_REPOSITORY_READ_AUDIT,
	validateIndirectRepositoryReadRegistry,
	validateUnresolvedRepositoryReadAudit,
} from "../../scripts/affected/impact-rules.mjs";
import { AFFECTED_GRAPH as graph } from "./helpers/affected-graph-fixture.js";

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

type UnresolvedRead = { expression: string; status: string };
type UnresolvedReadAuditEntry = {
	consumer: string;
	allowReason?: string;
	declarations?: readonly string[];
	reads: readonly { expression: string; count: number }[];
};

function expectBounded(path: string, expectedTest: string): void {
	const plan = affectedTests(graph, [path]);
	expect(plan.kind, path).toBe("bounded");
	expect(plan.cachePolicy, path).toBe("eligible");
	expect(plan.affected.size, path).toBeGreaterThan(0);
	expect(plan.affected.size, path).toBeLessThan(graph.testFiles.length);
	expect(plan.affected.has(expectedTest), path).toBe(true);
}

describe("affected repository reader inventory", () => {
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

describe("audited dynamic input readers", () => {
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
});
