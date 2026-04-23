/** A buffered event carries a per-session monotonic `seq` (assigned at
 *  broadcast time) and a wall-clock `ts` so the client can dedupe by seq and
 *  order by seq across a reconnect gap. See docs/design/streaming-dedup-reorder.md. */
export interface BufferedEvent {
	seq: number;
	ts: number;
	event: unknown;
}

/** Circular buffer of recent agent events for reconnection catch-up. */
export class EventBuffer {
	private buffer: BufferedEvent[] = [];
	private maxSize: number;
	private nextSeq = 1;

	constructor(maxSize = 1000) {
		this.maxSize = maxSize;
	}

	/** Append an event, assigning it a monotonic `seq` and wall-clock `ts`.
	 *  Returns the stored entry so callers can attach seq/ts to the broadcast. */
	push(event: unknown): BufferedEvent {
		const entry: BufferedEvent = { seq: this.nextSeq++, ts: Date.now(), event };
		this.buffer.push(entry);
		if (this.buffer.length > this.maxSize) {
			this.buffer.shift();
		}
		return entry;
	}

	/** All buffered entries, oldest first. */
	getAll(): BufferedEvent[] {
		return [...this.buffer];
	}

	/** Return entries whose `seq > fromSeq`, preserving buffer order. */
	since(fromSeq: number): BufferedEvent[] {
		if (this.buffer.length === 0) return [];
		// If fromSeq is older than our oldest retained - 1, we cannot resume.
		// Callers should check canResumeFrom first; we return all as a best-effort.
		const first = this.buffer[0].seq;
		if (fromSeq < first - 1) return [...this.buffer];
		const out: BufferedEvent[] = [];
		for (const e of this.buffer) {
			if (e.seq > fromSeq) out.push(e);
		}
		return out;
	}

	/** True if `fromSeq` falls inside the retained window (i.e. we still hold
	 *  `fromSeq + 1`, or the buffer is empty meaning no events were missed). */
	canResumeFrom(fromSeq: number): boolean {
		// Empty buffer: resume is only safe if the client is already caught up
		// (fromSeq === lastSeq). Otherwise events were evicted or never seen.
		if (this.buffer.length === 0) return fromSeq === this.lastSeq;
		// Non-empty: we need at least seq === fromSeq + 1 retained,
		// i.e. the oldest retained entry has seq <= fromSeq + 1.
		return this.buffer[0].seq <= fromSeq + 1;
	}

	clear(): void {
		this.buffer = [];
		this.nextSeq = 1;
	}

	get size(): number {
		return this.buffer.length;
	}

	/** Highest seq assigned so far (0 if nothing has been pushed). */
	get lastSeq(): number {
		return this.nextSeq - 1;
	}
}
