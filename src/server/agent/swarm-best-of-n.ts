/**
 * SWARM-W1 — the fixed best-of-N pattern, hand-wired on the existing team
 * machinery (design/swarm-orchestration.md §4 "Best-of-N / fan-out →
 * deterministic-verify", §11 Wave 1). NO synthesizer, NO classifier, NO
 * graph-UI — this module is the one place that fans a prompt out to N
 * same-prompt sibling child goals sharing a `swarmGroup` tag, on top of the
 * SWARM-W0 guardrails (structural recursion cap, suppressed auto-merge,
 * terminal barrier + artifact capture).
 *
 * SWARM-W0 carry-forward fix baked in here: the expected-sibling-id set is
 * persisted via `SwarmGroupStore.createGroup` BEFORE any sibling is started
 * (and therefore before any sibling could possibly reach a terminal state) —
 * never derived from a live scan at capture time.
 *
 * Scheduler invariant (design §7): siblings are only ever `requestChildStart`
 * (permit-acquire-when-runnable) — this module never spawns a separate
 * "join" node that would itself hold a permit. The barrier is the existing
 * event-driven `notifyChildTerminal` → `SwarmGroupStore.recordArtifact`
 * callback chain, which holds ZERO permits while waiting on siblings. When
 * `N > cap`, `ChildTeamScheduler.requestStart` parks the excess siblings
 * capacity-blocked (FIFO queue) and starts them as permits free from
 * terminating siblings — see `tests/swarm-w1-scheduler-deadlock.test.ts`.
 *
 * SWARM-W3 (design/swarm-orchestration.md, the scheduler-hook gap flagged by
 * docs/design/swarm-orchestration-w2.md): the hard governor is armed via
 * `requestChildStart`'s `onStart` hook, which fires exactly when a sibling's
 * team ACTUALLY starts — not at this module's `requestChildStart` call site.
 * For a sibling with a free permit that's effectively the same moment; for a
 * capacity-blocked sibling it is however much later the FIFO queue drains to
 * it. This is deliberate: arming the straggler wall-clock deadline any
 * earlier would start a capacity-blocked sibling's countdown before its team
 * ever runs — see `swarm-orchestration-w3.md` and
 * `tests/swarm-w3-scheduler-hook.test.ts`.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { GoalManager } from "./goal-manager.js";
import type { PersistedGoal } from "./goal-store.js";
import type { ProjectContext } from "./project-context.js";
import type { VerificationHarness } from "./verification-harness.js";
import { resolveChildWorkflow } from "./spawn-child-workflow.js";

/** Per-sibling override — the SAME prompt (`spec`) is shared by every sibling; only role varies. */
export interface BestOfNSiblingSpec {
	/** Optional per-sibling role override — omitted siblings resolve their role the normal way (goal/team defaults). Lets a best-of-N run vary role/model/thinking across candidates per design §4. */
	suggestedRole?: string;
}

export interface BestOfNSwarmOptions {
	parentGoalId: string;
	/** Base title; each sibling gets " (candidate N)" appended. */
	title: string;
	/** The SAME prompt every sibling receives — this is what makes it best-of-N, not orchestrator-worker. */
	spec: string;
	/** One entry per sibling; length is N (>= 2 — a single candidate is `solo`, not a swarm). */
	siblings: BestOfNSiblingSpec[];
	/** Hard per-node token ceiling (design §6 must-fix #1), enforced at the RPC/turn boundary. */
	tokenBudgetPerNode: number;
	/** Hard-kill margin multiplier over tokenBudgetPerNode (default in swarm-governor.ts). */
	hardKillMarginMultiplier?: number;
	/** Straggler wall-clock deadline per node, ms (design §6/§7). */
	wallClockMsPerNode: number;
	/** Deterministic verifier command (test/tool/grep — NEVER an LLM), run in each candidate's worktree once the barrier fires. Stored on the group record for `swarm-verifier.ts` to read later. */
	verifyCommand: string;
	/**
	 * SWARM-W4.1 (design/swarm-orchestration-w4.md §1.3) — opt-in early-kill:
	 * the instant one sibling goes terminal `"done"`, run `verifyCommand`
	 * against JUST that candidate; on a pass, hard-kill every still-running
	 * sibling rather than let them run to completion for nothing. Strictly
	 * dominant over plain best-of-N on cost, identical on pick quality and
	 * wall-clock (§1.3's "no real when-to-choose tradeoff" framing).
	 *
	 * Default `false` — the design doc argues this should eventually become
	 * the unconditional default (no opt-in) once it has real mileage; this
	 * wave keeps it caller-opt-in as the conservative choice, since flipping
	 * the default here would change behavior for every existing best-of-N
	 * caller (including the pinned `api-swarm-best-of-n.spec.ts` /
	 * `api-swarm-restart-resume.spec.ts` flows) with no prior production
	 * signal on the early-kill path itself. See the PR's "Judgment calls".
	 */
	earlyKill?: boolean;
}

export interface BestOfNSwarmResult {
	swarmGroup: string;
	siblingGoalIds: string[];
	/** Sibling ids parked capacity-blocked at creation (root's concurrency cap < N) — they will start as permits free from terminating siblings, per the scheduler invariant. */
	capacityBlocked: string[];
}

export interface BestOfNSwarmDeps {
	getContextForGoal(goalId: string): ProjectContext | undefined;
	getGoalManagerForGoal(goalId: string): GoalManager;
	harness: VerificationHarness;
}

/**
 * Fan a single prompt out to N sibling child goals under `parentGoalId`,
 * tagged with a fresh `swarmGroup`, governed by a hard per-node token/
 * wall-clock budget, and started through the SAME per-root scheduler every
 * other child-spawn path uses.
 */
