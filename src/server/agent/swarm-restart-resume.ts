/**
 * SWARM-W2 — restart-resume for the hard governor (design/swarm-orchestration.md
 * §11 Wave 2: "restart-resume in `test:manual`"; carried forward explicitly by
 * `docs/design/swarm-orchestration-w1.md`'s "Deliberately NOT built this wave"
 * note: "a hard-killed governor timer does not re-arm on restart (the
 * `SwarmGovernor` instance is in-memory only)").
 *
 * `SwarmGovernor` (swarm-governor.ts) is a per-process, in-memory Map: every
 * `registerNode` call arms a straggler wall-clock timer and enables
 * turn-boundary token-budget enforcement for one swarm-sibling goal. A
 * gateway restart wipes that Map. Anything durable (the goal itself, the
 * `SwarmGroupStore` barrier/artifact record, the per-session cost history
 * `checkTokenBudget` reads from) survives fine — restart-durability of the
 * SPEND counter was already true before this module existed (§6 "restart-durable
 * spend counter" — the cost tracker persists per-session usage, so a re-armed
 * governor immediately sees the correct pre-restart cumulative total on the
 * next `message_end`). The ONLY gap is re-establishing the Map entry (and
 * re-arming the straggler timer against the ORIGINAL deadline, not a fresh
 * `wallClockMs` from the restart moment — a naive re-arm would let every
 * restart buy a straggler a fresh full wall-clock budget, defeating the
 * guarantee that a swarm always converges).
 *
 * This module scans every project's `SwarmGroupStore` at boot and re-registers
 * the governor for any sibling that is still in-flight (expected, but not yet
 * captured in the barrier's artifacts) — nothing more. It never resolves the
 * barrier itself, never mutates goal/session state, and is a pure best-effort
 * sweep: a goal that no longer exists (deleted) or is archived is silently
 * skipped, not treated as an error, since it means SOME other terminal path
 * already ran (or the goal was cleaned up) even though the artifact wasn't
 * captured — outside this module's job to reconcile.
 */
import type { ProjectContextManager } from "./project-context-manager.js";
import type { VerificationHarness } from "./verification-harness.js";

export interface SwarmRestartResumeResult {
	/** Swarm groups scanned that had a live (unfired) barrier + a persisted config to re-arm from. */
	groupsScanned: number;
	/** Sibling goals whose governor node was re-registered. */
	nodesReArmed: number;
}

/**
 * Re-arm the (single, per-process) `SwarmGovernor` for every still-in-flight
 * best-of-N sibling across every project context, using each sibling goal's
 * `createdAt` as the best available proxy for its original `registerNode`
 * time (the two happen back-to-back, synchronously, in
 * `createBestOfNSwarm` — see swarm-best-of-n.ts) so the straggler wall-clock
 * deadline is computed against elapsed REAL time, not reset to a fresh
 * `wallClockMs` on every restart. A sibling that was already past its
 * deadline during the downtime gets straggler-killed almost immediately
 * after boot rather than silently running ungoverned forever.
 *
 * Call once, at boot, after `projectContextManager.initAll()` and the
 * `VerificationHarness` construction have both completed (server.ts wires
 * this right after `verificationHarness` is constructed).
 *
 * SWARM-W3 note (design/swarm-orchestration.md; the scheduler-hook gap this
 * wave closed — see `swarm-orchestration-w3.md`): `createBestOfNSwarm` no
 * longer registers a capacity-blocked sibling with the governor at
 * creation/request time — registration is now deferred to actual team-start
 * via `ChildTeamScheduler`'s `onStart` hook. `goal.createdAt` therefore is
 * NOT necessarily a proxy for "when this sibling's governor node was
 * originally registered" the way it was in W2 — it undercounts elapsed
 * governed time for a sibling that spent real time capacity-blocked before
 * starting. This sweep deliberately keeps using `createdAt` regardless: the
 * ALTERNATIVE in-memory queue state (`ChildTeamScheduler`'s FIFO) does NOT
 * survive a restart either (a separate, pre-existing, non-swarm-specific gap
 * — no boot-time re-drive of `state: 'blocked'` children exists anywhere in
 * the codebase today), so a sibling that was still genuinely capacity-blocked
 * (never actually started) at restart time is otherwise permanently
 * orphaned — no future event will ever start OR terminate it, and the
 * barrier would never converge. Re-arming it here (conservatively, against
 * `createdAt`) trades "may straggler-kill a moment early" for "the swarm
 * always converges" — the same priority ordering the design's §6/§7
 * guarantee already establishes. In the common case (a sibling that got a
 * free permit immediately, i.e. did NOT spend meaningful time queued)
 * `createdAt` is still an accurate proxy, since registration now happens
 * synchronously inside the same `requestChildStart` call `createBestOfNSwarm`
 * makes right after creating the goal.
 */
export function reArmSwarmGovernorsOnBoot(
	projectContextManager: ProjectContextManager,
	harness: VerificationHarness,
	now: () => number = Date.now,
): SwarmRestartResumeResult {
	let groupsScanned = 0;
	let nodesReArmed = 0;

	for (const ctx of projectContextManager.all()) {
		let groups;
		try {
			groups = ctx.swarmGroupStore.getAll();
		} catch (err) {
			console.warn(`[swarm-restart-resume] failed to read swarm groups for project ${ctx.project?.id}: (non-fatal)`, err);
			continue;
		}

		for (const group of groups) {
			// Barrier already fired (or an all-failed escalation already ran) —
			// nothing left to govern for this group.
			if (group.barrierFired) continue;

			// Only groups created via `SwarmGroupStore.createGroup` (SWARM-W1+)
			// carry the per-node budget config `createBestOfNSwarm` persists —
			// legacy/direct `recordArtifact` callers (this store's own unit
			// tests) never had a governor budget to re-arm in the first place.
			const config = group.config as
				| { tokenBudgetPerNode?: number; hardKillMarginMultiplier?: number; wallClockMsPerNode?: number }
				| undefined;
			if (!config || typeof config.tokenBudgetPerNode !== "number" || typeof config.wallClockMsPerNode !== "number") continue;

			groupsScanned++;
			const captured = new Set(group.artifacts.map((a) => a.goalId));
			const expected = group.expectedSiblingIds ?? [];

			for (const goalId of expected) {
				// Already terminal (has a captured artifact) — no re-arm needed;
				// the governor already unregistered it via `notifyChildTerminal`
				// before the restart (or will, once its artifact is captured).
				if (captured.has(goalId)) continue;

				const goal = ctx.goalStore.get(goalId);
				// Gone or archived: some other path already resolved this
				// sibling without going through the swarm artifact-capture seam
				// (or it was cleaned up) — not this sweep's job to reconcile.
				if (!goal || goal.archived) continue;

				const elapsedMs = Math.max(0, now() - goal.createdAt);
				harness.swarmGovernor.registerNode(
					goalId,
					{
						tokenBudget: config.tokenBudgetPerNode,
						hardKillMarginMultiplier: config.hardKillMarginMultiplier,
						wallClockMs: config.wallClockMsPerNode,
					},
					(reason) => {
						harness
							.hardKillSwarmNode(goalId, reason)
							.catch((err) => console.warn(`[swarm-restart-resume] straggler hard-kill failed for ${goalId} (non-fatal):`, err));
					},
					{ elapsedMs },
				);
				nodesReArmed++;
			}
		}
	}

	if (nodesReArmed > 0) {
		console.log(
			`[swarm-restart-resume] re-armed governor for ${nodesReArmed} in-flight swarm sibling(s) across ${groupsScanned} group(s)`,
		);
	}

	return { groupsScanned, nodesReArmed };
}
