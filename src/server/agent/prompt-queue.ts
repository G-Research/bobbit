import { randomUUID } from "node:crypto";
import { isMessageAuthor, type MessageAuthor } from "../../shared/message-author.js";
import { isPromptSource, type PromptSource } from "../../shared/prompt-source.js";
import type {
	DeliveryIntentKind,
	DeliveryState,
	DeliveryTargetTurn,
	QueuedMessage,
} from "../ws/protocol.js";

interface PromptQueueEnqueueOptions {
	/** Occurrence-owned outward text when `text` contains model-only context. */
	displayText?: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered?: boolean;
	suppressTitleGen?: boolean;
	source?: PromptSource;
	verifierOwned?: boolean;
	author?: MessageAuthor;
	streamingBehavior?: QueuedMessage["streamingBehavior"];
	coldStart?: boolean;
	goalDispatchGuardId?: string;
	/** Stable occurrence identity supplied by an admission boundary. */
	intentId?: string;
	kind?: DeliveryIntentKind;
	targetTurn?: DeliveryTargetTurn;
	sequence?: number;
	deliveryState?: DeliveryState;
	deliveryReason?: string;
	deliveryError?: string;
	retryable?: boolean;
}

function validKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validKind(value: unknown): value is DeliveryIntentKind {
	return value === "prompt" || value === "steer";
}

function validTargetTurn(value: unknown): value is DeliveryTargetTurn {
	return value === "continuation" || value === "next-turn";
}

function validDeliveryState(value: unknown): value is DeliveryState {
	return value === "queued"
		|| value === "dispatching"
		|| value === "received"
		|| value === "uncertain"
		|| value === "failed"
		|| value === "cancelled";
}

function boundedDiagnostic(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, 512) : undefined;
}

/**
 * Normalize queue rows at the persistence boundary. Legacy rows retain absent
 * delivery metadata so their historical steer-priority behavior stays isolated;
 * identified reliable rows receive conservative defaults for partial metadata.
 */
function normalizeQueuedMessage(
	message: QueuedMessage,
	fallbackSequence: (target: DeliveryTargetTurn) => number,
): QueuedMessage {
	const normalized = { ...message };
	if (!validKey(normalized.id)) normalized.id = randomUUID();
	if (normalized.displayText !== undefined && typeof normalized.displayText !== "string") {
		delete normalized.displayText;
	}
	if (normalized.author !== undefined && !isMessageAuthor(normalized.author)) {
		delete normalized.author;
	}
	if (normalized.source !== undefined && !isPromptSource(normalized.source)) {
		delete normalized.source;
	}
	if (!validKey(normalized.goalDispatchGuardId)) delete normalized.goalDispatchGuardId;
	// Only explicit true grants verifier lifecycle ownership. This keeps old
	// source:"verification" persisted rows as ordinary durable work.
	if (normalized.verifierOwned !== true) delete normalized.verifierOwned;
	// Older partial records may carry the accountable author without source.
	if (normalized.source === undefined && isMessageAuthor(normalized.author)) {
		normalized.source = normalized.author.kind;
	}

	const carriesReliableMetadata = normalized.kind !== undefined
		|| normalized.targetTurn !== undefined
		|| normalized.sequence !== undefined
		|| normalized.deliveryState !== undefined;
	if (carriesReliableMetadata) {
		const kind = validKind(normalized.kind)
			? normalized.kind
			: normalized.isSteered ? "steer" : "prompt";
		const targetTurn = validTargetTurn(normalized.targetTurn)
			? normalized.targetTurn
			: kind === "steer" ? "continuation" : "next-turn";
		normalized.kind = kind;
		normalized.targetTurn = targetTurn;
		normalized.sequence = validSequence(normalized.sequence)
			? normalized.sequence
			: fallbackSequence(targetTurn);
		normalized.deliveryState = validDeliveryState(normalized.deliveryState)
			? normalized.deliveryState
			: "queued";
	}
	const deliveryReason = boundedDiagnostic(normalized.deliveryReason);
	const deliveryError = boundedDiagnostic(normalized.deliveryError);
	if (deliveryReason === undefined) delete normalized.deliveryReason;
	else normalized.deliveryReason = deliveryReason;
	if (deliveryError === undefined) delete normalized.deliveryError;
	else normalized.deliveryError = deliveryError;
	return normalized;
}

/**
 * Server-side durable intent queue for a single session.
 *
 * The array retains the existing user-visible reorder contract. Targeted
 * dequeue uses the persisted lane sequence so continuation and next-turn work
 * can be released independently without losing FIFO occurrence order.
 */
export class PromptQueue {
	private queue: QueuedMessage[] = [];
	private nextSequence: Record<DeliveryTargetTurn, number> = {
		continuation: 1,
		"next-turn": 1,
	};

	/** Create a queue, optionally restoring from persisted data. */
	constructor(initial?: QueuedMessage[]) {
		if (!initial) return;
		const seen = new Set<string>();
		for (const message of initial) {
			const normalized = normalizeQueuedMessage(message, (target) => this.allocateSequence(target));
			if (seen.has(normalized.id)) continue;
			seen.add(normalized.id);
			this.observeSequence(normalized);
			this.queue.push(normalized);
		}
	}

