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
import { randomUUID } from "node:crypto";
import { isPiTranscriptEntryId } from "../../shared/message-author.js";
import type { SkillExpansion } from "./resolve-skill-expansions.js";
import type { FileMention } from "./resolve-file-mentions.js";
import {
	sanitizeAttachmentDisplayMetadata,
	type AttachmentDisplayMetadata,
} from "../agent/attachment-display.js";

const SKILL_RECORD_ID_PREFIX = "skill:v1:";

export interface SkillSidecarEntry {
	/** Additive schema marker. Legacy records without it remain readable. */
	schemaVersion?: 1;
	/** Bobbit-local identity. It is deliberately distinct from Pi's transcript id. */
	recordId?: string;
	/** Authoritative Pi message-entry identity, projected only from a unique settlement binding. */
	transcriptEntryId?: string;
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
	/** Safe outward-only tile data. Never contains file bytes or extracted text. */
	attachments?: AttachmentDisplayMetadata[];
}

interface SkillSidecarBindingRecord {
	schemaVersion: 1;
	type: "transcript-binding";
	recordId: string;
	transcriptEntryId: string;
}

function isSkillRecordId(value: unknown): value is string {
	return typeof value === "string"
		&& value.startsWith(SKILL_RECORD_ID_PREFIX)
		&& value.length <= 128
		&& value === value.trim();
}

export function makeSkillSidecarRecordId(): string {
	return `${SKILL_RECORD_ID_PREFIX}${randomUUID()}`;
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
	const attachments = entry.attachments === undefined
		? undefined
		: sanitizeAttachmentDisplayMetadata(entry.attachments);
	if (entry.attachments !== undefined && !attachments) return false;
	const storedEntry = attachments ? { ...entry, attachments } : entry;
	try {
		fs.appendFileSync(file, JSON.stringify(storedEntry) + "\n", "utf-8");
		return true;
	} catch (err) {
		console.warn(`[skill-sidecar] Append failed for session ${sessionId}:`, err);
		return false;
	}
}

/** Stage a newly-written record with a versioned Bobbit-local identity. */
export function appendIdentifiedSkillSidecarEntry(
	sessionId: string,
	entry: Omit<SkillSidecarEntry, "schemaVersion" | "recordId" | "transcriptEntryId">,
): string | undefined {
	const recordId = makeSkillSidecarRecordId();
	return appendSkillSidecarEntry(sessionId, { ...entry, schemaVersion: 1, recordId })
		? recordId
		: undefined;
}

/** Append-only authoritative binding. A fork observes either unbound or proven data. */
export function appendSkillSidecarTranscriptBinding(
	sessionId: string,
	recordId: string,
	transcriptEntryId: string,
): boolean {
	if (!isSkillRecordId(recordId) || !isPiTranscriptEntryId(transcriptEntryId)) return false;
	const file = sidecarPath(sessionId);
	if (!file) return false;
	try {
		const binding: SkillSidecarBindingRecord = {
			schemaVersion: 1,
			type: "transcript-binding",
			recordId,
			transcriptEntryId,
		};
		fs.appendFileSync(file, JSON.stringify(binding) + "\n", "utf-8");
		return true;
	} catch (err) {
		console.warn(`[skill-sidecar] Binding append failed for session ${sessionId}:`, err);
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
		const bindings = new Map<string, string | null>();
		const recordCounts = new Map<string, number>();
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as SkillSidecarEntry | SkillSidecarBindingRecord;
				if ((parsed as SkillSidecarBindingRecord)?.type === "transcript-binding") {
					const binding = parsed as SkillSidecarBindingRecord;
					if (binding.schemaVersion !== 1
						|| !isSkillRecordId(binding.recordId)
						|| !isPiTranscriptEntryId(binding.transcriptEntryId)) continue;
					// Exactly one valid append-only binding may establish provenance.
					// Repeated identical bindings fail closed just like conflicts.
					const existing = bindings.get(binding.recordId);
					bindings.set(binding.recordId,
						existing === undefined ? binding.transcriptEntryId : null);
					continue;
				}
				const entry = parsed as SkillSidecarEntry;
				// Accept legacy skill/file records and attachment-only display envelopes.
				// Attachment fields are client-originated and are validated again on read;
				// file bytes and extracted text are never projected from this sidecar.
				const attachments = sanitizeAttachmentDisplayMetadata(entry?.attachments);
				if (
					entry &&
					typeof entry.ts === "number" && Number.isFinite(entry.ts) &&
					typeof entry.modelText === "string" &&
					typeof entry.originalText === "string" &&
					(Array.isArray(entry.skillExpansions) || Array.isArray(entry.fileMentions) || attachments)
				) {
					const {
						recordId: candidateRecordId,
						attachments: _untrustedAttachments,
						// Inline identity is project-visible, untrusted metadata. Only a
						// separate append-only binding may project it onto the entry.
						transcriptEntryId: _untrustedTranscriptEntryId,
						...legacyFields
					} = entry;
					const normalized: SkillSidecarEntry = {
						...legacyFields,
						...(attachments ? { attachments } : {}),
						...(isSkillRecordId(candidateRecordId) ? { recordId: candidateRecordId } : {}),
					};
					out.push(normalized);
					if (normalized.recordId) {
						recordCounts.set(normalized.recordId, (recordCounts.get(normalized.recordId) ?? 0) + 1);
					}
				}
			} catch { /* skip malformed line */ }
		}
		return out.map((entry) => {
			if (!entry.recordId || recordCounts.get(entry.recordId) !== 1) return entry;
			const appended = bindings.get(entry.recordId);
			return appended === undefined || appended === null
				? entry
				: { ...entry, transcriptEntryId: appended };
		});
	} catch (err) {
		console.warn(`[skill-sidecar] Read failed for session ${sessionId}:`, err);
		return [];
	}
}

