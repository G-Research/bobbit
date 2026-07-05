import fs from "node:fs";
import path from "node:path";
import type { DecisionOutcome } from "./decision-types.js";

export interface TraceProviderRow {
	id: string;
	ms: number;
	blocks: number;
	omitted: number;
	error?: string;
}

export interface TraceEntry {
	ts: number;
	hook: string;
	sessionId: string;
	providers: TraceProviderRow[];
	/**
	 * CLF-W1a: classifier decision outcomes recorded during this dispatch (or,
	 * for decisions that fired after this entry was already written, appended
	 * post-hoc via `appendDecision` — see that method). OPTIONAL and additive:
	 * entries written before this field existed simply omit it, and readers
	 * must treat absence the same as an empty array. Pinned by
	 * `context-trace-store.test.ts`'s backward-compat-read case.
	 */
	decisions?: DecisionOutcome[];
}

const MAX_TRACE_BYTES = 2 * 1024 * 1024;

export class ContextTraceStore {
	private readonly traceDir: string;

	constructor(stateDir: string) {
		this.traceDir = path.join(stateDir, "session-context-trace");
	}

	appendTrace(sessionId: string, entry: TraceEntry): void {
		fs.mkdirSync(this.traceDir, { recursive: true });
		const file = this.traceFile(sessionId);
		fs.appendFileSync(file, JSON.stringify(entry) + "\n");
		this.enforceCap(file);
	}

	/**
	 * CLF-W1a: attach a classifier `DecisionOutcome` to the LATEST TraceEntry
	 * recorded for `sessionId` (i.e. "a per-turn entry is active" — the
	 * simplest defensible reading available today: `dispatchDecision` has no
	 * production call site yet, so there is no real per-turn boundary signal
	 * to key off; this treats "a trace entry already exists for this session"
	 * as the active-turn proxy). Returns `true` when it found an entry to
	 * amend, `false` when there is none (no file, empty file, or a corrupt
	 * last line) — the caller (`LifecycleHub.recordDecisionOutcome`) treats
	 * `false` as "out-of-turn" and falls back to its in-memory ring, per the
	 * TODO(CLF-W1a) comment this migrates.
	 *
	 * Multiple decisions recorded against the same still-latest entry
	 * accumulate in `decisions[]`, in call order. Once a new `appendTrace`
	 * call lands (the next turn's dispatch), subsequent decisions attach to
	 * THAT entry instead — decisions never retroactively attach to a stale
	 * entry once a newer one exists.
	 */
	appendDecision(sessionId: string, outcome: DecisionOutcome): boolean {
		const file = this.traceFile(sessionId);
		if (!fs.existsSync(file)) return false;
		const raw = fs.readFileSync(file, "utf-8");
		const lines = raw.split("\n").filter((line) => line.length > 0);
		if (lines.length === 0) return false;
		const lastIdx = lines.length - 1;
		let last: TraceEntry;
		try {
			last = JSON.parse(lines[lastIdx]) as TraceEntry;
		} catch {
			return false; // corrupt last line — don't silently attach to garbage
		}
		last.decisions = last.decisions ? [...last.decisions, outcome] : [outcome];
		lines[lastIdx] = JSON.stringify(last);

		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, lines.join("\n") + "\n");
		fs.renameSync(tmp, file);
		this.enforceCap(file);
		return true;
	}

	readTrace(sessionId: string, limit?: number): TraceEntry[] {
		const file = this.traceFile(sessionId);
		if (!fs.existsSync(file)) return [];
		const entries: TraceEntry[] = [];
		for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line) as TraceEntry);
			} catch {
				// Skip corrupt partial lines rather than failing trace reads.
			}
		}
		return typeof limit === "number" ? entries.slice(-Math.max(0, limit)) : entries;
	}

	private traceFile(sessionId: string): string {
		return path.join(this.traceDir, safeBasename(sessionId) + ".jsonl");
	}

	private enforceCap(file: string): void {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			return;
		}
		if (stat.size <= MAX_TRACE_BYTES) return;

		const lines = fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.length > 0);
		const kept: string[] = [];
		let bytes = 0;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i] + "\n";
			const lineBytes = Buffer.byteLength(line);
			if (bytes + lineBytes > MAX_TRACE_BYTES) break;
			kept.push(line);
			bytes += lineBytes;
		}
		kept.reverse();

		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, kept.join(""));
		fs.renameSync(tmp, file);
	}
}

function safeBasename(sessionId: string): string {
	const stripped = sessionId.replace(/\.\./g, "_").replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
	return stripped || "session";
}
