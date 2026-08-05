import { Worker } from "node:worker_threads";

import type { Clock, FsLike } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import { getCpuDiagnostics, recordEventLoopOperation } from "./cpu-diagnostics.js";

export interface JsonWriteMetrics {
	bytes: number;
	/** Backwards-compatible alias for writeMs. */
	durationMs: number;
	serializationMs: number;
	writeMs: number;
	filesWritten: number;
}

type Barrier = {
	revision: number;
	resolve: () => void;
	reject: (error: unknown) => void;
};

const JSON_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try { const json = JSON.stringify(workerData); parentPort.postMessage({ ok: true, json }); }
catch (error) { parentPort.postMessage({ ok: false, error: error?.stack || String(error) }); }
`;

/** JSON.stringify large bounded records away from the gateway event loop. */
function stringifyInWorker(value: unknown): Promise<string> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(JSON_WORKER_SOURCE, { eval: true, workerData: value });
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			void worker.terminate();
			fn();
		};
		worker.on("message", (message: { ok?: boolean; json?: string; error?: string }) => {
			if (message.ok && typeof message.json === "string") finish(() => resolve(message.json!));
			else finish(() => reject(new Error(message.error ?? "JSON serialization worker failed")));
		});
		worker.on("error", error => finish(() => reject(error)));
		worker.on("exit", code => { if (!settled) finish(() => reject(new Error(`JSON serialization worker exited (${code})`))); });
	});
}

/**
 * Serializes whole-file JSON snapshots without allowing a mutation burst to
 * create concurrent or unbounded writes. Every atomic rename, including a
 * strict lifecycle publication, passes through this one queue: an older async
 * rename can therefore never overtake a strict publication.
 */
export class CoalescedJsonWriter {
	private timer: ReturnType<Clock["setTimeout"]> | null = null;
	private inFlight: Promise<void> | null = null;
	private requested = false;
	private lastWriteMetrics: JsonWriteMetrics | null = null;
	/** Bumped for every requested snapshot. */
	private revision = 0;
	private publishedRevision = 0;
	private barriers: Barrier[] = [];

	constructor(
		private readonly fs: FsLike,
		private readonly directory: string,
		private readonly file: string,
		private readonly snapshot: () => unknown | Promise<unknown>,
		private readonly label: string,
		private readonly debounceMs = 500,
		private readonly clock: Clock = realClock,
		private readonly onWrite?: (metrics: JsonWriteMetrics) => void,
		/** Optional same-directory pre-publication name for store-specific WAL/fault seams. */
		private readonly stagingFile?: string,
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

	/**
	 * A durability barrier for the current snapshot. Unlike hot-path schedule(),
	 * this rejects when its requested generation cannot be atomically published.
	 */
	flush(): Promise<void> {
		if (!this.requested && !this.inFlight && !this.timer) return Promise.resolve();
		return this.requestBarrier();
	}

	/**
	 * Queue a fail-loud lifecycle publication behind any older coalesced write.
	 * This is a real publication fence, not a revision check before rename.
	 */
	publishStrict(): Promise<void> {
		return this.requestBarrier();
	}

	private requestBarrier(): Promise<void> {
		const revision = ++this.revision;
		this.requested = true;
		if (this.timer) {
			this.clock.clearTimeout(this.timer);
			this.timer = null;
		}
		const barrier = new Promise<void>((resolve, reject) => {
			this.barriers.push({ revision, resolve, reject });
		});
		void this.startDrain();
		return barrier;
	}

	private settlePublished(revision: number): void {
		this.publishedRevision = Math.max(this.publishedRevision, revision);
		const pending: Barrier[] = [];
		for (const barrier of this.barriers) {
			if (barrier.revision <= this.publishedRevision) barrier.resolve();
			else pending.push(barrier);
		}
		this.barriers = pending;
	}

	private settleFailed(revision: number, error: unknown): void {
		const pending: Barrier[] = [];
		for (const barrier of this.barriers) {
			if (barrier.revision <= revision) barrier.reject(error);
			else pending.push(barrier);
		}
		this.barriers = pending;
	}

	private startDrain(): Promise<void> {
		if (!this.inFlight) {
			this.inFlight = this.drain().finally(() => {
				this.inFlight = null;
				// Defer a trailing retry to let a strict caller synchronously roll
				// back its in-memory mutation after a rejected barrier.
				if (this.requested) queueMicrotask(() => { void this.startDrain(); });
			});
		}
		return this.inFlight;
	}

	private async drain(): Promise<void> {
		while (this.requested) {
			this.requested = false;
			const revision = this.revision;
			try {
				const serializeStartedAt = performance.now();
				const snapshot = await this.snapshot();
				const workerBacked = typeof snapshot !== "string";
				const json = workerBacked ? await stringifyInWorker(snapshot) : snapshot;
				const bytes = Buffer.byteLength(json);
				const serializeMs = performance.now() - serializeStartedAt;
				// Worker wall time is observable persistence latency, not an event-loop
				// stall. Only synchronous legacy snapshots enter the lag diagnostic.
				if (!workerBacked) recordEventLoopOperation(`${this.label}:serialize`, serializeMs, { bytes });
				getCpuDiagnostics().recordPersistence(`${this.label}:serialize`, serializeMs, bytes);
				const writeStartedAt = performance.now();
				await this.fs.promises.mkdir(this.directory, { recursive: true });
				const tmp = `${this.file}.tmp`;
				await this.fs.promises.writeFile(tmp, json, "utf-8");
				if (this.stagingFile) {
					await this.fs.promises.rename(tmp, this.stagingFile);
					await this.fs.promises.rename(this.stagingFile, this.file);
				} else {
					await this.fs.promises.rename(tmp, this.file);
				}
				const writeMs = performance.now() - writeStartedAt;
				getCpuDiagnostics().recordPersistence(`${this.label}:write`, writeMs, bytes);
				this.lastWriteMetrics = {
					bytes,
					durationMs: writeMs,
					serializationMs: serializeMs,
					writeMs,
					filesWritten: 1,
				};
				this.onWrite?.(this.lastWriteMetrics);
				this.settlePublished(revision);
			} catch (error) {
				console.error(`[${this.label}] Failed to save:`, error);
				try { await this.fs.promises.unlink(`${this.file}.tmp`); } catch { /* best-effort cleanup */ }
				// A store-specific staging file is a complete, atomically published
				// roll-forward record. Preserve it when the final rename fails so the
				// owning store can finish publication after restart.
				this.settleFailed(revision, error);
				// Do not spin on an I/O failure. A later ordinary mutation may retry;
				// explicit callers receive the exact failure instead of false success.
				return;
			}
		}
	}
}
