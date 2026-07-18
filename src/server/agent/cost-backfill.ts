/**
 * Boot-time backfill for legacy cost entries.
 *
 * Background — commit `a4050f59` ("cost persist by goalId") taught
 * `CostTracker.recordUsage` to stamp a `goalId` on each cost entry so
 * tree-cost rollups survive session purge. That fix only addressed the
 * FORWARD path: any cost entry that was already on disk before the
 * commit shipped has no `goalId`. If the source session has since been
 * archived/purged, the cost entry is orphaned and `computeTreeCost`
 * silently drops it ($0 archived subgoals — see the audit goal).
 *
 * This helper recovers the missing `goalId` once at boot. Two
 * recovery paths, tried in order per unstamped entry:
 *
 *   1. Live persisted session record (`sessionManager.getPersistedSession`).
 *      Prefers `teamGoalId` (the team-goal the session was spawned under),
 *      falls back to `goalId` (older non-team sessions).
 *
 *   2. Sidecar on disk. Two sub-paths:
 *        a. If the persisted record is still around AND carries an
 *           `agentSessionFile` path, read the sidecar next to it.
 *        b. If the session is purged entirely, scan the agent sessions
 *           root for `*.bobbit.json` sidecars and build a one-shot
 *           `bobbitSessionId -> teamGoalId` index.
 *
 * Anything that survives both passes stays unstamped and falls into
 * `CostTracker.getUnattributableLegacyCost()` — surfaced as the
 * `Unattributable (legacy)` row in the tree-cost panel rather than
 * being absorbed silently into $0.
 *
 * Idempotent: subsequent boots scan only entries that are still
 * unstamped, and `CostTracker.backfillGoalIds` only bumps the
 * generation tick when at least one entry was actually updated.
 */

import path from "node:path";
import {
	mapWithConcurrency,
	realRecoveryFs,
	RECOVERY_IO_CONCURRENCY,
	type RecoveryFs,
} from "./bounded-async-work.js";
import { readSessionSidecarAsync } from "./session-sidecar.js";
import type { CostTracker } from "./cost-tracker.js";

/**
 * Minimal session-manager shape the backfill needs — typed as a structural
 * subset so tests don't have to construct a full SessionManager.
 */
export interface CostBackfillSessionManager {
	getPersistedSession(sessionId: string): {
		goalId?: string;
		teamGoalId?: string;
		agentSessionFile?: string;
	} | undefined;
}

export interface CostBackfillResult {
	stamped: number;
	unattributable: number;
}

export interface CostBackfillOptions {
	costTracker: CostTracker;
	sessionManager: CostBackfillSessionManager;
	/**
	 * Agent sessions root — where the agent CLI writes `<slug>/<id>.jsonl`
	 * and bobbit writes the sibling `<id>.bobbit.json` sidecars. Used as a
	 * last-resort scan when the persisted session record is gone.
	 */
	agentSessionsRoot: string;
	logger?: Pick<Console, "log" | "warn">;
	fs?: RecoveryFs;
}

/**
 * Recover and stamp `goalId` on legacy cost entries. Returns counts.
 *
 * Logs exactly one summary line:
 *   `[cost-backfill] stamped goalId on N entries; M still unattributable`
 *
 * Safe to call multiple times — already-stamped entries are skipped, and
 * subsequent runs with no new unstamped entries are pure no-ops (no
 * persistence write, no generation bump).
 */
