import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";
import {
	PREFIX_COMPONENTS,
	type PrefixAttribution,
	type PrefixBoundary,
	type PrefixComponent,
	type PrefixComponentFingerprint,
	type ProviderCacheTelemetry,
} from "./prompt-prefix-attribution.js";

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
	private readonly fs: FsLike;

	constructor(stateDir: string, fsImpl: FsLike = realFs) {
		this.fs = fsImpl;
		this.traceDir = path.join(stateDir, "session-context-trace");
	}

	appendTrace(sessionId: string, entry: TraceEntry): void {
		this.fs.mkdirSync(this.traceDir, { recursive: true });
		const file = this.traceFile(sessionId);
		this.fs.appendFileSync(file, JSON.stringify(entry) + "\n");
		this.enforceCap(file);
	}

	readTrace(sessionId: string, limit?: number): TraceEntry[] {
		const file = this.traceFile(sessionId);
		if (!this.fs.existsSync(file)) return [];
		const entries: TraceEntry[] = [];
		for (const line of this.readLines(file)) {
			try {
				entries.push(JSON.parse(line) as TraceEntry);
			} catch {
				// Skip corrupt partial lines rather than failing trace reads.
			}
		}
		return limitEntries(entries, limit);
	}

	/**
	 * Attribution has a sibling JSONL so existing trace consumers and their raw
	 * diagnostics remain compatible. This method is the only filesystem path
	 * for prefix data and serializes a strict hashes-only allow-list.
	 */
	appendPrefixAttribution(sessionId: string, entry: PrefixAttribution): void {
		const safe = sanitizePrefixAttribution(sessionId, entry);
		if (!safe) throw new Error("Invalid prompt-prefix attribution entry");
		this.fs.mkdirSync(this.traceDir, { recursive: true });
		const file = this.prefixFile(sessionId);
		this.fs.appendFileSync(file, JSON.stringify(safe) + "\n");
		this.enforceCap(file);
	}

	/** Alias matching the prompt-prefix design terminology. */
	appendPrefixSnapshot(sessionId: string, entry: PrefixAttribution): void {
		this.appendPrefixAttribution(sessionId, entry);
	}

	readPrefixAttribution(sessionId: string, limit?: number): PrefixAttribution[] {
		const file = this.prefixFile(sessionId);
		if (!this.fs.existsSync(file)) return [];
		const entries: PrefixAttribution[] = [];
		for (const line of this.readLines(file)) {
			try {
				const entry = sanitizePrefixAttribution(sessionId, JSON.parse(line));
				if (entry) entries.push(entry);
			} catch {
				// Prefix diagnostics are best-effort: ignore corrupt or legacy rows.
			}
		}
		return limitEntries(entries, limit);
	}

	private readLines(file: string): string[] {
		return this.fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.trim().length > 0);
	}

	private traceFile(sessionId: string): string {
		return path.join(this.traceDir, safeBasename(sessionId) + ".jsonl");
	}

	private prefixFile(sessionId: string): string {
		return path.join(this.traceDir, safeBasename(sessionId) + ".prefix.jsonl");
	}

	private enforceCap(file: string): void {
		let stat: ReturnType<FsLike["statSync"]>;
		try {
			stat = this.fs.statSync(file);
		} catch {
			return;
		}
		if (stat.size <= MAX_TRACE_BYTES) return;

		const lines = this.fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.length > 0);
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
		this.fs.writeFileSync(tmp, kept.join(""));
		this.fs.renameSync(tmp, file);
	}
}

function safeBasename(sessionId: string): string {
	const stripped = sessionId.replace(/\.\./g, "_").replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
	return stripped || "session";
}

function limitEntries<T>(entries: T[], limit: number | undefined): T[] {
	return typeof limit === "number" ? entries.slice(-Math.max(0, limit)) : entries;
}

