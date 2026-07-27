// v2-native — trusted exact final-mutator target evidence coverage.

import { describe, expect, it } from "vitest";

import {
	FINAL_MUTATION_TARGET_CORRELATION_HEADER,
	FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY,
	acceptSignedFinalMutationTargetRecord,
	assertCapturedFinalMutationTarget,
	attachFinalMutationTargetQueueEnvelope,
	captureFinalMutationTarget,
	consumeFinalMutationTargetAssertion,
	createFinalMutationTargetCorrelationHeaders,
	createFinalMutationTargetCorrelationToken,
	createFinalMutationTargetEvidenceCapability,
	runWithFinalMutationTargetCorrelationToken,
	runWithFinalMutationTargetEvidenceCapability,
	runWithFinalMutationTargetQueueEnvelope,
	verifyFinalMutationTargetAssertion,
	type CreateFinalMutationTargetEvidenceCapabilityOptions,
	type FinalMutationTargetEvidenceCapability,
} from "../../src/server/agent/systems-review-target-evidence.ts";

const SIGNING_KEY = Buffer.alloc(32, 0x5a);
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function options(
	overrides: Partial<CreateFinalMutationTargetEvidenceCapabilityOptions> = {},
): CreateFinalMutationTargetEvidenceCapabilityOptions {
	return {
		executionId: "systems-execution-1",
		testKind: "integration",
		testIdentity: "tests2/integration/aggregate-action.test.ts > targets component repo",
		commandId: "npm run test:integration -- aggregate-action",
		actionId: "aggregate-delete",
		coverageItemId: "coverage-action-1",
		headOids: [{ repoId: "api", headOid: HEAD }],
		signingKey: SIGNING_KEY,
		...overrides,
	};
}

function capture(target = "C:/repo/api", scope = "component:api"): void {
	captureFinalMutationTarget({
		actionId: "aggregate-delete",
		coverageItemId: "coverage-action-1",
		resolvedTarget: target,
		resolvedScope: scope,
		effectKind: "git-delete-branch",
	});
}

async function withCapability<T>(
	capability: FinalMutationTargetEvidenceCapability,
	callback: () => T | PromiseLike<T>,
): Promise<T> {
	return await runWithFinalMutationTargetEvidenceCapability(capability, callback);
}

