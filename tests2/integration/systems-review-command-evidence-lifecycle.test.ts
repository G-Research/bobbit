// v2-native — accepted command evidence through the normal implementation-gate lifecycle.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import {
	SYSTEMS_INTERACTION_REVIEW_PROMPT,
	SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
	SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256,
} from "../../src/server/agent/systems-interaction-review-contract.ts";
import { SystemsReviewWriterLeaseCoordinator } from "../../src/server/agent/systems-review-lease.ts";
import { SystemsReviewExecutionStore } from "../../src/server/agent/systems-review-store.ts";
import type { SystemsReviewCoverageReadRecord } from "../../src/server/agent/systems-review-types.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import { expect, test } from "./_e2e/in-process-harness.ts";
import { execOnly, runLifecycle } from "./helpers/systems-review-command-evidence-fixture.ts";

test("normal implementation-gate lifecycle captures the real GoalManager.mergeChild target before reviewer launch", async ({ gateway }) => {
	const commandRunner = execOnly(gateway.sessionManager.commandRunner as CommandRunner);
	const result = await runLifecycle(commandRunner, {
		label: "happy path",
		commandName: "integration",
		invoke: "success",
		seedPassedCache: true,
		expectEvidence: true,
	});

	expect(result.spawnCount).toBe(1);
	expect(result.order).toEqual(["command:start", "command:end", "reviewer:start"]);
	expect(result.gateStatus, JSON.stringify(result.verification)).toBe("passed");
	expect(result.verification).toMatchObject({
		status: "passed",
		steps: [
			{ status: "passed", output: expect.not.stringContaining("cached from prior signal") },
			{ status: "passed" },
		],
	});
	expect(result.coverage).toMatchObject({
		requiresActionTrace: true,
		requiresExactTargetEvidence: true,
		requiredTargetActionIds: ["bobbit.goal.merge-child"],
		requiredTargetAdapterIds: ["bobbit.git.merge-child"],
		requiredTargetEffectKinds: ["git-merge"],
	});
	expect(result.coverage.eligibleTargetAssertions).toHaveLength(1);
	const assertion = result.execution.targetAssertions[0];
	expect(assertion).toMatchObject({
		actionId: "bobbit.goal.merge-child",
		testKind: "integration",
		expectedTarget: fs.realpathSync.native(result.effect!.parentRoot),
		expectedScope: "branch:master",
		adapterIds: ["bobbit.git.merge-child"],
		effectKinds: ["git-merge"],
		effectOutcome: "succeeded",
	});
	expect(assertion.evidence.attempts).toEqual([
		expect.objectContaining({
			resolvedTarget: fs.realpathSync.native(result.effect!.parentRoot),
			resolvedScope: "branch:master",
			effectKind: "git-merge",
			attempt: 1,
		}),
	]);

	const restarted = new SystemsReviewExecutionStore(result.stateDir);
	const durableCoverage = await restarted.reader(result.executionId, commandRunner).read({ operation: "coverage" });
	expect((durableCoverage.data as SystemsReviewCoverageReadRecord[])[0].eligibleTargetAssertions)
		.toEqual(result.coverage.eligibleTargetAssertions);
	const repo = result.execution.snapshot.repos[0];
	const expectedBinding = {
		executionId: result.executionId,
		baseOid: repo.mergeBaseOid,
		headOid: repo.headOid,
		actionId: "bobbit.goal.merge-child",
		coverageItemId: result.coverage.id,
		requiredAdapterIds: ["bobbit.git.merge-child"],
	};
	expect(restarted.validateTargetAssertion(result.executionId, assertion.assertionId, expectedBinding)).toBe(true);
	expect(restarted.validateTargetAssertion(result.executionId, assertion.assertionId, expectedBinding)).toBe(true);
	for (const mismatch of [
		{ executionId: "wrong-execution" },
		{ baseOid: "a".repeat(40) },
		{ headOid: "b".repeat(40) },
		{ actionId: "wrong-action" },
		{ coverageItemId: "wrong-coverage" },
		{ requiredAdapterIds: ["wrong-adapter"] },
	]) {
		expect(restarted.validateTargetAssertion(
			result.executionId,
			assertion.assertionId,
			{ ...expectedBinding, ...mismatch },
		)).toBe(false);
	}
});

