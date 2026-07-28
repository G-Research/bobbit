// v2-native — real Git final-adapter evidence accepted by Systems finalization.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.ts";
import { test, expect } from "./_e2e/in-process-harness.ts";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import { createSystemsReviewSnapshot } from "../../src/server/agent/systems-review-snapshot.ts";
import { mergeChildBranchLocal } from "../../src/server/skills/git.ts";
import type {
	SystemsReviewActionBehavior,
	SystemsReviewEvidenceLocation,
	SystemsReviewStateBehavior,
	SystemsReviewTraceLayerName,
} from "../../src/server/agent/systems-review-types.ts";

const temporaryRoots: string[] = [];

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

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("Systems finalization accepts a registered real-Git final-adapter assertion", async ({ gateway }) => {
		const gatewayCommandRunner = gateway.sessionManager.commandRunner as CommandRunner;
		const fixtureCommandRunner: CommandRunner = {
			execFile: (file, args, options) => gatewayCommandRunner.execFile(file, args, options),
		};
		const snapshotRepo = await repository("bobbit-systems-snapshot-");
		await git(fixtureCommandRunner, snapshotRepo, "checkout", "-b", "feature");
		await commitFile(
			fixtureCommandRunner,
			snapshotRepo,
			"src/worker.ts",
			"import fs from 'node:fs';\nexport function process(records: string[]) { return records.every(file => { fs.unlinkSync(file); return true; }); }\n",
			"aggregate mutation",
		);

		const snapshot = await createSystemsReviewSnapshot({
			sessionId: "systems-session-1",
			signalId: "systems-signal-1",
			projectRoot: snapshotRepo,
			branchContainer: snapshotRepo,
			components: [{ name: "app", repo: ".", commands: { integration: "npm run test:integration" } }],
			baseBranch: "master",
			commandRunner: fixtureCommandRunner,
		});
		expect(snapshot.coverage).toHaveLength(1);
		expect(snapshot.coverage[0]).toMatchObject({
			pathClass: "production-executable",
			requiresActionTrace: true,
			requiresExactTargetEvidence: true,
		});

		const effectRepo = await repository("bobbit-systems-effect-");
		await git(fixtureCommandRunner, effectRepo, "checkout", "-b", "child");
		await commitFile(fixtureCommandRunner, effectRepo, "value.txt", "child\n", "child change");
		await git(fixtureCommandRunner, effectRepo, "checkout", "master");

		const stateDir = temporaryDirectory("bobbit-systems-state-");
		const projectConfigStore = {
			getComponents: () => [{ name: "app", repo: ".", commands: { integration: "npm run test:integration" } }],
			getWithDefaults: () => ({}),
		} as any;
		const harness = new VerificationHarness(
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
			{ commandRunner: fixtureCommandRunner },
		) as any;
		const execution = harness.systemsReviewStore.create({
			id: "systems-execution-1",
			goalId: "goal-1",
			gateId: "implementation",
			signalId: snapshot.signalId,
			sessionId: snapshot.sessionId,
			snapshot,
			contractId: "bobbit:systems-interaction-review/v1",
			contractDigest: "a".repeat(64),
		});
		harness.systemsReviewExecutionBySession.set(snapshot.sessionId, execution.id);

		const coverageItem = snapshot.coverage[0];
		const actionId = "aggregate-delete";
		const targetResult = await harness.runRegisteredSystemsReviewTargetTest({
			executionId: execution.id,
			componentName: "app",
			commandName: "integration",
			testId: "tests2/integration/systems-review-target-finalization.test.ts > real Git adapter",
			actionId,
			coverageItemId: coverageItem.id,
			expectedTarget: fs.realpathSync.native(effectRepo),
			expectedScope: "branch:master",
			invoke: async () => {
				const result = await mergeChildBranchLocal("master", "child", effectRepo, fixtureCommandRunner);
				if (!result.merged) throw new Error(`Expected a real merge effect, got: ${result.output}`);
				return result;
			},
		});
		expect(targetResult.assertionId).toMatch(/^target-assertion:[0-9a-f-]{36}$/u);
		expect(targetResult.evidence.attempts).toHaveLength(1);
		expect(targetResult.evidence.attempts[0]).toMatchObject({
			resolvedTarget: fs.realpathSync.native(effectRepo),
			resolvedScope: "branch:master",
			effectKind: "git-merge",
		});

		const reader = harness.systemsReviewStore.reader(execution.id, fixtureCommandRunner);
		const patchPage = await reader.read({ operation: "patch", changeId: snapshot.changes[0].id });
		const coveragePage = await reader.read({ operation: "coverage" });
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
			title: "Aggregate delete",
			coverageItemIds: [coverageItem.id],
			layers: actionLayers.map(layer => ({ layer, description: `${layer} invariant`, locations: [location] })),
			change: "introduced",
			mutation: "destructive",
			aggregate: true,
			targetInvariant: "Every deletion reaches the selected repository.",
			tests: [{
				invariant: "The final Git adapter receives the exact repository and branch.",
				failureLayer: "final-side-effect",
				locations: [location],
				exactTargetAssertionId: targetResult.assertionId,
			}],
		};
		const stateLayers: SystemsReviewTraceLayerName[] = ["producer", "aggregation", "transport", "persistence", "consumer"];
		const state: SystemsReviewStateBehavior = {
			kind: "state",
			id: "aggregate-delete-state",
			title: "Aggregate delete state",
			coverageItemIds: [coverageItem.id],
			layers: stateLayers.map(layer => ({ layer, description: `${layer} invariant`, locations: [location] })),
			conservativeAggregateInvariant: "Positive aggregate state requires complete unanimous input.",
			mixedStateMatrix: (["empty", "complete", "partial", "failed", "stale", "mixed-success"] as const)
				.map(stateName => ({ state: stateName, expected: `${stateName} is explicit`, observed: `${stateName} is explicit`, locations: [location] })),
			tests: [{ invariant: "All mixed states remain explicit.", failureLayer: "aggregation", locations: [location] }],
		};

		const checkpoint = await harness.submitSystemsReviewResult(snapshot.sessionId, {
			operation: "checkpoint",
			executionId: execution.id,
			snapshotDigest: snapshot.digest,
			contractDigest: execution.contractDigest,
			chunkId: snapshot.chunks[0].id,
			coverageCursor: coveragePage.receipt,
			processedChangeIds: snapshot.chunks[0].changeIds,
			receiptTokens: [patchPage.receipt, coveragePage.receipt],
			behaviors: [action, state],
			coverageMappings: [{ coverageItemId: coverageItem.id, behaviorIds: [action.id, state.id] }],
			findings: [],
			unresolvedLinks: [],
		});
		expect(() => harness.assertGoalWorktreeWriteAllowed(execution.goalId)).toThrow(/immutable|protected/i);
		const final = await harness.submitSystemsReviewResult(snapshot.sessionId, {
			operation: "final",
			executionId: execution.id,
			snapshotDigest: snapshot.digest,
			contractDigest: execution.contractDigest,
			finalCheckpointDigest: checkpoint.checkpointDigest!,
			resolvedLinks: [],
		});
		expect(final.verdict).toBe("pass");
		expect(final.blockingFindingIds).toEqual([]);
		expect(() => harness.assertGoalWorktreeWriteAllowed(execution.goalId)).not.toThrow();

		// The same signed assertion cannot be rebound to another coverage item or action.
		expect(harness.systemsReviewAssertionRegistry.validateAndConsume(targetResult.assertionId, {
			executionId: execution.id,
			baseOid: snapshot.repos[0].mergeBaseOid,
			headOid: snapshot.repos[0].headOid,
			actionId: "another-action",
			coverageItemId: coverageItem.id,
		})).toBe(false);
});
