import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Durable SDK-owned compaction checkpoints. This deliberately does not share
 * Pi's JSONL sidecar: the Agent SDK owns its history and has no Pi entry ids.
 */
export interface ClaudeSdkCompactionCheckpoint {
	schemaVersion: 1;
	id: string;
	trigger: "auto" | "overflow";
	startedAt: string;
	endedAt?: string;
	status: "pending" | "complete";
	/** Normalized root rows captured from official SDK history before compaction. */
	preCompactionMessages: Record<string, unknown>[];
	preCompactionFingerprint: string;
}

let checkpointDir: string | undefined;

export function initClaudeSdkCompactionCheckpointDir(stateDir: string): void {
	checkpointDir = path.join(stateDir, "claude-sdk-compaction-checkpoints");
	try { fs.mkdirSync(checkpointDir, { recursive: true }); }
	catch (error) { console.warn("[claude-sdk-compaction] Failed to create checkpoint directory:", error); }
}

function fileFor(sessionId: string): string | undefined {
	if (!checkpointDir) return undefined;
	try { fs.mkdirSync(checkpointDir, { recursive: true }); } catch { return undefined; }
	return path.join(checkpointDir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function stableJson(value: unknown): string {
	const seen = new WeakSet<object>();
	const visit = (item: unknown): unknown => {
		if (!item || typeof item !== "object") return item;
		if (seen.has(item)) return "[circular]";
		seen.add(item);
		if (Array.isArray(item)) return item.map(visit);
		return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map(key => [key, visit((item as Record<string, unknown>)[key])]));
	};
	return JSON.stringify(visit(value));
}

function rootRows(messages: readonly unknown[]): Record<string, unknown>[] {
	return messages.filter((message): message is Record<string, unknown> =>
		!!message && typeof message === "object" && !Array.isArray(message)
			&& !(typeof (message as Record<string, unknown>).parentToolUseId === "string" && (message as Record<string, unknown>).parentToolUseId.length > 0),
	);
}

function readAll(sessionId: string): ClaudeSdkCompactionCheckpoint[] {
	const file = fileFor(sessionId);
	if (!file) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is ClaudeSdkCompactionCheckpoint =>
			!!entry && entry.schemaVersion === 1 && typeof entry.id === "string"
				&& (entry.trigger === "auto" || entry.trigger === "overflow")
				&& (entry.status === "pending" || entry.status === "complete")
				&& Array.isArray(entry.preCompactionMessages),
		);
	} catch { return []; }
}

function writeAll(sessionId: string, checkpoints: readonly ClaudeSdkCompactionCheckpoint[]): boolean {
	const file = fileFor(sessionId);
	if (!file) return false;
	try {
		const temporary = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(checkpoints), { mode: 0o600 });
		fs.renameSync(temporary, file);
		return true;
	} catch (error) {
		console.warn(`[claude-sdk-compaction] Failed to persist checkpoint for ${sessionId}:`, error);
		return false;
	}
}

export function readClaudeSdkCompactionCheckpoints(sessionId: string): ClaudeSdkCompactionCheckpoint[] {
	return readAll(sessionId);
}

/** Capture the official, normalized SDK root transcript before provider compaction. */
export function beginClaudeSdkCompactionCheckpoint(
	sessionId: string,
	input: { trigger?: string; messages: readonly unknown[]; startedAtMs?: number },
): ClaudeSdkCompactionCheckpoint | undefined {
	const checkpoints = readAll(sessionId);
	const existing = checkpoints.find(entry => entry.status === "pending");
	if (existing) return existing;
	const rows = rootRows(input.messages);
	const startedAtMs = input.startedAtMs ?? Date.now();
	const checkpoint: ClaudeSdkCompactionCheckpoint = {
		schemaVersion: 1,
		id: `sdkc_${startedAtMs}_${randomBytes(3).toString("hex")}`,
		trigger: input.trigger === "overflow" ? "overflow" : "auto",
		startedAt: new Date(startedAtMs).toISOString(),
		status: "pending",
		preCompactionMessages: rows,
		preCompactionFingerprint: stableJson(rows),
	};
	return writeAll(sessionId, [...checkpoints, checkpoint]) ? checkpoint : undefined;
}

/**
 * Resolve the pending boundary only when official history has actually changed.
 * A result frame alone is not evidence that provider compaction completed.
 */
