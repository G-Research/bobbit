// v2-native — trusted exact final-mutator target evidence coverage.

import { describe, expect, it } from "vitest";

import {
	FINAL_MUTATION_TARGET_CORRELATION_HEADER,
	FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY,
	FinalMutationTargetAssertionRegistry,
	FinalMutationTargetEvidenceBroker,
	assertCapturedFinalMutationTarget,
	attachFinalMutationTargetQueueEnvelope,
	captureFinalMutationTarget,
	consumeFinalMutationTargetAssertion,
	createFinalMutationTargetEvidenceCapability,
	mintFinalMutationTargetCrossProcessToken,
	runWithFinalMutationTargetCrossProcessToken,
	runWithFinalMutationTargetEvidenceCapability,
	runWithFinalMutationTargetQueueEnvelope,
	type FinalMutationTargetAssertionExpectation,
	type FinalMutationTargetEvidenceBinding,
	type FinalMutationTargetEvidenceBrokerOptions,
	type FinalMutationTargetEvidenceCapability,
} from "../../src/server/agent/systems-review-target-evidence.ts";

const SIGNING_KEY = Buffer.alloc(32, 0x5a);
const BASE_OID = "fedcba9876543210fedcba9876543210fedcba98";
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";

function binding(
	overrides: Partial<FinalMutationTargetEvidenceBinding> = {},
): FinalMutationTargetEvidenceBinding {
	return {
		executionId: "systems-execution-1",
		testKind: "integration",
		testId: "tests2/integration/aggregate-action.test.ts > targets component repo",
		commandId: "test:integration:aggregate-action",
		baseOid: BASE_OID,
		headOid: HEAD_OID,
		actionId: "aggregate-delete",
		coverageItemId: "coverage-action-1",
		...overrides,
	};
}

function isRegisteredTestRuntimeAdapterSource(source: string): boolean {
	// The stack walker must skip the evidence substrate itself and attribute the
	// record to the actual adapter. This test-only predicate intentionally accepts
	// only this helper; production harness validation uses its own closed allowlist.
	return source.startsWith("registeredFinalMutationAdapter (")
		&& source.replace(/\\/g, "/").includes("/tests2/core/systems-review-target-evidence.test.ts:");
}

function expectation(
	value: FinalMutationTargetEvidenceBinding,
	overrides: Partial<FinalMutationTargetAssertionExpectation> = {},
): FinalMutationTargetAssertionExpectation {
	return {
		executionId: value.executionId,
		testKind: value.testKind,
		testId: value.testId,
		commandId: value.commandId,
		baseOid: value.baseOid,
		headOid: value.headOid,
		actionId: value.actionId,
		coverageItemId: value.coverageItemId,
		isRegisteredFinalAdapterSource: isRegisteredTestRuntimeAdapterSource,
		...overrides,
	};
}

function harness(
	bindingOverrides: Partial<FinalMutationTargetEvidenceBinding> = {},
	brokerOptions: FinalMutationTargetEvidenceBrokerOptions = {},
): {
	broker: FinalMutationTargetEvidenceBroker;
	capability: FinalMutationTargetEvidenceCapability;
	binding: FinalMutationTargetEvidenceBinding;
} {
	const broker = new FinalMutationTargetEvidenceBroker({ signingKey: SIGNING_KEY, ...brokerOptions });
	const evidenceBinding = binding(bindingOverrides);
	return {
		broker,
		capability: createFinalMutationTargetEvidenceCapability(broker, evidenceBinding),
		binding: evidenceBinding,
	};
}

function registeredFinalMutationAdapter(
	target = "C:/repo/api",
	scope = "component:api",
	actionId = "aggregate-delete",
	coverageItemId = "coverage-action-1",
): void {
	captureFinalMutationTarget({
		actionId,
		coverageItemId,
		resolvedTarget: target,
		resolvedScope: scope,
		effectKind: "git-delete-branch",
	});
}

function captureThroughSerializedQueue(
	broker: FinalMutationTargetEvidenceBroker,
	target = "C:/repo/api",
	scope = "component:api",
	actionId = "aggregate-delete",
	coverageItemId = "coverage-action-1",
): void {
	const queued = attachFinalMutationTargetQueueEnvelope({ jobId: "job-1" });
	const serialized = JSON.parse(JSON.stringify(queued)) as Record<string, unknown>;
	const envelope = serialized[FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY];
	runWithFinalMutationTargetQueueEnvelope(broker, envelope, () => {
		registeredFinalMutationAdapter(target, scope, actionId, coverageItemId);
	});
}

