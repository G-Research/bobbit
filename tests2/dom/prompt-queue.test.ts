import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/prompt-queue.spec.ts (v2-dom tier).
// Pure-logic port: imports the REAL PromptQueue class directly (the legacy spec
// already imported it from src, no fixture DOM). No DOM/geometry involved; the
// bridge import is present for tier uniformity per the migration guide.
import { describe, expect, it } from "vitest";
import { PromptQueue } from "../../src/server/agent/prompt-queue.js";

describe("PromptQueue", () => {
	it("enqueue basics: adds messages, toArray returns in order, length/isEmpty correct", () => {
		const q = new PromptQueue();
		expect(q.isEmpty).toBe(true);
		expect(q.length).toBe(0);
		expect(q.toArray()).toEqual([]);

		q.enqueue("A");
		q.enqueue("B");
		q.enqueue("C");

		expect(q.isEmpty).toBe(false);
		expect(q.length).toBe(3);

		const arr = q.toArray();
		expect(arr.map(m => m.text)).toEqual(["A", "B", "C"]);
		expect(arr.every(m => !m.isSteered)).toBe(true);
		expect(arr.every(m => typeof m.id === "string" && m.id.length > 0)).toBe(true);
		expect(arr.every(m => typeof m.createdAt === "number")).toBe(true);
	});

	it("dequeue returns front message and removes it; empty returns undefined", () => {
		const q = new PromptQueue();
		expect(q.dequeue()).toBeUndefined();

		q.enqueue("A");
		q.enqueue("B");

		const first = q.dequeue();
		expect(first?.text).toBe("A");
		expect(q.length).toBe(1);

		const second = q.dequeue();
		expect(second?.text).toBe("B");
		expect(q.length).toBe(0);

		expect(q.dequeue()).toBeUndefined();
	});

	it("steer reordering: steered messages sort before non-steered, stable within groups", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		expect(q.steer(c.id)).toBe(true);
		expect(q.toArray().map(m => m.text)).toEqual(["C", "A", "B"]);

		expect(q.steer(b.id)).toBe(true);
		expect(q.toArray().map(m => m.text)).toEqual(["C", "B", "A"]);
	});

	it("steer already-steered returns true without reordering", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		const b = q.enqueue("B");

		q.steer(b.id);
		const orderBefore = q.toArray().map(m => m.text);

		expect(q.steer(b.id)).toBe(true);
		expect(q.toArray().map(m => m.text)).toEqual(orderBefore);
	});

	it("steer nonexistent ID returns false", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		expect(q.steer("nonexistent-id")).toBe(false);
	});

	it("remove: removes middle message, correct order; nonexistent returns false", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		const b = q.enqueue("B");
		q.enqueue("C");

		expect(q.remove(b.id)).toBe(true);
		expect(q.length).toBe(2);
		expect(q.toArray().map(m => m.text)).toEqual(["A", "C"]);

		expect(q.remove("nonexistent-id")).toBe(false);
	});

	it("enqueue with isSteered:true puts it ahead of non-steered", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		q.enqueue("B");
		q.enqueue("S", { isSteered: true });

		expect(q.toArray().map(m => m.text)).toEqual(["S", "A", "B"]);
		expect(q.toArray()[0].isSteered).toBe(true);
	});

	it("constructor restore: initial array populates the queue", () => {
		const initial = [
			{ id: "1", text: "X", isSteered: false, createdAt: 1000 },
			{ id: "2", text: "Y", isSteered: true, createdAt: 2000 },
		];
		const q = new PromptQueue(initial);
		expect(q.length).toBe(2);
		expect(q.toArray().map(m => m.text)).toEqual(["X", "Y"]);

		initial.push({ id: "3", text: "Z", isSteered: false, createdAt: 3000 });
		expect(q.length).toBe(2);
	});

	it("mixed operations: enqueue, steer, dequeue sequence", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		const b = q.enqueue("B");
		q.enqueue("C");

		q.steer(b.id);
		expect(q.toArray().map(m => m.text)).toEqual(["B", "A", "C"]);

		const first = q.dequeue();
		expect(first?.text).toBe("B");
		expect(first?.isSteered).toBe(true);

		const second = q.dequeue();
		expect(second?.text).toBe("A");

		const third = q.dequeue();
		expect(third?.text).toBe("C");

		expect(q.isEmpty).toBe(true);
	});

	it("steer ordering matches spec: steers in order they were steered", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		q.steer(c.id);
		q.steer(b.id);

		expect(q.toArray().map(m => m.text)).toEqual(["C", "B", "A"]);
		expect(q.toArray().map(m => m.isSteered)).toEqual([true, true, false]);
	});

	it("peek returns front without removing", () => {
		const q = new PromptQueue();
		expect(q.peek()).toBeUndefined();

		q.enqueue("A");
		q.enqueue("B");

		expect(q.peek()?.text).toBe("A");
		expect(q.length).toBe(2);
	});

	it("enqueue returns the queued message with correct fields", () => {
		const q = new PromptQueue();
		const msg = q.enqueue("hello", { isSteered: true });

		expect(msg.text).toBe("hello");
		expect(msg.isSteered).toBe(true);
		expect(typeof msg.id).toBe("string");
		expect(typeof msg.createdAt).toBe("number");
	});

	it("toArray returns a copy, not the internal array", () => {
		const q = new PromptQueue();
		q.enqueue("A");

		const arr = q.toArray();
		arr.push({ id: "fake", text: "fake", isSteered: false, createdAt: 0 });

		expect(q.length).toBe(1);
	});

	it("reorderByIds with valid IDs produces correct order", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		q.reorderByIds([c.id, a.id, b.id]);
		expect(q.toArray().map(m => m.text)).toEqual(["C", "A", "B"]);
	});

	it("reorderByIds with unknown IDs — ignored", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");

		q.reorderByIds(["unknown-id", a.id, b.id]);
		expect(q.toArray().map(m => m.text)).toEqual(["A", "B"]);
		expect(q.length).toBe(2);
	});

	it("reorderByIds with partial ID list — unlisted items appended at end", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		q.enqueue("B");
		const c = q.enqueue("C");

		q.reorderByIds([c.id]);
		expect(q.toArray().map(m => m.text)).toEqual(["C", "A", "B"]);
	});

	it("reorderByIds with empty array — all items preserved at end", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		q.enqueue("B");
		q.enqueue("C");

		q.reorderByIds([]);
		expect(q.toArray().map(m => m.text)).toEqual(["A", "B", "C"]);
		expect(q.length).toBe(3);
	});
});

