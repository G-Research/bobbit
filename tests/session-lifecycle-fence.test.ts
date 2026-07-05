import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	SessionLifecycleFence,
	type LifecycleFenceSession,
	type SessionLifecycleFenceDeps,
} from "../src/server/agent/session-lifecycle-fence.ts";

type FakeSession = LifecycleFenceSession & {
	status: "idle" | "streaming" | "terminated";
	clients: Set<string>;
};

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function makeSession(id = "s1", generation = 0): FakeSession {
	return {
		id,
		status: "idle",
		lifecycleGeneration: generation,
		clients: new Set(["client"]),
	};
}

function makeHarness() {
	const canonical = new Map<string, FakeSession>();
	const cancelled: Array<{ session: FakeSession; reason: "terminated" }> = [];
	const untracked: FakeSession[] = [];
	const deps = {
		getCanonicalSession: (sessionId) => canonical.get(sessionId),
		cancelPendingAutoRetry: (session, reason) => { cancelled.push({ session, reason }); },
		untrackConnectedSession: (session) => { untracked.push(session); },
	} satisfies SessionLifecycleFenceDeps<FakeSession>;
	return {
		canonical,
		cancelled,
		untracked,
		fence: new SessionLifecycleFence<FakeSession>(deps),
	};
}

describe("SessionLifecycleFence", () => {
	it("starts unknown sessions at generation 0", () => {
		const { fence } = makeHarness();
		assert.equal(fence.currentRespawnGeneration("missing"), 0);
	});

	it("increments and stores per-session generations independently", () => {
		const { fence } = makeHarness();
		assert.equal(fence.nextRespawnGeneration("a"), 1);
		assert.equal(fence.nextRespawnGeneration("a"), 2);
		assert.equal(fence.nextRespawnGeneration("b"), 1);
		assert.equal(fence.currentRespawnGeneration("a"), 2);
		assert.equal(fence.currentRespawnGeneration("b"), 1);
	});

	it("coalesces concurrent restores onto one promise and one generation", async () => {
		const { fence } = makeHarness();
		const gate = deferred<FakeSession>();
		let calls = 0;
		let seenGeneration = 0;

		const first = fence.coalesceRestore("s1", async (generation) => {
			calls++;
			seenGeneration = generation;
			return gate.promise;
		});
		const second = fence.coalesceRestore("s1", async () => {
			throw new Error("must not start a second restore");
		});

		assert.equal(first, second);
		assert.equal(calls, 1);
		assert.equal(seenGeneration, 1);
		assert.equal(fence.restoreCoordinators.get("s1")?.generation, 1);

		const restored = makeSession("s1", 1);
		gate.resolve(restored);
		assert.equal(await first, restored);
		assert.equal(await second, restored);
		assert.equal(fence.restoreCoordinators.has("s1"), false);
	});

	it("clears a coordinator after a failed restore", async () => {
		const { fence } = makeHarness();
		await assert.rejects(
			fence.coalesceRestore("s1", async () => {
				throw new Error("restore failed");
			}),
			/restore failed/,
		);
		assert.equal(fence.restoreCoordinators.has("s1"), false);
	});

	it("allocates a fresh generation after a settled restore", async () => {
		const { fence } = makeHarness();
		await fence.coalesceRestore("s1", async (generation) => makeSession("s1", generation));
		const restored = await fence.coalesceRestore("s1", async (generation) => makeSession("s1", generation));
		assert.equal(restored?.lifecycleGeneration, 2);
		assert.equal(fence.currentRespawnGeneration("s1"), 2);
	});

	it("treats the canonical matching generation as current", () => {
		const { fence, canonical } = makeHarness();
		const session = makeSession("s1", 0);
		canonical.set("s1", session);
		assert.equal(fence.sessionWriterIsCurrent(session), true);
	});

	it("rejects fenced sessions even when generation matches", () => {
		const { fence, canonical } = makeHarness();
		const session = makeSession("s1", 0);
		session.lifecycleFenced = true;
		canonical.set("s1", session);
		assert.equal(fence.sessionWriterIsCurrent(session), false);
	});

	it("rejects non-canonical session objects", () => {
		const { fence, canonical } = makeHarness();
		const stale = makeSession("s1", 0);
		canonical.set("s1", makeSession("s1", 0));
		assert.equal(fence.sessionWriterIsCurrent(stale), false);
	});

	it("rejects stale generations", () => {
		const { fence, canonical } = makeHarness();
		const stale = makeSession("s1", 0);
		canonical.set("s1", stale);
		fence.sessionRespawnGenerations.set("s1", 1);
		assert.equal(fence.sessionWriterIsCurrent(stale), false);
	});

	it("fences a replaced session and runs cleanup callbacks", () => {
		const { fence, cancelled, untracked } = makeHarness();
		const session = makeSession("s1", 4);

		fence.fenceReplacedSession(session, 7);

		assert.equal(session.lifecycleFenced, true);
		assert.equal(session.lifecycleGeneration, 6);
		assert.equal(session.dormant, true);
		assert.equal(session.status, "terminated");
		assert.equal(session.clients.size, 0);
		assert.deepEqual(cancelled, [{ session, reason: "terminated" }]);
		assert.deepEqual(untracked, [session]);
	});
});
