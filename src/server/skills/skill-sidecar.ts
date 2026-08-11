/**
 * Sidecar persistence for skill expansions.
 *
 * The pi-coding-agent CLI owns the canonical `.jsonl` transcript and
 * we don't modify its schema. Instead, when a user message contains
 * resolved slash-skill expansions, we append a single JSON line to a
 * per-session sidecar so the UI can recover the original text + chip
 * positions when replaying messages.
 *
 * Lookup key on restore:
 *   - exact `modelText` match (the persisted user message body), AND
 *   - timestamp within ±2 s of the agent message's recorded timestamp.
 *
 * Backward compatibility: a missing or unreadable sidecar is treated as
 * "no expansions" — the UI renders the user message as plain text.
 *
 * Storage: `<stateDir>/skill-sidecar/<sessionId>.jsonl` — host-side and
 * thus also valid for sandboxed sessions whose `.jsonl` lives inside
 * the container.
 */

import fs from "node:fs";
import path from "node:path";
import type { SkillExpansion } from "./resolve-skill-expansions.js";
import type { FileMention } from "./resolve-file-mentions.js";

export interface SkillSidecarEntry {
	/** Unix epoch (ms) at the moment the user message was persisted. */
	ts: number;
	/** What the agent saw. Used as a lookup key against the persisted message body. */
	modelText: string;
	/** What the user actually typed. */
	originalText: string;
	/** Slash-skill chips, snapshotted at invocation time. */
	skillExpansions: SkillExpansion[];
	/**
	 * `@path` file-mention chips, snapshotted at send time. Optional so old
	 * entries (written before this field existed) still parse, and entries
	 * carrying only file mentions (no skill expansions) round-trip correctly.
	 */
	fileMentions?: FileMention[];
}

let _sidecarDir: string | undefined;

/** Initialize the sidecar dir from the gateway state directory. Called by server bootstrap. */
export function initSkillSidecarDir(stateDir: string): void {
	_sidecarDir = path.join(stateDir, "skill-sidecar");
	try {
		if (!fs.existsSync(_sidecarDir)) fs.mkdirSync(_sidecarDir, { recursive: true });
	} catch (err) {
		console.warn(`[skill-sidecar] Failed to create sidecar dir at ${_sidecarDir}:`, err);
	}
}

function getSidecarDir(): string | undefined {
	if (!_sidecarDir) return undefined;
	// Defensive recreate (mirrors system-prompt.ts pattern).
	try {
		if (!fs.existsSync(_sidecarDir)) fs.mkdirSync(_sidecarDir, { recursive: true });
	} catch { /* ignore */ }
	return _sidecarDir;
}

function sidecarPath(sessionId: string): string | undefined {
	const dir = getSidecarDir();
	if (!dir) return undefined;
	// Sanitise sessionId — defensive; sessionIds are UUIDs in practice.
	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
	return path.join(dir, `${safe}.jsonl`);
}

/** Append one entry. Best-effort; failure logs and returns false. */
export function appendSkillSidecarEntry(sessionId: string, entry: SkillSidecarEntry): boolean {
	const file = sidecarPath(sessionId);
	if (!file) return false;
	try {
		fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
		return true;
	} catch (err) {
		console.warn(`[skill-sidecar] Append failed for session ${sessionId}:`, err);
		return false;
	}
}

/** Read all entries for a session. Empty array on any failure (backward compat). */
export function readSkillSidecarEntries(sessionId: string): SkillSidecarEntry[] {
	const file = sidecarPath(sessionId);
	if (!file) return [];
	try {
		if (!fs.existsSync(file)) return [];
		const raw = fs.readFileSync(file, "utf-8");
		const out: SkillSidecarEntry[] = [];
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as SkillSidecarEntry;
				// Accept entries with skillExpansions OR fileMentions (either may be
				// absent now that file mentions can be persisted without skills).
				if (
					parsed &&
					typeof parsed.modelText === "string" &&
					(Array.isArray(parsed.skillExpansions) || Array.isArray(parsed.fileMentions))
				) {
					out.push(parsed);
				}
			} catch { /* skip malformed line */ }
		}
		return out;
	} catch (err) {
		console.warn(`[skill-sidecar] Read failed for session ${sessionId}:`, err);
		return [];
	}
}