const SHA256 = /^[a-f0-9]{64}$/;
const BOUNDARIES: ReadonlySet<PrefixBoundary> = new Set(["dispatch", "before-prompt"]);
const TELEMETRY: ReadonlySet<ProviderCacheTelemetry> = new Set(["hit", "miss", "unknown"]);
const COMPARISONS = new Set(["first", "stable", "changed", "boundary"] as const);
const CULPRITS = new Set<PrefixComponent | "multiple" | "unattributable">([...PREFIX_COMPONENTS, "multiple", "unattributable"]);

/**
 * Copy only the documented hash metadata. In particular this rejects or drops
 * arbitrary properties supplied by a caller, so prompt/schema/block strings
 * cannot accidentally become durable when this API evolves.
 */
function sanitizePrefixAttribution(sessionId: string, value: unknown): PrefixAttribution | undefined {
	if (!isRecord(value)
		|| value.schemaVersion !== 1
		|| !validTimestamp(value.ts)
		|| !validNonNegativeInteger(value.sequence)
		|| !BOUNDARIES.has(value.boundary as PrefixBoundary)
		|| !validNonNegativeInteger(value.compactionEpoch)
		|| typeof value.aggregateSha256 !== "string" || !SHA256.test(value.aggregateSha256)
		|| !TELEMETRY.has(value.providerCacheTelemetry as ProviderCacheTelemetry)
		|| !COMPARISONS.has(value.comparison as "first" | "stable" | "changed" | "boundary")) return undefined;

	const components = sanitizeComponents(value.components);
	if (!components) return undefined;
	const model = sanitizeModel(value.model);
	if (value.model !== undefined && !model) return undefined;
	const changed = sanitizeChanged(value.changed);
	if (value.changed !== undefined && !changed) return undefined;
	const culprit = value.culprit;
	if (culprit !== undefined && (typeof culprit !== "string" || !CULPRITS.has(culprit as PrefixComponent | "multiple" | "unattributable"))) return undefined;
	if (value.comparableTo !== undefined && !validNonNegativeInteger(value.comparableTo)) return undefined;

	return {
		schemaVersion: 1,
		ts: value.ts,
		sessionId,
		sequence: value.sequence,
		boundary: value.boundary as PrefixBoundary,
		...(model ? { model } : {}),
		compactionEpoch: value.compactionEpoch,
		components,
		aggregateSha256: value.aggregateSha256,
		providerCacheTelemetry: value.providerCacheTelemetry as ProviderCacheTelemetry,
		comparison: value.comparison as PrefixAttribution["comparison"],
		...(culprit ? { culprit: culprit as PrefixAttribution["culprit"] } : {}),
		...(changed ? { changed } : {}),
		...(value.comparableTo !== undefined ? { comparableTo: value.comparableTo } : {}),
	};
}

function sanitizeComponents(value: unknown): PrefixComponentFingerprint[] | undefined {
	if (!Array.isArray(value) || value.length !== PREFIX_COMPONENTS.length) return undefined;
	const byKind = new Map<PrefixComponent, PrefixComponentFingerprint>();
	for (const component of value) {
		if (!isRecord(component) || !PREFIX_COMPONENTS.includes(component.kind as PrefixComponent)
			|| typeof component.sha256 !== "string" || !SHA256.test(component.sha256)
			|| !validNonNegativeInteger(component.bytes)) return undefined;
		const kind = component.kind as PrefixComponent;
		if (byKind.has(kind)) return undefined;
		byKind.set(kind, { kind, sha256: component.sha256, bytes: component.bytes });
	}
	const components = PREFIX_COMPONENTS.map((kind) => byKind.get(kind));
	return components.every(Boolean) ? components as PrefixComponentFingerprint[] : undefined;
}

function sanitizeModel(value: unknown): { provider: string; id: string } | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || !value.provider || typeof value.id !== "string" || !value.id) return undefined;
	return { provider: value.provider, id: value.id };
}

function sanitizeChanged(value: unknown): PrefixComponent[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const changed: PrefixComponent[] = [];
	for (const item of value) {
		if (!PREFIX_COMPONENTS.includes(item as PrefixComponent) || changed.includes(item as PrefixComponent)) return undefined;
		changed.push(item as PrefixComponent);
	}
	return changed;
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function validNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
