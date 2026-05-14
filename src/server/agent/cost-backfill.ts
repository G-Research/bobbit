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
