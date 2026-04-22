/**
 * Unit tests for EventBuffer — circular buffer for agent event replay with
 * monotonic per-session seq numbers and logical timestamps. See
 * docs/design/streaming-dedup-reorder.md for the seq/ts contract.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import { EventBuffer } from "../src/server/agent/event-buffer.ts";

// Helper — the old tests were written against a getAll() that returned raw
// events. Post-fix getAll() returns {seq,ts,event} tuples; unwrap for the
// legacy assertions.
function events(buf: EventBuffer) {
	return buf.getAll().map(e => e.event);
}

describe("EventBuffer", () => {
	describe("construction", () => {
		it("creates an empty buffer with default capacity", () => {
			const buf = new EventBuffer();
			assert.equal(buf.size, 0);
			assert.deepEqual(buf.getAll(), []);
			assert.equal(buf.lastSeq, 0);
		});

		it("creates an empty buffer with custom capacity", () => {
			const buf = new EventBuffer(5);
			assert.equal(buf.size, 0);
		});
	});

	describe("push and getAll", () => {
		it("stores a single event", () => {
			const buf = new EventBuffer(10);
			buf.push({ type: "msg", data: "hello" });
			assert.equal(buf.size, 1);
			assert.deepEqual(events(buf), [{ type: "msg", data: "hello" }]);
		});

		it("stores multiple events in order", () => {
			const buf = new EventBuffer(10);
			buf.push("a");
			buf.push("b");
			buf.push("c");
			assert.equal(buf.size, 3);
			assert.deepEqual(events(buf), ["a", "b", "c"]);
		});

		it("handles various event types (objects, strings, numbers, null)", () => {
			const buf = new EventBuffer(10);
			buf.push({ x: 1 });
			buf.push("text");
			buf.push(42);
			buf.push(null);
			assert.equal(buf.size, 4);
			assert.deepEqual(events(buf), [{ x: 1 }, "text", 42, null]);
		});
	});

	describe("overflow / circular behavior", () => {
		it("drops oldest events when exceeding capacity", () => {
			const buf = new EventBuffer(3);
			buf.push("a");
			buf.push("b");
			buf.push("c");
			buf.push("d"); // should drop "a"
			assert.equal(buf.size, 3);
			assert.deepEqual(events(buf), ["b", "c", "d"]);
		});

		it("handles heavy overflow correctly", () => {
			const buf = new EventBuffer(3);
			for (let i = 0; i < 100; i++) {
				buf.push(i);
			}
			assert.equal(buf.size, 3);
			assert.deepEqual(events(buf), [97, 98, 99]);
		});

		it("fills exactly to capacity without dropping", () => {
			const buf = new EventBuffer(5);
			for (let i = 0; i < 5; i++) buf.push(i);
			assert.equal(buf.size, 5);
			assert.deepEqual(events(buf), [0, 1, 2, 3, 4]);
		});

		it("drops exactly one event when one over capacity", () => {
			const buf = new EventBuffer(5);
			for (let i = 0; i < 6; i++) buf.push(i);
			assert.equal(buf.size, 5);
			assert.deepEqual(events(buf), [1, 2, 3, 4, 5]);
		});

		it("works with capacity of 1", () => {
			const buf = new EventBuffer(1);
			buf.push("first");
			assert.deepEqual(events(buf), ["first"]);
			buf.push("second");
			assert.deepEqual(events(buf), ["second"]);
			assert.equal(buf.size, 1);
		});
	});

	describe("getAll returns a copy", () => {
		it("modifying returned array does not affect buffer", () => {
			const buf = new EventBuffer(10);
			buf.push("a");
			buf.push("b");
			const arr = buf.getAll();
			arr.pop();
			arr.length = 0;
			assert.deepEqual(events(buf), ["a", "b"]);
		});
	});

	describe("clear", () => {
		it("empties the buffer and resets seq", () => {
			const buf = new EventBuffer(10);
			buf.push("a");
			buf.push("b");
			buf.clear();
			assert.equal(buf.size, 0);
			assert.deepEqual(buf.getAll(), []);
			assert.equal(buf.lastSeq, 0);
			const entry = buf.push("x");
			assert.equal(entry.seq, 1);
		});

		it("allows adding events after clear", () => {
			const buf = new EventBuffer(3);
			buf.push("a");
			buf.push("b");
			buf.clear();
			buf.push("x");
			assert.equal(buf.size, 1);
			assert.deepEqual(events(buf), ["x"]);
		});
	});

	describe("size property", () => {
		it("tracks size accurately through adds and overflows", () => {
			const buf = new EventBuffer(3);
			assert.equal(buf.size, 0);
			buf.push(1);
			assert.equal(buf.size, 1);
			buf.push(2);
			assert.equal(buf.size, 2);
			buf.push(3);
			assert.equal(buf.size, 3);
			buf.push(4); // overflow
			assert.equal(buf.size, 3);
		});
	});
});

// ── Sequence / timestamp / resume-catch-up contract ─────────────────────────

test("EventBuffer.push assigns monotonic seq starting at 1", () => {
	const buf = new EventBuffer();
	const a = buf.push({ type: "x" });
	const b = buf.push({ type: "y" });
	const c = buf.push({ type: "z" });
	assert.equal(a.seq, 1);
	assert.equal(b.seq, 2);
	assert.equal(c.seq, 3);
	assert.equal(buf.lastSeq, 3);
	assert.equal(buf.size, 3);
	assert.ok(typeof a.ts === "number" && a.ts > 0);
});

test("EventBuffer eviction: after 1001 pushes the oldest retained entry has seq 2", () => {
	const buf = new EventBuffer(1000);
	for (let i = 0; i < 1001; i++) buf.push({ i });
	assert.equal(buf.size, 1000);
	const all = buf.getAll();
	assert.equal(all[0].seq, 2);
	assert.equal(all[all.length - 1].seq, 1001);
	assert.equal(buf.lastSeq, 1001);
});

test("EventBuffer.since(N) returns entries with seq > N", () => {
	const buf = new EventBuffer();
	for (let i = 0; i < 5; i++) buf.push({ i });
	const tail = buf.since(2);
	assert.deepEqual(tail.map(e => e.seq), [3, 4, 5]);
	assert.deepEqual(buf.since(5), []);
	assert.deepEqual(buf.since(0).map(e => e.seq), [1, 2, 3, 4, 5]);
});

test("EventBuffer.canResumeFrom respects the retained window", () => {
	const buf = new EventBuffer(3);
	for (let i = 0; i < 5; i++) buf.push({ i }); // retains seqs 3,4,5
	assert.equal(buf.canResumeFrom(5), true);   // client caught up
	assert.equal(buf.canResumeFrom(4), true);   // need 5 — retained
	assert.equal(buf.canResumeFrom(2), true);   // need 3 — oldest retained
	assert.equal(buf.canResumeFrom(1), false);  // need 2 — evicted
	assert.equal(buf.canResumeFrom(0), false);
});

test("EventBuffer.canResumeFrom on empty buffer allows only caught-up clients", () => {
	const buf = new EventBuffer();
	assert.equal(buf.canResumeFrom(0), true);  // lastSeq=0, client caught up
	assert.equal(buf.canResumeFrom(5), false); // client ahead of us → mismatch
});
