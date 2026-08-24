// v2-native — exhaustive indirect and dynamic repository-reader audit contract.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { partition, record, testHash } from "../../scripts/affected/cache.mjs";
import {
	affectedTests,
	REPO_ROOT,
} from "../../scripts/affected/graph.mjs";
import {
	DYNAMIC_EXECUTABLE_CONSUMER_AUDIT,
	IMPACT_RULES,
	INDIRECT_REPOSITORY_READ_RULES,
	REPOSITORY_SCAN_RULES,
	UNRESOLVED_REPOSITORY_READ_AUDIT,
	validateDynamicExecutableConsumerAudit,
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
	{ consumer: "tests2/core/ponytail-accessory.test.ts", input: "src/ui/app.css" },
	{ consumer: "tests2/core/ponytail-accessory.test.ts", input: "src/ui/bobbit-render.ts" },
	{ consumer: "tests2/core/ponytail-accessory.test.ts", input: "src/ui/components/StreamingMessageContainer.ts" },
	{ consumer: "tests2/core/ponytail-accessory.test.ts", input: "src/app/role-manager.css" },
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
	{ consumer: "tests2/core/build-unit-gate-ci.test.ts", input: ".github/workflows/build-unit-gate.yml" },
	{ consumer: "tests2/core/build-unit-gate-ci.test.ts", input: ".github/workflows/codeql.yml" },
	{ consumer: "tests2/core/bobbit-dir-agent-dir.test.ts", input: "src/server/agent-dir-config.ts" },
	{ consumer: "tests2/core/bobbit-dir-agent-dir.test.ts", input: "src/server/bobbit-dir.ts" },
	{ consumer: "tests2/core/extension-host-channel-substrate.test.ts", input: "src/server/extension-host/channel-open-permits.ts" },
	{ consumer: "tests2/core/extension-host-channel-substrate.test.ts", input: "src/server/extension-host/channel-registry.ts" },
	{ consumer: "tests2/core/extension-host-channel-substrate.test.ts", input: "src/server/extension-host/channel-types.ts" },
	{ consumer: "tests2/core/file-mentions-authenticated-boundary.test.ts", input: "src/server/skills/resolve-file-mentions.ts" },
	{ consumer: "tests2/integration/hindsight-external.test.ts", input: "tests/e2e/hindsight-stub.mjs" },
	{ consumer: "tests2/core/hung-test-reporter.test.ts", input: "tests2/core/helpers/hung-test-reporter.mjs" },
	{ consumer: "tests2/core/image-generate-no-model-param.test.ts", input: "defaults/tools/images/extension.ts" },
	{ consumer: "tests2/core/ledger-lease-bridge-interop.test.ts", input: "scripts/testing-v2/ledger.mjs" },
	{ consumer: "tests2/core/qa-seed.test.ts", input: "scripts/qa-seed/seed.mjs" },
	{ consumer: "tests2/core/run-unit-heartbeat-diagnostics.test.ts", input: "scripts/lib/unit-heartbeat.mjs" },
	{ consumer: "tests2/core/team-extension-dismiss-gateway.test.ts", input: "defaults/tools/agent/gateway.js" },
	{ consumer: "tests2/core/run-isolation.test.ts", input: "playwright-e2e.config.ts" },
	{ consumer: "tests2/core/run-isolation.test.ts", input: "playwright-v2.config.ts" },
	{ consumer: "tests2/core/node-modules-ring-fence.test.ts", input: "src/server/harness.ts" },
	{ consumer: "tests2/core/node-modules-ring-fence.test.ts", input: "scripts/dev-nord.mjs" },
	{ consumer: "tests2/core/node-modules-ring-fence.test.ts", input: "scripts/harness-bootstrap.mjs" },
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

const REPOSITORY_SCAN_RULE_IDS = [
	"client-source-guards",
	"server-typescript-source-guards",
	"async-background-cleanup-source-guard",
	"metadata-retirement-source-guard",
	"search-worker-main-thread-boundary",
	"preview-cookie-server-source-guard",
	"worktree-setup-source-guard",
	"workflow-default-source-guard",
	"unit-test-dist-import-guard",
	"v2-test-inventory-guard",
	"unit-runtime-closure-guard",
	"affected-runner-no-escape-guard",
	"pi-browser-fixture-guard",
	"pr-walkthrough-pack-boundary",
	"hindsight-external-pack-fixture",
	"pr-walkthrough-proof-removal-guard",
	"extension-capability-residual-guard",
] as const;

const DYNAMIC_UNIT_REPRESENTATIVES = [
	["defaults/tools/images/extension.ts", "tests2/core/image-generate-no-model-param.test.ts"],
	["src/server/agent-dir-config.ts", "tests2/core/bobbit-dir-agent-dir.test.ts"],
	["src/server/extension-host/channel-open-permits.ts", "tests2/core/extension-host-channel-substrate.test.ts"],
	["tests2/core/helpers/hung-test-reporter.mjs", "tests2/core/hung-test-reporter.test.ts"],
	["scripts/testing-v2/ledger.mjs", "tests2/core/ledger-lease-bridge-interop.test.ts"],
	["scripts/qa-seed/seed.mjs", "tests2/core/qa-seed.test.ts"],
	["scripts/lib/unit-heartbeat.mjs", "tests2/core/run-unit-heartbeat-diagnostics.test.ts"],
	["defaults/tools/agent/gateway.js", "tests2/core/team-extension-dismiss-gateway.test.ts"],
	["src/server/server.ts", "tests2/core/async-background-cleanup-static.test.ts"],
	["src/shared/parse-acceptance-criteria.ts", "tests2/core/async-background-cleanup-static.test.ts"],
	["src/server/server.ts", "tests2/core/perm-frame-late-joiner-seq-gap.test.ts"],
	["src/server/server.ts", "tests2/core/preview-cookie.test.ts"],
	["tests2/core/aigw-headers.test.ts", "tests2/core/guard-v2.test.ts"],
	["market-packs/hindsight/pack.yaml", "tests2/integration/hindsight-external.test.ts"],
	["tests/e2e/hindsight-stub.mjs", "tests2/integration/hindsight-external.test.ts"],
] as const;

const REMOTE_STATE_SOURCE_READERS = [
	{
		input: "src/server/remote-state-coordinator.ts",
		consumers: [
			"tests2/core/remote-state-coordinator.test.ts",
			"tests2/core/remote-state-identity.test.ts",
			"tests2/integration/remote-state-routes.test.ts",
			"tests2/integration/staff-goal-triggers.test.ts",
		],
	},
	{
		input: "src/server/agent/staff-trigger-engine.ts",
		consumers: [
			"tests2/core/staff-trigger-engine.test.ts",
			"tests2/dom/cron-parser.test.ts",
			"tests2/integration/remote-state-routes.test.ts",
			"tests2/integration/staff-goal-triggers.test.ts",
		],
	},
] as const;

type UnresolvedRead = { expression: string; status: string };
type DynamicOperation = { kind: string; expression: string };
type DynamicAuditEntry = {
	consumer: string;
	operations: readonly {
		kind: string;
		expression: string;
		count: number;
		declarations?: readonly string[];
		allowReason?: string;
	}[];
};
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

function expectSelectionAndCacheInvalidation(input: string, consumer: string, temporaryPrefix: string): void {
	expectBounded(input, consumer);
	const dependencies = graph.testDeps.get(consumer)!;
	expect(dependencies.has(input), `${consumer} closure includes ${input}`).toBe(true);

	const root = mkdtempSync(join(tmpdir(), temporaryPrefix));
	try {
		const inputPath = join(root, ...input.split("/"));
		const consumerPath = join(root, ...consumer.split("/"));
		mkdirSync(dirname(inputPath), { recursive: true });
		mkdirSync(dirname(consumerPath), { recursive: true });
		writeFileSync(inputPath, "before\n", "utf8");
		writeFileSync(consumerPath, "test fixture\n", "utf8");

		const options = { repoRoot: root };
		const before = testHash(consumer, dependencies, options);
		const cache = record({}, "fixture-fingerprint", new Set([consumer]), "pass", new Map([[consumer, before]]));
		const focusedGraph = { testDeps: new Map([[consumer, dependencies]]) };
		expect(partition(cache, "fixture-fingerprint", focusedGraph, new Set([consumer]), options).hits)
			.toEqual(new Set([consumer]));

		writeFileSync(inputPath, "after\n", "utf8");
		expect(testHash(consumer, dependencies, options), `${input} changes the test hash`).not.toBe(before);
		expect(partition(cache, "fixture-fingerprint", focusedGraph, new Set([consumer]), options)).toMatchObject({
			hits: new Set(),
			misses: new Set([consumer]),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("affected repository reader inventory", () => {
	it("declares the complete exact indirect repository-read table", () => {
		const declared = INDIRECT_REPOSITORY_READ_RULES.flatMap((rule: {
			consumer: string;
			inputs: readonly string[];
		}) => rule.inputs.map((input) => ({ consumer: rule.consumer, input })));
		expect(declared).toHaveLength(63);
		expect(declared).toEqual(INDIRECT_READ_PAIRS);
		expect(graph.meta.indirectRepositoryReadValidation.issues).toEqual([]);
	});

	it.each(INDIRECT_READ_PAIRS)("maps $input to $consumer through the shared dependency graph", ({ input, consumer }) => {
		const plan = affectedTests(graph, [input]);
		const e2eOwned = graph.meta.e2eFiles.has(consumer);
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
		if (e2eOwned) {
			expect(graph.testFiles, consumer).not.toContain(consumer);
			expect(plan.affected.has(consumer), `${consumer} remains outside unit execution`).toBe(false);
			expect(graph.srcToE2e.get(input)?.has(consumer), `${input} -> advisory ${consumer}`).toBe(true);
		} else {
			expect(plan.affected.has(consumer), `${input} -> ${consumer}`).toBe(true);
		}
		const dependencies = (e2eOwned ? graph.e2eDeps : graph.testDeps).get(consumer);
		expect(dependencies?.has(input), `${consumer} hash closure includes ${input}`).toBe(true);
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
				const dependencies = graph.meta.e2eFiles.has(consumer)
					? graph.e2eDeps.get(consumer)
					: graph.testDeps.get(consumer);
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

	it.each([
		[".github/workflows/build-unit-gate.yml", "tests2/core/build-unit-gate-ci.test.ts"],
		[".github/workflows/codeql.yml", "tests2/core/build-unit-gate-ci.test.ts"],
	])("selects and invalidates the native CI workflow reader for %s", (input, consumer) => {
		expectSelectionAndCacheInvalidation(input, consumer, "bobbit-workflow-reader-");
	});

	it("keeps the file-mentions esbuild entry advisory with its transitive E2E closure", () => {
		const consumer = "tests2/core/file-mentions-authenticated-boundary.test.ts";
		const entry = "src/server/skills/resolve-file-mentions.ts";
		const transitive = "src/server/agent/semaphore.ts";
		expect(graph.meta.e2eFiles.has(consumer)).toBe(true);
		expect(graph.testDeps.has(consumer)).toBe(false);
		expect(graph.e2eDeps.get(consumer)).toBeInstanceOf(Set);
		for (const dependency of [entry, transitive]) {
			expect(graph.e2eDeps.get(consumer)?.has(dependency), dependency).toBe(true);
			expect(graph.srcToE2e.get(dependency)?.has(consumer), `${dependency} reverse advisory edge`).toBe(true);
		}
		const plan = affectedTests(graph, [entry]);
		expect(plan.kind).toBe("bounded");
		expect(plan.affected.has(consumer)).toBe(false);
	});

	it("pins the exact dynamic-operation and computed-scan inventories", () => {
		const audit = DYNAMIC_EXECUTABLE_CONSUMER_AUDIT as readonly DynamicAuditEntry[];
		const observedOperations = graph.meta.dynamicExecutableConsumerAudit.actual as Map<string, Map<string, number>>;
		expect(audit).toHaveLength(48);
		expect(audit.reduce((count, entry) => count + entry.operations.length, 0)).toBe(63);
		expect([...observedOperations.values()].reduce(
			(count, operations) => count + [...operations.values()].reduce((sum, occurrences) => sum + occurrences, 0),
			0,
		)).toBe(68);
		expect(REPOSITORY_SCAN_RULES).toHaveLength(17);
		expect(REPOSITORY_SCAN_RULES.map((rule: { id: string }) => rule.id)).toEqual(REPOSITORY_SCAN_RULE_IDS);
		expect(graph.meta.dynamicExecutableConsumerAudit.issues).toEqual([]);
		expect(observedOperations.size).toBe(48);
		expect(graph.meta.dynamicExecutableConsumerAudit.auditedConsumers.size).toBe(48);
		expect(graph.meta.repositoryScanValidation.issues).toEqual([]);
		for (const entry of audit) {
			for (const operation of entry.operations) {
				expect(Boolean(operation.declarations?.length) !== Boolean(operation.allowReason),
					`${entry.consumer}: ${operation.kind}:${operation.expression}`).toBe(true);
			}
		}

		const benchmarkCore = "tests2/core/benchmark-bobbit-journeys.test.ts";
		expect(audit.find((entry) => entry.consumer === benchmarkCore)).toEqual({
			consumer: benchmarkCore,
			operations: [
				{
					kind: "repository-directory-copy",
					expression: "fixtureRoot",
					count: 1,
					allowReason: "test-owned gateway fixture copied between isolated benchmark temporary roots",
				},
			],
		});

		const staffGoalTriggers = "tests2/integration/staff-goal-triggers.test.ts";
		expect(audit.find((entry) => entry.consumer === staffGoalTriggers)).toEqual({
			consumer: staffGoalTriggers,
			operations: [
				{
					kind: "repository-directory-copy",
					expression: "join(publisher, \".git\")",
					count: 1,
					allowReason: "test-owned Git-template clone copied into a temporary bare remote",
				},
				{
					kind: "repository-directory-copy",
					expression: "join(origin, \"objects\", objectRelativePath)",
					count: 1,
					allowReason: "test-owned temporary bare-remote object copied into a writable Git-template clone",
				},
			],
		});
	});

	it("selects and invalidates the search main-thread boundary through its repository scan", () => {
		const input = "src/server/search/search-worker.ts";
		const consumer = "tests2/core/session-connect-timeout-main-thread-repro.test.ts";
		const rule = REPOSITORY_SCAN_RULES.find((candidate: { id: string }) =>
			candidate.id === "search-worker-main-thread-boundary");
		expect(rule?.matches(input)).toBe(true);
		expect(rule?.consumers).toContain(consumer);
		expect(graph.meta.repositoryScanInputs).toContain(input);
		expectSelectionAndCacheInvalidation(input, consumer, "bobbit-search-scan-");
	});

	it("rejects changed, unowned, and dead dynamic executable operations", () => {
		const knownTests = new Set([...graph.testFiles, ...graph.meta.e2eFiles]);
		const changedConsumer = "tests2/core/image-generate-no-model-param.test.ts";
		const changedOperations = new Map<string, DynamicOperation[]>(graph.meta.dynamicExecutableOperations);
		changedOperations.set(changedConsumer, [
			...(changedOperations.get(changedConsumer) ?? []),
			{ kind: "dynamic-import", expression: "newRepositoryExtension" },
		]);
		const changed = validateDynamicExecutableConsumerAudit(
			changedOperations,
			knownTests,
			graph.meta.unresolvedReadDeclarations,
		);
		expect(changed.issues).toContain(
			`${changedConsumer}: new dynamic executable operation requires audit: dynamic-import:newRepositoryExtension (1)`,
		);

		const unownedConsumer = "tests2/core/package-files.test.ts";
		const unownedOperations = new Map<string, DynamicOperation[]>(graph.meta.dynamicExecutableOperations);
		unownedOperations.set(unownedConsumer, [{ kind: "dynamic-import", expression: "repositoryTarget" }]);
		const unowned = validateDynamicExecutableConsumerAudit(
			unownedOperations,
			knownTests,
			graph.meta.unresolvedReadDeclarations,
		);
		expect(unowned.issues).toContain(
			`${unownedConsumer}: dynamic executable operations have no audit (1 unique)`,
		);

		const deadConsumer = "tests2/integration/staff-goal-triggers.test.ts";
		const deadOperations = new Map<string, DynamicOperation[]>(graph.meta.dynamicExecutableOperations);
		deadOperations.set(deadConsumer, (deadOperations.get(deadConsumer) ?? []).filter(
			(operation) => operation.expression !== "join(publisher, \".git\")",
		));
		const dead = validateDynamicExecutableConsumerAudit(
			deadOperations,
			knownTests,
			graph.meta.unresolvedReadDeclarations,
		);
		expect(dead.issues).toContain(
			`${deadConsumer}: audited dynamic executable operation changed: repository-directory-copy:join(publisher, \".git\") (expected 1, observed 0)`,
		);
	});

	it.each(DYNAMIC_UNIT_REPRESENTATIVES)("maps and hashes dynamic input %s for %s", (input, consumer) => {
		expectBounded(input, consumer);
		expect(graph.testDeps.get(consumer)?.has(input), `${consumer} closure includes ${input}`).toBe(true);
		const root = mkdtempSync(join(tmpdir(), "bobbit-dynamic-consumer-hash-"));
		try {
			const inputPath = join(root, ...input.split("/"));
			const consumerPath = join(root, ...consumer.split("/"));
			mkdirSync(dirname(inputPath), { recursive: true });
			mkdirSync(dirname(consumerPath), { recursive: true });
			writeFileSync(inputPath, "before\n", "utf8");
			writeFileSync(consumerPath, "test fixture\n", "utf8");
			const dependencies = new Set([input]);
			const options = { repoRoot: root };
			const before = testHash(consumer, dependencies, options);
			const cache = record({}, "fixture-fingerprint", new Set([consumer]), "pass", new Map([[consumer, before]]));
			const focusedGraph = { testDeps: new Map([[consumer, dependencies]]) };
			expect(partition(cache, "fixture-fingerprint", focusedGraph, new Set([consumer]), options).hits)
				.toEqual(new Set([consumer]));

			writeFileSync(inputPath, "after\n", "utf8");
			expect(testHash(consumer, dependencies, options), input).not.toBe(before);
			expect(partition(cache, "fixture-fingerprint", focusedGraph, new Set([consumer]), options)).toMatchObject({
				hits: new Set(),
				misses: new Set([consumer]),
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(REMOTE_STATE_SOURCE_READERS)("selects and invalidates every intended reader for $input", ({ input, consumers }) => {
		const plan = affectedTests(graph, [input]);
		expect(plan.kind, input).toBe("bounded");
		expect(plan.cachePolicy, input).toBe("eligible");
		expect(plan.affected.size, input).toBeGreaterThan(0);
		expect(plan.affected.size, input).toBeLessThan(graph.testFiles.length);
		for (const consumer of consumers) {
			expect(plan.affected.has(consumer), `${input} -> ${consumer}`).toBe(true);
			expectSelectionAndCacheInvalidation(input, consumer, "bobbit-remote-state-reader-");
		}
	});

	it("pins every unresolved unit read to a live declaration or reviewed generated path", () => {
		expect(graph.meta.unresolvedRepositoryReadAudit.issues).toEqual([]);
		expect(graph.meta.unresolvedRepositoryReadAudit.actual.size).toBeGreaterThan(100);
		expect(UNRESOLVED_REPOSITORY_READ_AUDIT).toHaveLength(graph.meta.unresolvedRepositoryReadAudit.actual.size);
		const audit = UNRESOLVED_REPOSITORY_READ_AUDIT as readonly UnresolvedReadAuditEntry[];
		for (const entry of audit) {
			expect(Boolean(entry.allowReason) !== Boolean(entry.declarations?.length), entry.consumer).toBe(true);
		}

		const staffGoalTriggers = "tests2/integration/staff-goal-triggers.test.ts";
		const staffFixtureAudit = audit.find((entry) => entry.consumer === staffGoalTriggers);
		expect(staffFixtureAudit).toEqual({
			consumer: staffGoalTriggers,
			allowReason: "test-owned temporary Git-template clones, bare remote, refs, and loose objects",
			reads: [
				{ expression: "refPath(repo, ref)", count: 1 },
				{ expression: "join(origin, \"refs\", \"heads\", \"main\")", count: 1 },
				{ expression: "join(publisher, \".git\", \"objects\", baselineSha.slice(0, 2), baselineSha.slice(2))", count: 1 },
				{ expression: "join(origin, \"objects\", remoteSha.slice(0, 2), remoteSha.slice(2))", count: 1 },
				{ expression: "join(watched, \".git\", \"objects\", remoteSha.slice(0, 2), remoteSha.slice(2))", count: 1 },
			],
		});
		for (const read of staffFixtureAudit?.reads ?? []) {
			expect(graph.testDeps.get(staffGoalTriggers)?.has(read.expression),
				`${read.expression} remains test-owned fixture content`).toBe(false);
		}

		const benchmarkCore = "tests2/core/benchmark-bobbit-journeys.test.ts";
		const benchmarkFixtureAudit = audit.find((entry) => entry.consumer === benchmarkCore);
		expect(benchmarkFixtureAudit).toEqual({
			consumer: benchmarkCore,
			allowReason: "test-owned benchmark fixtures and reports generated beneath per-test temporary roots",
			reads: [
				{ expression: "baseline", count: 2 },
				{ expression: "destination", count: 2 },
				{ expression: "transcriptPath", count: 1 },
				{ expression: "path.join(fixture.directory, \"transcript.jsonl\")", count: 1 },
				{ expression: "preferencesPath", count: 1 },
				{ expression: "path.join(outputRoot, \"baseline.failed.json\")", count: 1 },
				{ expression: "path.join(root, \"sample-a\", \"secrets\", \"token\")", count: 1 },
				{ expression: "path.join(sample.secretsRoot, \"token\")", count: 1 },
			],
		});
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
