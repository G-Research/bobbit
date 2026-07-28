// v2-native — command-phase final-mutator evidence authority and fail-closed contracts.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import {
	FINAL_MUTATION_TARGET_ACTIONS,
	FinalMutationTargetCommandEvidenceBroker,
	captureFinalMutationTarget,
	runWithFinalMutationTargetAction,
	type FinalMutationTargetCommandBinding,
} from "../../src/server/agent/systems-review-target-evidence.ts";

const SIGNING_KEY = Buffer.alloc(32, 0x5a);
const BASE_OID = "fedcba9876543210fedcba9876543210fedcba98";
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";

function binding(overrides: Partial<FinalMutationTargetCommandBinding> = {}): FinalMutationTargetCommandBinding {
	return {
		executionId: "systems-execution-1",
		commandId: "signal-1:0:app:integration:0123456789abcdef",
		testId: "registered-command:app:integration:0123456789abcdef",
		testKind: "integration",
		coverage: [{
			coverageItemId: "coverage-action-1",
			baseOid: BASE_OID,
			headOid: HEAD_OID,
			requiredActionIds: ["bobbit.goal.merge-child"],
			requiredAdapterIds: ["bobbit.git.merge-child"],
		}],
		...overrides,
	};
}

function broker(now: () => number = () => 1_700_000_000_000): FinalMutationTargetCommandEvidenceBroker {
	return new FinalMutationTargetCommandEvidenceBroker({ signingKey: SIGNING_KEY, now });
}

function tamper(token: string): string {
	const parts = token.split(".");
	parts[2] = `${parts[2][0] === "a" ? "b" : "a"}${parts[2].slice(1)}`;
	return parts.join(".");
}

