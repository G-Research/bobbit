import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, vi } from "vitest";

import {
	executePauseForGoals,
	pauseGoalAwaitingExtensionConsent,
	type GoalPauseServiceDeps,
} from "../../src/server/agent/goal-pause-service.ts";
import { resumeOnlyAwaitingConsentGoal } from "../../src/server/agent/goal-resume.ts";
import {
	GoalStore,
	type AwaitingExtensionConsentPauseReason,
	type PersistedGoal,
} from "../../src/server/agent/goal-store.ts";
import { createMemFs } from "../harness/mem-fs.js";

const REASON: AwaitingExtensionConsentPauseReason = {
	kind: "awaiting-extension-consent",
	requestId: "decision-123",
	createdAt: "2026-01-02T03:04:05.000Z",
};

function makeGoal(id = "goal-1", updates: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id,
		title: "Goal",
		cwd: "/tmp/goal",
		state: "in-progress",
		spec: "spec",
		createdAt: 1,
		updatedAt: 1,
		...updates,
	};
}

function fixture(goal = makeGoal()): {
	store: GoalStore;
	deps: GoalPauseServiceDeps;
	cancel: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	broadcasts: string[];
} {
	const memfs = createMemFs();
	const stateDir = path.resolve("/memfs/goal-pause-service");
	memfs.mkdirSync(stateDir, { recursive: true });
	const store = new GoalStore(stateDir, memfs);
	store.put(goal);
	const cancel = vi.fn(async () => undefined);
	const abort = vi.fn(async () => undefined);
	const broadcasts: string[] = [];
	return {
		store,
		deps: {
			getGoalManagerForGoal: () => ({ getGoalStore: () => store }) as any,
			verificationHarness: {
				getActiveVerifications: () => [{ gateId: "verify" }],
				cancelStaleVerifications: cancel,
			} as any,
			sessionManager: {
				getAllSessionsRaw: () => [
					{ id: "caller", goalId: goal.id, status: "streaming" },
					{ id: "worker", goalId: goal.id, status: "streaming" },
					{ id: "idle", goalId: goal.id, status: "idle" },
					{ id: "other", goalId: "other-goal", status: "streaming" },
				],
				abortSessionTurn: abort,
			} as any,
			broadcastGoalStateChanged: id => broadcasts.push(id),
		},
		cancel,
		abort,
		broadcasts,
	};
}

describe("goal pause service", () => {
	it("keeps manual pause lifecycle behavior and clears stale consent provenance", async () => {
		const goal = makeGoal("goal-1", { paused: false, pauseReason: REASON });
		const { store, deps, cancel, abort, broadcasts } = fixture(goal);

		assert.equal(await executePauseForGoals(deps, [goal], "caller"), 1);
		assert.equal(store.get(goal.id)?.paused, true);
		assert.equal(store.get(goal.id)?.pauseReason, undefined);
		assert.equal(cancel.mock.calls.length, 1);
		assert.deepEqual(broadcasts, [goal.id]);
		await Promise.resolve();
		assert.deepEqual(abort.mock.calls, [["worker"]]);
	});

	it("manual pause supersedes an existing consent reason without resuming it", async () => {
		const goal = makeGoal("goal-1", { paused: true, pauseReason: REASON });
		const { store, deps, cancel, broadcasts } = fixture(goal);
		assert.equal(await executePauseForGoals(deps, [goal], "caller"), 0);
		assert.equal(store.get("goal-1")?.paused, true);
		assert.equal(store.get("goal-1")?.pauseReason, undefined);
		assert.equal(cancel.mock.calls.length, 0, "an already-paused goal keeps legacy no-op pause side effects");
		assert.deepEqual(broadcasts, ["goal-1"]);
	});

	it("pauses consent work durably, and replays only the same consent reason", async () => {
		const { store, deps, cancel, abort, broadcasts } = fixture();

		assert.equal(await pauseGoalAwaitingExtensionConsent(deps, "goal-1", REASON, "caller"), "paused");
		assert.deepEqual(store.get("goal-1")?.pauseReason, REASON);
		assert.equal(store.get("goal-1")?.paused, true);
		assert.equal(cancel.mock.calls.length, 1);
		await Promise.resolve();
		assert.deepEqual(abort.mock.calls, [["worker"]]);

		assert.equal(await pauseGoalAwaitingExtensionConsent(deps, "goal-1", REASON, "caller"), "already-paused");
		assert.equal(cancel.mock.calls.length, 2, "recovery completes a crash-interrupted canonical pause");
		assert.deepEqual(broadcasts, ["goal-1", "goal-1"]);
	});

	it("resumes only the exact durable consent pause", async () => {
		const { store, broadcasts } = fixture(makeGoal("goal-1", { paused: true, pauseReason: REASON, mergeConflict: true }));
		assert.equal(await resumeOnlyAwaitingConsentGoal(store, "goal-1", REASON, id => broadcasts.push(id)), "resumed");
		assert.equal(store.get("goal-1")?.paused, false);
		assert.deepEqual(store.get("goal-1")?.pauseReason, REASON, "the exact provenance makes a crash after goal resume recoverable");
		assert.equal(store.get("goal-1")?.mergeConflict, false);
		assert.deepEqual(broadcasts, ["goal-1"]);
		assert.equal(await resumeOnlyAwaitingConsentGoal(store, "goal-1", REASON, () => undefined), "already-resumed");
		store.update("goal-1", { pauseReason: undefined });
		assert.equal(await resumeOnlyAwaitingConsentGoal(store, "goal-1", REASON, () => undefined), "not-matching", "an arbitrary unpaused operator state is not consent success");
	});

	it("does not resume manual or different consent pauses", async () => {
		const { store, broadcasts } = fixture(makeGoal("goal-1", { paused: true }));
		assert.equal(await resumeOnlyAwaitingConsentGoal(store, "goal-1", REASON, id => broadcasts.push(id)), "not-matching");
		assert.equal(store.get("goal-1")?.paused, true);

		store.update("goal-1", { pauseReason: { ...REASON, requestId: "other" } });
		assert.equal(await resumeOnlyAwaitingConsentGoal(store, "goal-1", REASON, id => broadcasts.push(id)), "not-matching");
		assert.equal(store.get("goal-1")?.paused, true);
		assert.deepEqual(broadcasts, []);
	});

	it("rejects malformed consent reasons before mutating the goal", async () => {
		const { store, deps } = fixture();
		await assert.rejects(
			() => pauseGoalAwaitingExtensionConsent(deps, "goal-1", { ...REASON, createdAt: "not-a-date" }, "caller"),
			/Invalid awaiting-extension-consent pause reason/,
		);
		assert.equal(store.get("goal-1")?.paused, undefined);
	});
});