describe("trusted final-mutator target evidence", () => {
	it("accepts a successful integration action only when every attempted effect matches exact target and scope", async () => {
		const capability = createFinalMutationTargetEvidenceCapability(options());
		const assertion = await withCapability(capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => {
				capture();
				capture(); // retry: every attempted effect must agree
			},
		}));

		expect(assertion.payload.binding.testKind).toBe("integration");
		expect(assertion.payload.binding.headOids).toEqual([{ repoId: "api", headOid: HEAD }]);
		expect(assertion.payload.records).toHaveLength(2);
		expect(assertion.payload.records.every((record) => record.effectOutcome === "attempted")).toBe(true);
		expect(assertion.payload.records.every((record) => record.adapterSource.length > 0)).toBe(true);
		expect(assertion.payload.effectOutcome).toBe("invoke-succeeded");
		expect(verifyFinalMutationTargetAssertion(capability, assertion.token)).toEqual(assertion.payload);
		expect(consumeFinalMutationTargetAssertion(capability, assertion.token)).toEqual(assertion.payload);
		expect(() => consumeFinalMutationTargetAssertion(capability, assertion.token)).toThrow(/already consumed/i);
	});

	it("fails closed for missing capture, target/scope mismatch, or any mismatched retry", async () => {
		for (const scenario of [
			async () => undefined,
			async () => capture("C:/repo/wrong"),
			async () => capture("C:/repo/api", "project-root"),
			async () => { capture(); capture("C:/repo/wrong"); },
		]) {
			const capability = createFinalMutationTargetEvidenceCapability(options());
			await expect(withCapability(capability, () => assertCapturedFinalMutationTarget({
				actionId: "aggregate-delete",
				expectedTarget: "C:/repo/api",
				expectedScope: "component:api",
				invoke: scenario,
			}))).rejects.toThrow(/capture|target mismatch|scope mismatch/i);
		}
	});

	it("does not let the assertion helper submit actual values and records only final-adapter captures", async () => {
		const capability = createFinalMutationTargetEvidenceCapability(options());
		const forgedInput = {
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			actualTarget: "C:/repo/api",
			actualScope: "component:api",
			invoke: async () => undefined,
		};
		await expect(withCapability(capability, () => assertCapturedFinalMutationTarget(forgedInput)))
			.rejects.toThrow(/no final-effect capture/i);
	});

	it("rejects unit evidence, failed commands, action/coverage mismatch, weak keys, and malformed head bindings", async () => {
		expect(() => createFinalMutationTargetEvidenceCapability(options({ testKind: "unit" as never })))
			.toThrow(/integration or browser/i);
		expect(() => createFinalMutationTargetEvidenceCapability(options({ signingKey: Buffer.alloc(8) })))
			.toThrow(/at least 32 bytes/i);
		expect(() => createFinalMutationTargetEvidenceCapability(options({
			headOids: [{ repoId: "api", headOid: "HEAD" }],
		}))).toThrow(/full Git object ID/i);

		const capability = createFinalMutationTargetEvidenceCapability(options());
		await expect(withCapability(capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => { throw new Error("registered command failed"); },
		}))).rejects.toThrow(/invocation failed/i);

		await expect(withCapability(capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => captureFinalMutationTarget({
				actionId: "another-action",
				coverageItemId: "coverage-action-1",
				resolvedTarget: "C:/repo/api",
				resolvedScope: "component:api",
				effectKind: "git-delete-branch",
			}),
		}))).rejects.toThrow(/action or coverage item/i);
	});

	it("preserves signed correlation through serialized queue workers", async () => {
		let origin!: FinalMutationTargetEvidenceCapability;
		origin = createFinalMutationTargetEvidenceCapability(options());
		const worker = createFinalMutationTargetEvidenceCapability(options({
			externalRecordSink: (token) => { acceptSignedFinalMutationTargetRecord(origin, token); },
		}));

		const assertion = await withCapability(origin, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => {
				const serialized = JSON.parse(JSON.stringify(attachFinalMutationTargetQueueEnvelope({ jobId: "job-1" })));
				expect(serialized[FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY]).toBeDefined();
				await runWithFinalMutationTargetQueueEnvelope(worker, serialized, async () => capture());
			},
		}));
		expect(assertion.payload.records).toHaveLength(1);
		expect(assertion.payload.records[0].resolvedTarget).toBe("C:/repo/api");
	});

	it("preserves opaque signed correlation across browser/process boundaries", async () => {
		let origin!: FinalMutationTargetEvidenceCapability;
		origin = createFinalMutationTargetEvidenceCapability(options({ testKind: "browser" }));
		const remote = createFinalMutationTargetEvidenceCapability(options({
			testKind: "browser",
			externalRecordSink: (token) => { acceptSignedFinalMutationTargetRecord(origin, token); },
		}));

		const assertion = await withCapability(origin, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => {
				const headers = createFinalMutationTargetCorrelationHeaders();
				const token = headers[FINAL_MUTATION_TARGET_CORRELATION_HEADER];
				expect(token).toBeTypeOf("string");
				await runWithFinalMutationTargetCorrelationToken(remote, token, "cross-process", async () => capture());
			},
		}));
		expect(assertion.payload.binding.testKind).toBe("browser");
		expect(assertion.payload.records).toHaveLength(1);
	});

	it("rejects tampered, wrong-channel, and binding-mismatched correlation", async () => {
		const origin = createFinalMutationTargetEvidenceCapability(options());
		const wrongBinding = createFinalMutationTargetEvidenceCapability(options({ coverageItemId: "other-coverage" }));
		await withCapability(origin, async () => {
			const token = createFinalMutationTargetCorrelationToken();
			expect(token).toBeTypeOf("string");
			await expect(runWithFinalMutationTargetCorrelationToken(origin, `${token.slice(0, -1)}x`, "cross-process", async () => undefined))
				.rejects.toThrow(/signature|token/i);
			await expect(runWithFinalMutationTargetCorrelationToken(origin, token, "queue", async () => undefined))
				.rejects.toThrow(/Expected queue/i);
			await expect(runWithFinalMutationTargetCorrelationToken(wrongBinding, token, "cross-process", async () => undefined))
				.rejects.toThrow(/binding/i);
		});
	});

	it("is a production-safe no-op without harness correlation and protects the reserved queue field", () => {
		expect(() => capture()).not.toThrow();
		expect(createFinalMutationTargetCorrelationToken()).toBeUndefined();
		expect(createFinalMutationTargetCorrelationHeaders()).toEqual({});
		expect(() => attachFinalMutationTargetQueueEnvelope({
			[FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY]: { forged: true },
		})).toThrow(/reserved field/i);
	});
});
