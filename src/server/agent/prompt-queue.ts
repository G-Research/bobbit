import { randomUUID } from "node:crypto";
import { isMessageAuthor, type MessageAuthor } from "../../shared/message-author.js";
import { isPromptSource, type PromptSource } from "../../shared/prompt-source.js";
import type { QueuedMessage } from "../ws/protocol.js";

interface PromptQueueEnqueueOptions {
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered?: boolean;
	suppressTitleGen?: boolean;
	source?: PromptSource;
	author?: MessageAuthor;
}

/** Durable delivery state for the single FIFO row owned by a prompt attempt. */
export type PromptDeliveryState = "dispatching" | "awaiting-ack" | "retrying";
export type DurableQueuedMessage = QueuedMessage & {
	deliveryState?: PromptDeliveryState;
	deliveryAttempt?: number;
	/** Author-sidecar prompt identity; differs from row IDs for steered batches. */
	deliveryPromptId?: string;
};

/** A delivery-owned row is protocol state, not a user-editable queue entry. */
export function hasPromptDeliveryOwnership(message: DurableQueuedMessage): boolean {
	return message.deliveryState !== undefined
		|| (typeof message.deliveryPromptId === "string" && message.deliveryPromptId.length > 0);
}

function normalizeQueuedMessage(message: QueuedMessage): DurableQueuedMessage {
	const normalized: DurableQueuedMessage = { ...message };
	if (normalized.author !== undefined && !isMessageAuthor(normalized.author)) {
		delete normalized.author;
	}
	if (normalized.source !== undefined && !isPromptSource(normalized.source)) {
		delete normalized.source;
	}
	// Older partial records may carry the accountable author without source.
	// Recover the coarser source rather than defaulting an agent/system row to user.
	if (normalized.source === undefined && isMessageAuthor(normalized.author)) {
		normalized.source = normalized.author.kind;
	}
	if (normalized.deliveryState !== "dispatching"
		&& normalized.deliveryState !== "awaiting-ack"
		&& normalized.deliveryState !== "retrying") {
		delete normalized.deliveryState;
		delete normalized.deliveryAttempt;
	} else {
		// A live generation fences dispatching/awaiting-ACK rows. Constructing a
		// queue from persisted/replacement state starts a new bridge generation,
		// where the same stable ID must be eligible for deterministic redrive.
		if (normalized.deliveryState !== "retrying") normalized.deliveryState = "retrying";
		if (!Number.isSafeInteger(normalized.deliveryAttempt) || (normalized.deliveryAttempt ?? 0) < 1) {
			delete normalized.deliveryAttempt;
		}
	}
	// A stable prompt identity is independently sufficient delivery ownership.
	// Preserve partial crash-window records so generic controls cannot erase them.
	if (typeof normalized.deliveryPromptId !== "string" || normalized.deliveryPromptId.length === 0) {
		delete normalized.deliveryPromptId;
	}
	return normalized;
}

/**
 * Server-side prompt queue for a single session.
 * Steered messages sort before non-steered, stable within each group.
 */
export class PromptQueue {
	private queue: DurableQueuedMessage[] = [];

	/** Create a queue, optionally restoring from persisted data. */
	constructor(initial?: QueuedMessage[]) {
		if (initial) {
			this.queue = initial.map(normalizeQueuedMessage);
		}
	}

