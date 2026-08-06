import { describe, expect, it } from "vitest";
import {
	admitAdvisorySelection,
	createAdvisorySelectionCandidate,
	reduceAdvisorySelectionCandidates,
	snapshotAdvisorySelectionAvailability,
	validateAdvisorySelectionProposal,
} from "../../src/server/agent/advisory-selection-contract.ts";

const availability = {
	models: [
		{ provider: "openai", modelId: "gpt-5.2" },
		{ provider: "anthropic", modelId: "claude-opus-4-6" },
	],
	thinkingLevels: ["off", "low", "high"],
	roles: ["coder", "reviewer"],
	workflows: ["default", "release"],
};

function candidate(packId: string, hookId: string, priority: number, selection: unknown): unknown {
	return { source: { packId, hookId }, priority, selection };
}

describe("advisory selection contract", () => {
	it("strictly validates the closed discriminated selection union", () => {
		expect(validateAdvisorySelectionProposal({ kind: "model", provider: "openai", modelId: "gpt-5.2" })).toEqual({
			kind: "model", provider: "openai", modelId: "gpt-5.2",
		});
		expect(validateAdvisorySelectionProposal({ kind: "thinking", thinkingLevel: " high " })).toEqual({ kind: "thinking", thinkingLevel: "high" });
		expect(validateAdvisorySelectionProposal({ kind: "role", roleName: "coder" })).toEqual({ kind: "role", roleName: "coder" });
		expect(validateAdvisorySelectionProposal({ kind: "workflow", workflowId: "release" })).toEqual({ kind: "workflow", workflowId: "release" });
		for (const value of [
			{ kind: "model", provider: "openai", modelId: "gpt-5.2", priority: 10 },
			{ kind: "thinking", thinkingLevel: "HIGH" },
			{ kind: "role", roleName: "not safe" },
			{ kind: "workflow", workflowId: "release", callback: "apply" },
			{ kind: "other", value: "free-form" },
		]) expect(() => validateAdvisorySelectionProposal(value)).toThrow();
	});

	it("uses exact host availability membership and returns immutable copies", () => {
		const snapshot = snapshotAdvisorySelectionAvailability({
			...availability,
			models: [...availability.models, availability.models[0]],
			roles: ["reviewer", "coder", "coder", "not safe"],
			thinkingLevels: ["high", "HIGH", "low", "off"],
		});
		expect(snapshot).toEqual({
			models: [
				{ provider: "anthropic", modelId: "claude-opus-4-6" },
				{ provider: "openai", modelId: "gpt-5.2" },
			],
			thinkingLevels: ["off", "low", "high"],
			roles: ["coder", "reviewer"],
			workflows: ["default", "release"],
		});
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.models)).toBe(true);
		expect(Object.isFrozen(snapshot.models[0])).toBe(true);

		const proposed = validateAdvisorySelectionProposal({ kind: "model", provider: "openai", modelId: "gpt-5.2" });
		const accepted = admitAdvisorySelection(proposed, availability);
		expect(accepted).toEqual(proposed);
		expect(accepted).not.toBe(proposed);
		expect(Object.isFrozen(accepted)).toBe(true);
		expect(admitAdvisorySelection(validateAdvisorySelectionProposal({ kind: "model", provider: "openai", modelId: "gpt-5.3" }), availability)).toBeUndefined();
		expect(admitAdvisorySelection(validateAdvisorySelectionProposal({ kind: "thinking", thinkingLevel: "medium" }), availability)).toBeUndefined();
		expect(admitAdvisorySelection(validateAdvisorySelectionProposal({ kind: "role", roleName: "operator" }), availability)).toBeUndefined();
		expect(admitAdvisorySelection(validateAdvisorySelectionProposal({ kind: "workflow", workflowId: "hidden" }), availability)).toBeUndefined();
	});

	it("defensively copies only server-provenanced candidates", () => {
		const accepted = createAdvisorySelectionCandidate(candidate("pack-a", "hook-a", 1, { kind: "role", roleName: "coder" }));
		expect(accepted).toEqual({ source: { packId: "pack-a", hookId: "hook-a" }, priority: 1, selection: { kind: "role", roleName: "coder" } });
		expect(Object.isFrozen(accepted)).toBe(true);
		expect(Object.isFrozen(accepted?.source)).toBe(true);
		expect(Object.isFrozen(accepted?.selection)).toBe(true);
		expect(createAdvisorySelectionCandidate(candidate("pack-a", "hook-a", -1, { kind: "role", roleName: "coder" }))).toBeUndefined();
		expect(createAdvisorySelectionCandidate(candidate("../pack", "hook-a", 1, { kind: "role", roleName: "coder" }))).toBeUndefined();
		expect(createAdvisorySelectionCandidate(candidate("pack-a", "hook-a", 1, { kind: "role", roleName: "coder", score: 1 }))).toBeUndefined();
	});

	it("reduces each selection kind by priority, then lexical pack and hook identity", () => {
		const reduction = reduceAdvisorySelectionCandidates([
			candidate("pack-z", "hook-z", 1, { kind: "thinking", thinkingLevel: "low" }),
			candidate("pack-b", "hook-z", 5, { kind: "thinking", thinkingLevel: "high" }),
			candidate("pack-a", "hook-b", 5, { kind: "thinking", thinkingLevel: "off" }),
			candidate("pack-a", "hook-a", 5, { kind: "thinking", thinkingLevel: "low" }),
			candidate("pack-z", "hook-z", 1, { kind: "role", roleName: "reviewer" }),
			candidate("pack-a", "hook-a", 5, { kind: "workflow", workflowId: "release" }),
		]);
		expect(reduction.thinking).toMatchObject({ source: { packId: "pack-a", hookId: "hook-a" }, selection: { kind: "thinking", thinkingLevel: "low" } });
		expect(reduction.role).toMatchObject({ source: { packId: "pack-z", hookId: "hook-z" }, selection: { kind: "role", roleName: "reviewer" } });
		expect(reduction.workflow).toMatchObject({ source: { packId: "pack-a", hookId: "hook-a" }, selection: { kind: "workflow", workflowId: "release" } });
		expect(reduction.model).toBeUndefined();
		expect(Object.isFrozen(reduction)).toBe(true);
		expect(reduceAdvisorySelectionCandidates([])).toEqual({});
	});
});