/** Minimal structural contract accepted from the transcript materializer. */
export interface RetainedUserTranscriptEntry {
	entry: Record<string, unknown>;
}

const SIDECAR_CORRELATION_TOLERANCE_MS = 2_000;

function epochMilliseconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function retainedPromptCandidate(
	record: RetainedUserTranscriptEntry,
): { modelText: string; timestamp?: number } | undefined {
	const envelope = record?.entry;
	if (!envelope || envelope.type !== "message") return undefined;
	const message = envelope.message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const prompt = message as Record<string, unknown>;
	if (prompt.role !== "user" && prompt.role !== "user-with-attachments") return undefined;

	let modelText: string | undefined;
	if (typeof prompt.content === "string") {
		modelText = prompt.content;
	} else if (Array.isArray(prompt.content)) {
		const parts: string[] = [];
		let hasToolResult = false;
		for (const block of prompt.content) {
			if (!block || typeof block !== "object" || Array.isArray(block)) continue;
			const value = block as Record<string, unknown>;
			if (value.type === "tool_result" || value.type === "toolResult") hasToolResult = true;
			if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
		}
		if (hasToolResult) return undefined;
		modelText = parts.join("");
	}
	if (modelText === undefined) return undefined;
	return {
		modelText,
		timestamp:
			epochMilliseconds(envelope.timestamp)
			?? epochMilliseconds(envelope.ts)
			?? epochMilliseconds(prompt.timestamp)
			?? epochMilliseconds(prompt.ts),
	};
}

/**
 * Copy only skill/file-mention records proven to belong to retained transcript
 * prompts. Matching is occurrence-aware: timestamp-qualified exact-text
 * matches reserve their sidecar occurrence first, then remaining duplicates
 * use the same exact-text FIFO fallback as snapshot replay.
 */
export function copySkillSidecarForTranscript(
	fromSessionId: string,
	toSessionId: string,
	retainedUserEntries: readonly RetainedUserTranscriptEntry[],
): boolean {
	const target = sidecarPath(toSessionId);
	if (!target) return false;
	try {
		const sourceEntries = readSkillSidecarEntries(fromSessionId);
		const candidates = retainedUserEntries
			.map(retainedPromptCandidate)
			.filter((candidate): candidate is { modelText: string; timestamp?: number } => !!candidate);
		const consumed = new Set<number>();
		const retainedIndexes = new Set<number>();
		const unresolved: Array<{ modelText: string; timestamp?: number }> = [];

		// Timestamp matches run first so an earlier same-text branch occurrence
		// cannot consume a later retained prompt's precise sidecar record.
		for (const candidate of candidates) {
			if (candidate.timestamp === undefined) {
				unresolved.push(candidate);
				continue;
			}
			let index = -1;
			let closestDelta = Number.POSITIVE_INFINITY;
			for (let entryIndex = 0; entryIndex < sourceEntries.length; entryIndex++) {
				const entry = sourceEntries[entryIndex];
				if (consumed.has(entryIndex) || entry.modelText !== candidate.modelText) continue;
				const delta = Math.abs(entry.ts - candidate.timestamp);
				if (delta > SIDECAR_CORRELATION_TOLERANCE_MS || delta >= closestDelta) continue;
				index = entryIndex;
				closestDelta = delta;
			}
			if (index < 0) {
				unresolved.push(candidate);
				continue;
			}
			consumed.add(index);
			retainedIndexes.add(index);
		}
		for (const candidate of unresolved) {
			const index = sourceEntries.findIndex((entry, entryIndex) =>
				!consumed.has(entryIndex) && entry.modelText === candidate.modelText,
			);
			if (index < 0) continue;
			consumed.add(index);
			retainedIndexes.add(index);
		}

		const retained = sourceEntries.filter((_entry, index) => retainedIndexes.has(index));
		if (retained.length === 0) {
			try { fs.unlinkSync(target); } catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			}
			return true;
		}
		fs.writeFileSync(target, retained.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
		return true;
	} catch (err) {
		console.warn(`[skill-sidecar] Filtered copy failed from ${fromSessionId} to ${toSessionId}:`, err);
		return false;
	}
}

