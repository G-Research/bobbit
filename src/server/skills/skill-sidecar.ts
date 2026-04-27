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

export interface SkillSidecarEntry {
	/** Unix epoch (ms) at the moment the user message was persisted. */
	ts: number;
	/** What the agent saw. Used as a lookup key against the persisted message body. */
	modelText: string;
	/** What the user actually typed. */
	originalText: string;
	/** Chips, snapshotted at invocation time. */
	skillExpansions: SkillExpansion[];
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
				if (parsed && typeof parsed.modelText === "string" && Array.isArray(parsed.skillExpansions)) {
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

/** Delete the sidecar for a session (archive purge / terminate). */
export function purgeSkillSidecar(sessionId: string): void {
	const file = sidecarPath(sessionId);
	if (!file) return;
	try {
		if (fs.existsSync(file)) fs.unlinkSync(file);
	} catch { /* ignore */ }
}
