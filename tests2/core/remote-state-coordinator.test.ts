import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { RemoteStateCoordinator, type RemoteStateSnapshot } from "../../src/server/remote-state-coordinator.ts";

class ManualClock {
	value = 1_000;
	now = () => this.value;
	advance(ms: number): void { this.value += ms; }
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function registerRepository(coordinator: RemoteStateCoordinator, refresh: () => Promise<unknown>): string {
	return coordinator.registerRepository({ key: "repo:test", hasRemote: true }, { refresh });
}

describe("RemoteStateCoordinator", () => {
	it("uses stale-while-revalidate with a 30-second repository budget and single flight", async () => {
		const clock = new ManualClock();
		let calls = 0;
		let resolveRefresh: ((value: unknown) => void) | undefined;
		const coordinator = new RemoteStateCoordinator({ clock });
		const key = registerRepository(coordinator, async () => {
			calls += 1;
			if (calls > 1) return { ref: "safe-next" };
			return new Promise((resolve) => { resolveRefresh = resolve; });
		});

		const cold = coordinator.readSnapshot(key, { intent: "automatic" });
		coordinator.readSnapshot(key, { intent: "visible" });
		await settle();
		assert.equal(cold.stale, true);
		assert.equal(calls, 1);
		resolveRefresh?.({ ref: "safe" });
		await settle();

		const fresh = coordinator.readSnapshot<{ ref: string }>(key);
		assert.deepEqual(fresh.data, { ref: "safe" });
		assert.equal(fresh.stale, false);
		assert.equal(fresh.refreshedAt, 1_000);
		assert.equal(fresh.ageMs, 0);
		clock.advance(29_999);
		coordinator.readSnapshot(key);
		await settle();
		assert.equal(calls, 1);
		clock.advance(1);
		const stale = coordinator.readSnapshot(key);
		assert.equal(stale.stale, true);
		await settle();
		assert.equal(calls, 2);
	});

	it("forces explicit reads but joins an in-flight automatic refresh", async () => {
		const clock = new ManualClock();
		let calls = 0;
		const resolvers: Array<(value: unknown) => void> = [];
		const coordinator = new RemoteStateCoordinator({ clock });
		const key = registerRepository(coordinator, async () => {
			calls += 1;
			return new Promise((resolve) => { resolvers.push(resolve); });
		});
		coordinator.readSnapshot(key);
		await settle();
		coordinator.readSnapshot(key, { intent: "explicit" });
		await settle();
		assert.equal(calls, 1);
		resolvers.shift()?.({ version: 1 });
		await settle();
		const forced = coordinator.refreshSnapshot(key, { intent: "explicit" });
		await settle();
		assert.equal(calls, 2);
		resolvers.shift()?.({ version: 2 });
		await forced;
	});

	it("retains last-good snapshots, categorizes failures, applies backoff, and allows explicit recovery", async () => {
		const clock = new ManualClock();
		let shouldFail = false;
		let calls = 0;
		const coordinator = new RemoteStateCoordinator({ clock, backoffBaseMs: 100, backoffMaxMs: 500 });
		const key = registerRepository(coordinator, async () => {
			calls += 1;
			if (shouldFail) throw new Error("network timeout with https://secret@example.test");
			return { value: calls };
		});
		await coordinator.refreshSnapshot(key, { intent: "explicit" });
		shouldFail = true;
		coordinator.invalidate(key);
		clock.advance(30_000);
		await coordinator.refreshSnapshot(key, { intent: "automatic" });
		const retained = coordinator.readSnapshot<{ value: number }>(key);
		assert.deepEqual(retained.data, { value: 1 });
		assert.equal(retained.stale, true);
		assert.deepEqual(retained.lastError, { kind: "offline", observedAt: 31_000 });
		assert.equal(JSON.stringify(retained).includes("secret"), false);
		coordinator.readSnapshot(key);
		await settle();
		assert.equal(calls, 2, "automatic retry obeys backoff");
		shouldFail = false;
		const recovered = await coordinator.refreshSnapshot<{ value: number }>(key, { intent: "explicit" });
		assert.deepEqual(recovered.data, { value: 3 });
		assert.equal(recovered.stale, false);
		assert.equal(recovered.lastError, undefined);
	});

	it("blocks staff freshness on the same in-flight repository refresh", async () => {
		const clock = new ManualClock();
		let resolveRefresh: ((value: unknown) => void) | undefined;
		const coordinator = new RemoteStateCoordinator({ clock });
		const key = registerRepository(coordinator, async () => new Promise((resolve) => { resolveRefresh = resolve; }));
		coordinator.readSnapshot(key);
		await settle();
		let completed = false;
		const staff = coordinator.ensureFreshRepository<{ ref: string }>(key).then((snapshot) => {
			completed = true;
			return snapshot;
		});
		await settle();
		assert.equal(completed, false);
		resolveRefresh?.({ ref: "origin/main" });
		const snapshot = await staff;
		assert.equal(completed, true);
		assert.deepEqual(snapshot.data, { ref: "origin/main" });
	});

	it("uses active and sidebar PR windows independently and maps head aliases to PR numbers", async () => {
		const clock = new ManualClock();
		let calls = 0;
		const coordinator = new RemoteStateCoordinator({ clock });
		const head = coordinator.resolvePullRequestIdentity({ owner: "acme", repository: "widget", head: "feature/x" });
		coordinator.registerPullRequest(head, { refresh: async () => ({ number: 42, state: "OPEN", call: ++calls }) });
		await coordinator.refreshSnapshot(head.key, { intent: "explicit" });
		const number = coordinator.resolvePullRequestIdentity({ owner: "acme", repository: "widget", number: 42 });
		assert.equal(number.key, head.key);
		clock.advance(20_000);
		coordinator.readSnapshot(head.key, { cadence: "sidebar" });
		await settle();
		assert.equal(calls, 1, "sidebar retains data for 60 seconds");
		coordinator.readSnapshot(head.key, { cadence: "active" });
		await settle();
		assert.equal(calls, 2, "active demand revalidates at 20 seconds");
	});

	it("bounds distinct refreshes and emits one safe completion per public address", async () => {
		const clock = new ManualClock();
		const broadcasts: Array<{ address: string; snapshot: RemoteStateSnapshot<unknown> }> = [];
		let releaseFirst: (() => void) | undefined;
		let secondStarted = false;
		const coordinator = new RemoteStateCoordinator({
			clock,
			maxConcurrent: 1,
			broadcast: (address, snapshot) => broadcasts.push({ address: `${address.kind}:${address.id}`, snapshot }),
		});
		const first = coordinator.registerRepository({ key: "repo:first", hasRemote: true }, {
			address: { kind: "session", id: "s1" },
			refresh: async () => new Promise((resolve) => { releaseFirst = () => resolve({ ref: "one" }); }),
		});
		const second = coordinator.registerRepository({ key: "repo:second", hasRemote: true }, {
			address: { kind: "goal", id: "g1" },
			refresh: async () => { secondStarted = true; return { ref: "two" }; },
		});
		coordinator.readSnapshot(first);
		coordinator.readSnapshot(second);
		await settle();
		assert.equal(secondStarted, false);
		releaseFirst?.();
		await settle();
		assert.equal(secondStarted, true);
		assert.deepEqual(broadcasts.map((item) => item.address).sort(), ["goal:g1", "session:s1"]);
		assert.equal(JSON.stringify(broadcasts).includes("repo:first"), false);
	});
});
