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

	it("increments available on release when no waiters", () => {
		const sem = new Semaphore(2);
		// Release without prior acquire — available goes above initial
		sem.release();
		assert.equal(sem.available, 3);
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