export async function backfillLegacyCostGoalIds(opts: CostBackfillOptions): Promise<CostBackfillResult> {
	const { costTracker, sessionManager, agentSessionsRoot } = opts;
	const logger = opts.logger ?? console;
	const fsImpl = opts.fs ?? realRecoveryFs;

	const unstamped = costTracker.getUnstampedSessionIds();
	if (unstamped.length === 0) {
		if (process.env.BOBBIT_DEBUG) logger.log("[cost-backfill] stamped goalId on 0 entries; 0 still unattributable");
		return { stamped: 0, unattributable: 0 };
	}

	// Resolve persisted metadata and adjacent sidecars first. Keeping the
	// fallback tree scan as a second bounded phase prevents nested pools from
	// multiplying the global recovery I/O ceiling.
	const resolvedGoalIds = await mapWithConcurrency(
		unstamped,
		RECOVERY_IO_CONCURRENCY,
		async (sessionId): Promise<string | undefined> => {
			const ps = sessionManager.getPersistedSession(sessionId);
			if (!ps) return undefined;
			if (ps.teamGoalId) return ps.teamGoalId;
			if (ps.goalId) return ps.goalId;
			if (!ps.agentSessionFile) return undefined;
			const sidecar = await readSessionSidecarAsync(ps.agentSessionFile, fsImpl);
			return sidecar?.teamGoalId;
		},
	);

	let sidecarIndex: Map<string, string> | undefined;
	if (resolvedGoalIds.some((goalId) => !goalId)) {
		sidecarIndex = await buildSidecarGoalIdIndex(agentSessionsRoot, logger, fsImpl);
	}
	const resolved = new Map<string, string>();
	for (let i = 0; i < unstamped.length; i++) {
		const sessionId = unstamped[i]!;
		const goalId = resolvedGoalIds[i] ?? sidecarIndex?.get(sessionId);
		if (goalId) resolved.set(sessionId, goalId);
	}

	const stamped = costTracker.backfillGoalIds((sessionId) => resolved.get(sessionId));
	const remaining = costTracker.getUnstampedSessionIds().length;

	// Only emit when a real backfill happened; a no-op pass (stamped=0) is boot
	// noise — the standing `remaining` backlog is surfaced in the tree-cost panel.
	if (stamped > 0 || process.env.BOBBIT_DEBUG)
		logger.log(
			`[cost-backfill] stamped goalId on ${stamped} entries; ${remaining} still unattributable`,
		);

	return { stamped, unattributable: remaining };
}

// ---------------------------------------------------------------------------
// Transcript-pass backfill
//
// Second pass that runs *after* the sidecar pass for cost entries whose
// session record AND sidecar are both gone, but whose agent transcript
// (`<sessionsRoot>/<slug>/<sessionId>.jsonl`) is still on disk. bobbit
// injects the goalId into the first turn of every spawn (working-directory
// path, `BOBBIT_GOAL_ID` env block, goal-context system prompt), so the
// id usually appears verbatim in the first ~50 lines.
//
// Hard rule: confidence-based stamping only. A guess is worse than
// `unattributable`. See `extractTranscriptGoalId` for the rules.
// ---------------------------------------------------------------------------

/** Minimal goal shape used to build the known-id set. */
export interface CostBackfillGoalRef {
	id: string;
}

export interface CostBackfillTranscriptOptions {
	costTracker: CostTracker;
	agentSessionsRoot: string;
	/** Goal source — typically `ctx.goalStore.getAll()`. Used to cross-reference
	 *  every regex hit. Ids not present here are never stamped. */
	goals: CostBackfillGoalRef[];
	logger?: Pick<Console, "log" | "warn">;
	/** Max lines to read per transcript. Default 50. */
	maxLines?: number;
	/** Max bytes to read per transcript. Default 64 KiB. */
	maxBytes?: number;
	/** Per-project total runtime budget in ms. Default 30s. */
	deadlineMs?: number;
	fs?: RecoveryFs;
	clock?: { now(): number };
}

export interface CostBackfillTranscriptResult {
	stamped: number;
	unattributable: number;
	skipped: number;
}

const GOAL_ID_REGEX = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g;

const CONFIDENCE_KEYWORDS = [
	"BOBBIT_GOAL_ID",
	"--goal",
	"# Goal",
	"Goal Spec",
	"Goal nesting context",
	"Current Goal",
	"Working Directory",
];

/**
 * Extract a single, high-confidence goalId from transcript `text`. Returns
 * `undefined` unless exactly one id from `knownGoalIds` appears AND it
 * appears in a high/medium-confidence context (worktree path / env-injection
 * marker / `# Goal` / `--goal` flag etc.). Prose mentions (e.g. "see goal
 * <uuid>") are deliberately ignored — a wrong attribution is worse than
 * `unattributable`.
 *
 * Exported for unit coverage.
 */
export function extractTranscriptGoalId(
	text: string,
	knownGoalIds: Set<string>,
): string | undefined {
	if (!text) return undefined;
	const hits = new Set<string>();
	for (const m of text.matchAll(GOAL_ID_REGEX)) {
		const id = m[0];
		if (knownGoalIds.has(id)) hits.add(id);
	}
	if (hits.size !== 1) return undefined;
	const id = [...hits][0]!;
	const short = id.slice(0, 8);

	// High confidence: explicit env injection / CLI flag / worktree path.
	if (
		text.includes(`BOBBIT_GOAL_ID=${id}`) ||
		text.includes(`BOBBIT_GOAL_ID: ${id}`) ||
		text.includes(`BOBBIT_GOAL_ID="${id}"`) ||
		text.includes(`--goal ${id}`) ||
		text.includes(`--goal=${id}`)
	) {
		return id;
	}
	// Worktree path segment: `.../goal-<slug>-<id8>/...` where id8 = first 8.
	if (new RegExp(`goal-[a-z0-9][a-z0-9-]*-${short}\\b`).test(text)) {
		return id;
	}

	// Medium confidence: id occurs in the goal-context block. Be conservative:
	// require a goal-keyword marker within ~400 chars of the id occurrence.
	const idx = text.indexOf(id);
	if (idx >= 0) {
		const windowStart = Math.max(0, idx - 400);
		const windowEnd = Math.min(text.length, idx + id.length + 400);
		const window = text.slice(windowStart, windowEnd);
		for (const kw of CONFIDENCE_KEYWORDS) {
			if (window.includes(kw)) return id;
		}
	}
	return undefined;
}

