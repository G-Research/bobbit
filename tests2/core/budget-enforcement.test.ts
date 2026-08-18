import { describe, expect, it } from "vitest";
import {
	resolveBudgetEnforcement,
	type BudgetEnforcementCandidate,
	type BudgetEnforcementRequest,
} from "../../src/server/agent/budget-enforcement.js";
import type { ResolvedHook } from "../../src/server/agent/extension-grant-policy.js";
import type { ExtensionGrant } from "../../src/server/agent/project-config-store.js";

const grantedAt = "2025-02-03T04:05:06.000Z";
const request: BudgetEnforcementRequest = {
	sessionId: "session-1",
	consumerId: "budget-consumer",
	operationId: "attempt-1",
	fallback: "halt",
};

function hook(packId: string, hookId: string, priority?: number): ResolvedHook {
	return { packId, hookId, mode: "decide", capabilities: [], ...(priority === undefined ? {} : { priority }) };
}

function grant(packId: string, hookId: string): ExtensionGrant {
	return { packId, hookId, capability: "decide", grantedAt, grantedBy: "admin" };
}

function candidate(packId: string, hookId: string, disposition: string, ruleId = "rule-1", reasonId?: string): BudgetEnforcementCandidate {
	return {
		source: { packId, hookId },
		proposal: { disposition, ruleId, ...(reasonId === undefined ? {} : { reasonId }) },
	};
}

describe("budget enforcement", () => {
	it("requires an explicit valid fallback and never allows malformed silence", () => {
		expect(resolveBudgetEnforcement(request, [], [], [])).toMatchObject({
			disposition: "halt", permitsOperation: false, audit: { grantDenied: 0, malformed: 0 },
		});
		expect(resolveBudgetEnforcement({ ...request, fallback: "allow" }, [], [], [])).toMatchObject({
			disposition: "allow", permitsOperation: true,
		});
		expect(resolveBudgetEnforcement({ ...request, fallback: "unknown" as never }, [], [], [])).toEqual({
			disposition: "halt", permitsOperation: false, consent: "not-required",
			audit: { disposition: "halt", grantDenied: 0, malformed: 1 },
		});
		expect(resolveBudgetEnforcement({ ...request, consumerId: "../../unsafe" }, [], [], [])).toMatchObject({
			disposition: "halt", permitsOperation: false, audit: { malformed: 1 },
		});
	});

	it("re-evaluates exact decide grants and rejects inactive, revoked, and malformed candidates", () => {
		const active = [hook("pack-a", "hook-a")];
		const proposal = candidate("pack-a", "hook-a", "allow");
		expect(resolveBudgetEnforcement(request, active, [], [proposal])).toMatchObject({
			disposition: "halt", audit: { grantDenied: 1, malformed: 0 },
		});
		expect(resolveBudgetEnforcement(request, [], [grant("pack-a", "hook-a")], [proposal])).toMatchObject({
			disposition: "halt", audit: { grantDenied: 1, malformed: 0 },
		});
		expect(resolveBudgetEnforcement(request, active, [grant("pack-a", "hook-a")], [
			{ source: { packId: "pack-a", hookId: "hook-a" }, proposal: { disposition: "allow", ruleId: "../../secret", explanation: "TOKEN=raw-secret" } },
			{ source: { packId: "../pack", hookId: "hook-a" }, proposal: { disposition: "allow", ruleId: "rule" } },
			{ source: { packId: "pack-a", hookId: "hook-a" }, proposal: { disposition: "deny", ruleId: "rule" } },
			{ source: { packId: "pack-a", hookId: "hook-a" }, proposal: { disposition: "allow", ruleId: "rule", reasonId: "raw reason" } },
		] as BudgetEnforcementCandidate[])).toMatchObject({
			disposition: "halt", audit: { grantDenied: 0, malformed: 4 },
		});
	});

	it("selects the most restrictive authorized proposal and makes pause and halt non-permissive", () => {
		const active = [hook("pack-a", "hook-a"), hook("pack-b", "hook-b"), hook("pack-c", "hook-c")];
		const grants = active.map(({ packId, hookId }) => grant(packId, hookId));
		const resolved = resolveBudgetEnforcement(request, active, grants, [
			candidate("pack-a", "hook-a", "allow"),
			candidate("pack-b", "hook-b", "warn"),
			candidate("pack-c", "hook-c", "pause"),
			candidate("pack-a", "hook-a", "halt", "hard-stop"),
		]);
		expect(resolved).toEqual({
			disposition: "halt", permitsOperation: false, consent: "not-required",
			audit: { hookId: "hook-a", disposition: "halt", ruleId: "hard-stop", grantDenied: 0, malformed: 0 },
		});
		expect(resolveBudgetEnforcement(request, active, grants, [candidate("pack-c", "hook-c", "pause")]).permitsOperation).toBe(false);
		expect(resolveBudgetEnforcement(request, active, grants, [candidate("pack-b", "hook-b", "warn")]).permitsOperation).toBe(true);
	});

	it("uses configured pack priority then stable lexical attribution for equal dispositions", () => {
		const active = [hook("pack-z", "hook-z", 1), hook("pack-a", "hook-b", 4), hook("pack-a", "hook-a", 4)];
		const grants = active.map(({ packId, hookId }) => grant(packId, hookId));
		const resolved = resolveBudgetEnforcement(request, active, grants, [
			candidate("pack-z", "hook-z", "warn", "first"),
			candidate("pack-a", "hook-b", "warn", "alpha"),
			candidate("pack-a", "hook-a", "warn", "z-rule", "later"),
			candidate("pack-a", "hook-a", "warn", "a-rule"),
		]);
		expect(resolved.audit).toMatchObject({ hookId: "hook-a", ruleId: "a-rule" });
		const orderedActive = [hook("pack-low", "low"), hook("pack-high", "high")];
		const orderedGrants = orderedActive.map(({ packId, hookId }) => grant(packId, hookId));
		expect(resolveBudgetEnforcement(request, orderedActive, orderedGrants, [
			candidate("pack-low", "low", "warn", "low-rule"),
			candidate("pack-high", "high", "warn", "high-rule"),
		]).audit).toMatchObject({ hookId: "high", ruleId: "high-rule" });
	});

	it("classifies hard-cap overrides without importing consent and returns immutable secret-free metadata", () => {
		const rawSecret = "api-key=never-persist-this";
		const resolved = resolveBudgetEnforcement(
			{ ...request, hardCapOverride: "core-hard-cap" },
			[hook("pack-a", "hook-a")],
			[grant("pack-a", "hook-a")],
			[{ source: { packId: "pack-a", hookId: "hook-a", extra: rawSecret } as never, proposal: { disposition: "allow", ruleId: "rule-a", reasonId: "reason-a", rawSecret } }],
		);
		expect(resolved).toEqual({
			disposition: "allow", permitsOperation: true, consent: "hard-cap-override",
			audit: { hookId: "hook-a", disposition: "allow", ruleId: "rule-a", reasonId: "reason-a", grantDenied: 0, malformed: 0 },
		});
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.audit)).toBe(true);
		expect(JSON.stringify(resolved)).not.toContain(rawSecret);
		expect(() => { (resolved.audit as any).ruleId = "changed"; }).toThrow();
	});
});