describe("Systems review command evidence authority", () => {
	it("admits only immutable integration/browser bindings with production action and adapter provenance", () => {
		const authority = broker();
		const integration = authority.begin(binding());
		const browser = authority.begin(binding({
			commandId: "signal-1:1:app:browser:0123456789abcdef",
			testId: "registered-command:app:browser:0123456789abcdef",
			testKind: "browser",
		}));
		expect(Object.isFrozen(integration)).toBe(true);
		expect(Object.isFrozen(integration.capability)).toBe(true);
		expect(browser.correlationToken).not.toBe(integration.correlationToken);

		expect(() => authority.begin(binding({ testKind: "unit" as never }))).toThrow(/integration or browser/i);
		expect(() => authority.begin(binding({ coverage: [] }))).toThrow(/no immutable coverage binding/i);
		expect(() => authority.begin(binding({
			coverage: [{ ...binding().coverage[0], baseOid: "HEAD" }],
		}))).toThrow(/complete SHA-1 or SHA-256 object id/i);
		expect(() => authority.begin(binding({
			coverage: [{ ...binding().coverage[0], requiredActionIds: [] }],
		}))).toThrow(/production action provenance/i);
		expect(() => authority.begin(binding({
			coverage: [{ ...binding().coverage[0], requiredAdapterIds: [] }],
		}))).toThrow(/final adapter/i);
		expect(() => new FinalMutationTargetCommandEvidenceBroker({ signingKey: Buffer.alloc(8) }))
			.toThrow(/at least 32 bytes/i);
	});

	it("rejects missing, tampered, expired, foreign, and already-closed command correlations", async () => {
		let now = 10_000;
		const authority = broker(() => now);
		const run = authority.begin(binding({ ttlMs: 100 }));
		expect(() => authority.runWithCorrelation(undefined, () => undefined)).toThrow(/missing verification command correlation/i);
		expect(() => authority.runWithCorrelation(tamper(run.correlationToken), () => undefined)).toThrow(/signature/i);
		expect(() => broker(() => now).runWithCorrelation(run.correlationToken, () => undefined)).toThrow(/signature|closed or unknown/i);

		now = 10_101;
		expect(() => authority.runWithCorrelation(run.correlationToken, () => undefined)).toThrow(/expired/i);
		expect(() => authority.complete(run.capability, false)).toThrow(/unknown or closed/i);

		const closed = authority.begin(binding({
			commandId: "signal-2:0:app:integration:0123456789abcdef",
			testId: "registered-command:app:integration:fedcba9876543210",
		}));
		expect(authority.complete(closed.capability, false)).toEqual([]);
		expect(() => authority.complete(closed.capability, false)).toThrow(/unknown or closed/i);
		expect(() => authority.runWithCorrelation(closed.correlationToken, () => undefined)).toThrow(/closed or unknown/i);
	});

	it("requires production-owned action provenance and rejects caller-selected capture labels", async () => {
		const authority = broker();
		const run = authority.begin(binding());
		await authority.runWithCorrelation(run.correlationToken, async () => {
			expect(() => captureFinalMutationTarget({
				resolvedTarget: "C:/repo/api",
				resolvedScope: "branch:master",
				effectKind: "git-merge",
			})).toThrow(/lacks production action provenance/i);

			await expect(runWithFinalMutationTargetAction(
				{ id: "bobbit.goal.merge-child", adapterIds: ["bobbit.git.merge-child"] } as never,
				{ resolvedTarget: "C:/repo/api", resolvedScope: "branch:master" },
				async () => undefined,
			)).rejects.toThrow(/unregistered production action provenance/i);

			await expect(runWithFinalMutationTargetAction(
				FINAL_MUTATION_TARGET_ACTIONS.mergeChildGoal,
				{ resolvedTarget: "C:/repo/api", resolvedScope: "branch:master" },
				async () => captureFinalMutationTarget({
					actionId: "bobbit.goal.merge-child",
					coverageItemId: "coverage-action-1",
					resolvedTarget: "C:/repo/api",
					resolvedScope: "branch:master",
					effectKind: "git-merge",
				}),
			)).rejects.toThrow(/cannot supply caller-selected action or coverage labels/i);

			await expect(runWithFinalMutationTargetAction(
				FINAL_MUTATION_TARGET_ACTIONS.mergeChildGoal,
				{ resolvedTarget: "C:/repo/api", resolvedScope: "branch:master" },
				async () => captureFinalMutationTarget({
					resolvedTarget: "C:/repo/api",
					resolvedScope: "branch:master",
					effectKind: "git-merge",
				}),
			)).rejects.toThrow(/final adapter is not registered/i);
		});
		expect(authority.complete(run.capability, true)).toEqual([]);
	});

	it("never attests zero-capture, failed-action, or failed-command runs", async () => {
		const noCapture = broker();
		const noCaptureRun = noCapture.begin(binding());
		await noCapture.runWithCorrelation(noCaptureRun.correlationToken, () => runWithFinalMutationTargetAction(
			FINAL_MUTATION_TARGET_ACTIONS.mergeChildGoal,
			{ resolvedTarget: "C:/repo/api", resolvedScope: "branch:master" },
			async () => "effect returned without a final-adapter capture",
		));
		expect(noCapture.complete(noCaptureRun.capability, true)).toEqual([]);

		const failedAction = broker();
		const failedActionRun = failedAction.begin(binding());
		await expect(failedAction.runWithCorrelation(failedActionRun.correlationToken, () => runWithFinalMutationTargetAction(
			FINAL_MUTATION_TARGET_ACTIONS.mergeChildGoal,
			{ resolvedTarget: "C:/repo/api", resolvedScope: "branch:master" },
			async () => { throw new Error("production action failed"); },
		))).rejects.toThrow(/production action failed/i);
		expect(failedAction.complete(failedActionRun.capability, true)).toEqual([]);

		const failedCommand = broker();
		const failedCommandRun = failedCommand.begin(binding());
		expect(failedCommand.complete(failedCommandRun.capability, false)).toEqual([]);
	});

	it("is inert outside a harness command and exposes no caller-driven target-test runner", () => {
		expect(captureFinalMutationTarget({
			resolvedTarget: "C:/repo/api",
			resolvedScope: "branch:master",
			effectKind: "git-merge",
		})).toBeUndefined();

		const prototype = VerificationHarness.prototype as unknown as Record<string, unknown>;
		expect(prototype.runWithSystemsReviewTargetCorrelation).toBeTypeOf("function");
		expect(prototype).not.toHaveProperty("runRegisteredSystemsReviewTargetTest");
		expect(prototype).not.toHaveProperty("runRegisteredSystemsReviewTargetTestForSession");

		const harnessSource = fs.readFileSync(path.resolve("src/server/agent/verification-harness.ts"), "utf8");
		expect(harnessSource).not.toContain("runRegisteredSystemsReviewTargetTest");
		expect(harnessSource).not.toContain("RegisteredSystemsReviewTargetTestInput");
		expect(harnessSource).not.toContain("assertCapturedFinalMutationTarget");
		expect(harnessSource).toContain("preparedSystemsExecutionId && !expectFailure");
		const skippedCommandBranch = harnessSource.indexOf("else if (skipReason)");
		const evidenceBegin = harnessSource.indexOf("const targetEvidence = preparedSystemsExecutionId");
		expect(skippedCommandBranch).toBeGreaterThan(-1);
		expect(evidenceBegin).toBeGreaterThan(skippedCommandBranch);
	});
});