/** Read one bounded transcript header. Any I/O error returns `""`. */
async function readTranscriptHead(
	filePath: string,
	maxLines: number,
	maxBytes: number,
	fsImpl: RecoveryFs,
): Promise<string> {
	let handle: Awaited<ReturnType<RecoveryFs["open"]>> | undefined;
	try {
		handle = await fsImpl.open(filePath, "r");
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		return text.split("\n").slice(0, maxLines).join("\n");
	} catch {
		return "";
	} finally {
		if (handle) {
			try { await handle.close(); } catch { /* ignore */ }
		}
	}
}

/**
 * Locate a transcript for `sessionId` by scanning `<sessionsRoot>/<slug>/`
 * one level deep. The agent CLI names transcripts `<isoTs>_<sessionId>.jsonl`
 * (see `agent-session-path.ts`), while a few older tests/fixtures used
 * `<sessionId>.jsonl`; accept both. Returns the first match or `undefined`.
 * Defensive — any I/O error is swallowed.
 */
async function findTranscriptPath(
	agentSessionsRoot: string,
	sessionId: string,
	fsImpl: RecoveryFs,
): Promise<string | undefined> {
	let entries: string[];
	try {
		await fsImpl.access(agentSessionsRoot);
		entries = await fsImpl.readdir(agentSessionsRoot);
	} catch {
		return undefined;
	}
	const exactTarget = `${sessionId}.jsonl`;
	const suffixTarget = `_${sessionId}.jsonl`;
	for (const slug of entries) {
		const slugDir = path.join(agentSessionsRoot, slug);
		try {
			const stat = await fsImpl.stat(slugDir);
			if (!stat.isDirectory()) continue;
		} catch { continue; }
		let names: string[];
		try { names = await fsImpl.readdir(slugDir); } catch { continue; }
		for (const name of names) {
			if (name !== exactTarget && !name.endsWith(suffixTarget)) continue;
			const candidate = path.join(slugDir, name);
			try {
				const stat = await fsImpl.stat(candidate);
				if (stat.isFile()) return candidate;
			} catch { /* ignore */ }
		}
	}
	return undefined;
}

/**
 * Transcript-pass backfill. Runs *after* `backfillLegacyCostGoalIds` for
 * any cost entries that the sidecar pass could not map. Best-effort and
 * confidence-gated — silent skip beats wrong attribution.
 *
 * Logs one summary line:
 *   `[cost-backfill] transcript-pass stamped goalId on N additional entries; M still unattributable`
 * Plus a warning suffix when the deadline skipped sessions.
 *
 * Safe to call repeatedly. Idempotent via `CostTracker.backfillGoalIds`.
 */