test("explicit LLM-review skip bypasses Systems snapshot, execution, and writer lease precreation", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-systems-skip-"));
	const goalId = "systems-skip-goal";
	const signalId = "systems-skip-signal";
	const systemsStep = {
		name: "Systems interaction review",
		type: "llm-review" as const,
		role: "systems-reviewer",
		reviewGroup: "specialist",
		phase: 1,
		promptRef: SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
		promptId: SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
		promptSha256: SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256,
		resolvedPrompt: SYSTEMS_INTERACTION_REVIEW_PROMPT,
	};
	const gate = { id: "implementation", name: "Implementation", dependsOn: [], verify: [systemsStep] };
	const signal = {
		id: signalId,
		goalId,
		gateId: gate.id,
		sessionId: "signal-owner",
		timestamp: Date.now(),
		commitSha: "a".repeat(40),
		verification: { status: "running", steps: [] as any[] },
	};
	let verification: any;
	let gateStatus = "pending";
	const gateStore = {
		getGate: () => ({ signals: [] }),
		updateSignalVerification: (_id: string, next: unknown) => { verification = next; },
		updateGateStatus: (_goalId: string, _gateId: string, next: string) => { gateStatus = next; },
	};
	const projectConfigStore = {
		get: (key: string) => key === "base_ref" ? "master" : "",
		getWithDefaults: () => ({ base_ref: "master" }),
		getComponents: () => [{ name: "app", repo: ".", commands: {} }],
	};
	const goal = { id: goalId, enabledOptionalSteps: [], workflowId: "systems-skip" };
	const projectContextManager = {
		getContextForGoal: (candidate: string) => candidate === goalId ? {
			project: { id: "systems-skip-project", name: "Systems skip project", rootPath: stateDir },
			goalStore: { get: () => goal },
			gateStore,
			projectConfigStore,
		} : undefined,
	};
	const gitCalls: string[][] = [];
	const commandRunner: CommandRunner = {
		execFile: async (_file, args) => {
			gitCalls.push([...args]);
			throw new Error("Systems snapshot Git must not run while LLM review is explicitly skipped");
		},
	};
	class TrackingLeaseCoordinator extends SystemsReviewWriterLeaseCoordinator {
		acquireCount = 0;
		override acquire(goal: string, owner: string) {
			this.acquireCount++;
			return super.acquire(goal, owner);
		}
	}
	const leases = new TrackingLeaseCoordinator();
	const harness = new VerificationHarness(
		stateDir,
		gateStore as any,
		() => undefined,
		{ get: () => undefined, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		projectConfigStore as any,
		projectContextManager as any,
		undefined,
		{ commandRunner, skipLlmReview: true, systemsReviewWriterLeases: leases },
	) as any;
	// Keep this assertion scoped to Systems precreation rather than the generic
	// primary/base-branch probes that precede every verification.
	harness.resolveVerificationBaseBranch = async () => "master";
	harness.resolveLegacyMasterBranch = async () => "master";
	signal.verification.steps = harness.beginVerification(signal, gate);

	try {
		await harness.verifyGateSignal(signal, gate, stateDir, undefined, "master", new Map(), "skip fixture");
		expect(gateStatus).toBe("passed");
		expect(verification).toMatchObject({
			status: "passed",
			steps: [{ status: "passed", output: expect.stringContaining("LLM review skipped") }],
		});
		expect(gitCalls).toEqual([]);
		expect(leases.acquireCount).toBe(0);
		expect(fs.existsSync(path.join(stateDir, "systems-review-executions.json"))).toBe(false);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
