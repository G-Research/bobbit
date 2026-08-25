/** A buffered event carries a per-session monotonic `seq` (assigned at
 *  broadcast time) and a wall-clock `ts` so the client can dedupe by seq and
 *  order by seq across a reconnect gap. See docs/design/streaming-dedup-reorder.md. */
export interface BufferedEvent {
	seq: number;
	ts: number;
	event: unknown;
}

interface RetainedEvent {
	entry: BufferedEvent;
	/** Cached UTF-8 byte length of the entry's serialized wire shape. */
	bytes: number;
}

/** Recent agent events for reconnection catch-up, bounded by count and bytes. */
export class EventBuffer {
	/** Floor sentinel reserved for snapshot ordering. All snapshot `_order`
	 *  values are strictly less than every live `seq` (which starts at 1).
	 *  See docs/design/unified-message-ordering-reducer.md §3.2. */
	static readonly SNAPSHOT_ORDER_FLOOR = -1_000_000_000;

	/** Match the existing 2 MiB resume replay budget: retaining more cannot be
	 *  replayed and only increases old-generation heap pressure. */
	static readonly DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

	/** Minimum discarded prefix before compacting the backing array. */
	private static readonly COMPACTION_MIN_PREFIX = 1024;

	private buffer: Array<RetainedEvent | undefined> = [];
	/** Index of the oldest live entry in `buffer`. Slots before it are cleared. */
	private head = 0;
	private readonly maxSize: number;
	private readonly byteLimit: number;
	private bytesRetained = 0;
	/** Highest assigned seq that is intentionally not retained. A client whose
	 *  cursor predates this seq must recover through `resume_gap`/snapshot. */
	private lastUnretainedSeq = 0;
	private nextSeq = 1;

	constructor(maxSize = 1000, maxBytes = EventBuffer.DEFAULT_MAX_BYTES) {
		this.maxSize = Number.isFinite(maxSize) ? Math.max(0, Math.floor(maxSize)) : 0;
		this.byteLimit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
	}

	/** Append an event, assigning it a monotonic `seq` and wall-clock `ts`.
	 *  Returns the entry so callers can attach seq/ts to the broadcast, even if
	 *  it is too large to retain. An oversized/unserializable event clears the
	 *  retained window so canResumeFrom() cannot claim a replay across its gap. */
	push(event: unknown): BufferedEvent {
		const entry: BufferedEvent = { seq: this.nextSeq++, ts: Date.now(), event };
		const bytes = this.estimateSerializedBytes(entry);

		if (bytes > this.byteLimit || this.maxSize === 0) {
			this.dropAllRetained();
			this.lastUnretainedSeq = entry.seq;
			return entry;
		}

		this.buffer.push({ entry, bytes });
		this.bytesRetained += bytes;
		while (this.size > this.maxSize || this.bytesRetained > this.byteLimit) {
			const evicted = this.buffer[this.head];
			// Release the evicted payload graph without shifting the live suffix.
			this.buffer[this.head++] = undefined;
			if (evicted) this.bytesRetained -= evicted.bytes;
		}
		this.compactIfNeeded();
		return entry;
	}

	/** Like push() but for non-`event` frames (e.g. `tool_permission_needed`)
	 *  that need a seq for client ordering but do NOT need to be retained for
	 *  reconnect resume — the client recovers them via the messages snapshot.
	 *  Stamps a monotonic `seq` and wall-clock `ts` without touching the ring.
	 *  See docs/design/unified-message-ordering-reducer.md §3.1. */
	pushFrame(): { seq: number; ts: number } {
		const frame = { seq: this.nextSeq++, ts: Date.now() };
		this.lastUnretainedSeq = frame.seq;
		return frame;
	}

	/** All buffered entries, oldest first. */
	getAll(): BufferedEvent[] {
		const out: BufferedEvent[] = [];
		for (let index = this.head; index < this.buffer.length; index++) {
			const retained = this.buffer[index];
			if (retained) out.push(retained.entry);
		}
		return out;
	}

	/** Return entries whose `seq > fromSeq`, preserving buffer order. */
	since(fromSeq: number): BufferedEvent[] {
		const oldest = this.buffer[this.head];
		if (!oldest) return [];
		// If fromSeq is older than our oldest retained - 1, we cannot resume.
		// Callers should check canResumeFrom first; we return all as a best-effort.
		if (fromSeq < oldest.entry.seq - 1) return this.getAll();
		const out: BufferedEvent[] = [];
		for (let index = this.head; index < this.buffer.length; index++) {
			const retained = this.buffer[index];
			if (retained && retained.entry.seq > fromSeq) out.push(retained.entry);
		}
		return out;
	}

	/** True if `fromSeq` falls inside the retained window (i.e. we still hold
	 *  `fromSeq + 1`, or the buffer is empty meaning no events were missed). */
	canResumeFrom(fromSeq: number): boolean {
		// A pushFrame/oversized event after the client's cursor is an explicit hole:
		// it is recoverable only from the authoritative snapshot path.
		if (fromSeq < this.lastUnretainedSeq) return false;
		// Empty buffer: resume is only safe if the client is already caught up
		// (fromSeq === lastSeq). Otherwise events were evicted or never seen.
		const oldest = this.buffer[this.head];
		if (!oldest) return fromSeq === this.lastSeq;
		// Non-empty: we need at least seq === fromSeq + 1 retained,
		// i.e. the oldest retained entry has seq <= fromSeq + 1.
		return oldest.entry.seq <= fromSeq + 1;
	}

	clear(): void {
		this.dropAllRetained();
		this.lastUnretainedSeq = 0;
		this.nextSeq = 1;
	}

	/** Reseed the next-seq counter so a freshly constructed buffer continues
	 *  the previous one's monotonic sequence space. Used by `_restartAgent`-class
	 *  flows to preserve the client-side `_highestSeq` frame of reference across
	 *  a server-side process respawn (clients do NOT disconnect during the
	 *  restart, so their `_highestSeq` keeps the old high-water mark — if the
	 *  new buffer started back at 1, every fresh event would be silently dropped
	 *  by the client's `seq <= _highestSeq` dedup gate).
	 *  See docs/design/restart-preserves-streaming-frame-of-reference.md. */
	seedNextSeq(seq: number): void {
		if (!Number.isFinite(seq) || seq < 1) return;
		if (seq <= this.nextSeq) return; // never go backwards
		this.nextSeq = seq;
	}

	get size(): number {
		return this.buffer.length - this.head;
	}

	/** Estimated serialized UTF-8 bytes currently retained. */
	get retainedBytes(): number {
		return this.bytesRetained;
	}

	/** Configured serialized-byte retention budget. */
	get maxBytes(): number {
		return this.byteLimit;
	}

	/** Highest seq assigned so far (0 if nothing has been pushed). */
	get lastSeq(): number {
		return this.nextSeq - 1;
	}

	private estimateSerializedBytes(entry: BufferedEvent): number {
		try {
			return Buffer.byteLength(JSON.stringify(entry), "utf8");
		} catch {
			// Circular values and BigInts cannot be replayed as JSON. Treat them as
			// oversized so they do not make the retained window falsely resumable.
			return Number.POSITIVE_INFINITY;
		}
	}

	private compactIfNeeded(): void {
		if (
			this.head >= EventBuffer.COMPACTION_MIN_PREFIX
			&& this.head >= this.size
		) {
			this.buffer = this.buffer.slice(this.head);
			this.head = 0;
		}
	}

	private dropAllRetained(): void {
		this.buffer = [];
		this.head = 0;
		this.bytesRetained = 0;
	}
}
