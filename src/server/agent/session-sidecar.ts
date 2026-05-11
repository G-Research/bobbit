/**
 * Per-session bobbit-owned sidecar for exact recovery.
 *
 * Symptom this addresses: when an entry disappears from `sessions.json` but
 * the agent's `.jsonl` survives on disk, `team-manager.ts::restoreTeams`
 * reconstructs a session record best-effort — it has to invent a fresh
 * bobbit session id, roll a fun-name title, and parse the role from the
 * worktree slug. The original bobbit-side metadata (id, role, team links,
 * title, accessory, model preferences) is lost forever because it lived
 * only in `sessions.json`.
 *
 * Fix: write a bobbit-owned sidecar JSON file alongside each `.jsonl` so
 * future recoveries are exact. The sidecar is additive — sessions.json
 * remains the source of truth at runtime, the sidecar is consulted only
 * during boot recovery when the session record is missing. Heuristic
 * reconstruction (`team-store-consistency.ts`) remains the fallback for
 * pre-sidecar sessions.
 *
 * Schema is versioned (`version: 1`) so a future bump can ignore old files
 * via `readSessionSidecar` returning null on mismatch — callers naturally
 * fall back to the heuristic path.
 */

import fs from "node:fs";
import path from "node:path";

export interface SessionSidecar {
	version: 1;
	bobbitSessionId: string;
	agentSessionId: string;
	role: string;
	teamGoalId?: string;
	teamLeadSessionId?: string;
	delegateOf?: string | null;
	spawnedBySessionId?: string | null;
	title: string;
	accessory?: string | null;
	createdAt: number;
	modelProvider?: string;
	modelId?: string;
}

/**
 * Derive the sidecar path for an agent `.jsonl` path.
 *
 * Shape: `<jsonl-dir>/<jsonl-basename-without-.jsonl>.bobbit.json`. We
 * strip the `.jsonl` suffix and append `.bobbit.json` so that listing the
 * directory shows the pair (`<id>.jsonl` next to `<id>.bobbit.json`) and
 * cleanup logic that filters by basename stem keeps them aligned.
 *
 * If the input has no `.jsonl` suffix, we append `.bobbit.json` to the
 * full path — defensive, never throws.
 */
export function sidecarPathFor(jsonlPath: string): string {
	const dir = path.dirname(jsonlPath);
	const base = path.basename(jsonlPath);
	const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
	return path.join(dir, `${stem}.bobbit.json`);
}

/**
 * Write the sidecar JSON atomically (tmp → rename) so a crash mid-write
 * leaves either the previous content or the new content — never a partial
 * file. Fire-and-forget callers can swallow errors; we log but don't throw
 * so a sidecar I/O failure never breaks session creation.
 *
 * Idempotent: re-writing the same content is safe; the atomic rename is
 * cheap and overwrites the existing file in place.
 */
export function writeSessionSidecar(jsonlPath: string, meta: SessionSidecar): void {
	const target = sidecarPathFor(jsonlPath);
	const dir = path.dirname(target);
	try {
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
		const json = JSON.stringify(meta, null, 2);
		fs.writeFileSync(tmp, json, { encoding: "utf-8" });
		fs.renameSync(tmp, target);
	} catch (err) {
		console.warn(`[session-sidecar] Failed to write sidecar for ${jsonlPath}: ${err}`);
	}
}

/**
 * Read the sidecar JSON. Returns null when:
 *   - the file is absent
 *   - JSON parsing fails
 *   - `version` is not `1` (forward-compat — caller falls back to heuristic)
 *   - required string fields are missing/malformed
 *
 * Never throws — recovery callers should always be able to continue with
 * the heuristic fallback on any sidecar problem.
 */
