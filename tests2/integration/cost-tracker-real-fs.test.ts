import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CostTracker } from "../../src/server/agent/cost-tracker.ts";

const roots: string[] = [];

function freshRoot(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cost-tracker-real-fs-")));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("CostTracker real filesystem fidelity", () => {
	it("persists and reloads session-costs.json through the default realFs", () => {
		const root = freshRoot();
		const stateDir = path.join(root, "state");
		const storeFile = path.join(stateDir, "session-costs.json");

		// Default constructor (no fsImpl) exercises the real-disk realFs path.
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("session-a", { inputTokens: 100, outputTokens: 20, cost: 0.5 }, "goal-1");
		tracker.flush();

		assert.ok(fs.existsSync(storeFile), "session-costs.json should exist on real disk after flush");
		const parsed = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
		assert.equal(parsed["session-a"].inputTokens, 100);
		assert.equal(parsed["session-a"].totalCost, 0.5);
		assert.equal(parsed["session-a"].goalId, "goal-1");
		// Derived cacheHitRate must NEVER be persisted.
		assert.equal(Object.hasOwn(parsed["session-a"], "cacheHitRate"), false);

		// A fresh tracker over the same dir reloads the persisted counters.
		const reloaded = new CostTracker(stateDir);
		const cost = reloaded.getSessionCost("session-a");
		assert.equal(cost?.inputTokens, 100);
		assert.equal(cost?.outputTokens, 20);
		assert.equal(cost?.totalCost, 0.5);
		assert.equal(cost?.goalId, "goal-1");
		assert.equal(reloaded.getGoalCost("goal-1").totalCost, 0.5);
	});
});
