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
	/**
	 * SWARM-W4.1: WHY a `"killed"` artifact was killed, when known — purely
	 * informational (never read by any reconciler/barrier logic). Absent for
	 * an operator-initiated archive/kill (today's only other `"killed"`
	 * source) and for every non-`"killed"` status. `"superseded"` is the
	 * early-kill case: a sibling still in flight when another candidate
	 * already verified `passed: true` — see `swarm-verifier.ts` /
	 * `docs/design/swarm-orchestration-w4.md` §1.3. Lets the UI say "killed
	 * (superseded)" instead of implying a budget/timeout failure.
	 */
	killReason?: "governor-budget" | "governor-wallclock" | "superseded";
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
	/**
	 * SWARM-W1 carry-forward fix (SWARM-W0's tracker note: "expected-sibling
	 * set must be persisted at group creation — capture-time scan can fire
	 * the barrier early"). When set, this is the AUTHORITATIVE expected-set,
	 * fixed at `createGroup()` time (before any sibling can go terminal) —
	 * `recordArtifact` ignores its own `expectedSiblingIds` parameter once
	 * this is present, so a barrier can never fire against a set that is
	 * still growing (e.g. a sibling created after another already
	 * terminated, or a sibling reparented/archived mid-run would otherwise
	 * silently shrink a live `goalStore` scan). Absent for groups that never
	 * went through `createGroup` (legacy/test callers) — those fall back to
	 * the first `recordArtifact` call's parameter, exactly as before.
	 */
	expectedSiblingIds?: string[];
	/** SWARM-W1: opaque per-group config (token/wall-clock budgets, verify command) the governor/verifier read. Not interpreted by this store. */
	config?: Record<string, unknown>;
	/**
	 * SWARM-W1: the last deterministic-verifier run over this group, if any.
	 * Persisted (not just held in memory) so a page reload after triggering
	 * `/verify` still shows the pick + scores — the REST layer's
	 * confirmation TOKEN itself is never persisted here (stays in the
	 * in-memory `operator-confirmation.ts` store, one-shot by design); only
	 * the human-readable outcome is durable.
	 */
	lastVerify?: {
		outcome: string;
		winnerGoalId?: string;
		scores: Array<{ goalId: string; passed: boolean; score: number; exitCode: number | null; timedOut: boolean }>;
		verifiedAt: number;
	};
	/** SWARM-W1: set once a human has confirmed a winner and it has been actually integrated (real git merge, bypassing the swarm-suppression). Never set for losers. */
	integratedGoalId?: string;
	integratedAt?: number;
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
	 * SWARM-W1: create a swarm group's record UP FRONT, at fan-out time —
	 * BEFORE any sibling goal can possibly go terminal. Persists
	 * `expectedSiblingIds` as the group's permanent, authoritative expected
	 * set (see the field doc on {@link SwarmGroupRecord}). Idempotent: a
	 * second call for the same `swarmGroup` id is a no-op (returns the
	 * existing record unchanged) rather than resetting a group that may
	 * already have captured artifacts — callers that need to change the
	 * expected set must not reuse an id.
	 */
	createGroup(
		swarmGroup: string,
		expectedSiblingIds: readonly string[],
		rootGoalId?: string,
		config?: Record<string, unknown>,
	): SwarmGroupRecord {
		const existing = this.groups.get(swarmGroup);
		if (existing) return existing;
		const record: SwarmGroupRecord = {
			swarmGroup,
			rootGoalId,
			artifacts: [],
			barrierFired: false,
			allFailed: false,
			updatedAt: Date.now(),
			expectedSiblingIds: [...expectedSiblingIds],
			config,
		};
		this.groups.set(swarmGroup, record);
		this.save();
		return record;
	}

	/**
	 * Record (or update, idempotently by `goalId`) a sibling's terminal
	 * artifact and recompute the barrier. `expectedSiblingIds` is used ONLY
	 * as a fallback for a group that was never `createGroup`-ed (legacy /
	 * direct-`recordArtifact` callers, incl. this file's own unit tests): a
	 * group with a persisted `expectedSiblingIds` (set by `createGroup`)
	 * ALWAYS wins over whatever the caller passes here — see the SWARM-W1
	 * carry-forward fix note on {@link SwarmGroupRecord.expectedSiblingIds}.
	 * The barrier fires once every expected id has an artifact.
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

		// Authoritative expected set: the persisted one (from createGroup),
		// falling back to the caller-supplied scan only when no group record
		// (or no persisted expected set on one) exists yet.
		const authoritativeExpected = existing?.expectedSiblingIds ?? expectedSiblingIds;
		const expected = new Set(authoritativeExpected);
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
			expectedSiblingIds: existing?.expectedSiblingIds,
			config: existing?.config,
			lastVerify: existing?.lastVerify,
			integratedGoalId: existing?.integratedGoalId,
			integratedAt: existing?.integratedAt,
		};
		this.groups.set(swarmGroup, record);
		this.save();
		return record;
	}

	/** SWARM-W1: persist a deterministic-verifier run's outcome so it survives reload. No-op (returns undefined) if the group doesn't exist. */
	recordVerifyResult(swarmGroup: string, result: NonNullable<SwarmGroupRecord["lastVerify"]>): SwarmGroupRecord | undefined {
		const existing = this.groups.get(swarmGroup);
		if (!existing) return undefined;
		const record: SwarmGroupRecord = { ...existing, lastVerify: result, updatedAt: Date.now() };
		this.groups.set(swarmGroup, record);
		this.save();
		return record;
	}

	/** SWARM-W1: mark a group's winner as integrated (real merge performed, human-confirmed). No-op (returns undefined) if the group doesn't exist. */
	recordIntegration(swarmGroup: string, winnerGoalId: string): SwarmGroupRecord | undefined {
		const existing = this.groups.get(swarmGroup);
		if (!existing) return undefined;
		const record: SwarmGroupRecord = { ...existing, integratedGoalId: winnerGoalId, integratedAt: Date.now(), updatedAt: Date.now() };
		this.groups.set(swarmGroup, record);
		this.save();
		return record;
	}
}
