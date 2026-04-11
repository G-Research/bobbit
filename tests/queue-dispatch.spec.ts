import { test, expect } from "@playwright/test";
import { PromptQueue } from "../dist/server/agent/prompt-queue.js";
import type { QueuedMessage } from "../dist/server/ws/protocol.js";

/**
 * Simulates the SessionManager dispatch logic without needing real RPC/sessions.
 * Tracks dispatched messages, status transitions, and models the idle/busy state machine.
 */
class DispatchSimulator {
	queue: PromptQueue;
	status: "idle" | "streaming" = "idle";
	dispatched: Array<{ message: QueuedMessage; method: "prompt" | "steer" | "followUp" }> = [];
	statusTransitions: Array<"idle" | "streaming"> = [];
	lastTurnErrored = false;

	constructor(queue?: PromptQueue) {
		this.queue = queue ?? new PromptQueue();
		this.statusTransitions.push(this.status);
	}

	private setStatus(s: "idle" | "streaming") {
		if (this.status !== s) {
			this.status = s;
			this.statusTransitions.push(s);
		}
	}

	/**
	 * Models enqueuePrompt from SessionManager:
	 * - error state → always enqueue (never direct dispatch)
	 * - idle + empty queue → dispatch directly (don't enqueue)
	 * - idle + non-empty queue → enqueue then drain
	 * - busy → enqueue only
	 */
	enqueue(text: string, opts?: { isSteered?: boolean; isFollowUp?: boolean }): QueuedMessage | null {
		// Error-state gating: always enqueue when last turn errored
		if (this.lastTurnErrored) {
			const msg = this.queue.enqueue(text, opts);
			return msg;
		}

		if (this.status === "idle" && this.queue.isEmpty) {
			// Direct dispatch — create a synthetic QueuedMessage for tracking
			const msg: QueuedMessage = {
				id: `direct-${Date.now()}-${Math.random()}`,
				text,
				isSteered: opts?.isSteered ?? false,
				isFollowUp: opts?.isFollowUp ?? false,
				createdAt: Date.now(),
			};
			this.dispatch(msg);
			return null; // Not enqueued
		}

		const msg = this.queue.enqueue(text, opts);

		// If idle, drain immediately (idle + non-empty case)
		if (this.status === "idle") {
			this.drain();
		}

		return msg;
	}

	/** Models drainQueue from SessionManager — uses followUp for isFollowUp messages. */
	drain(): boolean {
		if (this.queue.isEmpty) return false;

		const next = this.queue.dequeueUndispatched();
		if (!next) return false;

		// Optimistic status update before dispatch (prevents double-dispatch race)
		this.setStatus("streaming");
		const method = next.isFollowUp ? "followUp" as const : "prompt" as const;
		this.dispatched.push({ message: next, method });
		return true;
	}

	/** Simulate the agent finishing a turn (agent_end). */
	agentEnd(): void {
		this.setStatus("idle");
		// SessionManager calls drainQueue on agent_end (unless lastTurnErrored)
		if (!this.lastTurnErrored) {
			this.drain();
		}
	}

	/** Simulate agent starting (agent_start event). */
	agentStart(): void {
		this.setStatus("streaming");
		this.lastTurnErrored = false;
	}

	/** Simulate a turn ending with an error (message_end with stopReason "error"). */
	errorEnd(): void {
		this.lastTurnErrored = true;
	}

	/**
	 * Models steerQueued — marks as steered + reorders but does NOT dispatch.
	 * Steered messages stay in queue until batchedSteerAbort().
	 */
	steerQueued(messageId: string): boolean {
		return this.queue.steer(messageId);
	}

	/**
	 * Models forceAbort batched steer injection:
	 * Collect all steered+undispatched messages, "dispatch" as steer batch,
	 * mark all as dispatched.
	 */
	batchedSteerAbort(): void {
		const steeredMessages = this.queue.toArray()
			.filter(m => m.isSteered && !m.dispatched);
		if (steeredMessages.length > 0) {
			const batchText = steeredMessages.map(m => m.text).join('\n');
			const batchMsg: QueuedMessage = {
				id: `steer-batch-${Date.now()}`,
				text: batchText,
				isSteered: true,
				createdAt: Date.now(),
			};
			this.dispatched.push({ message: batchMsg, method: "steer" });
			for (const m of steeredMessages) {
				this.queue.markDispatched(m.id);
			}
		}
		// After abort, agent becomes idle and queue drains
		this.setStatus("idle");
		this.drain();
	}

