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

import fs from "node:fs";
import path from "node:path";
import { readSessionSidecar, sidecarPathFor } from "./session-sidecar.js";
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
export function backfillLegacyCostGoalIds(opts: CostBackfillOptions): CostBackfillResult {
	const { costTracker, sessionManager, agentSessionsRoot } = opts;
	const logger = opts.logger ?? console;

	const unstamped = costTracker.getUnstampedSessionIds();
	if (unstamped.length === 0) {
		logger.log("[cost-backfill] stamped goalId on 0 entries; 0 still unattributable");
		return { stamped: 0, unattributable: 0 };
	}

	// Lazy-build the sidecar index only when we actually need it — scanning
	// `~/.bobbit/agent/sessions` recursively is comparatively expensive and
	// most installs have all live records intact.
	let sidecarIndex: Map<string, string> | null = null;
	const ensureSidecarIndex = (): Map<string, string> => {
		if (sidecarIndex) return sidecarIndex;
		sidecarIndex = buildSidecarGoalIdIndex(agentSessionsRoot, logger);
		return sidecarIndex;
	};

	const resolver = (sessionId: string): string | undefined => {
		// Path 1: live persisted record.
		const ps = sessionManager.getPersistedSession(sessionId);
		if (ps) {
			if (ps.teamGoalId) return ps.teamGoalId;
			if (ps.goalId) return ps.goalId;
			// Persisted record exists but has no goal mapping — try the
			// sidecar next to its .jsonl before giving up (the record may
			// have lost the field while the sidecar still has it).
			if (ps.agentSessionFile) {
				try {
					const sidecar = readSessionSidecar(ps.agentSessionFile);
					if (sidecar?.teamGoalId) return sidecar.teamGoalId;
				} catch {
					// fall through to index scan
				}
			}
		}

		// Path 2: scan-all sidecar index by bobbitSessionId.
		const idx = ensureSidecarIndex();
		const fromIndex = idx.get(sessionId);
		if (fromIndex) return fromIndex;

		return undefined;
	};

	const stamped = costTracker.backfillGoalIds(resolver);
	const remaining = costTracker.getUnstampedSessionIds().length;

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

/** Read up to `maxLines` lines or `maxBytes` bytes from a file. Defensive:
 *  any I/O error returns `""`. Truncated trailing lines are still returned. */
function readTranscriptHead(
	filePath: string,
	maxLines: number,
	maxBytes: number,
): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buf = Buffer.alloc(maxBytes);
		const n = fs.readSync(fd, buf, 0, maxBytes, 0);
		const text = buf.subarray(0, n).toString("utf8");
		const lines = text.split("\n");
		return lines.slice(0, maxLines).join("\n");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}
}

/**
 * Locate `<sessionsRoot>/<slug>/<sessionId>.jsonl` by scanning slug dirs
 * one level deep. Returns the first match or `undefined`. Defensive — any
 * I/O error is swallowed.
 */
function findTranscriptPath(
	agentSessionsRoot: string,
	sessionId: string,
): string | undefined {
	let entries: string[];
	try {
		if (!fs.existsSync(agentSessionsRoot)) return undefined;
		entries = fs.readdirSync(agentSessionsRoot);
	} catch {
		return undefined;
	}
	const target = `${sessionId}.jsonl`;
	for (const slug of entries) {
		const slugDir = path.join(agentSessionsRoot, slug);
		try {
			const stat = fs.statSync(slugDir);
			if (!stat.isDirectory()) continue;
		} catch { continue; }
		const candidate = path.join(slugDir, target);
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch { /* ignore */ }
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

	const unmapped = costTracker.getUnstampedSessionIds();
	if (unmapped.length === 0) {
		logger.log("[cost-backfill] transcript-pass stamped goalId on 0 additional entries; 0 still unattributable");
		return { stamped: 0, unattributable: 0, skipped: 0 };
	}

	const known = new Set<string>();
	for (const g of goals) {
		if (g && typeof g.id === "string" && g.id.length > 0) known.add(g.id);
	}
	if (known.size === 0) {
		logger.log(`[cost-backfill] transcript-pass stamped goalId on 0 additional entries; ${unmapped.length} still unattributable`);
		return { stamped: 0, unattributable: unmapped.length, skipped: 0 };
	}

	const transcriptMap = new Map<string, string>();
	const start = Date.now();
	let skipped = 0;

	for (let i = 0; i < unmapped.length; i++) {
		const sid = unmapped[i]!;
		if (Date.now() - start > deadlineMs) {
			skipped = unmapped.length - i;
			break;
		}
		let transcriptPath: string | undefined;
		try {
			transcriptPath = findTranscriptPath(agentSessionsRoot, sid);
		} catch {
			transcriptPath = undefined;
		}
		if (!transcriptPath) continue;
		const text = readTranscriptHead(transcriptPath, maxLines, maxBytes);
		if (!text) continue;
		let goalId: string | undefined;
		try {
			goalId = extractTranscriptGoalId(text, known);
		} catch {
			goalId = undefined;
		}
		if (goalId) transcriptMap.set(sid, goalId);
	}

	const stamped = costTracker.backfillGoalIds((sid) => transcriptMap.get(sid));
	const remaining = costTracker.getUnstampedSessionIds().length;

	const suffix = skipped > 0 ? ` (deadline reached; ${skipped} session(s) skipped)` : "";
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
export function buildSidecarGoalIdIndex(
	agentSessionsRoot: string,
	logger: Pick<Console, "warn"> = console,
): Map<string, string> {
	const out = new Map<string, string>();
	let rootEntries: string[];
	try {
		if (!fs.existsSync(agentSessionsRoot)) return out;
		rootEntries = fs.readdirSync(agentSessionsRoot);
	} catch (err) {
		logger.warn(`[cost-backfill] Failed to read agent sessions root ${agentSessionsRoot}: ${err}`);
		return out;
	}
	for (const slug of rootEntries) {
		const slugDir = path.join(agentSessionsRoot, slug);
		let stat: fs.Stats;
		try { stat = fs.statSync(slugDir); } catch { continue; }
		if (!stat.isDirectory()) continue;
		let names: string[];
		try { names = fs.readdirSync(slugDir); } catch { continue; }
		for (const name of names) {
			if (!name.endsWith(".bobbit.json")) continue;
			const full = path.join(slugDir, name);
			// readSessionSidecar takes the JSONL path, not the sidecar path —
			// derive a synthetic JSONL path so `sidecarPathFor` produces this
			// exact file.
			const stem = name.slice(0, -".bobbit.json".length);
			const syntheticJsonl = path.join(slugDir, `${stem}.jsonl`);
			// Sanity check — sidecarPathFor(syntheticJsonl) should equal `full`.
			if (sidecarPathFor(syntheticJsonl) !== full) continue;
			let sidecar;
			try {
				sidecar = readSessionSidecar(syntheticJsonl);
			} catch {
				continue;
			}
			if (!sidecar) continue;
			if (!sidecar.teamGoalId) continue;
			// First-wins: if the same bobbitSessionId somehow appears twice
			// across slug dirs (shouldn't, but defensive), keep the first.
			if (!out.has(sidecar.bobbitSessionId)) {
				out.set(sidecar.bobbitSessionId, sidecar.teamGoalId);
			}
		}
	}
	return out;
}
