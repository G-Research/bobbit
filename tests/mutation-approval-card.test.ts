/**
 * Phase 5b — mutation-approval card reducer + dispatch tests.
 *
 * Verifies:
 *  1. The `mutation-pending` reducer action appends a row.
 *  2. Duplicate `requestId` is deduped.
 *  3. The `mutation-update` reducer action patches the row in place.
 *  4. The `createMutationPending` helper produces the expected shape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reduce, initialState } from "../src/app/message-reducer.ts";
import { createMutationPending } from "../src/app/custom-messages.ts";

describe("createMutationPending", () => {
	it("produces a well-formed message", () => {
		const m = createMutationPending("g1", "req-1", "fix-up", "Adds one leaf at phase 2");
		assert.equal(m.role, "mutation-pending");
		assert.equal(m.goalId, "g1");
		assert.equal(m.requestId, "req-1");
		assert.equal(m.kind, "fix-up");
		assert.equal(m.summary, "Adds one leaf at phase 2");
		assert.ok(typeof m.timestamp === "string");
		assert.equal(m.decided, undefined);
	});
});

describe("reducer: mutation-pending", () => {
	it("appends a row", () => {
		const card: any = {
			role: "mutation-pending",
			goalId: "g1",
			requestId: "req-1",
			kind: "fix-up",
			summary: "Adds leaf",
			timestamp: new Date().toISOString(),
			id: "mut_req-1",
		};
		const out = reduce(initialState(), { type: "mutation-pending", message: card });
		assert.equal(out.messages.length, 1);
		assert.equal((out.messages[0] as any).requestId, "req-1");
		assert.equal((out.messages[0] as any).id, "mut_req-1");
	});

	it("dedupes by requestId", () => {
		const card: any = {
			role: "mutation-pending",
			goalId: "g1",
			requestId: "req-dupe",
			kind: "expansion",
			summary: "x",
			timestamp: new Date().toISOString(),
			id: "mut_req-dupe",
		};
		const out1 = reduce(initialState(), { type: "mutation-pending", message: card });
		const out2 = reduce(out1, { type: "mutation-pending", message: card });
		assert.equal(out2.messages.length, 1);
	});
});

describe("reducer: mutation-update", () => {
	it("patches the row matching messageId", () => {
		const card: any = {
			role: "mutation-pending",
			goalId: "g1",
			requestId: "req-2",
			kind: "fix-up",
			summary: "x",
			timestamp: new Date().toISOString(),
			id: "mut_req-2",
		};
		const after1 = reduce(initialState(), { type: "mutation-pending", message: card });
		const after2 = reduce(after1, { type: "mutation-update", messageId: "mut_req-2", patch: { decided: "approved" } });
		assert.equal(after2.messages.length, 1);
		assert.equal((after2.messages[0] as any).decided, "approved");
		assert.equal((after2.messages[0] as any).requestId, "req-2");
	});

	it("ignores unknown messageId", () => {
		const card: any = {
			role: "mutation-pending",
			goalId: "g1",
			requestId: "req-3",
			kind: "fix-up",
			summary: "x",
			timestamp: new Date().toISOString(),
			id: "mut_req-3",
		};
		const after1 = reduce(initialState(), { type: "mutation-pending", message: card });
		const after2 = reduce(after1, { type: "mutation-update", messageId: "nonexistent", patch: { decided: "rejected" } });
		// No mutation
		assert.equal(after2.messages.length, 1);
		assert.equal((after2.messages[0] as any).decided, undefined);
	});
});
