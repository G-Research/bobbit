import { test, expect } from "@playwright/test";
import { PromptQueue } from "../dist/server/agent/prompt-queue.js";
import type { QueuedMessage } from "../dist/server/ws/protocol.js";

const MAX_CONSECUTIVE_ERROR_TURNS = 3;
const SYSTEM_PREFIX_RE = /^\[SYSTEM: previous turn failed with: .+\. Ignore the incomplete last turn and handle the following\.\]\n\n/;
function buildErrorRecoveryPrefix(errMsg: string, userText: string): string {
	const snippet = (errMsg || "unknown error").slice(0, 200);
	return `[SYSTEM: previous turn failed with: ${snippet}. Ignore the incomplete last turn and handle the following.]\n\n${userText}`;
}

/**
 * Simulates the SessionManager dispatch logic without needing real RPC/sessions.
 * Tracks dispatched messages, status transitions, and models the idle/busy state machine.
 */
class DispatchSimulator {
	queue: PromptQueue;
	status: "idle" | "streaming" | "aborting" = "idle";
	dispatched: Array<{ message: QueuedMessage; method: "prompt" | "steer" | "followUp" }> = [];
	statusTransitions: Array<"idle" | "streaming" | "aborting"> = [];
	lastTurnErrored = false;
	lastTurnErrorMessage = "";
	consecutiveErrorTurns = 0;
	transientRetryAttempts = 0;
	turnHadToolCalls = false;
	pendingAutoRetryTimer: { cancelled: boolean } | undefined = undefined;
	logs: string[] = [];

	constructor(queue?: PromptQueue) {
		this.queue = queue ?? new PromptQueue();
		this.statusTransitions.push(this.status);
	}

