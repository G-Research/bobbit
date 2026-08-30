import { describe, expect, it } from "vitest";
import { PromptQueue } from "../../../src/server/agent/prompt-queue.js";
import { intentRow } from "../../../tests2/core/helpers/reliable-intent-fixture.js";

function queueApi(queue: PromptQueue): any {
	return queue as any;
}

describe("reliable intent queue identity and restore contract", () => {
	it("keeps identical text as distinct occurrences with caller-provided stable IDs", () => {
		const queue = new PromptQueue();
		queueApi(queue).enqueueExisting(intentRow({ id: "intent-A", text: "same text", sequence: 1 }));
		queueApi(queue).enqueueExisting(intentRow({ id: "intent-B", text: "same text", sequence: 2 }));

		expect(queue.toArray().map((row: any) => [row.id, row.text])).toEqual([
			["intent-A", "same text"],
			["intent-B", "same text"],
		]);
	});

	it("makes retransmission of one accepted occurrence idempotent without text deduplication", () => {
		const queue = new PromptQueue();
		const first = intentRow({ id: "intent-replayed", text: "repeat me", sequence: 7 });
		const accepted = queueApi(queue).enqueueExisting(first);
		const replayed = queueApi(queue).enqueueExisting({ ...first });

		expect(replayed.id).toBe(accepted.id);
		expect(queue.toArray()).toHaveLength(1);
		expect(queue.toArray()[0]).toMatchObject(first);
	});

	it("preserves occurrence, lane, delivery state, author, and attachments across persisted restore", () => {
		const persisted = intentRow({
			id: "intent-restored",
			text: "restore exact row",
			kind: "steer",
			targetTurn: "continuation",
			sequence: 41,
			deliveryState: "uncertain",
			images: [{ type: "image", data: "fixture-image", mimeType: "image/png" }],
			attachments: [{ name: "fixture.txt" }],
			source: "agent",
			author: { kind: "agent", id: "session:caller", label: "Caller" },
		});

		const restored = new PromptQueue([persisted] as any).toArray()[0] as any;

		expect(restored).toEqual(persisted);
	});

	it("re-enqueues a failed occurrence at the front without minting a new identity or sequence", () => {
		const queue = new PromptQueue();
		queueApi(queue).enqueueExisting(intentRow({ id: "later", text: "later", sequence: 12 }));
		const failed = intentRow({
			id: "failed-original",
			text: "retry original",
			kind: "steer",
			targetTurn: "continuation",
			sequence: 3,
			deliveryState: "failed",
		});
		queueApi(queue).enqueueExistingAtFront(failed);

		expect(queue.toArray().map((row: any) => row.id)).toEqual(["failed-original", "later"]);
		expect(queue.toArray()[0]).toEqual(failed);
	});

	it("makes explicit reorder durable by resequencing only within each reliable lane", () => {
		const queue = new PromptQueue();
		for (const row of [
			intentRow({ id: "P1", text: "prompt one", sequence: 10 }),
			intentRow({ id: "S1", text: "steer one", kind: "steer", targetTurn: "continuation", sequence: 20 }),
			intentRow({ id: "P2", text: "prompt two", sequence: 30 }),
			intentRow({ id: "S2", text: "steer two", kind: "steer", targetTurn: "continuation", sequence: 40 }),
		]) queueApi(queue).enqueueExisting(row);

		queueApi(queue).reorderByIds(["P2", "S2", "P1", "S1"], { resequenceReliableLanes: true });
		const reordered = queue.toArray() as any[];
		expect(reordered.map((row) => row.id)).toEqual(["P2", "S2", "P1", "S1"]);
		expect(reordered.map((row) => [row.id, row.targetTurn, row.sequence])).toEqual([
			["P2", "next-turn", 10],
			["S2", "continuation", 20],
			["P1", "next-turn", 30],
			["S1", "continuation", 40],
		]);

		const restored = new PromptQueue(reordered);
		expect(queueApi(restored).dequeueForTarget("continuation")?.id).toBe("S2");
		expect(queueApi(restored).dequeueForTarget("continuation")?.id).toBe("S1");
		expect(queueApi(restored).dequeueForTarget("next-turn")?.id).toBe("P2");
		expect(queueApi(restored).dequeueForTarget("next-turn")?.id).toBe("P1");
	});
});

describe("reliable intent target-turn lanes", () => {
	it("selects P1 → S1 → P2 as continuation S1, then next-turn P1/P2 FIFO", () => {
		const queue = new PromptQueue();
		queueApi(queue).enqueueExisting(intentRow({ id: "P1", text: "prompt one", sequence: 1 }));
		queueApi(queue).enqueueExisting(intentRow({
			id: "S1", text: "steer current", kind: "steer", targetTurn: "continuation", isSteered: true, sequence: 1,
		}));
		queueApi(queue).enqueueExisting(intentRow({ id: "P2", text: "prompt two", sequence: 2 }));

		expect(queueApi(queue).dequeueForTarget("continuation")?.id).toBe("S1");
		expect(queueApi(queue).dequeueForTarget("next-turn")?.id).toBe("P1");
		expect(queueApi(queue).dequeueForTarget("next-turn")?.id).toBe("P2");
		expect(queue.isEmpty).toBe(true);
	});

	it("preserves each lane FIFO for S1 → P1 and multiple identical steers", () => {
		const queue = new PromptQueue();
		for (const row of [
			intentRow({ id: "S1", text: "same", kind: "steer", targetTurn: "continuation", isSteered: true, sequence: 1 }),
			intentRow({ id: "P1", text: "later turn", sequence: 1 }),
			intentRow({ id: "S2", text: "same", kind: "steer", targetTurn: "continuation", isSteered: true, sequence: 2 }),
		]) queueApi(queue).enqueueExisting(row);

		expect(queueApi(queue).dequeueForTarget("continuation")?.id).toBe("S1");
		expect(queueApi(queue).dequeueForTarget("continuation")?.id).toBe("S2");
		expect(queueApi(queue).dequeueForTarget("next-turn")?.id).toBe("P1");
	});

	it("abort retargets only unreceived continuations ahead of later next-turn work", () => {
		const queue = new PromptQueue();
		const received = intentRow({
			id: "S-received", kind: "steer", targetTurn: "continuation", isSteered: true, sequence: 1, deliveryState: "received",
		});
		const unresolvedA = intentRow({
			id: "S-A", kind: "steer", targetTurn: "continuation", isSteered: true, sequence: 2,
			author: { kind: "agent", id: "session:a", label: "A" },
		});
		const unresolvedB = intentRow({
			id: "S-B", kind: "steer", targetTurn: "continuation", isSteered: true, sequence: 3,
		});
		const later = intentRow({ id: "P-later", sequence: 9 });
		for (const row of [received, unresolvedA, unresolvedB, later]) queueApi(queue).enqueueExisting(row);

		const retargeted = queueApi(queue).retargetContinuationToNextTurn("continuation-aborted");

		expect(retargeted.map((row: any) => row.id)).toEqual(["S-A", "S-B"]);
		expect(retargeted.map((row: any) => row.targetTurn)).toEqual(["next-turn", "next-turn"]);
		expect(retargeted.map((row: any) => row.deliveryReason)).toEqual([
			"continuation-aborted", "continuation-aborted",
		]);
		expect(retargeted[0].author).toEqual(unresolvedA.author);
		expect(queue.toArray().map((row: any) => row.id)).toEqual([
			"S-received", "S-A", "S-B", "P-later",
		]);
		expect((queue.toArray() as any[]).find((row) => row.id === "S-received")?.targetTurn).toBe("continuation");
	});
});
