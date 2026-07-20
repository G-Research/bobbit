import { promises as fs } from "node:fs";
import type { Clock } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import path from "node:path";
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

const DEFAULT_FLUSH_MS = 1000;

interface CpuDiagnosticsConfig {
	enabled: boolean;
	flushMs: number;
	jsonlPath?: string;
}

function cpuDiagnosticsConfig(env: NodeJS.ProcessEnv): CpuDiagnosticsConfig {
	const parsedFlushMs = Number(env.BOBBIT_CPU_DIAG_FLUSH_MS);
	return {
		enabled: env.BOBBIT_CPU_DIAG === "1",
		flushMs: Number.isFinite(parsedFlushMs) && parsedFlushMs > 0 ? parsedFlushMs : DEFAULT_FLUSH_MS,
		jsonlPath: env.BOBBIT_CPU_DIAG_JSONL,
	};
}

const RUNTIME_CONFIG = cpuDiagnosticsConfig(process.env);
const ENABLED = RUNTIME_CONFIG.enabled;
const FLUSH_MS = RUNTIME_CONFIG.flushMs;
const MAX_LABELS = 256;
const MAX_SAMPLES_PER_LABEL = 2048;
const OVERFLOW_LABEL = "__overflow__";

export interface WsBroadcastCounters {
	frames?: number;
	recipients?: number;
	scanned?: number;
	skipped?: number;
	bytes?: number;
	stringifyMs?: number;
	sendMs?: number;
	[key: string]: number | undefined;
}

export interface CpuDiagnostics {
	recordRest(label: string, status: number, durationMs: number, responseBytes?: number): void;
	recordWsBroadcast(label: string, type: string, counters: WsBroadcastCounters): void;
	recordTimer(label: string, durationMs: number, counters?: Record<string, number>): void;
	recordChildProcess(label: string, durationMs: number, metadata?: Record<string, string | number>): void;
	/** Snapshot immediately and resolve once this and all earlier snapshots have been written. */
	flush(reason?: string): Promise<void>;
	/** Stop future snapshots and resolve once the final snapshot and queued writes have settled. */
	shutdown(): Promise<void>;
}

export interface CpuDiagnosticsIo {
	mkdir(dirPath: string): Promise<void>;
	appendFile(filePath: string, data: string): Promise<void>;
	writeStderr(data: string): Promise<void>;
}

interface TimedBucket {
	count: number;
	totalMs: number;
	maxMs: number;
	samples: number[];
}

interface RestBucket extends TimedBucket {
	status: Record<string, number>;
	responseBytes: number;
}

interface CounterBucket {
	count: number;
	counters: Record<string, number>;
}

interface ChildBucket extends TimedBucket {
	metadata: Record<string, Record<string, number>>;
}

export interface CpuDiagnosticsSnapshot {
	kind: "cpu";
	ts: number;
	pid: number;
	wallMs: number;
	cpuUserMs: number;
	cpuSystemMs: number;
	cpuPct: number;
	elu: number;
	delayP50Ms: number;
	delayP95Ms: number;
	delayMaxMs: number;
	rssMb: number;
	heapUsedMb: number;
	heapTotalMb: number;
	externalMb: number;
	handles: Record<string, number>;
	reason?: string;
	rest: Record<string, unknown>;
	ws: Record<string, unknown>;
	timers: Record<string, unknown>;
	child: Record<string, unknown>;
}

const disabledDiagnostics: CpuDiagnostics = {
	recordRest() { /* no-op */ },
	recordWsBroadcast() { /* no-op */ },
	recordTimer() { /* no-op */ },
	recordChildProcess() { /* no-op */ },
	flush() { return Promise.resolve(); },
	shutdown() { return Promise.resolve(); },
};

