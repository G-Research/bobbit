import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/server/agent/semaphore.js";

describe("Semaphore", () => {
	it("allows up to N concurrent acquires", async () => {
		const sem = new Semaphore(2);
		assert.equal(sem.available, 2);
		assert.equal(sem.waiting, 0);

		await sem.acquire();
		assert.equal(sem.available, 1);

		await sem.acquire();
		assert.equal(sem.available, 0);
	});

	it("blocks the (N+1)th acquire until release", async () => {
		const sem = new Semaphore(2);
		await sem.acquire();
		await sem.acquire();

		let thirdResolved = false;
		const thirdPromise = sem.acquire().then(() => { thirdResolved = true; });

		// The third acquire should be waiting
		assert.equal(sem.waiting, 1);
		assert.equal(thirdResolved, false);

		// Release one slot — the third acquire should resolve
		sem.release();
		await thirdPromise;
		assert.equal(thirdResolved, true);
		assert.equal(sem.waiting, 0);
		assert.equal(sem.available, 0); // all slots still in use
	});

	it("maintains FIFO ordering of waiters", async () => {
		const sem = new Semaphore(1);
		await sem.acquire(); // take the only slot

		const order: number[] = [];

		const p1 = sem.acquire().then(() => { order.push(1); });
		const p2 = sem.acquire().then(() => { order.push(2); });
		const p3 = sem.acquire().then(() => { order.push(3); });

		assert.equal(sem.waiting, 3);

		// Release one at a time and verify FIFO
		sem.release();
		await p1;
		assert.deepEqual(order, [1]);

		sem.release();
		await p2;
		assert.deepEqual(order, [1, 2]);

		sem.release();
		await p3;
		assert.deepEqual(order, [1, 2, 3]);
	});

	it("throws on over-release when no waiters", () => {
		const sem = new Semaphore(2);
		// Release without prior acquire — should throw instead of exceeding capacity
		assert.throws(() => sem.release(), {
			message: /Semaphore over-release/,
		});
	});

	it("handles acquire-release cycles correctly", async () => {
		const sem = new Semaphore(1);

		await sem.acquire();
		assert.equal(sem.available, 0);

		sem.release();
		assert.equal(sem.available, 1);

		await sem.acquire();
		assert.equal(sem.available, 0);

		sem.release();
		assert.equal(sem.available, 1);
	});
});

// C2 — live resize so PATCH /policy can re-cap the per-root subgoal
// semaphore without a restart.
describe("Semaphore.resize (C2)", () => {
	it("grows available slots when nothing is held", () => {
		const sem = new Semaphore(1);
		assert.equal(sem.available, 1);
		sem.resize(3);
		assert.equal(sem.capacity, 3);
		assert.equal(sem.available, 3);
	});

	it("shrinks available slots when nothing is held", () => {
		const sem = new Semaphore(3);
		sem.resize(1);
		assert.equal(sem.capacity, 1);
		assert.equal(sem.available, 1);
	});

	it("a lowered cap takes effect on the next acquire (3→1 with one held)", async () => {
		const sem = new Semaphore(3);
		await sem.acquire(); // 1 held, 2 available
		assert.equal(sem.available, 2);
		sem.resize(1); // cap now 1; 1 already held → 0 available
		assert.equal(sem.available, 0);

		// A new acquire must block until the in-flight holder releases.
		let acquired = false;
		const p = sem.acquire().then(() => { acquired = true; });
		assert.equal(sem.waiting, 1);
		assert.equal(acquired, false);

		sem.release(); // in-flight holder finishes — hands its slot to the waiter
		await p;
		assert.equal(acquired, true);
		assert.equal(sem.available, 0); // still saturated at cap=1
	});

	it("shrinking below held count creates debt absorbed on release (no over-release throw)", async () => {
		const sem = new Semaphore(3);
		await sem.acquire();
		await sem.acquire();
		await sem.acquire(); // 3 held, 0 available, no waiters
		sem.resize(1); // cap=1, 3 held → debt=2
		assert.equal(sem.available, 0);

		// Three releases: first two pay debt (stay at 0), third frees the single slot.
		sem.release();
		assert.equal(sem.available, 0);
		sem.release();
		assert.equal(sem.available, 0);
		sem.release();
		assert.equal(sem.available, 1);
		// Back to a clean state at the new capacity — over-release still throws.
		assert.throws(() => sem.release(), { message: /over-release/ });
	});

	it("pays down debt before waking waiters on a live shrink (cap 3, 3 held, 1 waiting → 1)", async () => {
		const sem = new Semaphore(3);
		await sem.acquire();
		await sem.acquire();
		await sem.acquire(); // 3 held, 0 available

		// A fourth acquire queues up as a waiter while still at cap 3.
		let woken = false;
		const p = sem.acquire().then(() => { woken = true; });
		assert.equal(sem.waiting, 1);

		// Live shrink to 1: 3 held + 1 waiter against cap=1.
		// Held=3 exceeds cap by 2 → debt=2. The slot that the waiter wanted is
		// also over the cap, so debt must be paid before the waiter is woken.
		sem.resize(1);
		assert.equal(sem.capacity, 1);
		assert.equal(sem.available, 0);

		// First release pays debt (2→1); waiter must NOT wake — still over-subscribed.
		sem.release();
		assert.equal(woken, false);
		assert.equal(sem.waiting, 1);
		assert.equal(sem.available, 0);

		// Second release pays the last debt (1→0); waiter still must NOT wake yet
		// because the released permit was consumed by debt, not handed onward.
		sem.release();
		assert.equal(woken, false);
		assert.equal(sem.waiting, 1);
		assert.equal(sem.available, 0);

		// Third release: debt is clear, so the queued waiter finally wakes,
		// staying saturated at the new cap of 1.
		sem.release();
		await p;
		assert.equal(woken, true);
		assert.equal(sem.waiting, 0);
		assert.equal(sem.available, 0);
	});

	it("growing wakes blocked waiters before crediting available slots", async () => {
		const sem = new Semaphore(1);
		await sem.acquire(); // 1 held, 0 available
		let w1 = false, w2 = false;
		const p1 = sem.acquire().then(() => { w1 = true; });
		const p2 = sem.acquire().then(() => { w2 = true; });
		assert.equal(sem.waiting, 2);

		sem.resize(3); // +2 capacity → both waiters wake, available stays 0
		await Promise.all([p1, p2]);
		assert.equal(w1, true);
		assert.equal(w2, true);
		assert.equal(sem.waiting, 0);
		assert.equal(sem.available, 0); // 3 held (1 original + 2 woken), cap 3
	});

	it("floors fractional and clamps sub-1 capacities", () => {
		const sem = new Semaphore(2);
		sem.resize(1.9);
		assert.equal(sem.capacity, 1);
		sem.resize(0);
		assert.equal(sem.capacity, 1);
	});
});
