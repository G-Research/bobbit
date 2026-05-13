/**
 * Sidecar persistence for compaction events.
 *
 * The pi-coding-agent CLI owns the canonical `.jsonl` transcript. Its
 * `compaction_end` event arrives once on the live WebSocket stream but is
 * NOT replayed by `getMessages()` after compaction — the agent only
 * returns the active branch (summary entry + tail from `firstKeptEntryId`).
 * Bobbit's rich compaction-summary card therefore disappears on reload
 * because there's nothing to anchor it to in the snapshot.
 *
 * Storage: `<stateDir>/compaction-sidecar/<sessionId>.jsonl` — host-side
 * (mirrors `skill-sidecar.ts`), so valid even for sandboxed sessions
 * whose agent `.jsonl` lives inside the container. One JSON line per
 * compaction event.
 *
 * See docs/design/persist-compaction-history.md §3.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Sidecar record schema v1. Consumers must skip lines whose schemaVersion
 *  they don't recognise (forward-compat). */
export interface CompactionSidecarEntry {
	schemaVersion: 1;
	/** Stable id derived from startedAt + a 6-char random suffix. Used as the
	 *  primary key for the REST endpoint's `?compactionId=` query param. */
	id: string;
	/** "manual" | "auto" | "overflow". Matches CompactionTrigger. */
	trigger: "manual" | "auto" | "overflow";
	tokensBefore: number | null;
	/** Best-effort post-compaction usage. Usually null at end-of-event time;
	 *  may be amended by a follow-up assistant message_end's `usage`. */
	tokensAfter: number | null;
	durationMs: number;
	/** ISO-8601 timestamps. */
	startedAt: string;
	endedAt: string;
	success: boolean;
	/** Failure detail; only set on success=false. */
	error?: string;
	/** Pi-coding-agent's first-kept entry id from CompactionResult. Used by
	 *  the Part B reader to slice the .jsonl into orphaned vs active.
	 *  May be null if the upstream payload didn't carry it (legacy or error). */
	firstKeptEntryId: string | null;
}

/** Generate a stable compaction id `c_<startedAtMs>_<rand6>`. */
export function makeCompactionId(startedAtMs: number): string {
	return `c_${startedAtMs}_${randomBytes(3).toString("hex")}`;
}

let _sidecarDir: string | undefined;

/** Initialize the sidecar dir from the gateway state directory.
 *  Called by server bootstrap, next to `initSkillSidecarDir`. */
export function initCompactionSidecarDir(stateDir: string): void {
	_sidecarDir = path.join(stateDir, "compaction-sidecar");
	try {
		if (!fs.existsSync(_sidecarDir)) fs.mkdirSync(_sidecarDir, { recursive: true });
	} catch (err) {
		console.warn(`[compaction-sidecar] Failed to create sidecar dir at ${_sidecarDir}:`, err);
	}
}

function getSidecarDir(): string | undefined {
	if (!_sidecarDir) return undefined;
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
export function appendCompactionSidecarEntry(
	sessionId: string,
	entry: CompactionSidecarEntry,
): boolean {
	const file = sidecarPath(sessionId);
	if (!file) return false;
	try {
		fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
		return true;
	} catch (err) {
		console.warn(`[compaction-sidecar] Append failed for session ${sessionId}:`, err);
		return false;
	}
}

/** Read all entries for a session. Empty array on any failure (back-compat). */
export function readCompactionSidecarEntries(sessionId: string): CompactionSidecarEntry[] {
	const file = sidecarPath(sessionId);
	if (!file) return [];
	try {
		if (!fs.existsSync(file)) return [];
		const raw = fs.readFileSync(file, "utf-8");
		const out: CompactionSidecarEntry[] = [];
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as CompactionSidecarEntry;
				if (
					parsed &&
					parsed.schemaVersion === 1 &&
					typeof parsed.id === "string" &&
					(parsed.trigger === "manual" || parsed.trigger === "auto" || parsed.trigger === "overflow")
				) {
					out.push(parsed);
				}
			} catch { /* skip malformed line */ }
		}
		return out;
	} catch (err) {
		console.warn(`[compaction-sidecar] Read failed for session ${sessionId}:`, err);
		return [];
	}
}

/** Find a single sidecar entry by id. Used by the REST endpoint. */
export function findCompactionSidecarEntry(
	sessionId: string,
	id: string,
): CompactionSidecarEntry | undefined {
	if (!id) return undefined;
	return readCompactionSidecarEntries(sessionId).find((e) => e.id === id);
}

/** Delete the sidecar for a session (archive purge / terminate). */
export function purgeCompactionSidecar(sessionId: string): void {
	const file = sidecarPath(sessionId);
	if (!file) return;
	try {
		if (fs.existsSync(file)) fs.unlinkSync(file);
	} catch { /* ignore */ }
}

// ============================================================================
// Synthetic-row construction for snapshot splice
// ============================================================================

/**
 * Build the synthetic assistant message + paired toolResult that mirrors
 * what the live `compaction_end` path produces, except the id is the
 * sidecar's stable `entry.id` (NOT `compact_active` — that's reserved for
 * the live in-flight card so single-DOM-identity continuity isn't broken
 * during the same session).
 *
 * The renderer reads `payload.compactionId` (new field) to know it's
 * looking at a persisted sidecar row that can be expanded with
 * pre-compaction history (Part C).
 */
