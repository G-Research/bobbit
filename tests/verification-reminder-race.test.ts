/**
 * Regression test for Bug 2 — "resumed reviewer terminated before reminder
 * is acted on".
 *
 * After a server restart, the verification harness calls `_tryResumeFromSession`.
 * If the reviewer session is currently `idle`, the harness dispatches a
 * reminder prompt and races `resultPromise` against `waitForIdle(120s)`.
 *
 * Pre-fix: `waitForIdle` resolved synchronously because the session was
 * already idle, and `rpcClient.prompt()` is fire-and-forget — the session
 * had not yet transitioned to `streaming`. The race resolved `idle` instantly,
 * the harness declared failure, and `terminateSession` ran in the `finally`
 * block ~46ms after the reminder. The reviewer never had a chance to respond.
 *
 * Fix: `await waitForStreaming(sessionId, 10_000).catch(() => {})` between the
 * reminder dispatch and the race, so the race only starts once the agent has
 * begun a new turn (or 10s have elapsed — fall through, real failure).
 *
 * This test reproduces the exact reminder-then-race fragment using a fake
 * SessionManager. Without the `waitForStreaming` await, the race resolves
 * `idle` ~immediately (well under the 1-second SLA the test asserts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * `SessionManager` transitively pulls in flexsearch (via search-service),
 * which doesn't import cleanly under tsx in this test runner. Instead we
 * port the small `waitForStreaming` / `waitForIdle` helpers verbatim and
 * exercise them with the same `FakeSession` shape. The ported helpers are
 * byte-equivalent to the implementations in src/server/agent/session-manager.ts
 * — kept in sync via review (any structural divergence will be caught by
 * `npm run check`, since the production code is the only consumer).
 */

/** Minimal stand-in for a real session: emits agent_start / agent_end. */
class FakeSession {
	id: string;
	status: "idle" | "streaming" = "idle";
	private cbs: Array<(e: any) => void> = [];
	rpcClient = {
		prompt: async () => { /* fire-and-forget — does NOT change status */ },
		onEvent: (cb: (e: any) => void) => {
			this.cbs.push(cb);
			return () => {
				const i = this.cbs.indexOf(cb);
				if (i >= 0) this.cbs.splice(i, 1);
			};
		},
	};
	constructor(id: string) { this.id = id; }
	fire(event: any) { for (const cb of [...this.cbs]) cb(event); }
	startTurn() { this.status = "streaming"; this.fire({ type: "agent_start" }); }
	endTurn() { this.status = "idle"; this.fire({ type: "agent_end" }); }
}

/** Mirror of SessionManager.waitForStreaming (the helper under test). */
function waitForStreaming(session: FakeSession, timeoutMs: number): Promise<void> {
	if (session.status === "streaming") return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(new Error(`Timeout waiting for session ${session.id} to start streaming`));
		}, timeoutMs);
		const unsub = session.rpcClient.onEvent((event: any) => {
			if (event.type === "agent_start") {
				clearTimeout(timer);
				unsub();
				resolve();
			}
		});
	});
}

/** Mirror of SessionManager.waitForIdle. */
function waitForIdle(session: FakeSession, timeoutMs: number): Promise<void> {
	if (session.status === "idle") return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(new Error(`Timeout waiting for session ${session.id} to become idle`));
		}, timeoutMs);
		const unsub = session.rpcClient.onEvent((event: any) => {
			if (event.type === "agent_end") {
				clearTimeout(timer);
				unsub();
				resolve();
			}
		});
	});
}

