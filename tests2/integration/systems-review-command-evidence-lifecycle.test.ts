// v2-native — accepted command evidence through the normal implementation-gate lifecycle.

import fs from "node:fs";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import { SystemsReviewExecutionStore } from "../../src/server/agent/systems-review-store.ts";
import type { SystemsReviewCoverageReadRecord } from "../../src/server/agent/systems-review-types.ts";
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
