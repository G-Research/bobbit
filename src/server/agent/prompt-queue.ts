import { randomUUID } from "node:crypto";
import type { QueuedMessage } from "../ws/protocol.js";

/**
 * Server-side prompt queue for a single session.
 * Steered messages sort before non-steered, stable within each group.
 */
export class PromptQueue {
	private queue: QueuedMessage[] = [];

	/** Create a queue, optionally restoring from persisted data. */
	constructor(initial?: QueuedMessage[]) {
		if (initial) {
			this.queue = [...initial];
		}
	}

	/** Add a message to the end of the queue. Returns the queued message. */
	enqueue(text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
	}): QueuedMessage {
		const msg: QueuedMessage = {
			id: randomUUID(),
			text,
			isSteered: opts?.isSteered ?? false,
			createdAt: Date.now(),
		};
		if (opts?.images?.length) msg.images = opts.images;
		if (opts?.attachments?.length) msg.attachments = opts.attachments;

		this.queue.push(msg);
		if (msg.isSteered) this.reorder();
		return msg;
	}

	/**
	 * Mark a message as steered and reorder.
	 * Steered messages sort before non-steered, stable within each group.
	 * Returns true if the message was found and updated.
	 */
	steer(messageId: string): boolean {
		const msg = this.queue.find(m => m.id === messageId);
		if (!msg) return false;
		if (msg.isSteered) return true; // already steered
		msg.isSteered = true;
		this.reorder();
		return true;
	}

	/** Remove a message from the queue. Returns true if found and removed. */
	remove(messageId: string): boolean {
		const idx = this.queue.findIndex(m => m.id === messageId);
		if (idx === -1) return false;
		this.queue.splice(idx, 1);
		return true;
	}

	/** Pop the next message from the front of the queue. Returns undefined if empty. */
	dequeue(): QueuedMessage | undefined {
		return this.queue.shift();
	}

	/**
	 * Pop the next undispatched message, removing any already-dispatched
	 * messages from the front. Used by drainQueue to skip steered messages
	 * that were already sent mid-turn.
	 */
	dequeueUndispatched(): QueuedMessage | undefined {
		while (this.queue.length > 0 && this.queue[0].dispatched) {
			this.queue.shift();
		}
		return this.queue.shift();
	}

	/** Remove all dispatched messages from the queue. Returns true if any were removed. */
	removeDispatched(): boolean {
		const before = this.queue.length;
		this.queue = this.queue.filter(m => !m.dispatched);
		return this.queue.length < before;
	}

	/**
	 * Clear the dispatched flag on all queue items.
	 * Used after force-kill restart so drainQueue picks up messages that were
	 * dispatched to stdin of a now-dead process.
	 */
	resetDispatched(): void {
		for (const m of this.queue) {
			m.dispatched = false;
		}
	}

	/** Mark a message as dispatched (sent mid-turn, kept for UI display). */
	markDispatched(messageId: string): boolean {
		const msg = this.queue.find(m => m.id === messageId);
		if (!msg) return false;
		msg.dispatched = true;
		return true;
	}

	/** Peek at the front of the queue without removing. */
	peek(): QueuedMessage | undefined {
		return this.queue[0];
	}

	/** Get the full queue as an array (for broadcasting). */
	toArray(): QueuedMessage[] {
		return [...this.queue];
	}

	/** Number of messages in the queue. */
	get length(): number {
		return this.queue.length;
	}

	/** Whether the queue is empty. */
	get isEmpty(): boolean {
		return this.queue.length === 0;
	}

	/** Reorder queue to match the given ID list. Unknown IDs ignored. Unlisted items appended at end. */
	reorderByIds(messageIds: string[]): void {
		const byId = new Map(this.queue.map(m => [m.id, m]));
		const reordered: QueuedMessage[] = [];
		const seen = new Set<string>();
		for (const id of messageIds) {
			const msg = byId.get(id);
			if (msg) { reordered.push(msg); seen.add(id); }
		}
		for (const msg of this.queue) {
			if (!seen.has(msg.id)) reordered.push(msg);
		}
		this.queue = reordered;
	}

	/**
	 * Stable reorder: steered messages first, non-steered second.
	 * Within each group, original insertion order is preserved.
	 */
	private reorder(): void {
		const steered = this.queue.filter(m => m.isSteered);
		const normal = this.queue.filter(m => !m.isSteered);
		this.queue = [...steered, ...normal];
	}
}