export async function createBestOfNSwarm(deps: BestOfNSwarmDeps, opts: BestOfNSwarmOptions): Promise<BestOfNSwarmResult> {
	const { parentGoalId, title, spec, siblings, tokenBudgetPerNode, hardKillMarginMultiplier, wallClockMsPerNode, verifyCommand, earlyKill } = opts;
	if (!Array.isArray(siblings) || siblings.length < 2) {
		throw new Error("createBestOfNSwarm requires at least 2 siblings (N>=2) — one candidate is `solo`, not best-of-N");
	}
	const ctx = deps.getContextForGoal(parentGoalId);
	if (!ctx) throw new Error(`createBestOfNSwarm: project context not found for parent goal ${parentGoalId}`);
	const parent = ctx.goalStore.get(parentGoalId);
	if (!parent) throw new Error(`createBestOfNSwarm: parent goal not found: ${parentGoalId}`);
	if (parent.paused) throw new Error(`createBestOfNSwarm: parent goal ${parentGoalId} is paused`);

	const goalManager = deps.getGoalManagerForGoal(parentGoalId);
	const swarmGroup = `swarm-${randomUUID()}`;
	const rootGoalId = parent.rootGoalId ?? parent.id;

	// Children inherit the ROOT REPO path, not the parent's cwd (mirrors
	// nested-goal-routes.ts's spawn-child handler — a parent-worktree cwd
	// would nest child worktrees and collapse the branching topology).
	let childCwd = parent.cwd;
	if (parent.repoPath) {
		const offset = parent.worktreePath ? path.relative(parent.worktreePath, parent.cwd) : "";
		childCwd = (offset && offset !== "." && !offset.startsWith("..")) ? path.join(parent.repoPath, offset) : parent.repoPath;
	}

	let resolvedWorkflowForChild;
	let workflowId: string;
	try {
		const wf = resolveChildWorkflow(parent, undefined, {}, ctx.workflowStore);
		resolvedWorkflowForChild = wf.workflow;
		workflowId = wf.workflowId;
	} catch {
		resolvedWorkflowForChild = undefined;
		workflowId = "feature";
	}

	// Create every sibling FIRST, collecting ids, BEFORE persisting the
	// expected set and BEFORE starting any of them — the SWARM-W0
	// carry-forward fix this module exists to close.
	const created: PersistedGoal[] = [];
	for (let i = 0; i < siblings.length; i++) {
		const child = await goalManager.createGoal(`${title} (candidate ${i + 1})`, childCwd, {
			spec,
			workflowId,
			resolvedWorkflow: resolvedWorkflowForChild,
			projectId: parent.projectId,
			sandboxed: parent.sandboxed,
			parentGoalId,
			swarmGroup,
		});
		if (siblings[i].suggestedRole) {
			await goalManager.updateGoal(child.id, { suggestedRole: siblings[i].suggestedRole });
		}
		created.push(child);
	}
	const siblingGoalIds = created.map(c => c.id);

	// Persist the barrier's expected-sibling set NOW — before any
	// requestChildStart call below lets a sibling reach a terminal state.
	ctx.swarmGroupStore.createGroup(swarmGroup, siblingGoalIds, rootGoalId, {
		parentGoalId,
		tokenBudgetPerNode,
		hardKillMarginMultiplier,
		wallClockMsPerNode,
		verifyCommand,
		earlyKill: earlyKill === true,
	});

	// Route the start through the SAME per-root scheduler every other
	// child-spawn path uses (`requestChildStart`) — never a bespoke start
	// path, and never a "join" entity that would itself hold a permit.
	//
	// SWARM-W3 (design/swarm-orchestration.md; the scheduler-hook gap
	// flagged by docs/design/swarm-orchestration-w2.md): the hard governor is
	// armed via the scheduler's `onStart` hook, which fires exactly when the
	// sibling's team ACTUALLY starts — immediately for a sibling that gets a
	// free permit now, or later once a capacity-blocked sibling is dequeued
	// from the FIFO. Arming eagerly here (before `requestChildStart`, as W1/W2
	// did) started a capacity-blocked sibling's straggler wall-clock deadline
	// at goal-creation time instead of team-start time — under `fanOut > cap`
	// with a long queue, a sibling could be straggler-killed before it ever
	// got to run. Deferring to actual start closes that gap; token-budget
	// enforcement is unaffected (there is no session/turn to check budget
	// against until the team is running anyway).
	const capacityBlocked: string[] = [];
	for (const goalId of siblingGoalIds) {
		const armGovernor = () => {
			deps.harness.swarmGovernor.registerNode(
				goalId,
				{ tokenBudget: tokenBudgetPerNode, hardKillMarginMultiplier, wallClockMs: wallClockMsPerNode },
				(reason) => {
					deps.harness.hardKillSwarmNode(goalId, reason, { killReason: "governor-wallclock" })
						.catch((err) => console.warn(`[swarm-best-of-n] straggler hard-kill failed for ${goalId} (non-fatal):`, err));
				},
			);
		};
		const outcome = deps.harness.requestChildStart(goalId, armGovernor);
		if (outcome === "capacity-blocked") {
			capacityBlocked.push(goalId);
			try {
				await goalManager.updateGoal(goalId, { state: "blocked" });
			} catch (err) {
				console.warn(`[swarm-best-of-n] failed to stamp capacity-blocked state for ${goalId} (non-fatal):`, err);
			}
		}
	}

	return { swarmGroup, siblingGoalIds, capacityBlocked };
}