describe("enqueueAtFront", () => {
	it("inserts at index 0 of an empty queue", () => {
		const q = new PromptQueue();
		const m = q.enqueueAtFront("X");
		expect(q.length).toBe(1);
		expect(q.toArray()[0].id).toBe(m.id);
		expect(q.toArray()[0].text).toBe("X");
	});

	it("steered enqueueAtFront stays first when followed by a normal enqueue", () => {
		const q = new PromptQueue();
		const s = q.enqueueAtFront("S", { isSteered: true });
		q.enqueue("Normal");
		const arr = q.toArray();
		expect(arr.map(m => m.text)).toEqual(["S", "Normal"]);
		expect(arr[0].id).toBe(s.id);
		expect(arr[0].isSteered).toBe(true);
	});

	it("multiple enqueueAtFront calls preserve REVERSE insertion order", () => {
		const q = new PromptQueue();
		q.enqueue("existing");
		const first = q.enqueueAtFront("first");
		const second = q.enqueueAtFront("second");
		const third = q.enqueueAtFront("third");
		const arr = q.toArray();
		expect(arr.map(m => m.text)).toEqual(["third", "second", "first", "existing"]);
		expect(arr[0].id).toBe(third.id);
		expect(arr[1].id).toBe(second.id);
		expect(arr[2].id).toBe(first.id);
	});
});