export async function backfillLegacyCostGoalIdsFromTranscripts(
	opts: CostBackfillTranscriptOptions,
): Promise<CostBackfillTranscriptResult> {
	const { costTracker, agentSessionsRoot, goals } = opts;
	const logger = opts.logger ?? console;
	const maxLines = opts.maxLines ?? 50;
	const maxBytes = opts.maxBytes ?? 64 * 1024;
	const deadlineMs = opts.deadlineMs ?? 30_000;
	const fsImpl = opts.fs ?? realRecoveryFs;
	const clock = opts.clock ?? { now: Date.now };

	const unmapped = costTracker.getUnstampedSessionIds();
	if (unmapped.length === 0) {
		if (process.env.BOBBIT_DEBUG) logger.log("[cost-backfill] transcript-pass stamped goalId on 0 additional entries; 0 still unattributable");
		return { stamped: 0, unattributable: 0, skipped: 0 };
	}

	const known = new Set<string>();
	for (const g of goals) {
		if (g && typeof g.id === "string" && g.id.length > 0) known.add(g.id);
	}
	if (known.size === 0) {
		if (process.env.BOBBIT_DEBUG) logger.log(`[cost-backfill] transcript-pass stamped goalId on 0 additional entries; ${unmapped.length} still unattributable`);
		return { stamped: 0, unattributable: unmapped.length, skipped: 0 };
	}

	const transcriptGoalIds = new Array<string | undefined>(unmapped.length);
	const start = clock.now();
	let cursor = 0;
	let dispatchClosed = false;
	let skipped = 0;

	const workerCount = Math.min(RECOVERY_IO_CONCURRENCY, unmapped.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			// No await may occur between the deadline check and index claim. This
			// makes closure atomic while allowing already-claimed work to finish.
			if (dispatchClosed || cursor >= unmapped.length) return;
			if (clock.now() - start > deadlineMs) {
				dispatchClosed = true;
				skipped = unmapped.length - cursor;
				return;
			}
			const index = cursor++;
			const sid = unmapped[index]!;

			let transcriptPath: string | undefined;
			try {
				transcriptPath = await findTranscriptPath(agentSessionsRoot, sid, fsImpl);
			} catch {
				transcriptPath = undefined;
			}
			if (!transcriptPath) continue;
			const text = await readTranscriptHead(transcriptPath, maxLines, maxBytes, fsImpl);
			if (!text) continue;
			try {
				transcriptGoalIds[index] = extractTranscriptGoalId(text, known);
			} catch {
				transcriptGoalIds[index] = undefined;
			}
		}
	});
	await Promise.all(workers);

	const transcriptMap = new Map<string, string>();
	for (let i = 0; i < unmapped.length; i++) {
		const goalId = transcriptGoalIds[i];
		if (goalId) transcriptMap.set(unmapped[i]!, goalId);
	}
	const stamped = costTracker.backfillGoalIds((sid) => transcriptMap.get(sid));
	const remaining = costTracker.getUnstampedSessionIds().length;

	const suffix = skipped > 0 ? ` (deadline reached; ${skipped} session(s) skipped)` : "";
	if (stamped > 0 || process.env.BOBBIT_DEBUG)
		logger.log(
			`[cost-backfill] transcript-pass stamped goalId on ${stamped} additional entries; ${remaining} still unattributable${suffix}`,
		);

	return { stamped, unattributable: remaining, skipped };
}

/**
 * Walk `agentSessionsRoot` two levels deep (`<slug>/<file>`) and parse every
 * `*.bobbit.json` sidecar. Returns a map from `bobbitSessionId` to
 * `teamGoalId` (only entries that have a `teamGoalId` are included — a
 * sidecar without a goal mapping is useless for the backfill).
 *
 * Best-effort + defensive: any I/O error or malformed file is silently
 * skipped. A missing root returns an empty map.
 *
 * Exported for tests.
 */
export async function buildSidecarGoalIdIndex(
	agentSessionsRoot: string,
	logger: Pick<Console, "warn"> = console,
	fsImpl: RecoveryFs = realRecoveryFs,
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	try {
		await fsImpl.access(agentSessionsRoot);
	} catch {
		return out;
	}

	let rootEntries: string[];
	try {
		rootEntries = await fsImpl.readdir(agentSessionsRoot);
	} catch (err) {
		logger.warn(`[cost-backfill] Failed to read agent sessions root ${agentSessionsRoot}: ${err}`);
		return out;
	}

	const candidatesBySlug = await mapWithConcurrency(
		rootEntries,
		RECOVERY_IO_CONCURRENCY,
		async (slug): Promise<Array<readonly [string, string]>> => {
			const slugDir = path.join(agentSessionsRoot, slug);
			try {
				const stat = await fsImpl.stat(slugDir);
				if (!stat.isDirectory()) return [];
			} catch {
				return [];
			}

			let names: string[];
			try {
				names = await fsImpl.readdir(slugDir);
			} catch {
				return [];
			}

			const candidates: Array<readonly [string, string]> = [];
			for (const name of names) {
				if (!name.endsWith(".bobbit.json")) continue;
				const stem = name.slice(0, -".bobbit.json".length);
				const syntheticJsonl = path.join(slugDir, `${stem}.jsonl`);
				const sidecar = await readSessionSidecarAsync(syntheticJsonl, fsImpl);
				if (sidecar?.teamGoalId) {
					candidates.push([sidecar.bobbitSessionId, sidecar.teamGoalId]);
				}
			}
			return candidates;
		},
	);

	// Flatten only after every slug settles so duplicate identities remain
	// first-wins in root-entry and file-entry listing order.
	for (const candidates of candidatesBySlug) {
		for (const [sessionId, goalId] of candidates) {
			if (!out.has(sessionId)) out.set(sessionId, goalId);
		}
	}
	return out;
}