	private allocateSequence(target: DeliveryTargetTurn): number {
		const sequence = this.nextSequence[target];
		this.nextSequence[target] += 1;
		return sequence;
	}

	private observeSequence(message: QueuedMessage): void {
		if (!validTargetTurn(message.targetTurn) || !validSequence(message.sequence)) return;
		this.nextSequence[message.targetTurn] = Math.max(
			this.nextSequence[message.targetTurn],
			message.sequence + 1,
		);
	}

	private createMessage(text: string, opts?: PromptQueueEnqueueOptions): QueuedMessage {
		const isSteered = opts?.isSteered ?? opts?.kind === "steer";
		const reliable = validKey(opts?.intentId)
			|| opts?.kind !== undefined
			|| opts?.targetTurn !== undefined
			|| opts?.sequence !== undefined
			|| opts?.deliveryState !== undefined;
		const msg: QueuedMessage = {
			id: validKey(opts?.intentId) ? opts.intentId : randomUUID(),
			text,
			isSteered,
			createdAt: Date.now(),
		};
		if (typeof opts?.displayText === "string") msg.displayText = opts.displayText;
		if (reliable) {
			const kind = opts?.kind ?? (isSteered ? "steer" : "prompt");
			const targetTurn = opts?.targetTurn ?? (kind === "steer" ? "continuation" : "next-turn");
			msg.kind = kind;
			msg.targetTurn = targetTurn;
			msg.sequence = validSequence(opts?.sequence) ? opts.sequence : this.allocateSequence(targetTurn);
			msg.deliveryState = validDeliveryState(opts?.deliveryState) ? opts.deliveryState : "queued";
		}
		if (opts?.images?.length) msg.images = opts.images;
		if (opts?.attachments?.length) msg.attachments = opts.attachments;
		if (opts?.suppressTitleGen) msg.suppressTitleGen = true;
		if (opts?.source) msg.source = opts.source;
		if (opts?.verifierOwned) msg.verifierOwned = true;
		if (opts?.author && isMessageAuthor(opts.author)) msg.author = opts.author;
		if (opts?.streamingBehavior) msg.streamingBehavior = opts.streamingBehavior;
		if (opts?.coldStart) msg.coldStart = true;
		if (validKey(opts?.goalDispatchGuardId)) msg.goalDispatchGuardId = opts.goalDispatchGuardId;
		const deliveryReason = boundedDiagnostic(opts?.deliveryReason);
		const deliveryError = boundedDiagnostic(opts?.deliveryError);
		if (deliveryReason) msg.deliveryReason = deliveryReason;
		if (deliveryError) msg.deliveryError = deliveryError;
		if (opts?.retryable !== undefined) msg.retryable = opts.retryable;
		this.observeSequence(msg);
		return msg;
	}

	/** Add a newly admitted message. Legacy callers may omit an occurrence id. */
	enqueue(text: string, opts?: PromptQueueEnqueueOptions): QueuedMessage {
		const msg = this.createMessage(text, opts);
		const existing = this.queue.find((row) => row.id === msg.id);
		if (existing) return existing;
		this.queue.push(msg);
		if (msg.isSteered) this.reorder();
		return msg;
	}

	/**
	 * Admit or restore an already-identified occurrence without changing any of
	 * its delivery metadata. Replayed admission frames are idempotent by id.
	 */
	enqueueExisting(message: QueuedMessage): QueuedMessage {
		const existing = validKey(message?.id)
			? this.queue.find((row) => row.id === message.id)
			: undefined;
		if (existing) return existing;
		const normalized = normalizeQueuedMessage(message, (target) => this.allocateSequence(target));
		this.observeSequence(normalized);
		this.queue.push(normalized);
		return normalized;
	}

	/** Restore one exact occurrence at the front (failure/proven-no-start path). */
	enqueueExistingAtFront(message: QueuedMessage): QueuedMessage {
		const existing = validKey(message?.id)
			? this.queue.find((row) => row.id === message.id)
			: undefined;
		if (existing) return existing;
		const normalized = normalizeQueuedMessage(message, (target) => this.allocateSequence(target));
		this.observeSequence(normalized);
		this.queue.unshift(normalized);
		return normalized;
	}

	/**
	 * Mark a queued prompt as a continuation steer. Its continuation sequence is
	 * assigned when the user steers it, preserving the historical "order steered"
	 * behavior rather than its former next-turn position.
	 */
	steer(messageId: string): boolean {
		const msg = this.queue.find(m => m.id === messageId);
		if (!msg) return false;
		if (msg.isSteered) return true;
		const reliable = msg.kind !== undefined
			|| msg.targetTurn !== undefined
			|| msg.sequence !== undefined
			|| msg.deliveryState !== undefined;
		msg.isSteered = true;
		if (reliable) {
			msg.kind = "steer";
			msg.targetTurn = "continuation";
			msg.sequence = this.allocateSequence("continuation");
		}
		this.reorder();
		return true;
	}