/**
 * Copy only records carrying a proven Pi identity that survives the history
 * cut. Text, time, physical sidecar order, and legacy FIFO are intentionally
 * irrelevant here; they remain source-display compatibility mechanisms only.
 */
export function copySkillSidecarForTranscript(
	fromSessionId: string,
	toSessionId: string,
	retainedEntryIds: ReadonlySet<string>,
): boolean {
	const target = sidecarPath(toSessionId);
	if (!target) return false;
	try {
		type BoundEntry = SkillSidecarEntry & { recordId: string; transcriptEntryId: string };
		const candidates = readSkillSidecarEntries(fromSessionId).filter((entry): entry is BoundEntry =>
			isSkillRecordId(entry.recordId)
			&& isPiTranscriptEntryId(entry.transcriptEntryId)
			&& retainedEntryIds.has(entry.transcriptEntryId),
		);
		const counts = new Map<string, number>();
		for (const entry of candidates) {
			counts.set(entry.transcriptEntryId, (counts.get(entry.transcriptEntryId) ?? 0) + 1);
		}
		const retained = candidates.filter((entry) => counts.get(entry.transcriptEntryId) === 1);
		if (retained.length === 0) {
			try { fs.unlinkSync(target); } catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			}
			return true;
		}
		const serialized: string[] = [];
		for (const entry of retained) {
			const { transcriptEntryId, ...storedEntry } = entry;
			serialized.push(JSON.stringify(storedEntry));
			serialized.push(JSON.stringify({
				schemaVersion: 1,
				type: "transcript-binding",
				recordId: entry.recordId,
				transcriptEntryId,
			} satisfies SkillSidecarBindingRecord));
		}
		fs.writeFileSync(target, serialized.join("\n") + "\n", "utf-8");
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

/** Project one model-facing prompt into its outward-only display form. */
export function projectPromptDisplayMessage(msg: any, envelope: SkillSidecarEntry): any {
	const attachments = sanitizeAttachmentDisplayMetadata(envelope.attachments);
	let newContent: any;
	if (typeof msg.content === "string") {
		newContent = envelope.originalText;
	} else if (Array.isArray(msg.content)) {
		// Preserve image blocks and their order; only the model text block changes.
		newContent = msg.content.map((block: any) =>
			block?.type === "text" ? { ...block, text: envelope.originalText } : block,
		);
		if (!newContent.some((block: any) => block?.type === "text")) {
			newContent.unshift({ type: "text", text: envelope.originalText });
		}
	} else {
		newContent = envelope.originalText;
	}
	return {
		...msg,
		...(attachments?.length ? { role: "user-with-attachments" } : {}),
		content: newContent,
		skillExpansions: envelope.skillExpansions ?? [],
		...(envelope.fileMentions?.length ? { fileMentions: envelope.fileMentions } : {}),
		...(attachments?.length ? { attachments } : {}),
	};
}

/**
 * Pure outward projection for restore, history, title, and Copy Prompt sources.
 * Proven transcript occurrence identity wins over text matching. Bound records
 * never enter the legacy text FIFO, preventing equal-text prompts from borrowing
 * another occurrence's attachment presentation.
 */
export function mergeSidecarEntriesIntoMessages(
	entries: SkillSidecarEntry[],
	messages: any[],
): any[] {
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	if (!Array.isArray(entries) || entries.length === 0) return messages;

	const boundGroups = new Map<string, SkillSidecarEntry[]>();
	const legacyQueues = new Map<string, SkillSidecarEntry[]>();
	for (const entry of entries) {
		if (isPiTranscriptEntryId(entry.transcriptEntryId)) {
			const group = boundGroups.get(entry.transcriptEntryId) ?? [];
			group.push(entry);
			boundGroups.set(entry.transcriptEntryId, group);
		} else {
			const queue = legacyQueues.get(entry.modelText) ?? [];
			queue.push(entry);
			legacyQueues.set(entry.modelText, queue);
		}
	}

	let changed = false;
	const out = messages.map((msg: any) => {
		if (!msg || (msg.role !== "user" && msg.role !== "user-with-attachments")) return msg;
		let body = "";
		if (typeof msg.content === "string") body = msg.content;
		else if (Array.isArray(msg.content)) {
			body = msg.content.find((block: any) => block?.type === "text")?.text ?? "";
		}

		let envelope: SkillSidecarEntry | undefined;
		if (isPiTranscriptEntryId(msg.entryId)) {
			const exact = boundGroups.get(msg.entryId);
			// Duplicate/conflicting occurrence bindings fail closed.
			if (exact?.length === 1 && exact[0].modelText === body) envelope = exact[0];
		}
		if (!envelope) {
			const queue = legacyQueues.get(body);
			envelope = queue?.shift();
		}
		if (!envelope) return msg;
		changed = true;
		return projectPromptDisplayMessage(msg, envelope);
	});
	return changed ? out : messages;
}

/** Reusable outward projection boundary for snapshots, titles, and copy sources. */
export function projectPromptDisplayMessagesForSession<T extends object>(
	sessionId: string,
	messages: T[],
): T[] {
	const entries = readSkillSidecarEntries(sessionId);
	return (entries.length > 0 ? mergeSidecarEntriesIntoMessages(entries, messages) : messages) as T[];
}

/** Delete the sidecar for a session (archive purge / terminate). */
export function purgeSkillSidecar(sessionId: string): void {
	const file = sidecarPath(sessionId);
	if (!file) return;
	try {
		if (fs.existsSync(file)) fs.unlinkSync(file);
	} catch { /* ignore */ }
}
