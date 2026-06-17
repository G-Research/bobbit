import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.js";
import { GoalManager } from "../src/server/agent/goal-manager.js";
import { gateDiagnosticsGoalDir } from "../src/server/agent/gate-diagnostics-cleanup.js";

function makeGoal(id: string): PersistedGoal {
	return {
		id,
		title: id,
		cwd: process.cwd(),
		state: "in-progress",
		spec: "diagnostic cleanup test goal",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		setupStatus: "ready",
	};
}

function seedDiagnostics(stateDir: string, goalId: string): string {
	const dir = gateDiagnosticsGoalDir(goalId, stateDir);
	fs.mkdirSync(path.join(dir, "gate-a", "signal-b", "step-c"), { recursive: true });
	fs.writeFileSync(path.join(dir, "gate-a", "signal-b", "step-c", "stdout.log"), "retained output", "utf-8");
	return dir;
}

test("goal archive and hard delete remove retained gate diagnostics", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gate-diagnostics-cleanup-"));
	try {
		const stateDir = path.join(tmp, "state");
		const store = new GoalStore(stateDir);
		const manager = new GoalManager(store, undefined, stateDir);

		store.put(makeGoal("archive-goal"));
		const archiveDir = seedDiagnostics(stateDir, "archive-goal");
		assert.equal(fs.existsSync(archiveDir), true);
		assert.equal(await manager.archiveGoal("archive-goal"), true);
		assert.equal(fs.existsSync(archiveDir), false, "archive should remove goal diagnostics");

		store.put(makeGoal("delete-goal"));
		const deleteDir = seedDiagnostics(stateDir, "delete-goal");
		assert.equal(fs.existsSync(deleteDir), true);
		assert.equal(await manager.deleteGoal("delete-goal"), true);
		assert.equal(fs.existsSync(deleteDir), false, "hard delete should remove goal diagnostics");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
