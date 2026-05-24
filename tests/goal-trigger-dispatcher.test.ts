/**
 * Unit tests for `GoalTriggerDispatcher` — the push-based dispatcher that
 * fires `goal_created` / `goal_archived` staff triggers from `GoalStore`
 * mutations. Mirrors the mocking style of `tests/staff-trigger-engine.test.ts`
 * (plain object mocks for StaffManager / InboxManager).
 *
 * Pinned by docs/design (Goal lifecycle staff triggers).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { GoalTriggerDispatcher } from "../src/server/agent/goal-trigger-dispatcher.ts";
import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-trigger-disp-"));
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ } });

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockStaffManager(staffList: any[] = []) {
	const triggerUpdates: any[] = [];
	return {
		listStaff: () => staffList,
		updateTriggerState: (staffId: string, triggerId: string, update: any) => {
			triggerUpdates.push({ staffId, triggerId, update });
			for (const s of staffList) {
				for (const t of s.triggers) {
					if (t.id === triggerId) Object.assign(t, update);
				}
			}
			return true;
		},
		triggerUpdates,
	};
}

function makeMockInboxManager() {
	const enqueueHistory: any[] = [];
	return {
		enqueue: (staffId: string, input: { title: string; prompt: string; context?: string; source: any }) => {
			const entry = { id: `entry-${enqueueHistory.length}`, staffId, ...input, state: "pending", createdAt: Date.now() };
			enqueueHistory.push({ staffId, ...input });
			return entry;
		},
		enqueueHistory,
	};
}

function makeGoal(id: string, title = "Test goal"): PersistedGoal {
	return {
		id,
		title,
		cwd: "/tmp",
		state: "todo",
		spec: "",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeDispatcher(staffList: any[]) {
	const staffMgr = makeMockStaffManager(staffList);
	const inbox = makeMockInboxManager();
	const dispatcher = new GoalTriggerDispatcher(staffMgr as any, inbox as any);
	return { dispatcher, staffMgr, inbox };
}

// ---------------------------------------------------------------------------
// dispatch — goal_created
// ---------------------------------------------------------------------------

describe("GoalTriggerDispatcher.onGoalCreated", () => {
	it("fires enqueue once per matching enabled trigger on each active staff", () => {
		const staffA = {
			id: "staff-a",
			name: "Alpha",
			state: "active",
			triggers: [
				{ id: "t1", type: "goal_created", config: {}, enabled: true, prompt: "investigate" },
			],
		};
		const staffB = {
			id: "staff-b",
			name: "Beta",
			state: "active",
			triggers: [
				{ id: "t2", type: "goal_created", config: {}, enabled: true, prompt: "ping me" },
			],
		};

		const { dispatcher, staffMgr, inbox } = makeDispatcher([staffA, staffB]);
		dispatcher.onGoalCreated(makeGoal("g-1", "My new goal"));

		assert.equal(inbox.enqueueHistory.length, 2);
		const byStaff = new Map(inbox.enqueueHistory.map((e: any) => [e.staffId, e]));
		assert.equal(byStaff.get("staff-a")!.prompt, "investigate");
		assert.equal(byStaff.get("staff-a")!.source.type, "trigger");
		assert.equal(byStaff.get("staff-a")!.source.triggerId, "t1");
		assert.equal(byStaff.get("staff-a")!.title, "goal_created: My new goal");
		assert.ok(byStaff.get("staff-a")!.context.includes("g-1"));
		assert.ok(byStaff.get("staff-a")!.context.includes("My new goal"));
		assert.equal(byStaff.get("staff-b")!.prompt, "ping me");

		// Both triggers got their lastFired bumped.
		assert.equal(staffMgr.triggerUpdates.length, 2);
		for (const u of staffMgr.triggerUpdates) {
			assert.equal(typeof u.update.lastFired, "number");
		}
	});

	it("skips disabled triggers", () => {
		const staff = {
			id: "s",
			name: "S",
			state: "active",
			triggers: [
				{ id: "t1", type: "goal_created", config: {}, enabled: false, prompt: "x" },
			],
		};
		const { dispatcher, inbox } = makeDispatcher([staff]);
		dispatcher.onGoalCreated(makeGoal("g-1"));
		assert.equal(inbox.enqueueHistory.length, 0);
	});

	it("skips paused and retired staff", () => {
		const paused = {
			id: "paused",
			name: "P",
			state: "paused",
			triggers: [{ id: "t1", type: "goal_created", config: {}, enabled: true, prompt: "x" }],
		};
		const retired = {
			id: "retired",
			name: "R",
			state: "retired",
			triggers: [{ id: "t2", type: "goal_created", config: {}, enabled: true, prompt: "x" }],
		};
		const { dispatcher, inbox } = makeDispatcher([paused, retired]);
		dispatcher.onGoalCreated(makeGoal("g-1"));
		assert.equal(inbox.enqueueHistory.length, 0);
	});

	it("ignores triggers of unrelated types on the same staff", () => {
		const staff = {
			id: "s",
			name: "S",
			state: "active",
			triggers: [
				{ id: "schedule-1", type: "schedule", config: { cron: "* * * * *" }, enabled: true, prompt: "sched" },
				{ id: "git-1", type: "git", config: { branch: "main" }, enabled: true, prompt: "git" },
				{ id: "manual-1", type: "manual", config: {}, enabled: true, prompt: "manual" },
				{ id: "arch-1", type: "goal_archived", config: {}, enabled: true, prompt: "archived" },
				{ id: "created-1", type: "goal_created", config: {}, enabled: true, prompt: "created" },
			],
		};
		const { dispatcher, inbox } = makeDispatcher([staff]);
		dispatcher.onGoalCreated(makeGoal("g-1"));
		assert.equal(inbox.enqueueHistory.length, 1);
		assert.equal(inbox.enqueueHistory[0].source.triggerId, "created-1");
		assert.equal(inbox.enqueueHistory[0].prompt, "created");
	});

	it("fires ALL matching triggers on a single staff (no break-after-first)", () => {
		const staff = {
			id: "s",
			name: "S",
			state: "active",
			triggers: [
				{ id: "a", type: "goal_created", config: {}, enabled: true, prompt: "first" },
				{ id: "b", type: "goal_created", config: {}, enabled: true, prompt: "second" },
				{ id: "c", type: "goal_created", config: {}, enabled: true, prompt: "third" },
			],
		};
		const { dispatcher, inbox } = makeDispatcher([staff]);
		dispatcher.onGoalCreated(makeGoal("g-1"));
		assert.equal(inbox.enqueueHistory.length, 3);
		const prompts = inbox.enqueueHistory.map((e: any) => e.prompt).sort();
		assert.deepEqual(prompts, ["first", "second", "third"]);
	});

	it("isolates per-staff enqueue failures — one bad staff doesn't stop the rest", () => {
		const staffA = {
			id: "boom",
			name: "Boom",
			state: "active",
			triggers: [{ id: "t1", type: "goal_created", config: {}, enabled: true, prompt: "boom" }],
		};
		const staffB = {
			id: "good",
			name: "Good",
			state: "active",
			triggers: [{ id: "t2", type: "goal_created", config: {}, enabled: true, prompt: "ok" }],
		};
		const staffMgr = makeMockStaffManager([staffA, staffB]);
		const enqueueHistory: any[] = [];
		const inbox = {
			enqueue: (staffId: string, input: any) => {
				if (staffId === "boom") throw new Error("simulated enqueue failure");
				enqueueHistory.push({ staffId, ...input });
				return { id: "ok", staffId, ...input, state: "pending", createdAt: Date.now() };
			},
		};
		// Silence the expected error log.
		const originalError = console.error;
		console.error = () => { /* swallow */ };
		try {
			const dispatcher = new GoalTriggerDispatcher(staffMgr as any, inbox as any);
			dispatcher.onGoalCreated(makeGoal("g-1"));
		} finally {
			console.error = originalError;
		}
		assert.equal(enqueueHistory.length, 1);
		assert.equal(enqueueHistory[0].staffId, "good");
	});
});