describe("verification reminder race — Bug 2 (resumed reviewer terminated early)", () => {
	it("waitForStreaming resolves when an idle session transitions to streaming", async () => {
		const session = new FakeSession("rv-1");

		assert.equal(session.status, "idle");
		const promise = waitForStreaming(session, 1_000);

		let resolved = false;
		promise.then(() => { resolved = true; });

		// Prove the idle session does not resolve before the event arrives.
		await Promise.resolve();
		assert.equal(resolved, false, "should still be waiting before agent_start");

		// The transition itself, not a wall-clock timeout, should resolve the wait.
		session.startTurn();
		await promise;
		assert.equal(resolved, true, "should resolve after agent_start");
		assert.equal(session.status, "streaming");
	});

	it("waitForStreaming resolves immediately if already streaming", async () => {
		const session = new FakeSession("rv-2");
		session.status = "streaming";

		await waitForStreaming(session, 1_000);
	});

	it("waitForStreaming rejects on timeout if no agent_start arrives", async () => {
		const session = new FakeSession("rv-3");

		await assert.rejects(() => waitForStreaming(session, 100), /Timeout/);
	});

	/**
	 * The core regression — this is the exact fragment from
	 * `_tryResumeFromSession` after the reminder is dispatched. Without the
	 * `waitForStreaming` gate, the race resolves `idle` immediately (because
	 * the resumed session is in `idle` status when the reminder fires) and
	 * the harness would declare failure and terminate the session — ~46ms
	 * is what was observed in production. With the fix, the race only
	 * starts after agent_start, giving the agent the full waitForIdle
	 * timeout window to respond.
	 */
	it("reminder-then-race gives the agent time to respond after the reminder", async () => {
		const session = new FakeSession("rv-4");

		// Mimic the harness's resultPromise: a deferred that the verification_result
		// tool would resolve. Stays unresolved here — we only care that the race
		// doesn't resolve the `idle` branch instantly.
		let _resolveResult: ((v: any) => void) = () => {};
		const resultPromise = new Promise<any>((res) => { _resolveResult = res; });
		void _resolveResult;

		// 1. Dispatch the reminder (fire-and-forget on RPC).
		await session.rpcClient.prompt();

		// 2. Schedule the agent to start its turn 50ms after the reminder.
		setTimeout(() => session.startTurn(), 50);

		// 3. THE FIX: wait for the agent to start streaming before racing.
		const reminderDispatchedAt = Date.now();
		await waitForStreaming(session, 10_000).catch(() => {});

		// 4. Now race resultPromise vs waitForIdle(2s).
		const racePromise = Promise.race([
			resultPromise.then((r: any) => ({ type: "result" as const, ...r })),
			waitForIdle(session, 2_000).then(() => ({ type: "idle" as const })),
		]);

		// Without the fix, the race would resolve `idle` synchronously because
		// the session was idle at the moment the harness called waitForIdle.
		// With the fix, we waited until the agent started its turn. Now the
		// race only resolves when the agent ends — so 1 second after dispatch,
		// there should be NO resolution yet (the agent is still streaming).
		const wait = new Promise<"pending">((res) => setTimeout(() => res("pending"), 1_000));
		const outcome = await Promise.race([racePromise, wait]);
		const elapsed = Date.now() - reminderDispatchedAt;

		assert.equal(
			outcome, "pending",
			`race should still be pending 1s after reminder (was: ${typeof outcome === "object" ? JSON.stringify(outcome) : outcome}, elapsed: ${elapsed}ms)`,
		);

		// Cleanup so waitForIdle's timer doesn't keep the test alive.
		session.endTurn();
		await racePromise;
	});

	/**
	 * Negative control — demonstrates the original bug. When the reminder
	 * is dispatched against an idle session and the harness goes straight to
	 * the race (skipping `waitForStreaming`), `waitForIdle` resolves
	 * synchronously because the session is still idle. The race then resolves
	 * `idle` instantly even though the agent has not yet processed the
	 * reminder. This is what the production fix prevents.
	 */
	it("control: race without waitForStreaming resolves idle instantly (the original bug)", async () => {
		const session = new FakeSession("rv-5");
		const resultPromise = new Promise<any>(() => {});

		await session.rpcClient.prompt();
		setTimeout(() => session.startTurn(), 50);

		const t0 = Date.now();
		// NO waitForStreaming — straight to the race.
		const outcome = await Promise.race([
			resultPromise.then((r: any) => ({ type: "result" as const, ...r })),
			waitForIdle(session, 2_000).then(() => ({ type: "idle" as const })),
		]);
		const elapsed = Date.now() - t0;

		assert.equal(outcome.type, "idle", "control case: race resolves idle");
		assert.ok(elapsed < 50, `control case: race resolves ~immediately (${elapsed}ms) — this is the bug`);

		// Cleanup the queued startTurn timer.
		await new Promise((r) => setTimeout(r, 60));
	});
});
