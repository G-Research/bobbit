import type { Clock, FsLike } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";

export interface JsonWriteMetrics {
	bytes: number;
	durationMs: number;
}

/**
 * Serializes whole-file JSON snapshots without allowing a mutation burst to
 * create concurrent or unbounded writes. A successful rename is the publish
 * point; a failed write leaves the previous primary intact.
 */
export class CoalescedJsonWriter {
	private timer: ReturnType<Clock["setTimeout"]> | null = null;
	private inFlight: Promise<void> | null = null;
	private requested = false;
	private lastWriteMetrics: JsonWriteMetrics | null = null;
	/** Bumped for every new snapshot so an older async write cannot publish late. */
	private revision = 0;

	constructor(
		private readonly fs: FsLike,
		private readonly directory: string,
		private readonly file: string,
		private readonly snapshot: () => string,
		private readonly label: string,
		private readonly debounceMs = 500,
		private readonly clock: Clock = realClock,
		private readonly onWrite?: (metrics: JsonWriteMetrics) => void,
	) {}

	/** Metrics for the latest atomic publish, for low-cost persistence diagnostics. */
	getLastWriteMetrics(): JsonWriteMetrics | null {
		return this.lastWriteMetrics;
	}

	/** Mark the current in-memory snapshot dirty and arrange a trailing write. */
	schedule(): void {
		this.revision++;
		this.requested = true;
		if (this.inFlight || this.timer) return;
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			void this.startDrain();
		}, this.debounceMs);
	}

	/** Start a write immediately, coalescing with any active writer. */
	flush(): Promise<void> {
		this.revision++;
		this.requested = true;
		if (this.timer) {
			this.clock.clearTimeout(this.timer);
			this.timer = null;
		}
		return this.startDrain();
	}

	/**
	 * A strict synchronous transaction has already published the current
	 * snapshot. Cancel a delayed writer (or make an active one discard its temp
	 * payload) so it cannot replace that transaction with an older snapshot.
	 */
	markExternallyPublished(): void {
		this.revision++;
		this.requested = false;
		if (this.timer) {
			this.clock.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private startDrain(): Promise<void> {
		if (!this.inFlight) {
			this.inFlight = this.drain().finally(() => {
				this.inFlight = null;
				// A mutation can arrive as the promise settles. Starting another
				// drain here closes that settlement-boundary loss window.
				if (this.requested) void this.startDrain();
			});
		}
		return this.inFlight;
	}

	private async drain(): Promise<void> {
		while (this.requested) {
			this.requested = false;
			const revision = this.revision;
			const startedAt = performance.now();
			try {
				const json = this.snapshot();
				await this.fs.promises.mkdir(this.directory, { recursive: true });
				const tmp = `${this.file}.tmp`;
				await this.fs.promises.writeFile(tmp, json, "utf-8");
				if (revision !== this.revision) {
					try { await this.fs.promises.unlink(tmp); } catch { /* superseded temp */ }
					continue;
				}
				await this.fs.promises.rename(tmp, this.file);
				this.lastWriteMetrics = { bytes: Buffer.byteLength(json), durationMs: performance.now() - startedAt };
				this.onWrite?.(this.lastWriteMetrics);
			} catch (error) {
				console.error(`[${this.label}] Failed to save:`, error);
				try { await this.fs.promises.unlink(`${this.file}.tmp`); } catch { /* best-effort cleanup */ }
			}
		}
	}
}
