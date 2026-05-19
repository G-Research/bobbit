import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

const ENABLED = process.env.BOBBIT_CPU_DIAG === "1";
const DEFAULT_FLUSH_MS = 1000;
const parsedFlushMs = Number(process.env.BOBBIT_CPU_DIAG_FLUSH_MS);
const FLUSH_MS = Number.isFinite(parsedFlushMs) && parsedFlushMs > 0 ? parsedFlushMs : DEFAULT_FLUSH_MS;
const JSONL_PATH = process.env.BOBBIT_CPU_DIAG_JSONL;
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
	flush(reason?: string): void;
	shutdown(): void;
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
	flush() { /* no-op */ },
	shutdown() { /* no-op */ },
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
	private timer: ReturnType<typeof setInterval> | null = null;
	private shutdownCalled = false;
	private readonly outFile?: string;
	private readonly beforeExitHandler: () => void;
	private readonly exitHandler: () => void;

	constructor() {
		this.outFile = JSONL_PATH;
		if (this.outFile) fs.mkdirSync(path.dirname(this.outFile), { recursive: true });
		this.delay = monitorEventLoopDelay({ resolution: 20 });
		this.delay.enable();
		this.timer = setInterval(() => this.flush("tick"), FLUSH_MS);
		if (typeof this.timer.unref === "function") this.timer.unref();
		this.beforeExitHandler = () => { try { this.flush("beforeExit"); } catch { /* best-effort */ } };
		this.exitHandler = () => { try { this.flush("exit"); } catch { /* best-effort */ } };
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

	flush(reason = "manual"): void {
		const snapshot = this.buildSnapshot(reason);
		this.resetBuckets();
		this.writeSnapshot(snapshot);
	}

	shutdown(): void {
		if (this.shutdownCalled) return;
		this.shutdownCalled = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		try { this.flush("shutdown"); } catch { /* best-effort */ }
		try { this.delay.disable(); } catch { /* best-effort */ }
		process.off("beforeExit", this.beforeExitHandler);
		process.off("exit", this.exitHandler);
		singleton = null;
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
			ts: Date.now(),
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

	private writeSnapshot(snapshot: CpuDiagnosticsSnapshot): void {
		const line = JSON.stringify(snapshot);
		if (this.outFile) {
			fs.appendFileSync(this.outFile, `${line}\n`);
			return;
		}
		process.stderr.write(`${line}\n`);
	}
}

let singleton: CpuDiagnostics | null = null;

export function cpuDiagnosticsEnabled(): boolean {
	return ENABLED;
}

export function getCpuDiagnostics(): CpuDiagnostics {
	if (!ENABLED) return disabledDiagnostics;
	if (!singleton) singleton = new EnabledCpuDiagnostics();
	return singleton;
}

export const CPU_DIAGNOSTICS_ENABLED = ENABLED;
export const CPU_DIAGNOSTICS_FLUSH_MS = FLUSH_MS;
