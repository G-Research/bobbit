import fs from "node:fs";
import path from "node:path";

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
