import { describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import { GoalManager } from "../../src/server/agent/goal-manager.ts";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.ts";
import { createMemFs } from "../harness/mem-fs.ts";

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
		try {
			await manager.setupWorktreeAndStartTeam("single-flight-goal", startTeam);
			assert.equal(
				starts.length,
				0,
				"GOAL_SETUP_SINGLE_FLIGHT_EARLY_START_REGRESSION: duplicate setup started a Team Lead before the shared setup promise reached verified ready",
			);
		} finally {
			releaseProvisioning.resolve();
			await initial;
		}
	});

	it("GOAL_SETUP_STALE_ERROR_ATOMIC_CLEAR_REGRESSION: ready must remove the active setupError in the same transition", () => {
		const store = makeStore({
			...makeGoal("stale-error-goal"),
			setupStatus: "error",
			setupError: "could not lock config file /repo/.git/config.lock: File exists",
		});

		store.update("stale-error-goal", {
			setupStatus: "ready",
			setupError: undefined,
		});

		const recovered = store.get("stale-error-goal");
		assert.equal(recovered?.setupStatus, "ready");
		assert.equal(
			recovered?.setupError,
			undefined,
			"GOAL_SETUP_STALE_ERROR_ATOMIC_CLEAR_REGRESSION: a ready setup transition retained its previous active setupError",
		);
	});
});
