// v2-native — actual registered-command final-adapter evidence and finalization.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.ts";
import { test, expect } from "./_e2e/in-process-harness.ts";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import { createSystemsReviewSnapshot } from "../../src/server/agent/systems-review-snapshot.ts";
import { SystemsReviewExecutionStore } from "../../src/server/agent/systems-review-store.ts";
import {
	FINAL_MUTATION_TARGET_CORRELATION_ENV,
	FINAL_MUTATION_TARGET_CORRELATION_HEADER,
} from "../../src/server/agent/systems-review-target-evidence.ts";
import { mergeChildBranchLocal } from "../../src/server/skills/git.ts";
import type {
	SystemsReviewActionBehavior,
	SystemsReviewCoverageReadRecord,
	SystemsReviewEvidenceLocation,
	SystemsReviewStateBehavior,
	SystemsReviewTraceLayerName,
} from "../../src/server/agent/systems-review-types.ts";

const temporaryRoots: string[] = [];
const servers: http.Server[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryRoots.push(directory);
	return directory;
}

async function git(runner: CommandRunner, cwd: string, ...args: string[]): Promise<string> {
	return (await runner.execFile("git", args, { cwd, encoding: "utf8" })).stdout.toString().trim();
}

async function repository(prefix: string): Promise<string> {
	await prepareGitTemplate();
	const container = temporaryDirectory(prefix);
	return copyGitTemplate(path.join(container, "repo"));
}

async function commitFile(runner: CommandRunner, root: string, relativePath: string, content: string, message: string): Promise<void> {
	const target = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	await git(runner, root, "add", relativePath);
	await git(runner, root, "commit", "-m", message);
}

