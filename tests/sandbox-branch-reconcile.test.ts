import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Unit tests for the sandbox branch reconciliation logic added in
 * executeWorktreeAsync (session-setup.ts).
 *
 * The reconciliation logic is:
 *   if (plan.sandboxed && plan.sandboxBranch && plan.sandboxBranch !== plan.branch) {
 *       plan.branch = plan.sandboxBranch;
 *       ctx.store.update(session.id, { branch: plan.branch });
 *   }
 *
 * Since executeWorktreeAsync is tightly coupled to the full session pipeline,
 * we extract and test the decision logic in isolation (same pattern as
 * sandbox-restore.test.ts).
 */

interface ReconcileInput {
	sessionId: string;
	sandboxed?: boolean;
	branch?: string;
	sandboxBranch?: string;
	storeUpdate: (id: string, fields: Record<string, unknown>) => void;
}

interface ReconcileResult {
	branch: string | undefined;
	updateCalled: boolean;
	updatedWith?: { id: string; fields: Record<string, unknown> };
}

/** Mirrors the reconciliation logic from session-setup.ts executeWorktreeAsync */
function reconcileSandboxBranch(input: ReconcileInput): ReconcileResult {
	let updateCalled = false;
	let updatedWith: { id: string; fields: Record<string, unknown> } | undefined;

	const plan = {
		sandboxed: input.sandboxed,
		branch: input.branch,
		sandboxBranch: input.sandboxBranch,
	};

	// Exact logic from session-setup.ts
	if (plan.sandboxed && plan.sandboxBranch && plan.sandboxBranch !== plan.branch) {
		plan.branch = plan.sandboxBranch;
		input.storeUpdate(input.sessionId, { branch: plan.branch });
		updateCalled = true;
		updatedWith = { id: input.sessionId, fields: { branch: plan.branch } };
	}

	return { branch: plan.branch, updateCalled, updatedWith };
}

describe("sandbox branch reconciliation", () => {
	it("reconciles when sandboxBranch differs from branch", () => {
		const calls: Array<{ id: string; fields: Record<string, unknown> }> = [];
		const result = reconcileSandboxBranch({
			sessionId: "sess-1",
			sandboxed: true,
			branch: "session/new-session-620e30c0",
			sandboxBranch: "goal-my-goal-coder-abc123",
			storeUpdate: (id, fields) => calls.push({ id, fields }),
		});

		assert.equal(result.branch, "goal-my-goal-coder-abc123");
		assert.equal(result.updateCalled, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].id, "sess-1");
		assert.deepEqual(calls[0].fields, { branch: "goal-my-goal-coder-abc123" });
	});

	it("does not reconcile when branches match", () => {
		const calls: Array<{ id: string; fields: Record<string, unknown> }> = [];
		const result = reconcileSandboxBranch({
			sessionId: "sess-2",
			sandboxed: true,
			branch: "session/s-abc123",
			sandboxBranch: "session/s-abc123",
			storeUpdate: (id, fields) => calls.push({ id, fields }),
		});

		assert.equal(result.branch, "session/s-abc123");
		assert.equal(result.updateCalled, false);
		assert.equal(calls.length, 0);
	});

	it("does not reconcile when not sandboxed", () => {
		const calls: Array<{ id: string; fields: Record<string, unknown> }> = [];
		const result = reconcileSandboxBranch({
			sessionId: "sess-3",
			sandboxed: false,
			branch: "session/new-session-620e30c0",
			sandboxBranch: "goal-my-goal-coder-abc123",
			storeUpdate: (id, fields) => calls.push({ id, fields }),
		});

		assert.equal(result.branch, "session/new-session-620e30c0");
		assert.equal(result.updateCalled, false);
		assert.equal(calls.length, 0);
	});

	it("does not reconcile when sandboxBranch is undefined", () => {
		const calls: Array<{ id: string; fields: Record<string, unknown> }> = [];
		const result = reconcileSandboxBranch({
			sessionId: "sess-4",
			sandboxed: true,
			branch: "session/new-session-620e30c0",
			sandboxBranch: undefined,
			storeUpdate: (id, fields) => calls.push({ id, fields }),
		});

		assert.equal(result.branch, "session/new-session-620e30c0");
		assert.equal(result.updateCalled, false);
		assert.equal(calls.length, 0);
	});

	it("does not reconcile when sandboxBranch is empty string", () => {
		const calls: Array<{ id: string; fields: Record<string, unknown> }> = [];
		const result = reconcileSandboxBranch({
			sessionId: "sess-5",
			sandboxed: true,
			branch: "session/new-session-620e30c0",
			sandboxBranch: "",
			storeUpdate: (id, fields) => calls.push({ id, fields }),
		});

		assert.equal(result.branch, "session/new-session-620e30c0");
		assert.equal(result.updateCalled, false);
		assert.equal(calls.length, 0);
	});
});
