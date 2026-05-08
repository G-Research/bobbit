/**
 * Unit test for buildReattemptContext — verifies the helper reads PR URL
 * from PrStatusStore (single source of truth) instead of from Goal.prUrl.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReattemptContext } from "../src/server/agent/goal-assistant.js";
import { PrStatusStore } from "../src/server/agent/pr-status-store.js";
import type { PersistedGoal } from "../src/server/agent/goal-store.js";

function makeGoal(overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id: "goal-test-id",
		title: "Test Goal",
		cwd: "/tmp/test",
		state: "in-progress",
		spec: "Original spec body",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		branch: "goal/test-1234",
		workflowId: "general",
		...overrides,
	};
}

describe("buildReattemptContext", () => {
	it("includes **PR URL:** line when PrStatusStore has a URL for the goal", () => {
		const dir = mkdtempSync(join(tmpdir(), "bobbit-reattempt-"));
		try {
			const store = new PrStatusStore(dir);
			const goal = makeGoal({ id: "goal-with-pr" });
			store.set(goal.id, { state: "OPEN", url: "https://github.com/x/y/pull/42" });

			const out = buildReattemptContext(goal, store);

			assert.ok(out.includes("**PR URL:** https://github.com/x/y/pull/42"), "expected PR URL line in output");
			assert.ok(out.includes("**Branch:** goal/test-1234"), "expected branch line");
			assert.ok(out.includes("**Original Goal:** Test Goal"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("omits **PR URL:** line cleanly when PrStatusStore has no entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "bobbit-reattempt-"));
		try {
			const store = new PrStatusStore(dir);
			const goal = makeGoal({ id: "goal-without-pr" });

			const out = buildReattemptContext(goal, store);

			assert.ok(!out.includes("**PR URL:"), "expected NO PR URL line in output");
			// Sanity: other expected lines still present.
			assert.ok(out.includes("**Original Goal:** Test Goal"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("omits both **Branch:** and **PR URL:** when goal has no branch and store is empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "bobbit-reattempt-"));
		try {
			const store = new PrStatusStore(dir);
			const goal = makeGoal({ id: "goal-no-branch", branch: undefined });

			const out = buildReattemptContext(goal, store);

			assert.ok(!out.includes("**Branch:**"));
			assert.ok(!out.includes("**PR URL:"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("omits **PR URL:** when entry exists but has no url field", () => {
		const dir = mkdtempSync(join(tmpdir(), "bobbit-reattempt-"));
		try {
			const store = new PrStatusStore(dir);
			const goal = makeGoal({ id: "goal-state-only" });
			store.set(goal.id, { state: "CLOSED" });

			const out = buildReattemptContext(goal, store);

			assert.ok(!out.includes("**PR URL:"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
