import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
	contextClearExcludedCompactionIds,
	createContextClearBoundary,
	currentGenerationCompactionIds,
	findContextClearBoundary,
	latestContextClearBoundary,
	makeContextClearId,
	mergeContextClearBoundariesIntoMessages,
	normalizeContextClearBoundaries,
	normalizeContextClearBoundary,
	syntheticContextClearRows,
	type ContextClearBoundary,
} from "../../src/server/agent/context-clear-boundary.ts";

function boundary(
	id: string,
	previousAgentSessionFile: string,
	activatedAgentSessionFile: string,
	overrides: Partial<ContextClearBoundary> = {},
): ContextClearBoundary {
	return {
		schemaVersion: 1,
		id,
		clearedAt: "2026-08-22T10:00:00.000Z",
		previousAgentSessionFile,
		activatedAgentSessionFile,
		activatedTranscriptMaterialized: false,
		previousTranscriptMaterialized: true,
		compactionIds: [],
		...overrides,
	};
}

describe("context-clear boundary domain", () => {
	it("creates stable schema-v1 ids and defaults an activated lazy transcript to unmaterialized", () => {
		const id = makeContextClearId(1_787_392_800_000);
		expect(id, "CONTEXT_CLEAR_UNSTABLE_ID: clear ids must embed time plus stable random identity").toMatch(
			/^clr_1787392800000_[0-9a-f]{6}$/,
		);
		const created = createContextClearBoundary({
			id,
			clearedAt: "2026-08-22T10:00:00.000Z",
			previousAgentSessionFile: "/agent/A.jsonl",
			activatedAgentSessionFile: "/agent/B.jsonl",
			previousTranscriptMaterialized: true,
			compactionIds: ["c_old", "c_old", "c_tail"],
		});

		expect(created).toEqual({
			schemaVersion: 1,
			id,
			clearedAt: "2026-08-22T10:00:00.000Z",
			previousAgentSessionFile: "/agent/A.jsonl",
			activatedAgentSessionFile: "/agent/B.jsonl",
			activatedTranscriptMaterialized: false,
			previousTranscriptMaterialized: true,
			compactionIds: ["c_old", "c_tail"],
		});
	});

	it("rejects malformed or unknown-version records before consumers can use transcript paths", () => {
		const valid = boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl");
		expect(normalizeContextClearBoundary(valid)).toEqual(valid);
		for (const malformed of [
			null,
			[],
			{ ...valid, schemaVersion: 2 },
			{ ...valid, id: "not-a-clear-id" },
			{ ...valid, clearedAt: "yesterday" },
			{ ...valid, previousAgentSessionFile: "" },
			{ ...valid, previousAgentSessionFile: "/agent/same.jsonl", activatedAgentSessionFile: "/agent/same.jsonl" },
			{ ...valid, activatedTranscriptMaterialized: "false" },
			{ ...valid, previousTranscriptMaterialized: 1 },
			{ ...valid, compactionIds: ["c_ok", 3] },
		]) {
			expect(
				normalizeContextClearBoundary(malformed),
				"CONTEXT_CLEAR_UNVALIDATED_BOUNDARY_ACCEPTED: malformed paths/metadata must fail closed",
			).toBeUndefined();
		}
	});

	it("normalizes repeated clears in commit order, deduplicates ids, and selects each exact generation", () => {
		const clearA = boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl");
		const duplicateA = boundary("clr_1787392800000_a1b2c3", "/wrong/A.jsonl", "/wrong/B.jsonl");
		const clearB = boundary("clr_1787392860000_d4e5f6", "/agent/B.jsonl", "/agent/C.jsonl", {
			previousTranscriptMaterialized: false,
		});
		const normalized = normalizeContextClearBoundaries([
			clearA,
			{ ...clearA, id: "invalid" },
			duplicateA,
			clearB,
		]);

		expect(normalized).toEqual([clearA, clearB]);
		expect(findContextClearBoundary(normalized, clearA.id)).toEqual(clearA);
		expect(findContextClearBoundary(normalized, clearB.id)).toEqual(clearB);
		expect(latestContextClearBoundary(normalized)).toEqual(clearB);
		expect(findContextClearBoundary(normalized, "../../agent/A.jsonl")).toBeUndefined();
	});

	it("assigns only compaction ids unowned by prior context generations", () => {
		const clearA = boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl", {
			compactionIds: ["c_A1", "c_A2"],
		});
		const clearB = boundary("clr_1787392860000_d4e5f6", "/agent/B.jsonl", "/agent/C.jsonl", {
			compactionIds: ["c_B1", "c_A2"],
		});

		expect([...contextClearExcludedCompactionIds([clearA, clearB])]).toEqual(["c_A1", "c_A2", "c_B1"]);
		expect(
			currentGenerationCompactionIds(["c_A1", "c_C1", "c_B1", "c_C1", "", "c_C2"], [clearA, clearB]),
			"CONTEXT_CLEAR_COMPACTION_OWNERSHIP_LEAK: old cards must not reappear in the active generation",
		).toEqual(["c_C1", "c_C2"]);
	});

	it("synthesizes an outward-only Context Cleared pair without exposing transcript paths", () => {
		const clearA = boundary("clr_1787392800000_a1b2c3", "/sensitive/A.jsonl", "/sensitive/B.jsonl");
		const [assistant, result] = syntheticContextClearRows(clearA);

		expect(assistant).toMatchObject({
			id: clearA.id,
			role: "assistant",
			content: [{
				type: "toolCall",
				id: `context-cleared:${clearA.id}`,
				name: "__context_cleared",
				arguments: {
					schemaVersion: 1,
					clearId: clearA.id,
					clearedAt: clearA.clearedAt,
				},
			}],
		});
		expect(result).toMatchObject({
			role: "toolResult",
			toolCallId: `context-cleared:${clearA.id}`,
			toolName: "__context_cleared",
			isError: false,
		});
		const serialized = JSON.stringify([assistant, result]);
		expect(serialized).not.toContain("/sensitive/A.jsonl");
		expect(serialized).not.toContain("/sensitive/B.jsonl");
	});

	it("prepends repeated boundaries exactly once in order and never mutates Pi-owned messages", () => {
		const clearA = boundary("clr_1787392800000_a1b2c3", "/agent/A.jsonl", "/agent/B.jsonl");
		const clearB = boundary("clr_1787392860000_d4e5f6", "/agent/B.jsonl", "/agent/C.jsonl");
		const active = [{ role: "user", content: "only generation C", id: "current-C" }];
		const before = structuredClone(active);

		const once = mergeContextClearBoundariesIntoMessages([clearA, clearB], active);
		const twice = mergeContextClearBoundariesIntoMessages([clearA, clearB], once);

		assert.deepEqual(active, before, "CONTEXT_CLEAR_SYNTHESIS_MUTATED_PI_MESSAGES: outward rows must never enter Pi state");
		expect(once.map((row: any) => row.id ?? row.toolCallId)).toEqual([
			clearA.id,
			`context-cleared:${clearA.id}`,
			clearB.id,
			`context-cleared:${clearB.id}`,
			"current-C",
		]);
		expect(
			twice,
			"CONTEXT_CLEAR_BOUNDARY_DUPLICATED: repeated snapshot/event/reload synthesis must be idempotent",
		).toEqual(once);
		expect(twice.filter((row: any) => row.content?.[0]?.name === "__context_cleared")).toHaveLength(2);
	});
});