// ---------------------------------------------------------------------------
// dispatch — goal_archived
// ---------------------------------------------------------------------------

describe("GoalTriggerDispatcher.onGoalArchived", () => {
	it("fires enqueue once per matching enabled trigger on each active staff", () => {
		const staff = {
			id: "s",
			name: "S",
			state: "active",
			triggers: [
				{ id: "t1", type: "goal_archived", config: {}, enabled: true, prompt: "cleanup" },
			],
		};
		const { dispatcher, inbox } = makeDispatcher([staff]);
		dispatcher.onGoalArchived(makeGoal("g-archived", "Done thing"));
		assert.equal(inbox.enqueueHistory.length, 1);
		assert.equal(inbox.enqueueHistory[0].title, "goal_archived: Done thing");
		assert.equal(inbox.enqueueHistory[0].source.triggerId, "t1");
		assert.equal(inbox.enqueueHistory[0].prompt, "cleanup");
	});

	it("does not fire goal_created triggers when archiving", () => {
		const staff = {
			id: "s",
			name: "S",
			state: "active",
			triggers: [
				{ id: "created", type: "goal_created", config: {}, enabled: true, prompt: "x" },
				{ id: "archived", type: "goal_archived", config: {}, enabled: true, prompt: "y" },
			],
		};
		const { dispatcher, inbox } = makeDispatcher([staff]);
		dispatcher.onGoalArchived(makeGoal("g-1"));
		assert.equal(inbox.enqueueHistory.length, 1);
		assert.equal(inbox.enqueueHistory[0].source.triggerId, "archived");
	});
});

