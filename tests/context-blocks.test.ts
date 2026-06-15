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
});
