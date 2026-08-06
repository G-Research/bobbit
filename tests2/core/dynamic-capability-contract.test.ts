import { describe, expect, it } from "vitest";
import {
	canonicalizeCapabilityQuery,
	createCapabilitySelectionCandidate,
	createDynamicCapabilitySelection,
	filterSelectedCapabilities,
	reduceCapabilitySelectionCandidates,
	snapshotCapabilityAvailability,
	validateCapabilityProposal,
	validateDynamicCapabilitySelection,
} from "../../src/server/agent/dynamic-capability-contract.ts";

function candidate(packId: string, hookId: string, priority: number, confidence: number, add: string[], omit: string[] = []): unknown {
	return { source: { packId, hookId }, priority, proposal: { add, omit, reason: "bounded diagnostic", confidence } };
}

function expectCode(value: unknown, code: string): void {
	expect(() => validateCapabilityProposal(value)).toThrow(expect.objectContaining({
		name: "DynamicCapabilityContractError", code,
	}));
}

describe("dynamic capability contract", () => {
	it("strictly validates proposals, canonicalizes ids, and lets omit win overlap", () => {
		const proposal = validateCapabilityProposal({
			add: ["skill-z", "skill-a", "skill-z", "skill-b"],
			omit: ["skill-b", "skill-a", "skill-a"],
			reason: "bounded diagnostic",
			confidence: 0.75,
		});
		expect(proposal).toEqual({ add: ["skill-z"], omit: ["skill-a", "skill-b"], reason: "bounded diagnostic", confidence: 0.75 });
		expect(Object.isFrozen(proposal)).toBe(true);
		expect(Object.isFrozen(proposal.add)).toBe(true);
		for (const raw of [
			{},
			{ add: [], reason: "ok", confidence: 0, selectTools: ["forbidden"] },
			{ add: ["not safe"], reason: "ok", confidence: 0 },
			{ add: [], reason: "ok", confidence: Number.NaN },
			{ add: [], reason: "ok", confidence: 1.01 },
			{ add: [], reason: "\u0000", confidence: 0 },
		]) expectCode(raw, raw && typeof raw === "object" && "selectTools" in raw ? "UNKNOWN_CAPABILITY_PROPOSAL_FIELD" : "INVALID_CAPABILITY_PROPOSAL");
	});

	it("reduces only core-provenanced candidates by confidence, priority, and lexical source", () => {
		const reduced = reduceCapabilitySelectionCandidates([
			candidate("pack-z", "hook-z", 9, 0.9, ["skill-z"]),
			candidate("pack-b", "hook-z", 4, 1, ["skill-b"]),
			candidate("pack-a", "hook-z", 4, 1, ["skill-a"]),
			candidate("pack-a", "hook-a", 4, 1, ["skill-x", "unknown"]),
			{ source: { packId: "../forbidden", hookId: "hook" }, priority: 999, proposal: { add: ["forbidden"], reason: "x", confidence: 1 } },
		], ["skill-a", "skill-x", "skill-z"]);
		expect(reduced.selected).toEqual(["skill-x"]);
		expect(reduced.winner).toMatchObject({ source: { packId: "pack-a", hookId: "hook-a" } });
		expect(Object.isFrozen(reduced)).toBe(true);
		expect(createCapabilitySelectionCandidate(candidate("pack", "hook", -1, 1, []) as never)).toBeUndefined();
	});

	it("uses selection as an additional narrowing filter only", () => {
		const available = [
			{ id: "skill-a", value: 1 },
			{ id: "skill-b", value: 2 },
		];
		expect(filterSelectedCapabilities(available, ["skill-b", "invented"], item => item.id)).toEqual([{ id: "skill-b", value: 2 }]);
		expect(filterSelectedCapabilities(available, undefined, item => item.id)).toEqual(available);
		expect(snapshotCapabilityAvailability(["b", "a", "a", "not safe"])).toEqual(["a", "b"]);
	});

	it("creates redacted reproducible snapshots and rejects tampering or malformed legacy state", () => {
		const snapshot = createDynamicCapabilitySelection("find useful capability", ["skill-z", "skill-a", "skill-a"], ["mcp-b", "mcp-a"], { skills: true, mcp: false });
		expect(snapshot).toMatchObject({ version: 1, skillsAuthoritative: true, skills: ["skill-a", "skill-z"], mcpAuthoritative: false, mcp: ["mcp-a", "mcp-b"] });
		expect(JSON.stringify(snapshot)).not.toContain("find useful capability");
		expect(validateDynamicCapabilitySelection(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
		expect(validateDynamicCapabilitySelection({ ...snapshot, skills: ["skill-z"] })).toBeUndefined();
		expect(validateDynamicCapabilitySelection({ ...snapshot, skillsAuthoritative: false })).toBeUndefined();
		expect(validateDynamicCapabilitySelection({ ...snapshot, unexpected: true })).toBeUndefined();
		const ascii = "x".repeat(8 * 1024 + 512);
		const multibyte = "😀".repeat(3 * 1024);
		expect(Buffer.byteLength(canonicalizeCapabilityQuery(ascii), "utf8")).toBe(8 * 1024);
		expect(Buffer.byteLength(canonicalizeCapabilityQuery(multibyte), "utf8")).toBe(8 * 1024);
		expect(createDynamicCapabilitySelection(ascii, [], [], { skills: true, mcp: false }).queryFingerprint)
			.toBe(createDynamicCapabilitySelection(canonicalizeCapabilityQuery(ascii), [], [], { skills: true, mcp: false }).queryFingerprint);
		expect(createDynamicCapabilitySelection(multibyte, [], [], { skills: false, mcp: true }).selectionFingerprint)
			.toBe(createDynamicCapabilitySelection(canonicalizeCapabilityQuery(multibyte), [], [], { skills: false, mcp: true }).selectionFingerprint);
	});
});
