import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { coordinateBootWorktreeLifecycle } from "../../src/server/server.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => { resolve = settle; });
	return { promise, resolve };
}

describe("gateway boot worktree lifecycle", () => {
	it("does not expose a claimable pool entry until the deferred sweep deletion phase settles", async () => {
		const sweepEntered = deferred();
		const releaseSweep = deferred();
		const events: string[] = [];
		let deletionActive = false;
		let poolEntryExposed = false;
		let claimOverlappedDeletion = false;

		const tryClaim = (): "claimed" | "cold-fallback" => {
			if (!poolEntryExposed) return "cold-fallback";
			claimOverlappedDeletion ||= deletionActive;
			events.push("claim");
			return "claimed";
		};

		const lifecycle = coordinateBootWorktreeLifecycle(
			async () => {
				events.push("sweep-delete-start");
				deletionActive = true;
				sweepEntered.resolve();
				await releaseSweep.promise;
				deletionActive = false;
				events.push("sweep-delete-finish");
			},
			async () => {
				events.push("pool-init");
				assert.equal(deletionActive, false, "pool initialization must start after deletion finishes");
				poolEntryExposed = true;
			},
		);

		await sweepEntered.promise;
		assert.deepEqual(events, ["sweep-delete-start"]);
		assert.equal(poolEntryExposed, false);

		// The lifecycle remains post-listen background work: unrelated request
		// work can settle while deletion is deferred, and sessions take the cold
		// fallback rather than claiming an entry hidden behind the boot barrier.
		const requestResult = await Promise.resolve().then(tryClaim);
		assert.equal(requestResult, "cold-fallback");
		assert.deepEqual(events, ["sweep-delete-start"]);

		releaseSweep.resolve();
		await lifecycle;

		assert.equal(tryClaim(), "claimed");
		assert.equal(claimOverlappedDeletion, false);
		assert.deepEqual(events, [
			"sweep-delete-start",
			"sweep-delete-finish",
			"pool-init",
			"claim",
		]);
	});
});