/** Find the entry matching a persisted user message body within ±toleranceMs of `ts`. */
export function findSkillSidecarEntry(
	sessionId: string,
	modelText: string,
	ts: number,
	toleranceMs = 2000,
): SkillSidecarEntry | undefined {
	const entries = readSkillSidecarEntries(sessionId);
	for (const e of entries) {
		if (e.modelText !== modelText) continue;
		if (Math.abs(e.ts - ts) <= toleranceMs) return e;
	}
	// Fall back to text-only match if timestamps drift more than tolerance
	// (e.g. clock skew across restart). Returns the first match.
	return entries.find((e) => e.modelText === modelText);
}

/**
 * Pure merge of sidecar entries into a list of agent messages. For each user
 * message whose text body equals an entry's `modelText`, rewrite the body to
 * `originalText` and re-attach BOTH `skillExpansions` and `fileMentions`
 * (when present). This is the restore / authoritative-snapshot counterpart to
 * the live broadcast splice (`spliceSkillExpansionsIntoEvent`); the two MUST
 * stay in sync or chips vanish on reload. Pinned by tests/skill-sidecar.test.ts.
 *
 * Duplicate identical messages are matched in FIFO order. Idempotent for
 * messages without a matching entry. The input array/objects are not mutated.
 */
export function mergeSidecarEntriesIntoMessages(
	entries: SkillSidecarEntry[],
	messages: any[],
): any[] {
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	if (!Array.isArray(entries) || entries.length === 0) return messages;
	const queues = new Map<string, SkillSidecarEntry[]>();
	for (const e of entries) {
		const arr = queues.get(e.modelText) ?? [];
		arr.push(e);
		queues.set(e.modelText, arr);
	}
	let changed = false;
	const out = messages.map((msg: any) => {
		if (!msg || (msg.role !== "user" && msg.role !== "user-with-attachments")) return msg;
		let body: string;
		if (typeof msg.content === "string") body = msg.content;
		else if (Array.isArray(msg.content)) {
			const block = msg.content.find((c: any) => c?.type === "text");
			body = block?.text ?? "";
		} else body = "";
		const q = queues.get(body);
		if (!q || q.length === 0) return msg;
		const envelope = q.shift()!;
		changed = true;
		let newContent: any;
		if (typeof msg.content === "string") {
			newContent = envelope.originalText;
		} else if (Array.isArray(msg.content)) {
			newContent = msg.content.map((c: any) =>
				c?.type === "text" ? { ...c, text: envelope.originalText } : c,
			);
			if (!newContent.some((c: any) => c?.type === "text")) {
				newContent.unshift({ type: "text", text: envelope.originalText });
			}
		} else {
			newContent = envelope.originalText;
		}
		return {
			...msg,
			content: newContent,
			skillExpansions: envelope.skillExpansions,
			...(envelope.fileMentions?.length ? { fileMentions: envelope.fileMentions } : {}),
		};
	});
	return changed ? out : messages;
}

/** Delete the sidecar for a session (archive purge / terminate). */
export function purgeSkillSidecar(sessionId: string): void {
	const file = sidecarPath(sessionId);
	if (!file) return;
	try {
		if (fs.existsSync(file)) fs.unlinkSync(file);
	} catch { /* ignore */ }
}