	/**
	 * Models retryLastPrompt — clears error state. The retry prompt triggers
	 * agent_start → agent processes → agent_end → drainQueue.
	 */
	retry(): void {
		this.lastTurnErrored = false;
		// Simulate dispatching a retry prompt
		const retryMsg: QueuedMessage = {
			id: `retry-${Date.now()}`,
			text: "[RETRY]",
			isSteered: false,
			createdAt: Date.now(),
		};
		this.dispatch(retryMsg);
	}

	private dispatch(msg: QueuedMessage): void {
		this.setStatus("streaming");
		const method = msg.isFollowUp ? "followUp" as const : "prompt" as const;
		this.dispatched.push({ message: msg, method });
	}

	get dispatchedTexts(): string[] {
		return this.dispatched.map(d => d.message.text);
	}
}

// ─── Test Suite ────────────────────────────────────────────────────────

test.describe("Queue Dispatch Integration", () => {

	test("(1) enqueue 3 items, steer middle, dequeue returns steered first", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A");
		const b = q.enqueue("B");
		const c = q.enqueue("C");

		q.steer(b.id);

		const first = q.dequeue();
		expect(first?.text).toBe("B");
		expect(first?.isSteered).toBe(true);

		const second = q.dequeue();
		expect(second?.text).toBe("A");

		const third = q.dequeue();
		expect(third?.text).toBe("C");

		expect(q.isEmpty).toBe(true);
	});

	test("(2) idle + empty queue: new prompt dispatches directly, queue stays empty", () => {
		const sim = new DispatchSimulator();
		expect(sim.status).toBe("idle");

		const result = sim.enqueue("Hello");

		// Should NOT have been enqueued (returned null)
		expect(result).toBeNull();
		expect(sim.queue.isEmpty).toBe(true);
		expect(sim.queue.length).toBe(0);

		// Should have been dispatched directly
		expect(sim.dispatched.length).toBe(1);
		expect(sim.dispatched[0].message.text).toBe("Hello");
		expect(sim.status).toBe("streaming");
	});

	test("(3) busy agent: new prompt IS enqueued, not dispatched", () => {
		const sim = new DispatchSimulator();

		// Send first message (direct dispatch, agent becomes busy)
		sim.enqueue("First");
		expect(sim.status).toBe("streaming");

		// Now agent is busy — second message should be enqueued
		const queued = sim.enqueue("Second");

		expect(queued).not.toBeNull();
		expect(queued!.text).toBe("Second");
		expect(sim.queue.length).toBe(1);

		// Only the first message was dispatched
		expect(sim.dispatched.length).toBe(1);
		expect(sim.dispatchedTexts).toEqual(["First"]);
	});

	test("(4) idle + non-empty queue: enqueue triggers drain, queue becomes empty", () => {
		const sim = new DispatchSimulator();

		// Make agent busy, enqueue an item, then make agent idle without draining
		sim.enqueue("First"); // direct dispatch
		sim.enqueue("Queued"); // enqueued (agent busy)
		expect(sim.queue.length).toBe(1);

		// Agent finishes first task — drain fires, "Queued" dispatched
		sim.agentEnd();

		expect(sim.queue.isEmpty).toBe(true);
		expect(sim.dispatched.length).toBe(2);
		expect(sim.dispatchedTexts).toEqual(["First", "Queued"]);
	});

	test("(5) full drain: all items dequeue in correct order across multiple agent_end cycles", () => {
		const sim = new DispatchSimulator();

		// Direct dispatch first message
		sim.enqueue("A");
		expect(sim.status).toBe("streaming");

		// Queue up B, C, D while busy
		sim.enqueue("B");
		sim.enqueue("C");
		sim.enqueue("D");
		expect(sim.queue.length).toBe(3);

		// Agent finishes A → B dispatched
		sim.agentEnd();
		expect(sim.dispatchedTexts).toEqual(["A", "B"]);
		expect(sim.queue.length).toBe(2);

		// Agent finishes B → C dispatched
		sim.agentEnd();
		expect(sim.dispatchedTexts).toEqual(["A", "B", "C"]);
		expect(sim.queue.length).toBe(1);

		// Agent finishes C → D dispatched
		sim.agentEnd();
		expect(sim.dispatchedTexts).toEqual(["A", "B", "C", "D"]);
		expect(sim.queue.isEmpty).toBe(true);

		// Agent finishes D → nothing to drain
		sim.agentEnd();
		expect(sim.dispatched.length).toBe(4);
		expect(sim.status).toBe("idle");
	});

	test("(6) optimistic status: status flips to streaming before dispatch completes", () => {
		const sim = new DispatchSimulator();

		// Direct dispatch
		sim.enqueue("First");

		// Queue a message while busy
		sim.enqueue("Second");

		// Verify status transitions so far: idle → streaming (from direct dispatch)
		expect(sim.statusTransitions).toEqual(["idle", "streaming"]);

		// agent_end: idle briefly, then drain sets streaming again
		sim.agentEnd();

		// Transitions: idle → streaming → idle → streaming
		// The idle→streaming on drain happens synchronously (optimistic)
		expect(sim.statusTransitions).toEqual(["idle", "streaming", "idle", "streaming"]);

		// The key assertion: status is streaming BEFORE the RPC would resolve
		// (in real code, prompt() is async but status is set synchronously)
		expect(sim.status).toBe("streaming");
	});

	test("(7) queue persistence round-trip: serialize and restore identical state", () => {
		const q1 = new PromptQueue();
		q1.enqueue("Alpha");
		const b = q1.enqueue("Beta");
		q1.enqueue("Gamma");
		q1.steer(b.id);

		// Serialize
		const serialized = q1.toArray();

		// Restore into a new queue
		const q2 = new PromptQueue(serialized);

		// Verify identical state
		expect(q2.length).toBe(q1.length);
		const arr1 = q1.toArray();
		const arr2 = q2.toArray();

		expect(arr2.map(m => m.text)).toEqual(arr1.map(m => m.text));
		expect(arr2.map(m => m.isSteered)).toEqual(arr1.map(m => m.isSteered));
		expect(arr2.map(m => m.id)).toEqual(arr1.map(m => m.id));
		expect(arr2.map(m => m.createdAt)).toEqual(arr1.map(m => m.createdAt));

		// Dequeue order should be identical
		const order1: string[] = [];
		while (!q1.isEmpty) order1.push(q1.dequeue()!.text);

		const order2: string[] = [];
		while (!q2.isEmpty) order2.push(q2.dequeue()!.text);

		expect(order2).toEqual(order1);
	});

	test("(8) steer ordering: A,B,C enqueued, steer C then B, full drain is C,B,A", () => {
		const sim = new DispatchSimulator();

		// Make agent busy first
		sim.enqueue("Setup");
		expect(sim.status).toBe("streaming");

		// Enqueue A, B, C
		const a = sim.enqueue("A");
		const b = sim.enqueue("B");
		const c = sim.enqueue("C");

		expect(sim.queue.length).toBe(3);

		// Steer C first, then B
		sim.queue.steer(c!.id);
		sim.queue.steer(b!.id);

		// Verify queue order: C (steered first), B (steered second), A (not steered)
		const queueOrder = sim.queue.toArray().map(m => m.text);
		expect(queueOrder).toEqual(["C", "B", "A"]);

		// Full drain sequence
		sim.agentEnd(); // Setup done → C dispatched
		expect(sim.dispatchedTexts).toEqual(["Setup", "C"]);
		expect(sim.queue.length).toBe(2);

		sim.agentEnd(); // C done → B dispatched
		expect(sim.dispatchedTexts).toEqual(["Setup", "C", "B"]);
		expect(sim.queue.length).toBe(1);

		sim.agentEnd(); // B done → A dispatched
		expect(sim.dispatchedTexts).toEqual(["Setup", "C", "B", "A"]);
		expect(sim.queue.isEmpty).toBe(true);

		sim.agentEnd(); // A done → nothing left
		expect(sim.status).toBe("idle");
		expect(sim.dispatched.length).toBe(4);
	});

	test("steer during busy: steered messages dispatch before non-steered on drain", () => {
		const sim = new DispatchSimulator();

		sim.enqueue("Running"); // direct dispatch
		sim.enqueue("Normal1");
		sim.enqueue("Normal2");
		const urgent = sim.enqueue("Urgent");

		// Steer the last one
		sim.queue.steer(urgent!.id);
		expect(sim.queue.toArray().map(m => m.text)).toEqual(["Urgent", "Normal1", "Normal2"]);

		// Drain all
		sim.agentEnd(); // → Urgent
		expect(sim.dispatchedTexts[1]).toBe("Urgent");

		sim.agentEnd(); // → Normal1
		expect(sim.dispatchedTexts[2]).toBe("Normal1");

		sim.agentEnd(); // → Normal2
		expect(sim.dispatchedTexts[3]).toBe("Normal2");
	});

	test("remove from queue mid-drain: removed message is never dispatched", () => {
		const sim = new DispatchSimulator();

		sim.enqueue("Running"); // direct dispatch
		const a = sim.enqueue("A");
		const b = sim.enqueue("B");
		const c = sim.enqueue("C");

		// Remove B from queue
		sim.queue.remove(b!.id);
		expect(sim.queue.length).toBe(2);

		// Drain
		sim.agentEnd(); // → A
		sim.agentEnd(); // → C
		sim.agentEnd(); // → nothing

		expect(sim.dispatchedTexts).toEqual(["Running", "A", "C"]);
		expect(sim.status).toBe("idle");
	});

	test("all dispatches use 'prompt' method (not steer) since agent is idle at drain time", () => {
		const sim = new DispatchSimulator();

		sim.enqueue("First"); // direct
		const q = sim.enqueue("Steered");
		sim.queue.steer(q!.id);

		sim.agentEnd(); // drain Steered

		// Both dispatches should use "prompt" method
		for (const d of sim.dispatched) {
			expect(d.method).toBe("prompt");
		}
	});

	test("empty drain on agent_end is a no-op", () => {
		const sim = new DispatchSimulator();

		sim.enqueue("Only");
		sim.agentEnd();

		// Queue was already empty by agent_end (the direct dispatch didn't enqueue)
		// Actually: "Only" was direct-dispatched, so agent_end with empty queue → idle
		expect(sim.status).toBe("idle");
		expect(sim.dispatched.length).toBe(1);
	});

	test("multiple rapid enqueues while idle all get queued and drain sequentially", () => {
		const sim = new DispatchSimulator();

		// First goes direct
		sim.enqueue("A");
		expect(sim.status).toBe("streaming");

		// Rapid enqueues while busy
		sim.enqueue("B");
		sim.enqueue("C");
		sim.enqueue("D");
		sim.enqueue("E");

		expect(sim.queue.length).toBe(4);

		// Drain all
		const expectedOrder = ["A", "B", "C", "D", "E"];
		for (let i = 1; i < expectedOrder.length; i++) {
			sim.agentEnd();
			expect(sim.dispatchedTexts[i]).toBe(expectedOrder[i]);
		}

		sim.agentEnd();
		expect(sim.status).toBe("idle");
		expect(sim.dispatchedTexts).toEqual(expectedOrder);
	});

	// ── Error gating tests ─────────────────────────────────────────────

	test("(story 35) error gating: error turn with queued messages — queue stays intact, no drain", () => {
		const sim = new DispatchSimulator();

		// Send initial prompt
		sim.enqueue("Initial");
		expect(sim.status).toBe("streaming");

		// Queue 2 messages while busy
		sim.enqueue("Queued1");
		sim.enqueue("Queued2");
		expect(sim.queue.length).toBe(2);

		// Agent errors mid-turn
		sim.errorEnd();
		// agent_end fires — but drain should NOT happen because lastTurnErrored
		sim.agentEnd();

		// Queue should still have 2 messages
		expect(sim.queue.length).toBe(2);
		expect(sim.queue.toArray().map(m => m.text)).toEqual(["Queued1", "Queued2"]);
		// Only the initial prompt was dispatched
		expect(sim.dispatched.length).toBe(1);
		expect(sim.dispatchedTexts).toEqual(["Initial"]);
		expect(sim.status).toBe("idle");
	});

	test("(story 36) error → retry → drain: queued messages dispatch after successful retry", () => {
		const sim = new DispatchSimulator();

		// Send initial prompt, queue messages, error
		sim.enqueue("Initial");
		sim.enqueue("Queued1");
		sim.enqueue("Queued2");
		sim.errorEnd();
		sim.agentEnd(); // drain skipped
		expect(sim.queue.length).toBe(2);

		// User clicks retry — clears error, dispatches retry prompt
		sim.retry();
		expect(sim.lastTurnErrored).toBe(false);
		expect(sim.status).toBe("streaming");

		// Retry succeeds → agent_end → drain fires
		sim.agentEnd();
		expect(sim.dispatchedTexts).toEqual(["Initial", "[RETRY]", "Queued1"]);

		sim.agentEnd();
		expect(sim.dispatchedTexts).toEqual(["Initial", "[RETRY]", "Queued1", "Queued2"]);

		sim.agentEnd();
		expect(sim.queue.isEmpty).toBe(true);
		expect(sim.status).toBe("idle");
	});

	test("(story 37) error → new message: enqueue goes to queue, not direct dispatch", () => {
		const sim = new DispatchSimulator();

		// Send initial prompt, error
		sim.enqueue("Initial");
		sim.errorEnd();
		sim.agentEnd();
		expect(sim.status).toBe("idle");
		expect(sim.lastTurnErrored).toBe(true);

		// User sends a new message in error state — should be enqueued, not dispatched
		const queued = sim.enqueue("NewMessage");
		expect(queued).not.toBeNull();
		expect(queued!.text).toBe("NewMessage");
		expect(sim.queue.length).toBe(1);
		// Should NOT have been dispatched directly
		expect(sim.dispatched.length).toBe(1); // only Initial
		expect(sim.dispatchedTexts).toEqual(["Initial"]);
		// Status should still be idle (not streaming)
		expect(sim.status).toBe("idle");
	});

	// ── Batched steer tests ────────────────────────────────────────────

	test("(story 11) batched steer: steer 1 message, abort → steered dispatched as steer, remaining drains as prompt", () => {
		const sim = new DispatchSimulator();

		// Make agent busy
		sim.enqueue("Running");
		expect(sim.status).toBe("streaming");

		// Queue messages
		const msgA = sim.enqueue("MsgA");
		const msgB = sim.enqueue("MsgB");
		expect(sim.queue.length).toBe(2);

		// Steer msgB (marks as steered, reorders to front, but does NOT dispatch)
		sim.steerQueued(msgB!.id);
		expect(sim.queue.toArray().map(m => m.text)).toEqual(["MsgB", "MsgA"]);
		// No new dispatch should have happened
		expect(sim.dispatched.length).toBe(1); // only "Running"

		// User presses abort → batched steer injection
		sim.batchedSteerAbort();

		// "MsgB" should be dispatched as steer method
		expect(sim.dispatched[1].method).toBe("steer");
		expect(sim.dispatched[1].message.text).toBe("MsgB");

		// After abort, agent goes idle and drains remaining → "MsgA" as prompt
		expect(sim.dispatched[2].method).toBe("prompt");
		expect(sim.dispatched[2].message.text).toBe("MsgA");

		expect(sim.queue.isEmpty).toBe(true);
	});

	test("(story 12) multiple steer: steer C then B, abort → batch dispatch in steer order, then non-steered drain", () => {
		const sim = new DispatchSimulator();

		// Make agent busy
		sim.enqueue("Running");

		// Queue A, B, C
		const msgA = sim.enqueue("A");
		const msgB = sim.enqueue("B");
		const msgC = sim.enqueue("C");

		// Steer C first, then B (steer order: C first since steered first)
		sim.steerQueued(msgC!.id);
		sim.steerQueued(msgB!.id);
		expect(sim.queue.toArray().map(m => m.text)).toEqual(["C", "B", "A"]);

		// Abort — batch steer injection
		sim.batchedSteerAbort();

		// Batch steer: C and B concatenated as a single steer dispatch
		expect(sim.dispatched[1].method).toBe("steer");
		expect(sim.dispatched[1].message.text).toBe("C\nB");

		// After abort, drain non-steered: A
		expect(sim.dispatched[2].method).toBe("prompt");
		expect(sim.dispatched[2].message.text).toBe("A");

		sim.agentEnd();
		expect(sim.queue.isEmpty).toBe(true);
		expect(sim.status).toBe("idle");
	});

	// ── followUp dispatch test ─────────────────────────────────────────

	test.skip("followUp dispatch: enqueue with isFollowUp while busy → dispatched via followUp method", () => {
		const sim = new DispatchSimulator();

		// Make agent busy
		sim.enqueue("Running");

		// Queue a follow_up message
		const followUp = sim.enqueue("FollowUp", { isFollowUp: true });
		expect(followUp).not.toBeNull();
		expect(followUp!.isFollowUp).toBe(true);

		// Agent finishes → drain fires
		sim.agentEnd();

		// The follow_up message should be dispatched via "followUp" method
		expect(sim.dispatched[1].method).toBe("followUp");
		expect(sim.dispatched[1].message.text).toBe("FollowUp");
	});

	test("followUp direct dispatch: idle + empty queue + isFollowUp → dispatched via followUp method", () => {
		const sim = new DispatchSimulator();

		// Direct dispatch with isFollowUp
		sim.enqueue("DirectFollowUp", { isFollowUp: true });

		expect(sim.dispatched.length).toBe(1);
		expect(sim.dispatched[0].method).toBe("followUp");
		expect(sim.dispatched[0].message.text).toBe("DirectFollowUp");
	});

	// ── BUG REPRODUCING TESTS ──────────────────────────────────────────
	// These tests demonstrate confirmed bugs and SHOULD FAIL until fixed.

	test("BUG: steered messages lost after dispatch + force-kill — no resetDispatched method (PI-25)", () => {
		// Bug 1: When steered messages are dispatched via rpcClient.steer() and then
		// the agent process is force-killed, the messages are lost forever because:
		// 1. They have dispatched=true (so dequeueUndispatched skips them)
		// 2. No resetDispatched() method exists to clear the flag after force-kill restart
		const q = new PromptQueue();
		const a = q.enqueue("SteerA");
		const b = q.enqueue("SteerB");
		const c = q.enqueue("NormalC");

		// Simulate: user steers A and B
		q.steer(a.id);
		q.steer(b.id);

		// Simulate: _dispatchSteeredMessages() marks them dispatched (sent to stdin)
		q.markDispatched(a.id);
		q.markDispatched(b.id);

		// Simulate: agent process is force-killed. The steer RPCs are lost.
		// After restart, drainQueue calls dequeueUndispatched():
		const next = q.dequeueUndispatched();
		expect(next?.text).toBe("NormalC"); // C is dispatched fine

		// But A and B were silently dropped — they had dispatched=true
		// The queue is now empty. The steered messages are lost forever.
		expect(q.isEmpty).toBe(true);

		// THE FIX: PromptQueue needs a resetDispatched() method to clear
		// the dispatched flag after a force-kill restart.
		// This assertion FAILS because the method doesn't exist yet:
		expect(typeof (q as any).resetDispatched).toBe("function");
	});

	test("BUG: force-kill restart loses steered messages in full simulation (PI-25)", () => {
		// Full end-to-end simulation of the force-kill steered message loss bug.
		const sim = new DispatchSimulator();

		// Agent is streaming (processing first prompt)
		sim.enqueue("LongRunning");
		expect(sim.status).toBe("streaming");

		// User queues M1, M2, M3 while agent is busy
		const m1 = sim.enqueue("M1");
		const m2 = sim.enqueue("M2");
		const m3 = sim.enqueue("M3");

		// User promotes M1 and M2 to steers
		sim.steerQueued(m1!.id);
		sim.steerQueued(m2!.id);

		// Simulate _dispatchSteeredMessages() — marks steered msgs as dispatched
		// (In real code, this happens in steerQueued → _dispatchSteeredMessages)
		sim.queue.markDispatched(m1!.id);
		sim.queue.markDispatched(m2!.id);

		// User clicks abort. Agent is blocked in a tool call, doesn't respond.
		// 3 seconds pass, process is force-killed.
		// After restart, drainQueue runs — but M1 and M2 are marked dispatched!

		// Simulate: after force-kill restart, we SHOULD call resetDispatched()
		// but the method doesn't exist yet. This is the bug.
		// The fix: sim.queue.resetDispatched() would clear all dispatched flags.

		// Without the fix, drainQueue only gets M3:
		const firstDrain = sim.queue.dequeueUndispatched();
		expect(firstDrain?.text).toBe("M3");
		expect(sim.queue.isEmpty).toBe(true); // M1, M2 are gone!

		// THE FIX ASSERTION: resetDispatched must exist
		expect(typeof (sim.queue as any).resetDispatched).toBe("function");
	});

	test("BUG: no aborting status transition during force-abort (PI-21b)", () => {
		// Bug 2: When user clicks abort, there's no "aborting" status broadcast.
		// The user sees no feedback for up to 3 seconds while the grace period runs.
		// The status should transition: streaming → aborting → idle
		// But currently it goes: streaming → idle (with a 3s gap of silence)
		const sim = new DispatchSimulator();

		// Start streaming
		sim.enqueue("Running");
		expect(sim.status).toBe("streaming");
		expect(sim.statusTransitions).toEqual(["idle", "streaming"]);

		// User aborts — the DispatchSimulator models the current behavior:
		// batchedSteerAbort() goes directly to idle (no "aborting" intermediate)
		sim.batchedSteerAbort();

		// EXPECTED (after fix): transitions should include "aborting"
		// streaming → aborting → idle
		// ACTUAL (current bug): streaming → idle (no aborting)
		expect(sim.statusTransitions).toContain("aborting");
	});
});
