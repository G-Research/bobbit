import { describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import { GoalManager } from "../../../src/server/agent/goal-manager.ts";
import { GoalStore, type PersistedGoal } from "../../../src/server/agent/goal-store.ts";
import { createMemFs } from "../../../tests/support/harnesses/shared/mem-fs.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function makeGoal(id = "single-flight-goal"): PersistedGoal {
	return {
		id,
		title: "Single flight goal",
		cwd: "/repo-wt/single-flight-goal",
		state: "todo",
		spec: "# Reproduce setup race",
		createdAt: 1,
		updatedAt: 1,
		repoPath: "/repo",
		branch: "goal/single-flight",
		worktreePath: "/repo-wt/single-flight-goal",
		setupStatus: "ready",
	};
}

function makeStore(goal: PersistedGoal): GoalStore {
	const fs = createMemFs();
	const stateDir = path.resolve(`/memfs/${goal.id}`);
	fs.mkdirSync(stateDir, { recursive: true });
	const store = new GoalStore(stateDir, fs);
	store.put(goal);
	return store;
}

describe("parallel goal setup reproductions", () => {
	it("GOAL_SETUP_SINGLE_FLIGHT_EARLY_START_REGRESSION: a duplicate auto-start must await the authoritative setup", async () => {
		const store = makeStore(makeGoal());
		const manager = new GoalManager(store);
		// The setup begins only after boot recovery has finished; a persisted
		// preparing state at construction time correctly means an interrupted
		// previous process, not this in-process transaction.
		store.update("single-flight-goal", { setupStatus: "preparing" });
		const provisioningEntered = deferred();
		const releaseProvisioning = deferred();
		const starts: string[] = [];

		// Hold the real GoalManager immediately inside the setup transaction. This
		// is a deterministic barrier: no wall-clock delay or scheduler timing is
		// involved in making the duplicate caller race the initial setup.
		(manager as any)._doSetupWorktree = async (goal: PersistedGoal) => {
			provisioningEntered.resolve();
			await releaseProvisioning.promise;
			store.update(goal.id, { setupStatus: "ready" });
		};
		const startTeam = async () => { starts.push("team-lead"); };
		const initial = manager.setupWorktreeAndStartTeam("single-flight-goal", startTeam);

		await provisioningEntered.promise;
		const duplicate = manager.setupWorktreeAndStartTeam("single-flight-goal", startTeam);
		// Let the duplicate call reach its shared setup await. This is a
		// deterministic barrier, not a timing delay: neither callback may start
		// before the one authoritative setup promise resolves to ready.
		await Promise.resolve();
		assert.equal(
			starts.length,
			0,
			"GOAL_SETUP_SINGLE_FLIGHT_EARLY_START_REGRESSION: duplicate setup started a Team Lead before the shared setup promise reached verified ready",
		);
		releaseProvisioning.resolve();
		await Promise.all([initial, duplicate]);
		assert.equal(starts.length, 2, "both callers may proceed only after the shared verified-ready transition");
	});

	it("GOAL_SETUP_STALE_ERROR_ATOMIC_CLEAR_REGRESSION: ready must remove the active setupError in the same transition", () => {
		const store = makeStore({
			...makeGoal("stale-error-goal"),
			setupStatus: "error",
			setupError: "could not lock config file /repo/.git/config.lock: File exists",
		});

		store.transitionSetup("stale-error-goal", "ready");

		const recovered = store.get("stale-error-goal");
		assert.equal(recovered?.setupStatus, "ready");
		assert.equal(
			recovered?.setupError,
			undefined,
			"GOAL_SETUP_STALE_ERROR_ATOMIC_CLEAR_REGRESSION: a ready setup transition retained its previous active setupError",
		);
	});

	it("GOAL_SETUP_RETRY_COALESCING_REGRESSION: retrying clears the active error and joins one setup transaction", async () => {
		const store = makeStore({
			...makeGoal("retrying-goal"),
			setupStatus: "error",
			setupError: "could not lock config file /repo/.git/config.lock: File exists",
		});
		const manager = new GoalManager(store);
		const entered = deferred();
		const release = deferred();
		let provisionings = 0;
		(manager as any)._doSetupWorktree = async (goal: PersistedGoal) => {
			provisionings++;
			entered.resolve();
			await release.promise;
			await store.transitionSetupStrict(goal.id, "ready");
		};

		assert.equal(manager.retrySetup("retrying-goal"), true);
		assert.equal(store.get("retrying-goal")?.setupStatus, "retrying");
		assert.equal(store.get("retrying-goal")?.setupError, undefined);
		const first = manager.setupWorktree("retrying-goal");
		await entered.promise;
		assert.equal(manager.retrySetup("retrying-goal"), true, "a concurrent retry must join rather than reject");
		const second = manager.setupWorktree("retrying-goal");
		assert.strictEqual(second, first, "all callers share the same in-flight setup promise");
		release.resolve();
		await Promise.all([first, second]);
		assert.equal(provisionings, 1);
		assert.equal(store.get("retrying-goal")?.setupStatus, "ready");
	});
});
