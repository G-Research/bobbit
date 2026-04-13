import { test, expect } from "@playwright/test";
import { PromptQueue } from "../dist/server/agent/prompt-queue.js";

test.describe("PromptQueue", () => {
	test("enqueue basics: adds messages, toArray returns in order, length/isEmpty correct", () => {
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

	test("dequeue returns front message and removes it; empty returns undefined", () => {
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

	test("steer reordering: steered messages sort before non-steered, stable within groups", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		// Steer C → [C, A, B]
		expect(q.steer(c.id)).toBe(true);
		expect(q.toArray().map(m => m.text)).toEqual(["C", "A", "B"]);

		// Steer B → [C, B, A]
		expect(q.steer(b.id)).toBe(true);
		expect(q.toArray().map(m => m.text)).toEqual(["C", "B", "A"]);
	});

	test("steer already-steered returns true without reordering", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		const b = q.enqueue("B");

		q.steer(b.id);
		const orderBefore = q.toArray().map(m => m.text);

		expect(q.steer(b.id)).toBe(true);
		expect(q.toArray().map(m => m.text)).toEqual(orderBefore);
	});

	test("steer nonexistent ID returns false", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		expect(q.steer("nonexistent-id")).toBe(false);
	});

	test("remove: removes middle message, correct order; nonexistent returns false", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		expect(q.remove(b.id)).toBe(true);
		expect(q.length).toBe(2);
		expect(q.toArray().map(m => m.text)).toEqual(["A", "C"]);

		expect(q.remove("nonexistent-id")).toBe(false);
	});

	test("enqueue with isSteered:true puts it ahead of non-steered", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		q.enqueue("B");
		q.enqueue("S", { isSteered: true });

		expect(q.toArray().map(m => m.text)).toEqual(["S", "A", "B"]);
		expect(q.toArray()[0].isSteered).toBe(true);
	});

	test("constructor restore: initial array populates the queue", () => {
		const initial = [
			{ id: "1", text: "X", isSteered: false, createdAt: 1000 },
			{ id: "2", text: "Y", isSteered: true, createdAt: 2000 },
		];
		const q = new PromptQueue(initial);
		expect(q.length).toBe(2);
		expect(q.toArray().map(m => m.text)).toEqual(["X", "Y"]);

		// Mutating original does not affect the queue (defensive copy)
		initial.push({ id: "3", text: "Z", isSteered: false, createdAt: 3000 });
		expect(q.length).toBe(2);
	});

	test("mixed operations: enqueue, steer, dequeue sequence", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		// Steer B
		q.steer(b.id);
		expect(q.toArray().map(m => m.text)).toEqual(["B", "A", "C"]);

		// Dequeue should get B (the steered one)
		const first = q.dequeue();
		expect(first?.text).toBe("B");
		expect(first?.isSteered).toBe(true);

		// Next dequeue gets A
		const second = q.dequeue();
		expect(second?.text).toBe("A");

		// Then C
		const third = q.dequeue();
		expect(third?.text).toBe("C");

		expect(q.isEmpty).toBe(true);
	});

	test("steer ordering matches spec: steers in order they were steered", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		// Steer C first, then B
		q.steer(c.id);
		q.steer(b.id);

		// C was steered first so it's ahead of B; A remains at back
		expect(q.toArray().map(m => m.text)).toEqual(["C", "B", "A"]);
		expect(q.toArray().map(m => m.isSteered)).toEqual([true, true, false]);
	});

	test("peek returns front without removing", () => {
		const q = new PromptQueue();
		expect(q.peek()).toBeUndefined();

		q.enqueue("A");
		q.enqueue("B");

		expect(q.peek()?.text).toBe("A");
		expect(q.length).toBe(2); // not removed
	});

	test("enqueue returns the queued message with correct fields", () => {
		const q = new PromptQueue();
		const msg = q.enqueue("hello", { isSteered: true });

		expect(msg.text).toBe("hello");
		expect(msg.isSteered).toBe(true);
		expect(typeof msg.id).toBe("string");
		expect(typeof msg.createdAt).toBe("number");
	});

	test("toArray returns a copy, not the internal array", () => {
		const q = new PromptQueue();
		q.enqueue("A");

		const arr = q.toArray();
		arr.push({ id: "fake", text: "fake", isSteered: false, createdAt: 0 });

		expect(q.length).toBe(1); // internal not affected
	});

	test("reorderByIds with valid IDs produces correct order", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		q.reorderByIds([c.id, a.id, b.id]);
		expect(q.toArray().map(m => m.text)).toEqual(["C", "A", "B"]);
	});

	test("reorderByIds with unknown IDs — ignored", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");

		q.reorderByIds(["unknown-id", a.id, b.id]);
		expect(q.toArray().map(m => m.text)).toEqual(["A", "B"]);
		expect(q.length).toBe(2);
	});

	test("reorderByIds with partial ID list — unlisted items appended at end", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		q.reorderByIds([c.id]); // only C specified
		expect(q.toArray().map(m => m.text)).toEqual(["C", "A", "B"]);
	});

	test("reorderByIds with empty array — all items preserved at end", () => {
		const q = new PromptQueue();
		q.enqueue("A");
		q.enqueue("B");
		q.enqueue("C");

		q.reorderByIds([]);
		expect(q.toArray().map(m => m.text)).toEqual(["A", "B", "C"]);
		expect(q.length).toBe(3);
	});

});