// ---------------------------------------------------------------------------
// GoalStore callback wiring
// ---------------------------------------------------------------------------

describe("GoalStore — onGoalCreated / onGoalArchived", () => {
	function freshStore(): GoalStore {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "gs-"));
		return new GoalStore(dir);
	}

	it("put with a new id fires onGoalCreated exactly once", () => {
		const store = freshStore();
		const fired: PersistedGoal[] = [];
		store.onGoalCreated = (g) => { fired.push(g); };
		store.put(makeGoal("g-1", "First"));
		assert.equal(fired.length, 1);
		assert.equal(fired[0].id, "g-1");
	});

	it("put with an existing id does NOT re-fire onGoalCreated", () => {
		const store = freshStore();
		store.put(makeGoal("g-1"));
		const fired: PersistedGoal[] = [];
		store.onGoalCreated = (g) => { fired.push(g); };
		// Re-put same id with mutated title (update path).
		const updated = makeGoal("g-1", "Renamed");
		store.put(updated);
		assert.equal(fired.length, 0);
	});

	it("archive fires onGoalArchived exactly once on the false → true transition", () => {
		const store = freshStore();
		store.put(makeGoal("g-1"));
		const fired: PersistedGoal[] = [];
		store.onGoalArchived = (g) => { fired.push(g); };
		assert.equal(store.archive("g-1"), true);
		assert.equal(fired.length, 1);
		assert.equal(fired[0].id, "g-1");
		assert.equal(fired[0].archived, true);
	});

	it("calling archive again on an already-archived goal does NOT re-fire", () => {
		const store = freshStore();
		store.put(makeGoal("g-1"));
		store.archive("g-1");
		const fired: PersistedGoal[] = [];
		store.onGoalArchived = (g) => { fired.push(g); };
		// Second archive — still returns true (back-compat) but must NOT re-fire.
		assert.equal(store.archive("g-1"), true);
		assert.equal(fired.length, 0);
	});

	it("archive on a missing goal does not fire and returns false", () => {
		const store = freshStore();
		const fired: PersistedGoal[] = [];
		store.onGoalArchived = (g) => { fired.push(g); };
		assert.equal(store.archive("ghost"), false);
		assert.equal(fired.length, 0);
	});

	it("onIndexUpdate is independent of onGoalCreated/onGoalArchived", () => {
		// Pinning: the search-index hook must keep firing even when goal
		// trigger callbacks are set. Stomping was the documented regression
		// risk in the design doc.
		const store = freshStore();
		const indexFires: PersistedGoal[] = [];
		const createdFires: PersistedGoal[] = [];
		const archivedFires: PersistedGoal[] = [];
		store.onIndexUpdate = (g) => { indexFires.push(g); };
		store.onGoalCreated = (g) => { createdFires.push(g); };
		store.onGoalArchived = (g) => { archivedFires.push(g); };

		store.put(makeGoal("g-1"));
		// One index update for the new goal, one created callback.
		assert.equal(indexFires.length, 1);
		assert.equal(createdFires.length, 1);
		assert.equal(archivedFires.length, 0);

		store.put(makeGoal("g-1", "renamed"));
		// Index updates on every put, but no new "created".
		assert.equal(indexFires.length, 2);
		assert.equal(createdFires.length, 1);

		store.archive("g-1");
		assert.equal(indexFires.length, 3);
		assert.equal(archivedFires.length, 1);
	});
});