	remove(messageId: string): boolean {
		const idx = this.queue.findIndex(m => m.id === messageId);
		if (idx === -1) return false;
		this.queue.splice(idx, 1);
		return true;
	}

	dequeue(): QueuedMessage | undefined {
		return this.queue.shift();
	}

	/** Pop the earliest occurrence in one target-turn lane. */
	dequeueForTarget(targetTurn: DeliveryTargetTurn): QueuedMessage | undefined {
		let selectedIndex = -1;
		let selectedSequence = Number.POSITIVE_INFINITY;
		for (let index = 0; index < this.queue.length; index++) {
			const row = this.queue[index];
			if (row.targetTurn !== targetTurn) continue;
			const sequence = validSequence(row.sequence) ? row.sequence : Number.POSITIVE_INFINITY;
			if (selectedIndex === -1 || sequence < selectedSequence) {
				selectedIndex = index;
				selectedSequence = sequence;
			}
		}
		if (selectedIndex === -1) return undefined;
		return this.queue.splice(selectedIndex, 1)[0];
	}

	dequeueAllSteered(): QueuedMessage[] {
		const result: QueuedMessage[] = [];
		while (this.queue.length > 0 && this.queue[0].isSteered) {
			result.push(this.queue.shift()!);
		}
		return result;
	}

	/** Legacy rollback API. New lifecycle code should use enqueueExistingAtFront. */
	enqueueAtFront(text: string, opts?: PromptQueueEnqueueOptions): QueuedMessage {
		const msg = this.createMessage(text, opts);
		const existing = this.queue.find((row) => row.id === msg.id);
		if (existing) return existing;
		this.queue.unshift(msg);
		this.reorder();
		return msg;
	}

	/**
	 * Restore an already-admitted row at the front without allocating a new ID.
	 * Receipts correlate dispatch/recovery/cancellation to this durable identity.
	 */
	restoreAtFront(message: QueuedMessage): QueuedMessage {
		const restored = this.enqueueExistingAtFront(message);
		this.reorder();
		return restored;
	}

	peek(): QueuedMessage | undefined {
		return this.queue[0];
	}

	toArray(): QueuedMessage[] {
		return [...this.queue];
	}

	get length(): number {
		return this.queue.length;
	}

	get isEmpty(): boolean {
		return this.queue.length === 0;
	}

	reorderByIds(messageIds: string[], opts?: { resequenceReliableLanes?: boolean }): void {
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
		if (opts?.resequenceReliableLanes) this.resequenceReliableLanes();
	}

	/**
	 * Make an explicit visible reorder durable for lane-aware dequeue. Reassign
	 * only the queued rows' existing sequence slots: lane membership and the
	 * independently ordered in-flight ledger remain untouched.
	 */
	private resequenceReliableLanes(): void {
		for (const targetTurn of ["continuation", "next-turn"] as const) {
			const rows = this.queue.filter((row) => row.targetTurn === targetTurn && validSequence(row.sequence));
			const sequenceSlots = rows.map((row) => row.sequence!).sort((left, right) => left - right);
			for (let index = 0; index < rows.length; index++) rows[index].sequence = sequenceSlots[index];
		}
	}

	/**
	 * Restore proven-no-start rows and move every unresolved continuation into the
	 * next-turn lane as one operation. Accepted time is the session-wide immutable
	 * admission ordinal for modern rows; stable input order conservatively breaks
	 * ties in legacy persisted data. Reallocating the merged lane prevents sequence
	 * collisions while preserving the occurrence payload and identity.
	 */
	retargetContinuationToNextTurn(reason: string, restoredRows: QueuedMessage[] = []): QueuedMessage[] {
		for (const message of restoredRows) this.enqueueExisting(message);

		const retargeted = this.queue.filter((row) =>
			row.targetTurn === "continuation"
				&& (row.deliveryState === undefined || row.deliveryState === "queued" || row.deliveryState === "failed"));
		if (retargeted.length === 0) return [];

		for (const row of retargeted) {
			row.targetTurn = "next-turn";
			row.deliveryReason = reason;
		}

		const laneSlots: number[] = [];
		const laneRows: Array<{ row: QueuedMessage; priorIndex: number }> = [];
		for (let index = 0; index < this.queue.length; index++) {
			const row = this.queue[index];
			if (row.targetTurn !== "next-turn" || row.kind === undefined) continue;
			laneSlots.push(index);
			laneRows.push({ row, priorIndex: index });
		}
		laneRows.sort((left, right) => {
			const acceptedDifference = left.row.createdAt - right.row.createdAt;
			return acceptedDifference || left.priorIndex - right.priorIndex;
		});
		for (let index = 0; index < laneRows.length; index++) {
			const row = laneRows[index].row;
			row.sequence = this.allocateSequence("next-turn");
			this.queue[laneSlots[index]] = row;
		}

		const retargetedIds = new Set(retargeted.map((row) => row.id));
		return laneRows.map(({ row }) => row).filter((row) => retargetedIds.has(row.id));
	}

	private reorder(): void {
		const steered = this.queue.filter(m => m.isSteered);
		const normal = this.queue.filter(m => !m.isSteered);
		this.queue = [...steered, ...normal];
	}
}
