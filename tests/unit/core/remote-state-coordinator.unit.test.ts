import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { RemoteStateCoordinator, type RemoteStateSnapshot } from "../../../src/server/remote-state-coordinator.ts";

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

	it("preserves the automatic repository budget across invalidation while explicit force bypasses it", async () => {
		const clock = new ManualClock();
		let calls = 0;
		const coordinator = new RemoteStateCoordinator({ clock });
		const key = registerRepository(coordinator, async () => ({ call: ++calls }));

		await coordinator.refreshSnapshot(key, { intent: "explicit", forceRequestedAt: 100, forceCoalesceMs: 250 });
		coordinator.invalidate(key);
		const stale = coordinator.readSnapshot(key, { intent: "automatic" });
		await settle();
		assert.equal(stale.stale, true);
		assert.equal(calls, 1, "mutation invalidation does not erase the 30-second automatic attempt budget");

		const forced = await coordinator.refreshSnapshot<{ call: number }>(key, {
			intent: "explicit",
			forceRequestedAt: 101,
			forceCoalesceMs: 250,
		});
		assert.equal(calls, 2);
		assert.deepEqual(forced.data, { call: 2 });
		assert.equal(forced.stale, false);
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

	it("retains invalidation that races an in-flight refresh", async () => {
		const clock = new ManualClock();
		let calls = 0;
		const resolvers: Array<(value: unknown) => void> = [];
		const coordinator = new RemoteStateCoordinator({ clock });
		const key = registerRepository(coordinator, async () => {
			calls += 1;
			return new Promise((resolve) => { resolvers.push(resolve); });
		});

		const first = coordinator.refreshSnapshot(key, { intent: "explicit" });
		await settle();
		coordinator.invalidate(key, { allowImmediateRefresh: true });
		resolvers.shift()?.({ call: 1 });
		const raced = await first;
		assert.equal(raced.stale, true, "a completion must not clear newer invalidation");

		coordinator.readSnapshot(key, { intent: "automatic" });
		await settle();
		assert.equal(calls, 2, "immediate invalidation starts one next canonical refresh");
		resolvers.shift()?.({ call: 2 });
		await settle();
	});

	it("keeps immediate PR invalidation subject to backoff while explicit force can recover", async () => {
		const clock = new ManualClock();
		let calls = 0;
		let fail = false;
		const coordinator = new RemoteStateCoordinator({ clock, backoffBaseMs: 100 });
		const identity = coordinator.resolvePullRequestIdentity({ owner: "acme", repository: "widget", head: "feature" });
		const key = coordinator.registerPullRequest(identity, {
			refresh: async () => {
				calls += 1;
				if (fail) throw new Error("offline");
				return { number: 7, call: calls };
			},
		});
		await coordinator.refreshSnapshot(key, { intent: "explicit" });
		fail = true;
		clock.advance(20_000);
		await coordinator.refreshSnapshot(key, { intent: "automatic" });
		coordinator.invalidate(key, { allowImmediateRefresh: true });
		coordinator.readSnapshot(key, { intent: "automatic" });
		await settle();
		assert.equal(calls, 2, "automatic cache-bust retry still honors failure backoff");
		fail = false;
		await coordinator.refreshSnapshot(key, { intent: "explicit" });
		assert.equal(calls, 3, "explicit force bypasses backoff without duplicating in-flight work");
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

	it("reprojects entity-local repository status to every bound address after one refresh", async () => {
		const clock = new ManualClock();
		const events: Array<{ address: string; snapshot: RemoteStateSnapshot<unknown> }> = [];
		const invalidated: string[] = [];
		let refreshes = 0;
		const coordinator = new RemoteStateCoordinator({
			clock,
			broadcast: (address, snapshot) => events.push({ address: `${address.kind}:${address.id}`, snapshot }),
		});
		const identity = { key: "repo:shared", hasRemote: true };
		const key = coordinator.registerRepository(identity, {
			refresh: async () => { refreshes += 1; },
			address: { kind: "session", id: "s1" },
			binding: {
				address: { kind: "session", id: "s1" },
				invalidate: () => { invalidated.push("session"); },
				project: async () => {
					assert.deepEqual(invalidated.sort(), ["goal", "session"]);
					return { branch: "feature/session", dirty: true };
				},
			},
		});
		coordinator.registerRepository(identity, {
			refresh: async () => { refreshes += 1; },
			address: { kind: "goal", id: "g1" },
			binding: {
				address: { kind: "goal", id: "g1" },
				invalidate: () => { invalidated.push("goal"); },
				project: async () => ({ branch: "feature/goal", dirty: false }),
			},
		});

		await coordinator.refreshSnapshot(key, { intent: "explicit" });
		assert.equal(refreshes, 1);
		assert.equal(events.length, 2, "each public entity receives one completion frame");
		assert.deepEqual(
			events.map(event => [event.address, (event.snapshot.data as { branch: string }).branch]).sort(),
			[["goal:g1", "feature/goal"], ["session:s1", "feature/session"]],
		);
		assert.equal(events.every(event => event.snapshot.refreshedAt === clock.value && event.snapshot.stale === false), true);
	});

	it("emits best-effort structured telemetry without identities, URLs, refs, data, or raw errors", async () => {
		const clock = new ManualClock();
		const events: Array<Record<string, unknown>> = [];
		let releaseFirst: (() => void) | undefined;
		let throwFromSink = false;
		const coordinator = new RemoteStateCoordinator({
			clock,
			maxConcurrent: 1,
			backoffBaseMs: 100,
			telemetry: (event) => {
				events.push(event as unknown as Record<string, unknown>);
				if (throwFromSink) throw new Error("telemetry sink unavailable");
			},
		});
		const first = coordinator.registerRepository(
			{ key: "repo:https://token:secret@example.test/private/repo.git", hasRemote: true },
			{ refresh: async () => new Promise<void>(resolve => { releaseFirst = resolve; }) },
		);
		const second = coordinator.registerPullRequest(
			{ key: "pr:C:/private/worktree#refs/private/feature" },
			{ refresh: async () => { throw new Error("401 token:secret https://example.test stderr review body"); } },
		);

		coordinator.readSnapshot(first, { intent: "automatic" });
		const firstCompletion = coordinator.refreshSnapshot(first, { intent: "visible" });
		coordinator.readSnapshot(second, { intent: "automatic", cadence: "sidebar" });
		await settle();
		assert.ok(events.some(event => event.outcome === "joined"));
		assert.ok(events.some(event => event.outcome === "queued"));

		throwFromSink = true;
		releaseFirst?.();
		await firstCompletion;
		await coordinator.refreshSnapshot(second, { intent: "automatic", cadence: "sidebar" });
		throwFromSink = false;
		assert.ok(events.some(event => event.source === "pull_request" && event.outcome === "started"), "a throwing sink must not strand the queued permit");
		throwFromSink = true;
		assert.doesNotThrow(() => coordinator.readSnapshot(first, { intent: "automatic" }));
		throwFromSink = false;
		coordinator.invalidate(first);
		coordinator.readSnapshot(first, { intent: "automatic" });
		coordinator.readSnapshot(second, { intent: "automatic", cadence: "sidebar" });

		const outcomes = new Set(events.map(event => event.outcome));
		for (const outcome of ["admitted", "started", "joined", "queued", "success", "failure", "fresh", "budget", "backoff"]) {
			assert.ok(outcomes.has(outcome), `missing telemetry outcome ${outcome}`);
		}
		const failure = events.find(event => event.outcome === "failure");
		assert.equal(failure?.errorKind, "auth");
		const serialized = JSON.stringify(events);
		for (const sensitive of ["token:secret", "https://", "C:/private", "refs/private", "feature", "stderr", "review body"]) {
			assert.equal(serialized.includes(sensitive), false, sensitive);
		}
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
		// The queued refresh starts only after the first completion releases its
		// permit. Await its canonical in-flight record rather than assuming a
		// fixed number of microtasks also reaches its completion broadcast.
		await coordinator.refreshSnapshot(second);
		assert.equal(secondStarted, true);
		assert.deepEqual(broadcasts.map((item) => item.address).sort(), ["goal:g1", "session:s1"]);
		assert.equal(JSON.stringify(broadcasts).includes("repo:first"), false);
	});
});
