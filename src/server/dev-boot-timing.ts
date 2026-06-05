// src/server/dev-boot-timing.ts
//
// Sink for client-side boot/reload performance samples. When the dev "perf
// instrumentation" toggle is enabled (Settings → next to Restart Server,
// harness-mode only), the client POSTs one timing sample per full reload to
// `POST /api/dev/boot-timing`, and the route appends it here as a JSON line at
// `<stateDir>/boot-timing.jsonl` — a known, easily-inspectable location in the
// server cwd that agents can `cat`/`tail` to read real reload numbers.
//
// The file is a capped append-only JSONL log: once it grows past
// `MAX_FILE_BYTES` we keep only the most recent `KEEP_LINES` entries so it can
// never grow without bound during a long instrumented session.

import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "./bobbit-dir.js";

/** File name under the state dir. */
export const BOOT_TIMING_FILE = "boot-timing.jsonl";

/** Trim the log once it exceeds this many bytes. */
const MAX_FILE_BYTES = 1_000_000; // 1 MB
/** Number of most-recent lines retained when trimming. */
const KEEP_LINES = 300;
/** Reject samples whose serialized form exceeds this (defends the disk). */
const MAX_SAMPLE_BYTES = 64 * 1024; // 64 KB

export interface BootTimingMark { name: string; t: number; }

/** One client-reported reload sample. Shape is advisory — extra keys are kept. */
export interface BootTimingSample {
	reason?: string;
	isReload?: boolean;
	total_ms?: number;
	route?: string;
	sessionId?: string;
	transcriptMessages?: number;
	buildId?: string;
	userAgent?: string;
	viewport?: { w: number; h: number };
	clientTs?: number;
	marks?: BootTimingMark[];
	rows?: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

/** Stored line = the client sample plus a server receive timestamp. */
export interface StoredBootTimingSample extends BootTimingSample {
	receivedAt: string;
}

function filePath(stateDir: string): string {
	return path.join(stateDir, BOOT_TIMING_FILE);
}

/**
 * Append one boot-timing sample as a JSON line. Returns the absolute path
 * written (so the route can echo it back for discoverability) or null if the
 * sample was rejected (too large / not an object).
 *
 * Best-effort: filesystem errors are swallowed — diagnostics must never break
 * a reload. Throws only on a programmer error (missing stateDir).
 */
export function recordBootTiming(sample: unknown, stateDir: string = bobbitStateDir()): string | null {
	if (!stateDir) throw new Error("recordBootTiming: stateDir is required");
	if (!sample || typeof sample !== "object" || Array.isArray(sample)) return null;

	const stored: StoredBootTimingSample = { ...(sample as BootTimingSample), receivedAt: new Date().toISOString() };
	let line: string;
	try {
		line = JSON.stringify(stored);
	} catch {
		return null;
	}
	if (line.length > MAX_SAMPLE_BYTES) return null;

	const target = filePath(stateDir);
	try {
		fs.mkdirSync(stateDir, { recursive: true });
		fs.appendFileSync(target, line + "\n", "utf-8");
		trimIfNeeded(target);
		return target;
	} catch {
		return null;
	}
}

/** Keep only the last KEEP_LINES entries once the file passes MAX_FILE_BYTES. */
function trimIfNeeded(target: string): void {
	let size: number;
	try {
		size = fs.statSync(target).size;
	} catch {
		return;
	}
	if (size <= MAX_FILE_BYTES) return;
	try {
		const lines = fs.readFileSync(target, "utf-8").split("\n").filter((l) => l.trim().length > 0);
		const kept = lines.slice(-KEEP_LINES);
		fs.writeFileSync(target, kept.join("\n") + "\n", "utf-8");
	} catch {
		/* best-effort */
	}
}

/**
 * Read the most-recent `limit` samples (newest last), parsed from JSONL.
 * Malformed lines are skipped. Returns [] when the file does not exist.
 */
export function readBootTimings(limit = 50, stateDir: string = bobbitStateDir()): StoredBootTimingSample[] {
	const target = filePath(stateDir);
	let raw: string;
	try {
		raw = fs.readFileSync(target, "utf-8");
	} catch {
		return [];
	}
	const out: StoredBootTimingSample[] = [];
	for (const l of raw.split("\n")) {
		const trimmed = l.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as StoredBootTimingSample);
		} catch {
			/* skip malformed */
		}
	}
	return limit > 0 ? out.slice(-limit) : out;
}