export function readSessionSidecar(jsonlPath: string): SessionSidecar | null {
	const target = sidecarPathFor(jsonlPath);
	let raw: string;
	try {
		raw = fs.readFileSync(target, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	if (obj.version !== 1) return null;
	if (typeof obj.bobbitSessionId !== "string" || !obj.bobbitSessionId) return null;
	if (typeof obj.agentSessionId !== "string") return null;
	if (typeof obj.role !== "string" || !obj.role) return null;
	if (typeof obj.title !== "string") return null;
	if (typeof obj.createdAt !== "number" || !Number.isFinite(obj.createdAt)) return null;
	return {
		version: 1,
		bobbitSessionId: obj.bobbitSessionId,
		agentSessionId: obj.agentSessionId,
		role: obj.role,
		teamGoalId: typeof obj.teamGoalId === "string" ? obj.teamGoalId : undefined,
		teamLeadSessionId: typeof obj.teamLeadSessionId === "string" ? obj.teamLeadSessionId : undefined,
		delegateOf: typeof obj.delegateOf === "string" ? obj.delegateOf : (obj.delegateOf === null ? null : undefined),
		spawnedBySessionId: typeof obj.spawnedBySessionId === "string" ? obj.spawnedBySessionId : (obj.spawnedBySessionId === null ? null : undefined),
		title: obj.title,
		accessory: typeof obj.accessory === "string" ? obj.accessory : (obj.accessory === null ? null : undefined),
		createdAt: obj.createdAt,
		modelProvider: typeof obj.modelProvider === "string" ? obj.modelProvider : undefined,
		modelId: typeof obj.modelId === "string" ? obj.modelId : undefined,
	};
}

/**
 * Apply sidecar fields over a heuristically-reconstructed session record.
 *
 * Sidecar fields WIN — that's the whole point of the sidecar: when the
 * record was lost from sessions.json, the heuristic guesses can be wrong
 * (fresh UUID, fun-name title, role parsed from worktree slug) and the
 * sidecar carries the exact original values bobbit wrote when the session
 * was first created.
 *
 * Returns a new object — never mutates the input.
 */
export function reconcileRecoveredSessionWithSidecar<S extends Record<string, unknown>>(
	record: S,
	sidecar: SessionSidecar,
): S {
	const out: Record<string, unknown> = { ...record };
	out.id = sidecar.bobbitSessionId;
	out.role = sidecar.role;
	out.title = sidecar.title;
	out.createdAt = sidecar.createdAt;
	if (sidecar.teamGoalId !== undefined) out.teamGoalId = sidecar.teamGoalId;
	if (sidecar.teamLeadSessionId !== undefined) out.teamLeadSessionId = sidecar.teamLeadSessionId;
	if (sidecar.delegateOf !== undefined && sidecar.delegateOf !== null) out.delegateOf = sidecar.delegateOf;
	if (sidecar.accessory !== undefined && sidecar.accessory !== null) out.accessory = sidecar.accessory;
	if (sidecar.modelProvider !== undefined) out.modelProvider = sidecar.modelProvider;
	if (sidecar.modelId !== undefined) out.modelId = sidecar.modelId;
	return out as S;
}

/**
 * Build a SessionSidecar from a persisted session record. Used by the
 * session-manager write path and by the boot-time backfill in team-manager.
 *
 * Caller passes the `agentSessionId` separately — we don't read it from
 * the .jsonl here to keep this pure and synchronous. The first line of
 * the .jsonl carries it; session-manager has it via the rpcClient state.
 */
export function buildSessionSidecar(
	record: {
		id: string;
		role?: string;
		title: string;
		createdAt: number;
		teamGoalId?: string;
		teamLeadSessionId?: string;
		delegateOf?: string;
		accessory?: string;
		modelProvider?: string;
		modelId?: string;
	},
	agentSessionId: string,
	spawnedBySessionId?: string | null,
): SessionSidecar {
	return {
		version: 1,
		bobbitSessionId: record.id,
		agentSessionId,
		role: record.role || "general",
		teamGoalId: record.teamGoalId,
		teamLeadSessionId: record.teamLeadSessionId,
		delegateOf: record.delegateOf ?? null,
		spawnedBySessionId: spawnedBySessionId ?? null,
		title: record.title,
		accessory: record.accessory ?? null,
		createdAt: record.createdAt,
		modelProvider: record.modelProvider,
		modelId: record.modelId,
	};
}
