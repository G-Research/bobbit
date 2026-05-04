/**
 * Unit tests for the ephemeral proposal-annotations store.
 *
 *   - keying: separate buckets per (sessionId, type)
 *   - clearProposalAnnotations targets only the named bucket
 *   - composeProposalFeedback emits a quoted-comment block per annotation
 *
 * No DOM. The module is pure data + a Map cache.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
	proposalBackend,
	clearProposalAnnotations,
	composeProposalFeedback,
} from "../src/ui/components/review/proposal-annotations.ts";
import type { ReviewAnnotation } from "../src/ui/components/review/AnnotationStore.ts";

let _idCounter = 0;
function makeAnn(over: Partial<ReviewAnnotation> = {}): ReviewAnnotation {
	return {
		id: `ann-${++_idCounter}`,
		quote: "selected text",
		comment: "a comment",
		start: 0,
		end: 13,
		...over,
	};
}

/** Drain every bucket touched by the test so each `it` starts clean. */
function resetAll() {
	for (const sid of ["s1", "s2"]) {
		for (const type of ["goal", "role", "staff"] as const) {
			proposalBackend.clear({ sessionId: sid, bucket: `proposal:${type}` });
		}
	}
}

describe("proposal-annotations — keying", () => {
	beforeEach(resetAll);

	it("separate buckets per (sessionId, type)", () => {
		proposalBackend.add({ sessionId: "s1", bucket: "proposal:goal" }, makeAnn());
		proposalBackend.add({ sessionId: "s1", bucket: "proposal:role" }, makeAnn());
		proposalBackend.add({ sessionId: "s2", bucket: "proposal:goal" }, makeAnn());

		assert.equal(proposalBackend.count({ sessionId: "s1", bucket: "proposal:goal" }), 1);
		assert.equal(proposalBackend.count({ sessionId: "s1", bucket: "proposal:role" }), 1);
		assert.equal(proposalBackend.count({ sessionId: "s2", bucket: "proposal:goal" }), 1);
		assert.equal(proposalBackend.count({ sessionId: "s2", bucket: "proposal:role" }), 0);
	});

	it("get returns a fresh array (caller can't mutate cache)", () => {
		proposalBackend.add({ sessionId: "s1", bucket: "proposal:goal" }, makeAnn());
		const arr = proposalBackend.get({ sessionId: "s1", bucket: "proposal:goal" });
		arr.length = 0;
		assert.equal(proposalBackend.count({ sessionId: "s1", bucket: "proposal:goal" }), 1);
	});

	it("remove targets the right id within a bucket", () => {
		const a = makeAnn({ id: "keep" });
		const b = makeAnn({ id: "drop" });
		proposalBackend.add({ sessionId: "s1", bucket: "proposal:goal" }, a);
		proposalBackend.add({ sessionId: "s1", bucket: "proposal:goal" }, b);
		proposalBackend.remove({ sessionId: "s1", bucket: "proposal:goal" }, "drop");
		const remaining = proposalBackend.get({ sessionId: "s1", bucket: "proposal:goal" });
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0].id, "keep");
	});
});

describe("proposal-annotations — clearProposalAnnotations", () => {
	beforeEach(resetAll);

	it("targets only the named bucket", () => {
		proposalBackend.add({ sessionId: "s1", bucket: "proposal:goal" }, makeAnn());
		proposalBackend.add({ sessionId: "s1", bucket: "proposal:role" }, makeAnn());
		proposalBackend.add({ sessionId: "s2", bucket: "proposal:goal" }, makeAnn());

		clearProposalAnnotations("s1", "goal");

		assert.equal(proposalBackend.count({ sessionId: "s1", bucket: "proposal:goal" }), 0);
		assert.equal(proposalBackend.count({ sessionId: "s1", bucket: "proposal:role" }), 1);
		assert.equal(proposalBackend.count({ sessionId: "s2", bucket: "proposal:goal" }), 1);
	});

	it("is idempotent on empty buckets", () => {
		clearProposalAnnotations("s-nonexistent", "goal");
		assert.equal(
			proposalBackend.count({ sessionId: "s-nonexistent", bucket: "proposal:goal" }),
			0,
		);
	});
});

describe("proposal-annotations — composeProposalFeedback", () => {
	beforeEach(resetAll);

	it("returns empty string when bucket has no annotations", () => {
		const text = composeProposalFeedback("s1", "proposal:goal", "anything");
		assert.equal(text, "");
	});

	it("emits a quoted-comment block per annotation with line numbers", () => {
		const md = "First line.\nSecond line.\nThird line.";
		const secondLineStart = md.indexOf("Second line.");
		proposalBackend.add(
			{ sessionId: "s1", bucket: "proposal:goal" },
			makeAnn({
				quote: "Second line.",
				comment: "Make this clearer",
				start: secondLineStart,
				end: secondLineStart + "Second line.".length,
			}),
		);

		const text = composeProposalFeedback("s1", "proposal:goal", md);

		assert.match(text, /^## Feedback on proposal/);
		assert.match(text, /"Second line\."/);
		assert.match(text, /Make this clearer/);
		assert.match(text, /\(line 2\)/);
	});

	it("wraps code-flagged quotes in backticks", () => {
		proposalBackend.add(
			{ sessionId: "s1", bucket: "proposal:role" },
			makeAnn({ quote: "foo()", comment: "rename", isCode: true, start: 0, end: 5 }),
		);
		const text = composeProposalFeedback("s1", "proposal:role", "foo() bar");
		assert.match(text, /`foo\(\)`/);
		assert.doesNotMatch(text, /"foo\(\)"/);
	});

	it("includes one entry per annotation in insertion order", () => {
		const md = "alpha beta gamma";
		proposalBackend.add(
			{ sessionId: "s1", bucket: "proposal:staff" },
			makeAnn({ quote: "alpha", comment: "first", start: 0, end: 5 }),
		);
		proposalBackend.add(
			{ sessionId: "s1", bucket: "proposal:staff" },
			makeAnn({ quote: "gamma", comment: "third", start: 11, end: 16 }),
		);
		const text = composeProposalFeedback("s1", "proposal:staff", md);
		const firstIdx = text.indexOf("first");
		const thirdIdx = text.indexOf("third");
		assert.ok(firstIdx >= 0 && thirdIdx >= 0);
		assert.ok(firstIdx < thirdIdx, "first comment must precede the third");
	});
});