	/** Add a message to the end of the queue. Returns the queued message. */
	enqueue(text: string, opts?: PromptQueueEnqueueOptions): QueuedMessage {
		const msg: QueuedMessage = {
			id: randomUUID(),
			text,
			isSteered: opts?.isSteered ?? false,
			createdAt: Date.now(),
		};
		if (opts?.images?.length) msg.images = opts.images;
		if (opts?.attachments?.length) msg.attachments = opts.attachments;
		if (opts?.suppressTitleGen) msg.suppressTitleGen = true;
		if (opts?.source) msg.source = opts.source;
		if (opts?.author && isMessageAuthor(opts.author)) msg.author = opts.author;

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

	/** Generic client removal may not erase a protocol-owned delivery row. */
	removeUnowned(messageId: string): boolean {
		const idx = this.queue.findIndex((message) => message.id === messageId);
		if (idx === -1 || hasPromptDeliveryOwnership(this.queue[idx])) return false;
		this.queue.splice(idx, 1);
		return true;
	}

	/** Pop the next message from the front of the queue. Returns undefined if empty. */
	dequeue(): QueuedMessage | undefined {
		return this.queue.shift();
	}

	/** Pop all consecutive steered messages from the front. Returns empty array if front is not steered. */
	dequeueAllSteered(): QueuedMessage[] {
		const result: QueuedMessage[] = [];
		while (this.queue.length > 0 && this.queue[0].isSteered) {
			result.push(this.queue.shift()!);
		}
		return result;
	}

	/** Read all consecutive steered rows without transferring FIFO ownership. */
	peekAllSteered(): DurableQueuedMessage[] {
		const result: DurableQueuedMessage[] = [];
		for (const row of this.queue) {
			if (!row.isSteered) break;
			result.push(row);
		}
		return result;
	}

	/** Mark existing rows as dispatched/retrying without changing their identity or order. */
	markDelivery(
		messageIds: readonly string[],
		state: PromptDeliveryState,
		attempt: number,
		promptId?: string,
	): void {
		const ids = new Set(messageIds);
		for (const row of this.queue) {
			if (!ids.has(row.id)) continue;
			row.deliveryState = state;
			row.deliveryAttempt = Math.max(1, Math.floor(attempt));
			if (promptId) row.deliveryPromptId = promptId;
		}
	}

	/**
	 * Insert a message at the front of the queue. Used by reconciliation paths
	 * (e.g. RPC failure rollback) that need to put a row back at index 0.
	 * Calls reorder() so the steered group still sorts first.
	 */
	enqueueAtFront(text: string, opts?: PromptQueueEnqueueOptions): QueuedMessage {
		const msg: QueuedMessage = {
			id: randomUUID(),
			text,
			isSteered: opts?.isSteered ?? false,
			createdAt: Date.now(),
		};
		if (opts?.images?.length) msg.images = opts.images;
		if (opts?.attachments?.length) msg.attachments = opts.attachments;
		if (opts?.suppressTitleGen) msg.suppressTitleGen = true;
		if (opts?.source) msg.source = opts.source;
		if (opts?.author && isMessageAuthor(opts.author)) msg.author = opts.author;
		this.queue.unshift(msg);
		this.reorder();
		return msg;
	}

	/** Restore an already-owned durable row without allocating a new identity. */
	restoreAtFront(message: DurableQueuedMessage): DurableQueuedMessage {
		const normalized = normalizeQueuedMessage(message);
		const existing = this.queue.findIndex((row) => row.id === normalized.id);
		if (existing !== -1) this.queue.splice(existing, 1);
		this.queue.unshift(normalized);
		this.reorder();
		return normalized;
	}

	/** Peek at the front of the queue without removing. */
	peek(): QueuedMessage | undefined {
		return this.queue[0];
	}

	/** Get the full queue as an array (for broadcasting). */
	toArray(): DurableQueuedMessage[] {
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
		const reordered: DurableQueuedMessage[] = [];
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
	 * Apply a generic client reorder without moving protocol-owned rows. Unknown,
	 * duplicate, or stale attempts to move an explicitly listed owned row fail
	 * closed. Hidden owned rows remain pinned at their absolute FIFO positions.
	 */
	reorderUnownedByIds(messageIds: readonly string[]): boolean {
		const byId = new Map(this.queue.map((message, index) => [message.id, { message, index }]));
		const seen = new Set<string>();
		const requestedUnowned: DurableQueuedMessage[] = [];

		for (let requestedIndex = 0; requestedIndex < messageIds.length; requestedIndex++) {
			const id = messageIds[requestedIndex];
			const entry = byId.get(id);
			if (!entry || seen.has(id)) return false;
			seen.add(id);
			if (hasPromptDeliveryOwnership(entry.message)) {
				if (entry.index !== requestedIndex) return false;
				continue;
			}
			requestedUnowned.push(entry.message);
		}

		const unowned = [
			...requestedUnowned,
			...this.queue.filter((message) => !hasPromptDeliveryOwnership(message) && !seen.has(message.id)),
		];
		let nextUnowned = 0;
		this.queue = this.queue.map((message) => hasPromptDeliveryOwnership(message)
			? message
			: unowned[nextUnowned++]);
		return true;
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