async function withCapability<T>(
	broker: FinalMutationTargetEvidenceBroker,
	capability: FinalMutationTargetEvidenceCapability,
	callback: () => T | Promise<T>,
): Promise<T> {
	return await runWithFinalMutationTargetEvidenceCapability(broker, capability, callback);
}

describe("trusted final-mutator target evidence", () => {
	it("accepts a successful integration action only when every attempted effect matches exact target and scope", async () => {
		const context = harness();
		const assertion = await withCapability(context.broker, context.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => {
				captureThroughSerializedQueue(context.broker);
				captureThroughSerializedQueue(context.broker); // retry: every attempted effect must agree
				return "effect-complete";
			},
		}));

		expect(assertion.value).toBe("effect-complete");
		expect(assertion.evidence.testKind).toBe("integration");
		expect(assertion.evidence.baseOid).toBe(BASE_OID);
		expect(assertion.evidence.headOid).toBe(HEAD_OID);
		expect(assertion.evidence.attempts).toHaveLength(2);
		expect(assertion.evidence.attempts.map(attempt => attempt.attempt)).toEqual([1, 2]);
		expect(assertion.evidence.attempts.every(attempt => attempt.effectKind === "git-delete-branch")).toBe(true);
		expect(
			assertion.evidence.attempts.every(attempt => isRegisteredTestRuntimeAdapterSource(attempt.adapterSource)),
			JSON.stringify(assertion.evidence.attempts.map(attempt => attempt.adapterSource)),
		).toBe(true);
		expect(assertion.evidence.effectOutcome).toBe("succeeded");
		expect(Object.isFrozen(assertion.evidence)).toBe(true);

		expect(consumeFinalMutationTargetAssertion(
			context.broker,
			assertion.assertionToken,
			expectation(context.binding),
		)).toEqual(assertion.evidence);
		expect(() => consumeFinalMutationTargetAssertion(
			context.broker,
			assertion.assertionToken,
			expectation(context.binding),
		)).toThrow(/already consumed/i);
	});

	it("fails closed for zero captures, target or scope mismatch, and any mismatched retry", async () => {
		const scenarios: Array<{
			invoke: (broker: FinalMutationTargetEvidenceBroker) => void | Promise<void>;
			error: RegExp;
		}> = [
			{ invoke: async () => undefined, error: /without a capture/i },
			{ invoke: broker => captureThroughSerializedQueue(broker, "C:/repo/wrong"), error: /target did not match/i },
			{ invoke: broker => captureThroughSerializedQueue(broker, "C:/repo/api", "project-root"), error: /scope did not match/i },
			{
				invoke: broker => {
					captureThroughSerializedQueue(broker);
					captureThroughSerializedQueue(broker, "C:/repo/wrong");
				},
				error: /target did not match on attempt 2/i,
			},
		];

		for (const scenario of scenarios) {
			const context = harness();
			await expect(withCapability(context.broker, context.capability, () => assertCapturedFinalMutationTarget({
				actionId: "aggregate-delete",
				expectedTarget: "C:/repo/api",
				expectedScope: "component:api",
				invoke: () => scenario.invoke(context.broker),
			}))).rejects.toThrow(scenario.error);
		}
	});

	it("does not accept caller-supplied actual values or a route-level capture that skipped signed transport", async () => {
		const forged = harness();
		const forgedInput = {
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			actualTarget: "C:/repo/api",
			actualScope: "component:api",
			invoke: async () => undefined,
		};
		await expect(withCapability(forged.broker, forged.capability, () => assertCapturedFinalMutationTarget(forgedInput)))
			.rejects.toThrow(/without a capture/i);

		const routeOnly = harness();
		await expect(withCapability(routeOnly.broker, routeOnly.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => registeredFinalMutationAdapter(),
		}))).rejects.toThrow(/did not cross a signed queue or process boundary/i);
	});

	it("rejects unit evidence, failed commands, invalid bindings, and action or coverage mismatches", async () => {
		const broker = new FinalMutationTargetEvidenceBroker({ signingKey: SIGNING_KEY });
		expect(() => createFinalMutationTargetEvidenceCapability(broker, binding({ testKind: "unit" as never })))
			.toThrow(/integration or browser/i);
		expect(() => new FinalMutationTargetEvidenceBroker({ signingKey: Buffer.alloc(8) }))
			.toThrow(/at least 32 bytes/i);
		expect(() => createFinalMutationTargetEvidenceCapability(broker, binding({ headOid: "HEAD" })))
			.toThrow(/complete SHA-1 or SHA-256 object id/i);

		const failedCommand = harness();
		await expect(withCapability(failedCommand.broker, failedCommand.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => { throw new Error("registered command failed"); },
		}))).rejects.toThrow(/registered command failed/i);

		const wrongAction = harness();
		await expect(withCapability(wrongAction.broker, wrongAction.capability, () => assertCapturedFinalMutationTarget({
			actionId: "another-action",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => undefined,
		}))).rejects.toThrow(/actionId does not match/i);

		const wrongCoverage = harness();
		await expect(withCapability(wrongCoverage.broker, wrongCoverage.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: () => captureThroughSerializedQueue(
				wrongCoverage.broker,
				"C:/repo/api",
				"component:api",
				"aggregate-delete",
				"another-coverage-item",
			),
		}))).rejects.toThrow(/action or coverage item did not match/i);
	});

	it("binds consumption to the registered run and rejects unregistered adapters before one-time consumption", async () => {
		const context = harness();
		const assertion = await withCapability(context.broker, context.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: () => captureThroughSerializedQueue(context.broker),
		}));

		expect(() => consumeFinalMutationTargetAssertion(
			context.broker,
			assertion.assertionToken,
			expectation(context.binding, { isRegisteredFinalAdapterSource: () => false }),
		)).toThrow(/registered final production adapter/i);

		const mismatches: Array<Partial<FinalMutationTargetAssertionExpectation>> = [
			{ executionId: "another-execution" },
			{ commandId: "another-command" },
			{ testId: "another-test" },
			{ testKind: "browser" },
			{ baseOid: "a".repeat(40) },
			{ headOid: "b".repeat(40) },
			{ actionId: "another-action" },
			{ coverageItemId: "another-coverage" },
		];
		for (const mismatch of mismatches) {
			expect(() => consumeFinalMutationTargetAssertion(
				context.broker,
				assertion.assertionToken,
				expectation(context.binding, mismatch),
			)).toThrow(/did not match the registered run/i);
		}

		expect(consumeFinalMutationTargetAssertion(
			context.broker,
			assertion.assertionToken,
			expectation(context.binding),
		)).toEqual(assertion.evidence);
	});

	it("registers opaque assertion ids and permits only identical replay-safe finalization", async () => {
		const context = harness();
		const assertion = await withCapability(context.broker, context.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: () => captureThroughSerializedQueue(context.broker),
		}));
		const registry = new FinalMutationTargetAssertionRegistry(
			context.broker,
			isRegisteredTestRuntimeAdapterSource,
			() => 123,
			() => "server-generated-id",
		);
		const registered = registry.register(assertion);
		expect(registered.assertionId).toBe("target-assertion:server-generated-id");
		const expected = {
			executionId: context.binding.executionId,
			baseOid: context.binding.baseOid,
			headOid: context.binding.headOid,
			actionId: context.binding.actionId,
			coverageItemId: context.binding.coverageItemId,
		};
		expect(registry.validateAndConsume(registered.assertionId, expected)).toBe(true);
		expect(registry.validateAndConsume(registered.assertionId, expected)).toBe(true);
		expect(registry.validateAndConsume(registered.assertionId, { ...expected, actionId: "different-action" })).toBe(false);
	});

	it("preserves signed correlation through serialized queue workers and fails closed for lost or forged envelopes", async () => {
		const context = harness();
		const assertion = await withCapability(context.broker, context.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: () => captureThroughSerializedQueue(context.broker),
		}));
		expect(assertion.evidence.attempts).toHaveLength(1);
		expect(assertion.evidence.attempts[0].resolvedTarget).toBe("C:/repo/api");

		const lost = harness();
		await expect(withCapability(lost.broker, lost.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: () => runWithFinalMutationTargetQueueEnvelope(lost.broker, undefined, () => registeredFinalMutationAdapter()),
		}))).rejects.toThrow(/malformed final mutation queue envelope/i);

		const forged = harness();
		await expect(withCapability(forged.broker, forged.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: () => runWithFinalMutationTargetQueueEnvelope(forged.broker, {
				version: "bobbit:final-mutation-target/v1",
				token: "attacker-controlled",
			}, () => registeredFinalMutationAdapter()),
		}))).rejects.toThrow(/malformed|signature|token/i);
	});

	it("preserves opaque signed correlation across browser/process boundaries", async () => {
		const context = harness({ testKind: "browser" });
		const assertion = await withCapability(context.broker, context.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => {
				const headers = {
					[FINAL_MUTATION_TARGET_CORRELATION_HEADER]: mintFinalMutationTargetCrossProcessToken(),
				};
				expect(headers[FINAL_MUTATION_TARGET_CORRELATION_HEADER]).toBeTypeOf("string");
				await runWithFinalMutationTargetCrossProcessToken(
					context.broker,
					headers[FINAL_MUTATION_TARGET_CORRELATION_HEADER],
					async () => registeredFinalMutationAdapter(),
				);
			},
		}));
		expect(assertion.evidence.testKind).toBe("browser");
		expect(assertion.evidence.attempts).toHaveLength(1);
	});

	it("rejects tampered, wrong-channel, and foreign-broker correlation tokens", async () => {
		const context = harness();
		const foreignBroker = new FinalMutationTargetEvidenceBroker({ signingKey: SIGNING_KEY });
		const assertion = await withCapability(context.broker, context.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: async () => {
				const token = mintFinalMutationTargetCrossProcessToken();
				expect(token).toBeTypeOf("string");
				const opaqueToken = token as string;
				const tampered = `${opaqueToken.slice(0, -1)}${opaqueToken.endsWith("a") ? "b" : "a"}`;
				expect(() => runWithFinalMutationTargetCrossProcessToken(
					context.broker,
					tampered,
					() => undefined,
				)).toThrow(/signature|token/i);

				const queued = attachFinalMutationTargetQueueEnvelope({ jobId: "job-1" });
				const queueToken = queued[FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY]?.token;
				expect(() => runWithFinalMutationTargetCrossProcessToken(
					context.broker,
					queueToken,
					() => undefined,
				)).toThrow(/audience mismatch/i);

				expect(() => runWithFinalMutationTargetCrossProcessToken(
					foreignBroker,
					opaqueToken,
					() => undefined,
				)).toThrow(/active capability/i);

				await runWithFinalMutationTargetCrossProcessToken(
					context.broker,
					opaqueToken,
					async () => registeredFinalMutationAdapter(),
				);
			},
		}));
		expect(assertion.evidence.attempts).toHaveLength(1);

		const tamperedAssertion = `${assertion.assertionToken.slice(0, -1)}${assertion.assertionToken.endsWith("a") ? "b" : "a"}`;
		expect(() => consumeFinalMutationTargetAssertion(
			context.broker,
			tamperedAssertion,
			expectation(context.binding),
		)).toThrow(/signature|token/i);
	});

	it("is a production-safe no-op without harness correlation and protects the reserved queue field when active", async () => {
		expect(registeredFinalMutationAdapter()).toBeUndefined();
		expect(mintFinalMutationTargetCrossProcessToken()).toBeUndefined();
		const payload = { jobId: "ordinary-job" };
		expect(attachFinalMutationTargetQueueEnvelope(payload)).toBe(payload);
		const ordinaryReservedPayload = {
			[FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY]: { applicationOwned: true },
		};
		expect(attachFinalMutationTargetQueueEnvelope(ordinaryReservedPayload)).toBe(ordinaryReservedPayload);

		const context = harness();
		await expect(withCapability(context.broker, context.capability, () => assertCapturedFinalMutationTarget({
			actionId: "aggregate-delete",
			expectedTarget: "C:/repo/api",
			expectedScope: "component:api",
			invoke: () => attachFinalMutationTargetQueueEnvelope({
				[FINAL_MUTATION_TARGET_QUEUE_ENVELOPE_KEY]: { forged: true },
			}),
		}))).rejects.toThrow(/reserved key/i);
	});
});