const realCpuDiagnosticsIo: CpuDiagnosticsIo = {
	async mkdir(dirPath) {
		await fs.mkdir(dirPath, { recursive: true });
	},
	async appendFile(filePath, data) {
		await fs.appendFile(filePath, data);
	},
	writeStderr(data) {
		return new Promise<void>((resolve, reject) => {
			process.stderr.write(data, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	},
};

function safeNumber(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function round(value: number, digits = 3): number {
	const factor = 10 ** digits;
	return Math.round(safeNumber(value) * factor) / factor;
}

function mb(bytes: number): number {
	return round(bytes / 1024 / 1024, 3);
}

function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
	return sorted[idx];
}

function pushSample(bucket: TimedBucket, durationMs: number): void {
	const duration = safeNumber(durationMs);
	bucket.count++;
	bucket.totalMs += duration;
	if (duration > bucket.maxMs) bucket.maxMs = duration;
	if (bucket.samples.length < MAX_SAMPLES_PER_LABEL) bucket.samples.push(duration);
}

function summarizeTimed(bucket: TimedBucket): Record<string, number> {
	const sorted = [...bucket.samples].sort((a, b) => a - b);
	return {
		count: bucket.count,
		totalMs: round(bucket.totalMs),
		p50Ms: round(percentile(sorted, 0.5)),
		p95Ms: round(percentile(sorted, 0.95)),
		maxMs: round(bucket.maxMs),
	};
}

function bucketFor<T>(map: Map<string, T>, label: string, create: () => T): T {
	const key = map.has(label) || map.size < MAX_LABELS ? label : OVERFLOW_LABEL;
	let bucket = map.get(key);
	if (!bucket) {
		bucket = create();
		map.set(key, bucket);
	}
	return bucket;
}

function newTimedBucket(): TimedBucket {
	return { count: 0, totalMs: 0, maxMs: 0, samples: [] };
}

function activeHandleCounts(): Record<string, number> {
	const getter = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
	if (typeof getter !== "function") return {};
	const counts: Record<string, number> = {};
	try {
		for (const handle of getter.call(process)) {
			const name = handle && typeof handle === "object" && (handle as { constructor?: { name?: string } }).constructor?.name
				? (handle as { constructor: { name: string } }).constructor.name
				: "unknown";
			counts[name] = (counts[name] ?? 0) + 1;
		}
	} catch {
		return {};
	}
	return counts;
}

class EnabledCpuDiagnostics implements CpuDiagnostics {
	private rest = new Map<string, RestBucket>();
	private ws = new Map<string, CounterBucket>();
	private timers = new Map<string, TimedBucket & { counters: Record<string, number> }>();
	private child = new Map<string, ChildBucket>();
	private lastCpu = process.cpuUsage();
	private lastWall = performance.now();
	private lastElu: EventLoopUtilization = performance.eventLoopUtilization();
	private delay: ReturnType<typeof monitorEventLoopDelay>;
	private timer: ReturnType<Clock["setInterval"]> | null = null;
	private shutdownPromise: Promise<void> | null = null;
	private writeQueue: Promise<void> = Promise.resolve();
	private outputReady = false;
	private readonly outFile?: string;
	private readonly beforeExitHandler: () => void;
	private readonly exitHandler: () => void;

	constructor(
		private readonly clock: Clock = realClock,
		config: CpuDiagnosticsConfig = RUNTIME_CONFIG,
		private readonly io: CpuDiagnosticsIo = realCpuDiagnosticsIo,
	) {
		this.outFile = config.jsonlPath;
		if (this.outFile) this.enqueueOutputDirectory();
		this.delay = monitorEventLoopDelay({ resolution: 20 });
		this.delay.enable();
		this.timer = this.clock.setInterval(() => {
			// flush owns and logs write failures, so this scheduled promise cannot reject.
			void this.flush("tick");
		}, config.flushMs);
		if (typeof this.timer.unref === "function") this.timer.unref();
		this.beforeExitHandler = () => {
			// Stopping removes this handler synchronously; the queued I/O keeps a natural
			// process exit alive without causing a repeating beforeExit cycle.
			void this.stop("beforeExit");
		};
		this.exitHandler = () => {
			// Async work cannot delay an explicit process.exit(), but retaining this
			// best-effort snapshot preserves the existing exit diagnostic.
			void this.stop("exit");
		};
		process.on("beforeExit", this.beforeExitHandler);
		process.on("exit", this.exitHandler);
	}

	recordRest(label: string, status: number, durationMs: number, responseBytes?: number): void {
		const bucket = bucketFor(this.rest, label, (): RestBucket => ({ ...newTimedBucket(), status: {}, responseBytes: 0 }));
		pushSample(bucket, durationMs);
		const family = `${Math.floor(status / 100)}xx`;
		bucket.status[family] = (bucket.status[family] ?? 0) + 1;
		bucket.status[String(status)] = (bucket.status[String(status)] ?? 0) + 1;
		if (typeof responseBytes === "number" && Number.isFinite(responseBytes) && responseBytes > 0) {
			bucket.responseBytes += responseBytes;
		}
	}

	recordWsBroadcast(label: string, type: string, counters: WsBroadcastCounters): void {
		const key = `${label}:${type || "unknown"}`;
		const bucket = bucketFor(this.ws, key, (): CounterBucket => ({ count: 0, counters: {} }));
		bucket.count++;
		for (const [name, value] of Object.entries(counters)) {
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			bucket.counters[name] = (bucket.counters[name] ?? 0) + value;
		}
	}

	recordTimer(label: string, durationMs: number, counters?: Record<string, number>): void {
		const bucket = bucketFor(this.timers, label, (): TimedBucket & { counters: Record<string, number> } => ({ ...newTimedBucket(), counters: {} }));
		pushSample(bucket, durationMs);
		if (counters) {
			for (const [name, value] of Object.entries(counters)) {
				if (!Number.isFinite(value)) continue;
				bucket.counters[name] = (bucket.counters[name] ?? 0) + value;
			}
		}
	}

	recordChildProcess(label: string, durationMs: number, metadata?: Record<string, string | number>): void {
		const bucket = bucketFor(this.child, label, (): ChildBucket => ({ ...newTimedBucket(), metadata: {} }));
		pushSample(bucket, durationMs);
		if (metadata) {
			for (const [name, value] of Object.entries(metadata)) {
				const valueKey = String(value);
				const values = bucket.metadata[name] ?? {};
				values[valueKey] = (values[valueKey] ?? 0) + 1;
				bucket.metadata[name] = values;
			}
		}
	}

	flush(reason = "manual"): Promise<void> {
		try {
			const snapshot = this.buildSnapshot(reason);
			this.resetBuckets();
			return this.enqueueSnapshot(snapshot);
		} catch (error) {
			this.logWriteFailure(error);
			return this.writeQueue;
		}
	}

	shutdown(): Promise<void> {
		return this.stop("shutdown");
	}

	private stop(reason: string): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		if (this.timer) {
			this.clock.clearInterval(this.timer);
			this.timer = null;
		}
		try { this.delay.disable(); } catch { /* best-effort */ }
		process.off("beforeExit", this.beforeExitHandler);
		process.off("exit", this.exitHandler);
		if (singleton === this) singleton = null;
		this.shutdownPromise = this.flush(reason);
		return this.shutdownPromise;
	}

	private buildSnapshot(reason?: string): CpuDiagnosticsSnapshot {
		const now = performance.now();
		const wallMs = Math.max(1, now - this.lastWall);
		const cpu = process.cpuUsage(this.lastCpu);
		this.lastCpu = process.cpuUsage();
		this.lastWall = now;
		const cpuUserMs = cpu.user / 1000;
		const cpuSystemMs = cpu.system / 1000;
		const currentElu = performance.eventLoopUtilization();
		const eluDelta = performance.eventLoopUtilization(currentElu, this.lastElu);
		this.lastElu = currentElu;
		const memory = process.memoryUsage();
		const snapshot: CpuDiagnosticsSnapshot = {
			kind: "cpu",
			ts: this.clock.now(),
			pid: process.pid,
			wallMs: round(wallMs),
			cpuUserMs: round(cpuUserMs),
			cpuSystemMs: round(cpuSystemMs),
			cpuPct: round(((cpuUserMs + cpuSystemMs) / wallMs) * 100, 2),
			elu: round(eluDelta.utilization, 4),
			delayP50Ms: round(this.delay.percentile(50) / 1e6),
			delayP95Ms: round(this.delay.percentile(95) / 1e6),
			delayMaxMs: round(this.delay.max / 1e6),
			rssMb: mb(memory.rss),
			heapUsedMb: mb(memory.heapUsed),
			heapTotalMb: mb(memory.heapTotal),
			externalMb: mb(memory.external),
			handles: activeHandleCounts(),
			rest: this.snapshotRest(),
			ws: this.snapshotWs(),
			timers: this.snapshotTimers(),
			child: this.snapshotChild(),
		};
		if (reason) snapshot.reason = reason;
		try { this.delay.reset(); } catch { /* best-effort */ }
		return snapshot;
	}

	private snapshotRest(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [label, bucket] of this.rest) {
			out[label] = {
				...summarizeTimed(bucket),
				status: { ...bucket.status },
				...(bucket.responseBytes > 0 ? { responseBytes: bucket.responseBytes } : {}),
			};
		}
		return out;
	}

	private snapshotWs(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [label, bucket] of this.ws) {
			out[label] = { count: bucket.count, ...bucket.counters };
		}
		return out;
	}

	private snapshotTimers(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [label, bucket] of this.timers) {
			out[label] = { ...summarizeTimed(bucket), ...bucket.counters };
		}
		return out;
	}

	private snapshotChild(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [label, bucket] of this.child) {
			out[label] = { ...summarizeTimed(bucket), metadata: { ...bucket.metadata } };
		}
		return out;
	}

	private resetBuckets(): void {
		this.rest.clear();
		this.ws.clear();
		this.timers.clear();
		this.child.clear();
	}

	private enqueueOutputDirectory(): void {
		const outFile = this.outFile;
		if (!outFile) return;
		const pending = this.writeQueue.then(async () => {
			await this.io.mkdir(path.dirname(outFile));
			this.outputReady = true;
		});
		this.writeQueue = this.ownWriteFailure(pending);
	}

	private enqueueSnapshot(snapshot: CpuDiagnosticsSnapshot): Promise<void> {
		const line = `${JSON.stringify(snapshot)}\n`;
		const pending = this.writeQueue.then(async () => {
			if (this.outFile) {
				if (!this.outputReady) {
					await this.io.mkdir(path.dirname(this.outFile));
					this.outputReady = true;
				}
				await this.io.appendFile(this.outFile, line);
				return;
			}
			await this.io.writeStderr(line);
		});
		this.writeQueue = this.ownWriteFailure(pending);
		return this.writeQueue;
	}

	private ownWriteFailure(pending: Promise<void>): Promise<void> {
		// Diagnostics are best-effort. Own each queued rejection here so timer,
		// beforeExit, and existing synchronous-style callers cannot leak one.
		return pending.then(
			() => undefined,
			(error) => { this.logWriteFailure(error); },
		);
	}

	private logWriteFailure(error: unknown): void {
		try {
			console.error("[cpu-diagnostics] Failed to write snapshot:", error);
		} catch {
			// Diagnostics must never destabilize the gateway, including a broken logger.
		}
	}
}

let singleton: CpuDiagnostics | null = null;

export function cpuDiagnosticsEnabled(env?: NodeJS.ProcessEnv): boolean {
	return env ? cpuDiagnosticsConfig(env).enabled : ENABLED;
}

/** Create an isolated diagnostics instance without mutating the process-wide singleton. */
export function createCpuDiagnostics(options: { env: NodeJS.ProcessEnv; clock?: Clock; io?: CpuDiagnosticsIo }): CpuDiagnostics {
	const config = cpuDiagnosticsConfig(options.env);
	return config.enabled ? new EnabledCpuDiagnostics(options.clock, config, options.io) : disabledDiagnostics;
}

export function getCpuDiagnostics(clock?: Clock): CpuDiagnostics {
	if (!ENABLED) return disabledDiagnostics;
	if (!singleton) singleton = new EnabledCpuDiagnostics(clock);
	return singleton;
}

export const CPU_DIAGNOSTICS_ENABLED = ENABLED;
export const CPU_DIAGNOSTICS_FLUSH_MS = FLUSH_MS;