	private setStatus(s: "idle" | "streaming" | "aborting") {
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
		// Error-state gating with implicit unstick up to MAX_CONSECUTIVE_ERROR_TURNS.
		if (this.lastTurnErrored) {
			if (this.consecutiveErrorTurns >= MAX_CONSECUTIVE_ERROR_TURNS) {
				this.logs.push(
					`park:consecutiveErrorTurns=${this.consecutiveErrorTurns}`
				);
				const msg = this.queue.enqueue(text, opts);
				return msg;
			}
			// Implicit unstick.
			this.logs.push(
				`unstick:consecutiveErrorTurns=${this.consecutiveErrorTurns}`
			);
			if (this.pendingAutoRetryTimer) {
				this.pendingAutoRetryTimer.cancelled = true;
				this.pendingAutoRetryTimer = undefined;
			}
			const errSnippet = (this.lastTurnErrorMessage || "").slice(0, 200);
			this.lastTurnErrored = false;
			this.lastTurnErrorMessage = "";
			this.turnHadToolCalls = false;
			this.transientRetryAttempts = 0;
			const prefixed = buildErrorRecoveryPrefix(errSnippet, text);
			// Dispatch ahead of any parked items (spec: "new first" ordering).
			const msg: QueuedMessage = {
				id: `unstick-${Date.now()}-${Math.random()}`,
				text: prefixed,
				isSteered: opts?.isSteered ?? false,
				isFollowUp: opts?.isFollowUp ?? false,
				createdAt: Date.now(),
			};
			this.dispatch(msg);
			return null;
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

	/** Models deliverLiveSteer — routes through enqueue under cap (implicit unstick); parks directly at cap. */
	steerLive(message: string): { parked: boolean } {
		if (this.lastTurnErrored) {
			if (this.consecutiveErrorTurns >= MAX_CONSECUTIVE_ERROR_TURNS) {
				this.logs.push(`park-steer:consecutiveErrorTurns=${this.consecutiveErrorTurns}`);
				this.queue.enqueue(message, { isSteered: true });
				return { parked: true };
			}
			this.logs.push(`unstick-steer:consecutiveErrorTurns=${this.consecutiveErrorTurns}`);
			this.enqueue(message, { isSteered: true });
			return { parked: false };
		}
		// Happy path — persist steered+dispatched and simulate steer().
		const queued = this.queue.enqueue(message, { isSteered: true });
		this.queue.markDispatched(queued.id);
		this.dispatched.push({ message: queued, method: "steer" });
		return { parked: false };
	}

	/** Models drainQueue from SessionManager — batches steered, then falls back to single. */
	drain(): boolean {
		if (this.queue.isEmpty) return false;

		// Batch all steered messages at the front into a single prompt
		const steered = this.queue.dequeueAllSteered();
		let next: QueuedMessage | undefined;

		if (steered.length > 0) {
			const batchText = steered.map(m => m.text).join('\n');
			next = { ...steered[0], text: batchText };
		} else {
			next = this.queue.dequeueUndispatched();
		}

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
	errorEnd(errMsg = "simulated error"): void {
		this.lastTurnErrored = true;
		this.lastTurnErrorMessage = errMsg;
		this.consecutiveErrorTurns += 1;
	}

	/** Simulate a successful terminal message_end — resets the cap. */
	successEnd(): void {
		this.lastTurnErrored = false;
		this.lastTurnErrorMessage = "";
		this.consecutiveErrorTurns = 0;
	}

	/** Simulate scheduling an auto-retry timer (from maybeAutoRetryTransient). */
	scheduleAutoRetry(): { cancelled: boolean } {
		const timer = { cancelled: false };
		this.pendingAutoRetryTimer = timer;
		return timer;
	}

	/**
	 * Models steerQueued — marks as steered + reorders.
	 * Does NOT dispatch immediately. Steered messages accumulate and are
	 * dispatched as a batch at the next tool boundary via toolBoundary().
	 */
	steerQueued(messageId: string): boolean {
		return this.queue.steer(messageId);
	}

	/**
	 * Models the tool boundary event (tool_execution_end).
	 * Dispatches all steered+undispatched messages as a single batch steer.
	 */
	toolBoundary(): void {
		if (this.status !== "streaming") return;
		const steered = this.queue.toArray().filter(m => m.isSteered && !m.dispatched);
		if (steered.length === 0) return;

		const batchText = steered.map(m => m.text).join("\n");
		const batchMsg: QueuedMessage = {
			id: `steer-batch-${Date.now()}`,
			text: batchText,
			isSteered: true,
			createdAt: Date.now(),
		};
		this.dispatched.push({ message: batchMsg, method: "steer" });
		for (const m of steered) {
			this.queue.markDispatched(m.id);
		}
	}

	/**
	 * Models forceAbort batched steer injection:
	 * Collect all steered+undispatched messages, "dispatch" as steer batch,
	 * mark all as dispatched.
	 */
	batchedSteerAbort(): void {
		// Broadcast aborting status first
		this.setStatus("aborting");

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
	 * Models the fixed forceAbort flow:
	 * 1. Set aborting status
	 * 2. Force-kill the process (steers dispatched to dead process are lost)
	 * 3. resetDispatched() clears dispatched flags so messages are recovered
	 * 4. Restart agent → drain queue
	 */
	forceAbortRestart(): void {
		this.setStatus("aborting");
		// After force-kill restart, reset dispatched flags
		this.queue.resetDispatched();
		this.setStatus("idle");
		this.drain();
	}

	/**
	 * Models retryLastPrompt — clears error state. The retry prompt triggers
	 * agent_start → agent processes → agent_end → drainQueue.
	 */
	retry(): void {
		this.lastTurnErrored = false;
		// Explicit retry bypasses the cap — fresh budget.
		this.consecutiveErrorTurns = 0;
		if (this.pendingAutoRetryTimer) {
			this.pendingAutoRetryTimer.cancelled = true;
			this.pendingAutoRetryTimer = undefined;
		}
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

	test("(8) steer ordering: A,B,C enqueued, steer C then B, drain batches steered C+B then A", () => {
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

		// First drain batches all steered messages (C+B) into a single prompt
		sim.agentEnd(); // Setup done → C+B batched dispatch
		expect(sim.dispatchedTexts).toEqual(["Setup", "C\nB"]);
		expect(sim.queue.length).toBe(1); // only A left

		// Second drain dispatches A
		sim.agentEnd(); // C+B batch done → A dispatched
		expect(sim.dispatchedTexts).toEqual(["Setup", "C\nB", "A"]);
		expect(sim.queue.isEmpty).toBe(true);

		sim.agentEnd(); // A done → nothing left
		expect(sim.status).toBe("idle");
		expect(sim.dispatched.length).toBe(3); // Setup, C+B batch, A
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

	test("(story 37, updated) error → new message: implicit unstick under cap dispatches prefixed", () => {
		// Updated for "Unstick sessions on new input": a new message after an
		// errored turn now dispatches immediately with a system-prefix (up to
		// MAX_CONSECUTIVE_ERROR_TURNS). Parking only happens at the cap — see
		// (unstick 2) above.
		const sim = new DispatchSimulator();

		sim.enqueue("Initial");
		sim.errorEnd();
		sim.agentEnd();
		expect(sim.status).toBe("idle");
		expect(sim.lastTurnErrored).toBe(true);

		const queued = sim.enqueue("NewMessage");
		expect(queued).toBeNull(); // direct-dispatched, not parked
		expect(sim.queue.isEmpty).toBe(true);
		expect(sim.dispatched.length).toBe(2); // Initial + NewMessage (prefixed)
		expect(sim.dispatched[1].message.text).toMatch(SYSTEM_PREFIX_RE);
		expect(sim.dispatched[1].message.text.endsWith("NewMessage")).toBe(true);
		expect(sim.lastTurnErrored).toBe(false);
		expect(sim.status).toBe("streaming");
	});

	// ── Batched steer tests ────────────────────────────────────────────

	test("PI-10: steerQueued accumulates, toolBoundary dispatches as batch", () => {
		// PI-10/PI-10b: steered messages are NOT dispatched on promotion.
		// They accumulate and are dispatched as a batch at the next tool
		// boundary. This ensures that multiple steers sent during a long
		// tool call (even seconds apart) all arrive together.
		const sim = new DispatchSimulator();

		// Make agent busy
		sim.enqueue("Running");
		expect(sim.status).toBe("streaming");

		// Queue a message while busy
		const msg = sim.enqueue("Urgent steer");
		expect(msg).not.toBeNull();

		// Promote to steered — should NOT dispatch yet
		sim.steerQueued(msg!.id);
		expect(sim.dispatched.length).toBe(1); // only "Running"

		// Tool boundary fires — NOW the steer is dispatched
		sim.toolBoundary();
		expect(sim.dispatched.length).toBe(2);
		expect(sim.dispatched[1].method).toBe("steer");
		expect(sim.dispatched[1].message.text).toBe("Urgent steer");
	});

	test("PI-10b: multiple steers during same tool call are batched at tool boundary", () => {
		// User steers two messages 10s apart during a long tool call.
		// Both should be delivered as a single batch at the next tool boundary.
		const sim = new DispatchSimulator();

		// Make agent busy
		sim.enqueue("Running");
		expect(sim.status).toBe("streaming");

		// Queue and steer first message
		const msg1 = sim.enqueue("Steer A");
		sim.steerQueued(msg1!.id);

		// Queue and steer second message (seconds later, same tool call)
		const msg2 = sim.enqueue("Steer B");
		sim.steerQueued(msg2!.id);

		// Neither should have dispatched yet
		expect(sim.dispatched.length).toBe(1); // only "Running"

		// Tool boundary fires — both steers dispatched as a single batch
		sim.toolBoundary();
		expect(sim.dispatched.length).toBe(2);
		expect(sim.dispatched[1].method).toBe("steer");
		expect(sim.dispatched[1].message.text).toBe("Steer A\nSteer B");
	});

	test("(story 11) steer 1 message while streaming → dispatched at tool boundary, abort drains remaining", () => {
		const sim = new DispatchSimulator();

		// Make agent busy
		sim.enqueue("Running");
		expect(sim.status).toBe("streaming");

		// Queue messages
		const msgA = sim.enqueue("MsgA");
		const msgB = sim.enqueue("MsgB");
		expect(sim.queue.length).toBe(2);

		// Steer msgB — NOT dispatched yet
		sim.steerQueued(msgB!.id);
		expect(sim.dispatched.length).toBe(1); // only "Running"

		// Tool boundary → MsgB dispatched as steer
		sim.toolBoundary();
		expect(sim.dispatched.length).toBe(2);
		expect(sim.dispatched[1].method).toBe("steer");
		expect(sim.dispatched[1].message.text).toBe("MsgB");

		// MsgA remains in queue (non-steered)
		const remaining = sim.queue.toArray().filter(m => !m.dispatched);
		expect(remaining.length).toBe(1);
		expect(remaining[0].text).toBe("MsgA");

		// User presses abort → MsgA drains as prompt
		sim.batchedSteerAbort();

		expect(sim.dispatched[2].method).toBe("prompt");
		expect(sim.dispatched[2].message.text).toBe("MsgA");

		expect(sim.queue.isEmpty).toBe(true);
	});

	test("(story 12) steer C then B while streaming → batched at tool boundary, abort drains A", () => {
		const sim = new DispatchSimulator();

		// Make agent busy
		sim.enqueue("Running");

		// Queue A, B, C
		const msgA = sim.enqueue("A");
		const msgB = sim.enqueue("B");
		const msgC = sim.enqueue("C");

		// Steer C then B — neither dispatched yet
		sim.steerQueued(msgC!.id);
		sim.steerQueued(msgB!.id);
		expect(sim.dispatched.length).toBe(1); // only "Running"

		// Tool boundary → C and B dispatched as a single batch
		sim.toolBoundary();
		expect(sim.dispatched.length).toBe(2);
		expect(sim.dispatched[1].method).toBe("steer");
		expect(sim.dispatched[1].message.text).toBe("C\nB");

		// Abort — only non-steered A drains
		sim.batchedSteerAbort();

		expect(sim.dispatched[2].method).toBe("prompt");
		expect(sim.dispatched[2].message.text).toBe("A");

		sim.agentEnd();
		expect(sim.queue.isEmpty).toBe(true);
		expect(sim.status).toBe("idle");
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

	test("dequeueAllSteered pops all consecutive steered messages from front", () => {
		const q = new PromptQueue();
		const a = q.enqueue("A", { isSteered: true });
		const b = q.enqueue("B", { isSteered: true });
		const c = q.enqueue("C"); // not steered
		const d = q.enqueue("D", { isSteered: true }); // steered but after a non-steered

		// Reorder puts steered first: A, B, D, C
		const arr = q.toArray();
		expect(arr.map(m => m.text)).toEqual(["A", "B", "D", "C"]);

		// dequeueAllSteered should pop all consecutive steered from front
		const steered = q.dequeueAllSteered();
		expect(steered.map(m => m.text)).toEqual(["A", "B", "D"]);

		// Only C remains
		expect(q.length).toBe(1);
		expect(q.dequeue()?.text).toBe("C");
		expect(q.isEmpty).toBe(true);
	});

	test("dequeueAllSteered returns empty array when front is not steered", () => {
		const q = new PromptQueue();
		q.enqueue("Normal1");
		q.enqueue("Normal2");

		const steered = q.dequeueAllSteered();
		expect(steered).toEqual([]);
		expect(q.length).toBe(2); // unchanged
	});

	test("steered messages recovered after dispatch + force-kill via resetDispatched (PI-25)", () => {
		const q = new PromptQueue();
		const a = q.enqueue("SteerA");
		const b = q.enqueue("SteerB");
		const c = q.enqueue("NormalC");

		// User steers A and B
		q.steer(a.id);
		q.steer(b.id);

		// _dispatchSteeredMessages() marks them dispatched (sent to stdin)
		q.markDispatched(a.id);
		q.markDispatched(b.id);

		// Agent process is force-killed. The steer RPCs are lost.
		// resetDispatched() clears the dispatched flag so they can be recovered.
		expect(typeof q.resetDispatched).toBe("function");
		q.resetDispatched();

		// After restart, drainQueue calls dequeueUndispatched():
		// Steered messages come first (A, B), then normal (C)
		const first = q.dequeueUndispatched();
		expect(first?.text).toBe("SteerA");

		const second = q.dequeueUndispatched();
		expect(second?.text).toBe("SteerB");

		const third = q.dequeueUndispatched();
		expect(third?.text).toBe("NormalC");

		expect(q.isEmpty).toBe(true);
	});

	test("force-kill restart recovers steered messages as single batched prompt (PI-25)", () => {
		const sim = new DispatchSimulator();

		// Agent is streaming (processing first prompt)
		sim.enqueue("LongRunning");
		expect(sim.status).toBe("streaming");

		// User queues M1, M2, M3 while agent is busy
		const m1 = sim.enqueue("M1");
		const m2 = sim.enqueue("M2");
		const m3 = sim.enqueue("M3");

		// User promotes M1 and M2 to steers (not dispatched yet — waiting for tool boundary)
		sim.steerQueued(m1!.id);
		sim.steerQueued(m2!.id);
		expect(sim.dispatched.length).toBe(1); // only "LongRunning"

		// User clicks abort. Agent is blocked, 3s grace expires, force-killed.
		// forceAbortRestart: aborting → resetDispatched → idle → drain
		sim.forceAbortRestart();

		// M1+M2 should be recovered and dispatched as a SINGLE batched prompt
		const recoveredBatch = sim.dispatched.find(
			(d, i) => i > 0 && d.message.text.includes("M1") && d.message.text.includes("M2"),
		);
		expect(recoveredBatch).toBeTruthy();
		expect(recoveredBatch!.method).toBe("prompt"); // idle dispatch uses prompt

		// M3 drains on next agent_end cycle
		sim.agentEnd();
		const m3Dispatch = sim.dispatched.find(d => d.message.text === "M3");
		expect(m3Dispatch).toBeTruthy();

		sim.agentEnd(); // M3 finishes
		expect(sim.queue.isEmpty).toBe(true);

		// Verify aborting status was included
		expect(sim.statusTransitions).toContain("aborting");
	});

	// ── Implicit-unstick tests ("Unstick sessions on new input" goal) ──────

	test("(unstick 1) happy path: errored session, new enqueue dispatches prefixed", () => {
		const sim = new DispatchSimulator();
		sim.enqueue("initial");
		const timer = sim.scheduleAutoRetry();
		sim.errorEnd("JSON parse failure at position 320");
		expect(sim.consecutiveErrorTurns).toBe(1);
		expect(sim.lastTurnErrored).toBe(true);

		const result = sim.enqueue("new work");

		// Dispatched directly, not parked
		expect(result).toBeNull();
		expect(sim.queue.isEmpty).toBe(true);
		const last = sim.dispatched[sim.dispatched.length - 1];
		expect(last.message.text).toMatch(SYSTEM_PREFIX_RE);
		expect(last.message.text).toContain("JSON parse failure at position 320");
		expect(last.message.text.endsWith("new work")).toBe(true);
		expect(sim.lastTurnErrored).toBe(false);
		// Counter NOT reset by unstick — only by success or explicit retry.
		expect(sim.consecutiveErrorTurns).toBe(1);
		// Auto-retry timer cancelled.
		expect(timer.cancelled).toBe(true);
		expect(sim.pendingAutoRetryTimer).toBeUndefined();
		expect(sim.logs.some(l => l.startsWith("unstick:"))).toBe(true);
	});

	test("(unstick 2) cap triggers parking after 3 errored turns", () => {
		const sim = new DispatchSimulator();
		sim.enqueue("first");
		sim.errorEnd("err 1");
		sim.errorEnd("err 2");
		sim.errorEnd("err 3");
		expect(sim.consecutiveErrorTurns).toBe(3);

		const dispatchedBefore = sim.dispatched.length;
		const result = sim.enqueue("fourth");

		expect(result).not.toBeNull();
		expect(sim.queue.length).toBe(1);
		expect(sim.queue.toArray()[0].text).toBe("fourth");
		expect(sim.lastTurnErrored).toBe(true);
		// No new dispatch
		expect(sim.dispatched.length).toBe(dispatchedBefore);
		expect(sim.logs.filter(l => l.startsWith("park:")).length).toBe(1);
	});

	test("(unstick 3) success resets counter", () => {
		const sim = new DispatchSimulator();
		sim.enqueue("first");
		sim.errorEnd("e1");
		sim.errorEnd("e2");
		expect(sim.consecutiveErrorTurns).toBe(2);

		sim.successEnd();
		expect(sim.consecutiveErrorTurns).toBe(0);

		sim.errorEnd("e3");
		expect(sim.consecutiveErrorTurns).toBe(1);

		const result = sim.enqueue("recovery");
		expect(result).toBeNull(); // unstick dispatch
		const last = sim.dispatched[sim.dispatched.length - 1];
		expect(last.message.text).toMatch(SYSTEM_PREFIX_RE);
	});

	test("(unstick 4) explicit retry bypasses cap", () => {
		const sim = new DispatchSimulator();
		sim.enqueue("first");
		for (let i = 0; i < 5; i++) sim.errorEnd(`err ${i}`);
		expect(sim.consecutiveErrorTurns).toBe(5);

		const before = sim.dispatched.length;
		sim.retry();

		expect(sim.dispatched.length).toBe(before + 1);
		const last = sim.dispatched[sim.dispatched.length - 1];
		expect(last.message.text).toBe("[RETRY]");
		expect(sim.lastTurnErrored).toBe(false);
		expect(sim.consecutiveErrorTurns).toBe(0);
	});

	test("(unstick 5) steer path implicit unstick", () => {
		const sim = new DispatchSimulator();
		sim.enqueue("first");
		sim.errorEnd("transport blip");

		const result = sim.steerLive("hi");

		expect(result.parked).toBe(false);
		const last = sim.dispatched[sim.dispatched.length - 1];
		expect(last.message.text).toMatch(SYSTEM_PREFIX_RE);
		expect(last.message.text.endsWith("hi")).toBe(true);
		expect(last.message.isSteered).toBe(true);
		expect(sim.lastTurnErrored).toBe(false);
		expect(sim.logs.some(l => l.startsWith("unstick-steer:"))).toBe(true);
	});

	test("(unstick 5b) steer path parks at cap, persists to queue (PI-25 invariant)", () => {
		const sim = new DispatchSimulator();
		sim.enqueue("first");
		for (let i = 0; i < 3; i++) sim.errorEnd(`e${i}`);

		const result = sim.steerLive("hi");

		expect(result.parked).toBe(true);
		expect(sim.queue.length).toBe(1);
		const parked = sim.queue.toArray()[0];
		expect(parked.text).toBe("hi");
		expect(parked.isSteered).toBe(true);
		// NOT marked dispatched — drainQueue should pick it up after Retry.
		expect(parked.dispatched).toBeFalsy();
	});

	test("(unstick 6) queue drain ordering: new prefixed first, then parked FIFO unprefixed", () => {
		const sim = new DispatchSimulator();
		// Busy with initial, park parked1 while busy (normal path)
		sim.enqueue("initial"); // direct dispatch, status=streaming
		sim.enqueue("parked1"); // enqueued (busy)
		// Agent errors; while wedged, parked2 enqueues (error path puts to queue when at cap
		// but here we still have consecutiveErrorTurns<3 so — wait, unstick fires. To
		// model "parked while wedged at cap" we push the cap first.
		// Better: simulate 1 error + direct enqueue while wedged using queue enqueue.
		// Re-model: we just directly push parked2 via queue to simulate "queued during error".
		sim.errorEnd("glitch");
		// Simulate an under-cap enqueue that still wanted to park — we simulate by direct
		// queue push to represent pre-existing wedged queue items that landed via earlier
		// at-cap parks before being relaxed. For spec coverage of "new first, parked after"
		// what matters is that parked items already exist and the new unstick dispatches
		// ahead of them.
		sim.queue.enqueue("parked2");

		expect(sim.queue.length).toBe(2); // parked1 + parked2

		const before = sim.dispatched.length;
		sim.enqueue("new");

		// New prefixed dispatched first, ahead of parked items.
		const nextDispatch = sim.dispatched[before];
		expect(nextDispatch.message.text).toMatch(SYSTEM_PREFIX_RE);
		expect(nextDispatch.message.text.endsWith("new")).toBe(true);
		expect(sim.queue.length).toBe(2); // parked items untouched

		// After turn ends, parked items drain in FIFO, unprefixed.
		sim.agentEnd();
		const d2 = sim.dispatched[sim.dispatched.length - 1];
		expect(d2.message.text).toBe("parked1");
		expect(d2.message.text).not.toMatch(SYSTEM_PREFIX_RE);

		sim.agentEnd();
		const d3 = sim.dispatched[sim.dispatched.length - 1];
		expect(d3.message.text).toBe("parked2");
		expect(d3.message.text).not.toMatch(SYSTEM_PREFIX_RE);

		sim.agentEnd();
		expect(sim.queue.isEmpty).toBe(true);
		expect(sim.status).toBe("idle");
	});

	test("(unstick 7) auto-retry timer cancelled by new input", () => {
		const sim = new DispatchSimulator();
		sim.enqueue("initial");
		sim.errorEnd("transient");
		const timer = sim.scheduleAutoRetry();
		expect(sim.pendingAutoRetryTimer).toBe(timer);
		expect(timer.cancelled).toBe(false);

		const before = sim.dispatched.length;
		sim.enqueue("user-input");

		expect(timer.cancelled).toBe(true);
		expect(sim.pendingAutoRetryTimer).toBeUndefined();
		// Only ONE dispatch from the unstick (no double dispatch from retry timer).
		expect(sim.dispatched.length).toBe(before + 1);
	});

	test("aborting status transition during force-abort (PI-21b)", () => {
		const sim = new DispatchSimulator();

		// Start streaming
		sim.enqueue("Running");
		expect(sim.status).toBe("streaming");
		expect(sim.statusTransitions).toEqual(["idle", "streaming"]);

		// User aborts — should see aborting status
		sim.batchedSteerAbort();

		// Transitions should include "aborting": streaming → aborting → idle
		expect(sim.statusTransitions).toContain("aborting");
		expect(sim.statusTransitions).toEqual(["idle", "streaming", "aborting", "idle"]);
	});
});
