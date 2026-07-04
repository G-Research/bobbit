/**
 * SWARM-W0 — restart-durable swarm-group barrier + artifact store.
 *
 * See docs/design/swarm-orchestration-w0.md and
 * design/swarm-orchestration.md §5 (reconciliation primitives #2/#3).
 *
 * One record per `swarmGroup` id, holding a per-sibling artifact captured at
 * the moment each sibling goal reaches a terminal state (done | failed |
 * killed — see `verification-harness.ts` `notifyChildTerminal`). The barrier
 * "fires" (`barrierFired: true`) once every expected sibling in the group has
 * a recorded artifact; `allFailed` is set when the barrier fires and NONE of
 * the artifacts is `done` — per the design's critique-fix, an all-failed
 * group must surface for human escalation, never be silently synthesized or
 * picked over. This wave only records that flag; no reconciler consumes it
 * yet (SWARM-W1+).
 *
 * Follows the same crash-safe atomic-json write discipline as `team-store.ts`
 * (tmp-write → fsync → rename + `.bak.N` rotation) — this store is a NEW,
 * genuinely new artifact (not an existing goal/team field), so it gets its
 * own small JSON file rather than piggy-backing on `GoalStore` (which does
 * not use atomic-json — see docs/design/swarm-orchestration-w0.md for why
 * `swarmGroup` itself, a tag ON the goal record, still inherits GoalStore's
 * existing non-atomic-but-restart-durable persistence instead).
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync, loadJsonWithBackupFallback } from "./atomic-json.js";

/** Terminal statuses a swarm sibling can reach. Barrier-relevant. */
export type SwarmTerminalStatus = "done" | "failed" | "killed";

/** Per-sibling artifact captured at the moment it goes terminal. */
export interface SwarmArtifact {
	/** The sibling child-goal's id. */
	goalId: string;
	/** The sibling's team-lead session id, when known (source of `output`). */
	sessionId?: string;
	/** Distilled output — reuses `SessionManager.getSessionOutput` verbatim. */
	output: string;
	/** The sibling's git branch, when known. */
	branch?: string;
	/** HEAD commit sha of the sibling's branch at capture time, when resolvable. */
	commitSha?: string;
	/** Terminal status that triggered capture. */
	status: SwarmTerminalStatus;
	/** Placeholder — no reconciler/verifier exists yet (SWARM-W1+). */
	verifierScore: null;
	/** Epoch ms when this artifact was captured. */
	capturedAt: number;
}

/** One swarm-group's barrier state + captured sibling artifacts. */
export interface SwarmGroupRecord {
	swarmGroup: string;
	/** Root goal id owning this swarm group, when known. */
	rootGoalId?: string;
	/** One entry per terminal sibling so far (deduped by goalId). */
	artifacts: SwarmArtifact[];
	/** True once every EXPECTED sibling has a recorded artifact. */
	barrierFired: boolean;
	/**
	 * True when the barrier fired and NONE of the artifacts is `done` — must
	 * be surfaced for human escalation (critique fix); never auto-resolved.
	 */
	allFailed: boolean;
	updatedAt: number;
}

export class SwarmGroupStore {
	private readonly storeFile: string;
	private groups: Map<string, SwarmGroupRecord> = new Map();
	private static readonly BACKUP_COUNT = 3;

	constructor(stateDir: string) {
		this.storeFile = path.join(stateDir, "swarm-groups.json");
		this.load();
	}

	private load(): void {
		if (!fs.existsSync(this.storeFile)) return;
		const data = loadJsonWithBackupFallback<SwarmGroupRecord[]>(this.storeFile, {
			backups: SwarmGroupStore.BACKUP_COUNT,
			onBackupUsed: (usedFile) =>
				console.warn(`[swarm-group-store] Loaded from backup ${path.basename(usedFile)} — primary missing/corrupt`),
		});
		if (Array.isArray(data)) {
			for (const g of data) {
				if (g && typeof g.swarmGroup === "string") this.groups.set(g.swarmGroup, g);
			}
		}
	}

	private save(): void {
		try {
			atomicWriteJsonSync(this.storeFile, Array.from(this.groups.values()), { backups: SwarmGroupStore.BACKUP_COUNT });
		} catch (err) {
			console.error("[swarm-group-store] Failed to save:", err);
		}
	}

	get(swarmGroup: string): SwarmGroupRecord | undefined {
		return this.groups.get(swarmGroup);
	}

	getAll(): SwarmGroupRecord[] {
		return Array.from(this.groups.values());
	}

	/**
	 * Record (or update, idempotently by `goalId`) a sibling's terminal
	 * artifact and recompute the barrier. `expectedSiblingIds` is the FULL set
	 * of goal ids that belong to this swarm group at call time (the caller
	 * enumerates via `goalStore` — this store has no goal-graph knowledge of
	 * its own). The barrier fires once every expected id has an artifact.
	 */
	recordArtifact(
		swarmGroup: string,
		artifact: SwarmArtifact,
		expectedSiblingIds: readonly string[],
		rootGoalId?: string,
	): SwarmGroupRecord {
		const existing = this.groups.get(swarmGroup);
		const artifacts = existing ? existing.artifacts.filter(a => a.goalId !== artifact.goalId) : [];
		artifacts.push(artifact);

		const expected = new Set(expectedSiblingIds);
		const captured = new Set(artifacts.map(a => a.goalId));
		const barrierFired = expected.size > 0 && [...expected].every(id => captured.has(id));
		const allFailed = barrierFired && artifacts.every(a => a.status !== "done");

		const record: SwarmGroupRecord = {
			swarmGroup,
			rootGoalId: rootGoalId ?? existing?.rootGoalId,
			artifacts,
			barrierFired,
			allFailed,
			updatedAt: Date.now(),
		};
		this.groups.set(swarmGroup, record);
		this.save();
		return record;
	}
}