export function completeClaudeSdkCompactionCheckpoint(
	sessionId: string,
	messages: readonly unknown[],
	endedAtMs = Date.now(),
): ClaudeSdkCompactionCheckpoint | undefined {
	const checkpoints = readAll(sessionId);
	const index = checkpoints.findIndex(entry => entry.status === "pending");
	if (index < 0) return undefined;
	const currentFingerprint = stableJson(rootRows(messages));
	if (currentFingerprint === checkpoints[index].preCompactionFingerprint) return undefined;
	const complete: ClaudeSdkCompactionCheckpoint = {
		...checkpoints[index], status: "complete", endedAt: new Date(endedAtMs).toISOString(),
	};
	const next = [...checkpoints];
	next[index] = complete;
	return writeAll(sessionId, next) ? complete : undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
		? (block as Record<string, string>).text : "").filter(Boolean).join("\n");
}

/** Bounded text supplied to the existing provider beforeCompact hook. */
export function claudeSdkCompactionSpan(checkpoint: ClaudeSdkCompactionCheckpoint): string | undefined {
	const span = checkpoint.preCompactionMessages
		.map(row => textFromContent(row.content))
		.filter(Boolean)
		.join("\n\n")
		.slice(0, 8_000);
	return span || undefined;
}

/** The pre-compaction REST envelope expected by the existing read-only widget. */
export function readClaudeSdkPreCompactionMessages(
	sessionId: string,
	compactionId: string,
	input: { cursor?: number; limit?: number; verbose?: boolean },
): { total: number; returned: number; nextCursor: number | null; messages: unknown[] } | undefined {
	const checkpoint = readAll(sessionId).find(entry => entry.id === compactionId);
	if (!checkpoint) return undefined;
	const cursor = Number.isInteger(input.cursor) && (input.cursor ?? 0) >= 0 ? input.cursor! : 0;
	const limit = Number.isInteger(input.limit) && (input.limit ?? 50) >= 1 && (input.limit ?? 50) <= 200 ? input.limit! : 50;
	const total = checkpoint.preCompactionMessages.length;
	const start = Math.min(cursor, total);
	const end = Math.min(start + limit, total);
	const messages = checkpoint.preCompactionMessages.slice(start, end).map((message, index) => {
		const row = message as Record<string, unknown>;
		return input.verbose
			? { index: start + index, role: row.role ?? "?", ts: null, content: row.content, message: row }
			: { index: start + index, role: row.role ?? "?", ts: null, content: textFromContent(row.content) };
	});
	return { total, returned: messages.length, nextCursor: end < total ? end : null, messages };
}

/** Build the persisted marker consumed by the existing compaction renderer. */
export function mergeClaudeSdkCompactionCheckpoints(sessionId: string, messages: any[]): any[] {
	const checkpoints = readAll(sessionId);
	if (checkpoints.length === 0 || !Array.isArray(messages)) return messages;
	const existing = new Set(messages.flatMap(message => Array.isArray(message?.content)
		? message.content.filter((block: any) => block?.type === "toolCall").map((block: any) => block.id) : []));
	const additions: any[] = [];
	for (const checkpoint of checkpoints) {
		const toolCallId = `compaction-summary:${checkpoint.id}`;
		if (existing.has(toolCallId)) continue;
		const timestamp = new Date(checkpoint.endedAt ?? checkpoint.startedAt).getTime();
		const payload = {
			schemaVersion: 1, trigger: checkpoint.trigger,
			state: checkpoint.status === "complete" ? "complete" : "in-progress",
			success: checkpoint.status === "complete",
			timestamp: checkpoint.endedAt ?? checkpoint.startedAt,
			startedAt: checkpoint.startedAt,
			durationMs: checkpoint.endedAt ? Math.max(0, timestamp - new Date(checkpoint.startedAt).getTime()) : null,
			tokensBefore: null, tokensAfter: null, reductionPct: null,
			compactionId: checkpoint.id,
		};
		additions.push(
			{ id: checkpoint.id, role: "assistant", timestamp, content: [{ type: "toolCall", id: toolCallId, name: "__compaction_summary", arguments: payload }] },
			{ role: "toolResult", toolCallId, toolName: "__compaction_summary", isError: false, content: [{ type: "text", text: checkpoint.status === "complete" ? "ok" : "Compaction in progress" }], details: payload, timestamp },
		);
	}
	return additions.length > 0 ? [...additions, ...messages] : messages;
}
