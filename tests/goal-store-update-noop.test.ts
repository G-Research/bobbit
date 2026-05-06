/**
 * R-007 — `GoalStore.update()` skips the write when no field actually
 * changes, so `update(id, {})` (after the cleaned-undefined sweep) does
 * not bump generation, rewrite goals.json, or fire onIndexUpdate.
 *
 * R-010 — Malformed `inlineRoles` (non-object / array) is dropped at
 * load() with a console warning rather than crashing resolveRole().
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-store-noop-"));
});

function makeGoal(id: string, overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id,
		title: "T",
		cwd: "/x",
		state: "todo",
		spec: "spec",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("GoalStore.update() no-op skip (R-007)", () => {
	it("update with empty cleaned set does NOT bump generation or fire onIndexUpdate", () => {
		const store = new GoalStore(tmpRoot);
		store.put(makeGoal("g1"));
		const gen0 = store.getGeneration();
		let calls = 0;
		store.onIndexUpdate = () => { calls++; };

		// `undefined` values are stripped first; cleaned is empty, so no-op.
		const ok = store.update("g1", { title: undefined, paused: undefined });
		assert.equal(ok, true, "update returns true when goal exists, even on no-op");
		assert.equal(store.getGeneration(), gen0, "generation must NOT bump on no-op write");
		assert.equal(calls, 0, "onIndexUpdate must NOT fire on no-op write");
	});

	it("update with same value (already-paused → paused: true) is a no-op", () => {
		const store = new GoalStore(tmpRoot);
		store.put(makeGoal("g1", { paused: true }));
		const gen0 = store.getGeneration();
		let calls = 0;
		store.onIndexUpdate = () => { calls++; };

		const ok = store.update("g1", { paused: true });
		assert.equal(ok, true);
		assert.equal(store.getGeneration(), gen0);
		assert.equal(calls, 0);
	});

	it("update with a real change DOES bump generation and fire onIndexUpdate", () => {
		const store = new GoalStore(tmpRoot);
		store.put(makeGoal("g1"));
		const gen0 = store.getGeneration();
		let calls = 0;
		store.onIndexUpdate = () => { calls++; };

		const ok = store.update("g1", { paused: true });
		assert.equal(ok, true);
		assert.equal(store.getGeneration(), gen0 + 1);
		assert.equal(calls, 1);
		assert.equal(store.get("g1")?.paused, true);
	});

	it("update on missing goal returns false", () => {
		const store = new GoalStore(tmpRoot);
		assert.equal(store.update("nope", { title: "X" }), false);
	});
});

describe("GoalStore.load() drops malformed inlineRoles (R-010)", () => {
	function writeRaw(goals: unknown[]): void {
		fs.mkdirSync(tmpRoot, { recursive: true });
		fs.writeFileSync(path.join(tmpRoot, "goals.json"), JSON.stringify(goals));
	}

	it("inlineRoles as an array is dropped on load", () => {
		writeRaw([{ ...makeGoal("g1"), inlineRoles: [{ name: "r" }] }]);
		const store = new GoalStore(tmpRoot);
		assert.equal(store.get("g1")?.inlineRoles, undefined);
	});

	it("inlineRoles as a string is dropped on load", () => {
		writeRaw([{ ...makeGoal("g1"), inlineRoles: "garbage" }]);
		const store = new GoalStore(tmpRoot);
		assert.equal(store.get("g1")?.inlineRoles, undefined);
	});

	it("inlineRoles as a valid object is preserved on load", () => {
		const inlineRoles = { r: { name: "r", label: "R", promptTemplate: "P" } };
		writeRaw([{ ...makeGoal("g1"), inlineRoles }]);
		const store = new GoalStore(tmpRoot);
		assert.deepEqual(store.get("g1")?.inlineRoles, inlineRoles);
	});
});