export function syntheticCompactionRowsFromSidecar(
	entry: CompactionSidecarEntry,
): [any, any] {
	const payload = {
		schemaVersion: 1 as const,
		trigger: entry.trigger,
		state: entry.success ? ("complete" as const) : ("error" as const),
		success: entry.success,
		timestamp: entry.endedAt,
		startedAt: entry.startedAt,
		durationMs: entry.durationMs,
		tokensBefore: entry.tokensBefore,
		tokensAfter: entry.tokensAfter,
		reductionPct:
			entry.tokensBefore != null && entry.tokensAfter != null && entry.tokensBefore > 0
				? Math.round(((entry.tokensBefore - entry.tokensAfter) / entry.tokensBefore) * 1000) / 10
				: null,
		error: entry.success ? undefined : entry.error,
		/** Sidecar id — Part C uses this to query pre-compaction history. */
		compactionId: entry.id,
	};
	const id = entry.id;
	const toolCallId = `compaction-summary:${id}`;
	const tsMs = new Date(entry.endedAt).getTime();
	const message = {
		id,
		role: "assistant" as const,
		timestamp: tsMs,
		content: [{
			type: "toolCall" as const,
			id: toolCallId,
			name: "__compaction_summary",
			arguments: payload,
		}],
	};
	const toolResult = {
		role: "toolResult" as const,
		toolCallId,
		toolName: "__compaction_summary",
		isError: !entry.success,
		content: [{
			type: "text" as const,
			text: entry.success ? "ok" : (entry.error || "compaction failed"),
		}],
		details: payload,
		timestamp: tsMs,
	};
	return [message, toolResult];
}

/**
 * Splice sidecar-driven synthetic compaction rows into a message list so
 * the rich card survives reload. Runs BEFORE other post-processing so the
 * synthetic rows participate in the same truncate/skill-merge pipeline as
 * server-origin rows.
 *
 * Idempotency: if a `__compaction_summary` toolCall with the same
 * `toolCallId` is already present (live emission during the same WS
 * session), the sidecar pair is skipped for that slot — the live row
 * wins. The reducer's `hasCompactionToolCall` handles client-side dedup
 * (matching by `compact_active` for live rows vs sidecar id for
 * persisted rows).
 *
 * Position: each sidecar pair is spliced immediately BEFORE the agent's
 * own active-branch boundary — which appears in the agent's getMessages
 * output as the first entry whose role matches the keep boundary. We
 * don't have access to entry uuids in the message list, so the
 * conservative behaviour is: append at the end if no boundary is
 * resolvable. The card still renders correctly; the rendered
 * pre-compaction history (Part C) is fetched separately by id.
 */
export function mergeCompactionSidecarIntoMessages(
	sessionId: string,
	messages: any[],
): any[] {
	if (!Array.isArray(messages)) return messages;
	const entries = readCompactionSidecarEntries(sessionId);
	if (entries.length === 0) return messages;

	// Collect existing __compaction_summary toolCall ids already in the array
	// — both the live `compact_active` slot and any prior splice.
	const existingToolCallIds = new Set<string>();
	for (const m of messages) {
		if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const c of m.content) {
			if (c?.type === "toolCall" && c?.name === "__compaction_summary" && typeof c.id === "string") {
				existingToolCallIds.add(c.id);
			}
		}
	}
	// Also collect ids by message.id so we don't duplicate by row identity.
	const existingMessageIds = new Set<string>();
	for (const m of messages) {
		if (m && typeof m.id === "string") existingMessageIds.add(m.id);
	}

	// Build sidecar rows (oldest-first), skipping any whose stable id is
	// already represented in the live list. The live `compact_active` row
	// uses a DIFFERENT id from any sidecar entry, so we additionally drop
	// the most-recent sidecar row when a `compact_active` is present — that
	// IS the same compaction surfaced live, just under the stable in-flight
	// id. Without this hop we'd render both cards stacked.
	const hasLiveActive = existingToolCallIds.has("compaction-summary:compact_active");

	const splice: any[] = [];
	// De-dup sidecar by id: idempotent re-appends (e.g. test re-seeds, or a
	// rare double-write race) must not produce multiple cards.
	const dedup = new Map<string, CompactionSidecarEntry>();
	for (const e of entries) dedup.set(e.id, e);
	const sorted = Array.from(dedup.values())
		.sort((a, b) => new Date(a.endedAt).getTime() - new Date(b.endedAt).getTime());
	const lastIdx = sorted.length - 1;
	for (let i = 0; i < sorted.length; i++) {
		const entry = sorted[i];
		const tcid = `compaction-summary:${entry.id}`;
		if (existingToolCallIds.has(tcid)) continue;
		if (existingMessageIds.has(entry.id)) continue;
		// Drop the most-recent sidecar row if the live in-flight card is
		// already on screen — same compaction, two surfaces.
		if (hasLiveActive && i === lastIdx) continue;
		const [msg, tr] = syntheticCompactionRowsFromSidecar(entry);
		splice.push(msg, tr);
	}
	if (splice.length === 0) return messages;

	// Position: prepend the splice block at the start. The reducer sorts by
	// `_order` (snapshot-stamped position) so this controls visual position
	// after stamping. We want the compaction card to appear before the kept
	// tail rows — prepending achieves that since the kept tail rows are
	// stamped with the original snapshot positions. Subsequent compactions
	// for the same session naturally come oldest-first.
	return [...splice, ...messages];
}
