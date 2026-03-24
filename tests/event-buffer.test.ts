/**
 * Unit tests for EventBuffer — circular buffer for agent event replay.
 * Pure in-memory logic, no I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EventBuffer } from "../src/server/agent/event-buffer.ts";

describe("EventBuffer", () => {
	describe("construction", () => {
		it("creates an empty buffer with default capacity", () => {
			const buf = new EventBuffer();
			assert.equal(buf.size, 0);
			assert.deepEqual(buf.getAll(), []);
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
			assert.deepEqual(buf.getAll(), [{ type: "msg", data: "hello" }]);
		});

		it("stores multiple events in order", () => {
			const buf = new EventBuffer(10);
			buf.push("a");
			buf.push("b");
			buf.push("c");
			assert.equal(buf.size, 3);
			assert.deepEqual(buf.getAll(), ["a", "b", "c"]);
		});

		it("handles various event types (objects, strings, numbers, null)", () => {
			const buf = new EventBuffer(10);
			buf.push({ x: 1 });
			buf.push("text");
			buf.push(42);
			buf.push(null);
			assert.equal(buf.size, 4);
			assert.deepEqual(buf.getAll(), [{ x: 1 }, "text", 42, null]);
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
			assert.deepEqual(buf.getAll(), ["b", "c", "d"]);
		});

		it("handles heavy overflow correctly", () => {
			const buf = new EventBuffer(3);
			for (let i = 0; i < 100; i++) {
				buf.push(i);
			}
			assert.equal(buf.size, 3);
			assert.deepEqual(buf.getAll(), [97, 98, 99]);
		});

		it("fills exactly to capacity without dropping", () => {
			const buf = new EventBuffer(5);
			for (let i = 0; i < 5; i++) {
				buf.push(i);
			}
			assert.equal(buf.size, 5);
			assert.deepEqual(buf.getAll(), [0, 1, 2, 3, 4]);
		});

		it("drops exactly one event when one over capacity", () => {
			const buf = new EventBuffer(5);
			for (let i = 0; i < 6; i++) {
				buf.push(i);
			}
			assert.equal(buf.size, 5);
			assert.deepEqual(buf.getAll(), [1, 2, 3, 4, 5]);
		});

		it("works with capacity of 1", () => {
			const buf = new EventBuffer(1);
			buf.push("first");
			assert.deepEqual(buf.getAll(), ["first"]);
			buf.push("second");
			assert.deepEqual(buf.getAll(), ["second"]);
			assert.equal(buf.size, 1);
		});
	});

	describe("getAll returns a copy", () => {
		it("modifying returned array does not affect buffer", () => {
			const buf = new EventBuffer(10);
			buf.push("a");
			buf.push("b");
			const arr = buf.getAll();
			arr.push("c");
			arr[0] = "modified";
			assert.deepEqual(buf.getAll(), ["a", "b"]);
		});
	});

	describe("clear", () => {
		it("empties the buffer", () => {
			const buf = new EventBuffer(10);
			buf.push("a");
			buf.push("b");
			buf.clear();
			assert.equal(buf.size, 0);
			assert.deepEqual(buf.getAll(), []);
		});

		it("allows adding events after clear", () => {
			const buf = new EventBuffer(3);
			buf.push("a");
			buf.push("b");
			buf.clear();
			buf.push("x");
			assert.equal(buf.size, 1);
			assert.deepEqual(buf.getAll(), ["x"]);
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
