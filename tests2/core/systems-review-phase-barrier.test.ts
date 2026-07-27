// v2-native — same-phase Systems/specialist review concurrency barrier coverage.

import { describe, expect, it } from "vitest";

import { runVerificationPhaseSteps } from "../../src/server/agent/verification-harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe("verification specialist-phase barrier", () => {
	it("starts every specialist peer before awaiting any result", async () => {
		const releases = [deferred<string>(), deferred<string>(), deferred<string>()];
		const started: number[] = [];
		const run = runVerificationPhaseSteps([0, 1, 2], async (index) => {
			started.push(index);
			return releases[index].promise;
		});
		await Promise.resolve();
		expect(started).toEqual([0, 1, 2]);
		releases[2].resolve("systems");
		releases[0].resolve("code");
		releases[1].resolve("security");
		await expect(run).resolves.toEqual(["code", "security", "systems"]);
	});

	it("does not cancel or finalize the phase when a peer fails quickly", async () => {
		const systems = deferred<string>();
		const peer = deferred<string>();
		const completed: string[] = [];
		let barrierSettled = false;
		const barrier = runVerificationPhaseSteps(["fast-failure", "systems", "peer"], async (name) => {
			if (name === "fast-failure") throw new Error("specialist failed");
			const result = await (name === "systems" ? systems.promise : peer.promise);
			completed.push(name);
			return result;
		});
		void barrier.finally(() => { barrierSettled = true; }).catch(() => undefined);

		await Promise.resolve();
		await Promise.resolve();
		expect(barrierSettled).toBe(false);
		systems.resolve("complete final systems report");
		await Promise.resolve();
		expect(completed).toEqual(["systems"]);
		expect(barrierSettled).toBe(false);
		peer.resolve("peer complete");
		await expect(barrier).rejects.toThrow(/1 verification phase step\(s\) rejected/);
		expect(completed.sort()).toEqual(["peer", "systems"]);
		expect(barrierSettled).toBe(true);
	});

	it("aggregates all unexpected peer exceptions only after every continuation settles", async () => {
		const continuation = deferred<string>();
		const barrier = runVerificationPhaseSteps(["first", "second", "systems"], async (name) => {
			if (name === "first") throw new Error("first failed");
			if (name === "second") throw new Error("second failed");
			return continuation.promise;
		});
		continuation.resolve("systems final");
		try {
			await barrier;
			expect.fail("barrier should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors.map((entry) => (entry as Error).message))
				.toEqual(["first failed", "second failed"]);
		}
	});
});
