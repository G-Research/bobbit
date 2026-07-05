/**
 * Unit tests for `hasPollDiff` (src/app/visibility-poller.ts) — the
 * diff-before-render half of PERF-04. Pure/dependency-free, so this runs as a
 * plain node:test rather than a browser fixture (the DOM-dependent half,
 * `createVisibilityAwarePoller`'s visibilitychange behavior, is covered by
 * tests/visibility-poller.spec.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasPollDiff } from "../src/app/visibility-poller.ts";

describe("hasPollDiff", () => {
	it("returns false for structurally identical arrays (new references)", () => {
		const prev = [{ id: "a1", role: "worker" }, { id: "a2", role: "lead" }];
		const next = [{ id: "a1", role: "worker" }, { id: "a2", role: "lead" }];
		assert.equal(hasPollDiff(prev, next), false);
	});

	it("returns true when a field changes", () => {
		const prev = [{ id: "a1", role: "worker" }];
		const next = [{ id: "a1", role: "lead" }];
		assert.equal(hasPollDiff(prev, next), true);
	});

	it("returns true when an item is added", () => {
		const prev = [{ id: "a1" }];
		const next = [{ id: "a1" }, { id: "a2" }];
		assert.equal(hasPollDiff(prev, next), true);
	});

	it("returns true when an item is removed", () => {
		const prev = [{ id: "a1" }, { id: "a2" }];
		const next = [{ id: "a1" }];
		assert.equal(hasPollDiff(prev, next), true);
	});

	it("handles primitive payloads (e.g. a single cost total)", () => {
		assert.equal(hasPollDiff(12.5, 12.5), false);
		assert.equal(hasPollDiff(12.5, 12.6), true);
	});

	it("treats null/undefined distinctly", () => {
		assert.equal(hasPollDiff(null, null), false);
		assert.equal(hasPollDiff(undefined, undefined), false);
		assert.equal(hasPollDiff(null, undefined), true);
	});

	it("is order-sensitive (matches JSON.stringify semantics used elsewhere in goal-dashboard.ts)", () => {
		const prev = [{ id: "a1" }, { id: "a2" }];
		const next = [{ id: "a2" }, { id: "a1" }];
		assert.equal(hasPollDiff(prev, next), true);
	});
});
