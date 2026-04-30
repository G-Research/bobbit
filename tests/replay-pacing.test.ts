/**
 * Unit tests for paceAndSend (src/server/replay-pacing.ts).
 *
 * The BOBBIT_E2E-only replay-buffered-events endpoint uses paceAndSend to
 * cooperatively yield while a WS client's bufferedAmount is high, so we don't
 * trip the production broadcast() 4 MiB overflow guard during ST-DEDUP-01.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paceAndSend, PACE_THRESHOLD_BYTES } from "../src/server/replay-pacing.js";

interface FakeClient {
	readyState: number;
	bufferedAmount: number;
	send(d: string): void;
	terminate(): void;
	sendCount: number;
	terminateCount: number;
}

function makeClient(opts: { readyState?: number; bufferedAmount?: number } = {}): FakeClient {
	const c: FakeClient = {
		readyState: opts.readyState ?? 1,
		bufferedAmount: opts.bufferedAmount ?? 0,
		sendCount: 0,
		terminateCount: 0,
		send(_d: string) { this.sendCount++; },
		terminate() { this.terminateCount++; },
	};
	return c;
}

describe("paceAndSend", () => {
	it("fast client: sends once with no sleep", async () => {
		const c = makeClient({ bufferedAmount: 0 });
		let sleeps = 0;
		const sleep = async (_ms: number) => { sleeps++; };
		await paceAndSend(c, "x", Date.now() + 2000, sleep);
		assert.equal(c.sendCount, 1);
		assert.equal(c.terminateCount, 0);
		assert.equal(sleeps, 0);
	});

	it("slow client: drains after a few ticks, sends once, never terminates", async () => {
		const c = makeClient({ bufferedAmount: PACE_THRESHOLD_BYTES + 1 });
		let sleeps = 0;
		const sleep = async (_ms: number) => {
			sleeps++;
			if (sleeps >= 5) c.bufferedAmount = 0;
		};
		await paceAndSend(c, "payload", Date.now() + 2000, sleep);
		assert.equal(c.sendCount, 1);
		assert.equal(c.terminateCount, 0);
		assert.equal(sleeps, 5);
	});

	it("stuck client: deadline elapses, send still called once, no throw, no terminate", async () => {
		const c = makeClient({ bufferedAmount: PACE_THRESHOLD_BYTES * 10 });
		// Fake clock: monotonically advances past the deadline as sleep is called.
		const realNow = Date.now;
		let virtual = 1_000_000;
		(Date as any).now = () => virtual;
		try {
			const deadline = virtual + 2000;
			let sleeps = 0;
			const sleep = async (ms: number) => {
				sleeps++;
				virtual += ms;
				// bufferedAmount stays high — client never drains.
			};
			await paceAndSend(c, "payload", deadline, sleep);
			assert.equal(c.sendCount, 1, "send is best-effort once after wait cap");
			assert.equal(c.terminateCount, 0);
			assert.ok(sleeps > 0, "should have slept at least once");
			assert.ok(virtual >= deadline, "virtual clock should reach deadline");
		} finally {
			(Date as any).now = realNow;
		}
	});

	it("closed client: returns without sending or sleeping, no throw", async () => {
		const c = makeClient({ readyState: 3, bufferedAmount: 0 });
		let sleeps = 0;
		const sleep = async (_ms: number) => { sleeps++; };
		await paceAndSend(c, "x", Date.now() + 2000, sleep);
		assert.equal(c.sendCount, 0);
		assert.equal(c.terminateCount, 0);
		assert.equal(sleeps, 0);
	});
});
