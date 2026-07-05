import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBudgets, estimateTokens, fenceBlock, type ContextBlock } from "../src/server/agent/context-blocks.ts";

function block(id: string, providerId: string, priority: number, tokens: number): ContextBlock {
	const content = "x".repeat(tokens * 4);
	return {
		id,
		title: `Title ${id}`,
		providerId,
		authority: "memory",
		content,
		reason: "because",
		priority,
		tokenEstimate: estimateTokens(content),
	};
}

describe("context blocks", () => {
	it("fences content and escapes/strips attributes", () => {
		const fenced = fenceBlock({
			id: "id\"\n1",
			title: "title\"\r\nsource",
			providerId: "p1",
			authority: "memory",
			content: "line 1\nline 2",
			reason: "why\"\nnow",
			priority: 1,
			tokenEstimate: 4,
		});

		assert.equal(
			fenced,
			`<context-block id="id&quot; 1" source="title&quot; source" authority="memory" reason="why&quot; now">\nline 1\nline 2\n</context-block>`,
		);
	});

	it("keeps two fitting blocks and omits the third with a reason", () => {
		const result = applyBudgets([
			block("a", "p", 10, 5),
			block("b", "p", 9, 5),
			block("c", "p", 8, 5),
		], new Map([["p", 100]]), 10);

		assert.deepEqual(result.kept.map((b) => b.id), ["a", "b"]);
		assert.equal(result.omitted.length, 1);
		assert.equal(result.omitted[0].block.id, "c");
		assert.ok(result.omitted[0].why.length > 0);
	});

	it("truncates the first over-budget block when enough headroom remains", () => {
		const result = applyBudgets([block("large", "p", 10, 200)], new Map([["p", 80]]), 80);

		assert.equal(result.omitted.length, 0);
		assert.equal(result.kept.length, 1);
		assert.equal(result.kept[0].id, "large");
		assert.ok(result.kept[0].content.endsWith("…[truncated]"));
		assert.ok(result.kept[0].tokenEstimate <= 80);
	});

	it("drops instead of truncating when the truncated remainder would be below 32 tokens", () => {
		const result = applyBudgets([block("large", "p", 10, 200)], new Map([["p", 31]]), 31);

		assert.equal(result.kept.length, 0);
		assert.equal(result.omitted.length, 1);
		assert.equal(result.omitted[0].block.id, "large");
		assert.equal(result.omitted[0].why, "truncated-below-min");
	});

	it("global cap binds before remaining per-provider headroom", () => {
		const result = applyBudgets([
			block("first", "p1", 10, 30),
			block("second", "p2", 9, 80),
		], new Map([["p1", 100], ["p2", 200]]), 50);

		assert.deepEqual(result.kept.map((b) => b.id), ["first"]);
		assert.equal(result.omitted.length, 1);
		assert.equal(result.omitted[0].block.id, "second");
		assert.equal(result.omitted[0].why, "truncated-below-min");
	});

	// EXT-06 — fair-share floor (see docs/design/context-budget-fair-share.md and
	// FINDINGS.md EXT-06). The pre-fix single global priority queue would let one
	// pack's oversized demand crowd every lower-priority pack out entirely, via
	// the "stop everything after the first truncation" rule — even a tiny block
	// that would trivially fit in the headroom left behind. These pins prove the
	// two-phase guarantee/leftover allocation fixes that without disturbing any
	// of the byte-identical single-pack cases above.
	it("fair-share floor: a low-priority pack's small block is no longer starved by a high-priority pack's oversized demand", () => {
		const result = applyBudgets([
			block("A", "p1", 10, 30),
			block("B", "p1", 8, 30),
			block("C", "p2", 5, 10),
		], new Map([["p1", 1000], ["p2", 1000]]), 50);

		// Pre-fix behaviour (for context, not asserted): A(30) kept first, B(30)
		// overflows the remaining 20 tokens and triggers "stop after first
		// truncation" — C(10), which would trivially fit in A's leftover headroom,
		// used to be dropped anyway as "after-truncation". floor(50/2)=25 reserves
		// enough for p2's tiny block up front regardless of p1's demand.
		assert.deepEqual(result.kept.map((b) => b.id), ["A", "C"]);
		assert.equal(result.omitted.length, 1);
		assert.equal(result.omitted[0].block.id, "B");
	});

	it("N packs, one greedy: the greedy pack no longer starves the rest", () => {
		const result = applyBudgets([
			block("greedy", "p1", 10, 90),
			block("p2-block", "p2", 5, 8),
			block("p3-block", "p3", 3, 8),
		], new Map([["p1", 1000], ["p2", 1000], ["p3", 1000]]), 60);

		assert.ok(result.kept.some((b) => b.id === "p2-block"), "p2's block should survive the greedy pack's demand");
		assert.ok(result.kept.some((b) => b.id === "p3-block"), "p3's block should survive the greedy pack's demand");
		assert.ok(result.kept.some((b) => b.id === "greedy"), "the greedy pack still gets a (truncated) block from the leftover pass");
	});

	it("a single contributing pack degrades to the pre-fix single-phase algorithm (fairShare === globalMax)", () => {
		// N=1 ⇒ fairShare = floor(globalMax/1) = globalMax, so the guarantee cap
		// never binds tighter than the pack's own perProviderMax/globalMax already
		// did — byte-identical to applyBudgets before the EXT-06 fix.
		const result = applyBudgets([
			block("a", "solo", 10, 5),
			block("b", "solo", 9, 5),
			block("c", "solo", 8, 5),
		], new Map([["solo", 100]]), 10);

		assert.deepEqual(result.kept.map((b) => b.id), ["a", "b"]);
		assert.equal(result.omitted.length, 1);
		assert.equal(result.omitted[0].block.id, "c");
	});
});