async function closeServer(server: http.Server): Promise<void> {
	await new Promise<void>(resolve => server.close(() => resolve()));
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface TargetFixture {
	harness: any;
	snapshot: Awaited<ReturnType<typeof createSystemsReviewSnapshot>>;
	executionId: string;
	coverageItemId: string;
	stateDir: string;
	snapshotRepo: string;
	effectRepo: string;
	effectCalls: () => number;
	commandRunner: CommandRunner;
	components: Array<{ name: string; repo: string; commands: Record<string, string> }>;
}

async function targetFixture(gatewayCommandRunner: CommandRunner): Promise<TargetFixture> {
	const commandRunner: CommandRunner = {
		execFile: (file, args, options) => gatewayCommandRunner.execFile(file, args, options),
	};
	const snapshotRepo = await repository("bobbit-systems-snapshot-");
	const commandScript = [
		`const token = process.env.${FINAL_MUTATION_TARGET_CORRELATION_ENV};`,
		`if (!token) throw new Error("missing target correlation");`,
		`const response = await fetch(process.argv[2], { method: "POST", headers: { ${JSON.stringify(FINAL_MUTATION_TARGET_CORRELATION_HEADER)}: token } });`,
		`if (!response.ok) throw new Error(await response.text());`,
	].join("\n");
	await commitFile(commandRunner, snapshotRepo, "target-command.mjs", `${commandScript}\n`, "add registered target command");
	await git(commandRunner, snapshotRepo, "checkout", "-b", "feature");
	await commitFile(commandRunner, snapshotRepo, "src/action.ts", [
		`import { mergeChildBranchLocal } from "./git.js";`,
		`export async function mergeEveryRepo(repos: string[]) {`,
		`  return Promise.all(repos.map(repo => mergeChildBranchLocal("master", "child", repo)));`,
		`}`,
	].join("\n"), "aggregate mutation");

	const effectRepo = await repository("bobbit-systems-effect-");
	await git(commandRunner, effectRepo, "checkout", "-b", "child");
	await commitFile(commandRunner, effectRepo, "value.txt", "child\n", "child change");
	await git(commandRunner, effectRepo, "checkout", "master");

	let harness: any;
	let calls = 0;
	const server = http.createServer(async (request, response) => {
		try {
			calls++;
			const result = await harness.runWithSystemsReviewTargetCorrelation(
				request.headers[FINAL_MUTATION_TARGET_CORRELATION_HEADER],
				() => mergeChildBranchLocal("master", "child", effectRepo, commandRunner),
			);
			if (!result.merged && !result.alreadyMerged) throw new Error(`Git effect did not complete: ${result.output}`);
			response.writeHead(204).end();
		} catch (error) {
			response.writeHead(500, { "Content-Type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
		}
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Target effect server did not bind a TCP port");
	const registeredCommand = `node target-command.mjs http://127.0.0.1:${address.port}/effect`;
	const components = [{
		name: "app",
		repo: ".",
		commands: { integration: registeredCommand, unit: registeredCommand },
	}];
	const snapshot = await createSystemsReviewSnapshot({
		sessionId: `systems-session-${Math.random()}`,
		signalId: `systems-signal-${Math.random()}`,
		projectRoot: snapshotRepo,
		branchContainer: snapshotRepo,
		components,
		baseBranch: "master",
		commandRunner,
	});
	expect(snapshot.coverage).toHaveLength(1);

	const stateDir = temporaryDirectory("bobbit-systems-state-");
	const projectConfigStore = {
		getComponents: () => components,
		getWithDefaults: () => ({}),
	} as any;
	harness = new VerificationHarness(
		stateDir,
		undefined,
		() => undefined,
		{ get: () => undefined, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		projectConfigStore,
		undefined,
		undefined,
		{ commandRunner },
	) as any;
	const executionId = `systems-execution-${Math.random()}`;
	const execution = harness.systemsReviewStore.create({
		id: executionId,
		goalId: "goal-1",
		gateId: "implementation",
		signalId: snapshot.signalId,
		sessionId: snapshot.sessionId,
		snapshot,
		contractId: "bobbit:systems-interaction-review/v1",
		contractDigest: "a".repeat(64),
	});
	harness.systemsReviewExecutionBySession.set(snapshot.sessionId, execution.id);
	return {
		harness,
		snapshot,
		executionId,
		coverageItemId: snapshot.coverage[0].id,
		stateDir,
		snapshotRepo,
		effectRepo,
		effectCalls: () => calls,
		commandRunner,
		components,
	};
}

test("actual registered commands produce only matching reader-visible target proof", async ({ gateway }) => {
	const fixture = await targetFixture(gateway.sessionManager.commandRunner as CommandRunner);
	const { harness, snapshot, executionId, coverageItemId, effectRepo, commandRunner } = fixture;
	const coverageItem = snapshot.coverage[0];
	expect(coverageItem).toMatchObject({
		pathClass: "production-executable",
		requiresActionTrace: true,
		requiresExactTargetEvidence: true,
		requiredTargetAdapterIds: ["bobbit.git.merge-child"],
		requiredTargetEffectKinds: ["git-merge"],
	});

	const actionId = "aggregate-merge";
	const targetResult = await harness.runRegisteredSystemsReviewTargetTest({
		executionId,
		componentName: "app",
		commandName: "integration",
		actionId,
		coverageItemId,
		expectedTarget: fs.realpathSync.native(effectRepo),
		expectedScope: "branch:master",
	});
	expect(targetResult.stdout).toBe("");
	expect(fixture.effectCalls()).toBe(1);
	expect(targetResult.evidence.testId).toMatch(/^registered-command:app:integration:/u);
	expect(targetResult.evidence.attempts[0]).toMatchObject({
		resolvedTarget: fs.realpathSync.native(effectRepo),
		resolvedScope: "branch:master",
		effectKind: "git-merge",
	});

	const reader = harness.systemsReviewStore.reader(executionId, commandRunner);
	const patchPage = await reader.read({ operation: "patch", changeId: snapshot.changes[0].id });
	const coveragePage = await reader.read({ operation: "coverage" });
	const coverageRecord = (coveragePage.data as SystemsReviewCoverageReadRecord[])[0];
	expect(coverageRecord.eligibleTargetAssertions).toHaveLength(1);
	expect(coverageRecord.eligibleTargetAssertions[0]).toMatchObject({
		assertionId: targetResult.assertionId,
		actionId,
		testKind: "integration",
		headOid: snapshot.repos[0].headOid,
		adapterIds: ["bobbit.git.merge-child"],
		effectKinds: ["git-merge"],
		effectOutcome: "succeeded",
	});
	const restartedStore = new SystemsReviewExecutionStore(fixture.stateDir);
	const restartedCoveragePage = await restartedStore.reader(executionId, commandRunner).read({ operation: "coverage" });
	expect((restartedCoveragePage.data as SystemsReviewCoverageReadRecord[])[0].eligibleTargetAssertions[0]?.assertionId)
		.toBe(targetResult.assertionId);
	expect(restartedStore.validateTargetAssertion(executionId, targetResult.assertionId, {
		executionId,
		baseOid: snapshot.repos[0].mergeBaseOid,
		headOid: snapshot.repos[0].headOid,
		actionId,
		coverageItemId,
		requiredAdapterIds: ["bobbit.git.merge-child"],
	})).toBe(true);

	const location: SystemsReviewEvidenceLocation = {
		repoId: snapshot.repos[0].id,
		path: snapshot.changes[0].newPath!,
		kind: "changed",
		receipts: [patchPage.receipt],
	};
	const actionLayers: SystemsReviewTraceLayerName[] = ["control", "payload", "handler", "target-resolver", "final-side-effect"];
	const action: SystemsReviewActionBehavior = {
		kind: "action",
		id: actionId,
		title: "Aggregate merge",
		coverageItemIds: [coverageItemId],
		layers: actionLayers.map(layer => ({ layer, description: `${layer} invariant`, locations: [location] })),
		change: "introduced",
		mutation: "destructive",
		aggregate: true,
		targetInvariant: "Every merge reaches the selected repository and branch.",
		tests: [{
			invariant: "The final Git adapter receives the exact repository and branch.",
			failureLayer: "final-side-effect",
			locations: [location],
			exactTargetAssertionId: coverageRecord.eligibleTargetAssertions[0].assertionId,
		}],
	};
	const stateLayers: SystemsReviewTraceLayerName[] = ["producer", "aggregation", "transport", "persistence", "consumer"];
	const state: SystemsReviewStateBehavior = {
		kind: "state",
		id: "aggregate-merge-state",
		title: "Aggregate merge state",
		coverageItemIds: [coverageItemId],
		layers: stateLayers.map(layer => ({ layer, description: `${layer} invariant`, locations: [location] })),
		conservativeAggregateInvariant: "Positive aggregate state requires complete unanimous input.",
		mixedStateMatrix: (["empty", "complete", "partial", "failed", "stale", "mixed-success"] as const)
			.map(stateName => ({ state: stateName, expected: `${stateName} is explicit`, observed: `${stateName} is explicit`, locations: [location] })),
		tests: [{ invariant: "All mixed states remain explicit.", failureLayer: "aggregation", locations: [location] }],
	};

	const checkpoint = await harness.submitSystemsReviewResult(snapshot.sessionId, {
		operation: "checkpoint",
		executionId,
		snapshotDigest: snapshot.digest,
		contractDigest: "a".repeat(64),
		chunkId: snapshot.chunks[0].id,
		coverageCursor: coveragePage.receipt,
		processedChangeIds: snapshot.chunks[0].changeIds,
		receiptTokens: [patchPage.receipt, coveragePage.receipt],
		behaviors: [action, state],
		coverageMappings: [{ coverageItemId, behaviorIds: [action.id, state.id] }],
		findings: [],
		unresolvedLinks: [],
	});
	const final = await harness.submitSystemsReviewResult(snapshot.sessionId, {
		operation: "final",
		executionId,
		snapshotDigest: snapshot.digest,
		contractDigest: "a".repeat(64),
		finalCheckpointDigest: checkpoint.checkpointDigest!,
		resolvedLinks: [],
	});
	expect(final.verdict).toBe("pass");
	expect(final.blockingFindingIds).toEqual([]);

	// Reuse the real command transport against a different immutable branch. The
	// command still reaches the Git adapter, but that adapter is unrelated to the
	// changed filesystem-delete action and must never become reviewer-visible.
	await git(commandRunner, fixture.snapshotRepo, "checkout", "master");
	await git(commandRunner, fixture.snapshotRepo, "checkout", "-b", "file-delete");
	await commitFile(
		commandRunner,
		fixture.snapshotRepo,
		"src/action.ts",
		`import fs from "node:fs";\nexport function deleteEveryFile(files: string[]) { return files.every(file => { fs.unlinkSync(file); return true; }); }\n`,
		"aggregate file delete",
	);
	const deleteSnapshot = await createSystemsReviewSnapshot({
		sessionId: `systems-session-delete-${Math.random()}`,
		signalId: `systems-signal-delete-${Math.random()}`,
		projectRoot: fixture.snapshotRepo,
		branchContainer: fixture.snapshotRepo,
		components: fixture.components,
		baseBranch: "master",
		commandRunner,
	});
	const deleteCoverage = deleteSnapshot.coverage[0];
	expect(deleteCoverage).toMatchObject({
		requiresExactTargetEvidence: true,
		requiredTargetAdapterIds: ["bobbit.filesystem.delete"],
		requiredTargetEffectKinds: ["filesystem-delete"],
	});
	const deleteExecutionId = `systems-execution-delete-${Math.random()}`;
	harness.systemsReviewStore.create({
		id: deleteExecutionId,
		goalId: "goal-1",
		gateId: "implementation",
		signalId: deleteSnapshot.signalId,
		sessionId: deleteSnapshot.sessionId,
		snapshot: deleteSnapshot,
		contractId: "bobbit:systems-interaction-review/v1",
		contractDigest: "a".repeat(64),
	});
	harness.systemsReviewExecutionBySession.set(deleteSnapshot.sessionId, deleteExecutionId);
	const priorCalls = fixture.effectCalls();
	const deleteInput = {
		executionId: deleteExecutionId,
		componentName: "app",
		actionId: "aggregate-delete",
		coverageItemId: deleteCoverage.id,
		expectedTarget: fs.realpathSync.native(effectRepo),
		expectedScope: "branch:master",
	};
	await expect(harness.runRegisteredSystemsReviewTargetTest({ ...deleteInput, commandName: "unit" }))
		.rejects.toThrow(/only registered integration or browser commands/i);
	expect(fixture.effectCalls()).toBe(priorCalls);
	await expect(harness.runRegisteredSystemsReviewTargetTest({ ...deleteInput, commandName: "integration" }))
		.rejects.toThrow(/unrelated to the changed action/i);
	expect(fixture.effectCalls()).toBe(priorCalls + 1);

	const deleteCoveragePage = await harness.systemsReviewStore.reader(deleteExecutionId, commandRunner).read({ operation: "coverage" });
	const deleteCoverageRecord = (deleteCoveragePage.data as SystemsReviewCoverageReadRecord[])[0];
	expect(deleteCoverageRecord.eligibleTargetAssertions).toEqual([]);
});
