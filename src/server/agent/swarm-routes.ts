/**
 * SWARM-W1 REST surface — fixed best-of-N pattern. SWARM-W4.5 adds the
 * plan-fan-in surface alongside it (same file, same auth/human-gate
 * discipline, distinct routes — see that section below).
 *
 * design/swarm-orchestration.md §4/§5/§9. Goal-scoped (`/api/goals/:id/...`)
 * to reuse the existing per-goal project-context resolution rather than
 * building a new cross-project swarm-group index — mirrors
 * `nested-goal-routes.ts`'s convention.
 *
 *   POST /api/goals/:id/swarm/best-of-n           — fan out N siblings (id = parent)
 *   GET  /api/goals/:id/swarm-groups/:swarmGroup   — status (id = any goal in the tree)
 *   POST /api/goals/:id/swarm-groups/:swarmGroup/verify   — run the deterministic verifier
 *   POST /api/goals/:id/swarm-groups/:swarmGroup/confirm  — human-gated integrate
 *
 * Human-gate (design §9 "Human-gate every non-solo plan"): `/verify` mints an
 * operator-confirmation token ONLY when the caller is a verified human/UI
 * session (`authorizeChildrenMutation`'s `"human-cookie"` reason) — an
 * agent-triggered verify (team-lead credential) gets the scores back but no
 * token, so it structurally cannot self-confirm its own pick. `/confirm`
 * requires BOTH a human caller AND that exact token, one-shot, bound to
 * `{swarmGroup, winnerGoalId}` (`stableConfirmationBinding` /
 * `consumeOperatorConfirmation` — the SAME primitive the Claude Code
 * host-preferences confirmation flow uses, reused rather than reinvented).
 *
 * ── SWARM-W4.5 — plan-fan-in (design/swarm-orchestration-w4.md §1.1) ───────
 *
 *   POST /api/goals/:id/swarm/plan-fan-in                         — fan out N planning-only siblings
 *   POST /api/goals/:id/swarm-groups/:swarmGroup/plan-verify       — mint the pre-build gate token, once synthesis is done
 *   POST /api/goals/:id/swarm-groups/:swarmGroup/plan-confirm      — consume the token, spawn the ONE ordinary build child
 *   POST /api/goals/:id/swarm-groups/:swarmGroup/plan-reject       — consume the token, archive the group (orchestrator ruling #1 — no auto-retry)
 *
 * The plan-phase fan-out itself reuses `createBestOfNSwarm` verbatim (via
 * `swarm-plan-fan-in.ts`) — same barrier/governor/restart-durability. Once
 * the barrier fires, `VerificationHarness._maybeTriggerPlanSynthesis` spawns
 * ONE synthesis role and records `SwarmGroupRecord.synthesis`; a human then
 * polls/`/plan-verify`s to mint a ONE-SHOT `swarm-plan-fan-in-build-start`
 * token bound to `{swarmGroup, planHash}` (mirroring `/verify`'s
 * human-cookie-only mint discipline exactly), and either `/plan-confirm`s
 * (consumes the token, spawns the single build child — an ORDINARY,
 * non-swarm-tagged nested goal, so its eventual merge goes through the
 * existing, completely unmodified nested-goal `mergeChild` path, never
 * `forceIntegrateSwarmWinner`) or `/plan-reject`s (consumes the SAME token,
 * archives the N plan siblings — soft-deleted, branches preserved, never
 * auto-retried). The plain best-of-n `/verify` and `/confirm` routes below
 * explicitly refuse to operate on a `topology: "plan-fan-in"` group (a plan
 * sibling must never be `mergeChild`-integrated as if it were a winning
 * build) — that guard is the ONLY change to those two routes' bodies; their
 * mint/consume logic itself is untouched.
 */
import type http from "node:http";
import path from "node:path";
import type { PersistedGoal } from "./goal-store.js";
import type { GoalManager } from "./goal-manager.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { TeamManager } from "./team-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { VerificationHarness } from "./verification-harness.js";
import { authorizeChildrenMutation } from "../auth/children-mutation-authz.js";
import { tryAuth as cookieTryAuth, type CookieStore } from "../auth/cookie.js";
import { mintOperatorConfirmation, consumeOperatorConfirmation, stableConfirmationBinding } from "../auth/operator-confirmation.js";
import { createBestOfNSwarm, type BestOfNSiblingSpec } from "./swarm-best-of-n.js";
import { createPlanFanInSwarm } from "./swarm-plan-fan-in.js";
import { createOrchestratorWorkerSwarm } from "./swarm-orchestrator-worker.js";
import { resolveChildWorkflow } from "./spawn-child-workflow.js";
import { verifyBestOfNGroup } from "./swarm-verifier.js";
import { SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND, type SwarmTopologyChoice, type SwarmTopologyArg } from "./swarm-topology-classifier.js";

const SWARM_PICK_CONFIRMATION_PURPOSE = "swarm-best-of-n-pick";
/** SWARM-W4.5 — orchestrator ruling: exact purpose string for the plan-fan-in pre-build gate. */
const PLAN_FAN_IN_BUILD_START_PURPOSE = "swarm-plan-fan-in-build-start";

export interface SwarmRouteDeps {
	projectContextManager: ProjectContextManager;
	verificationHarness: VerificationHarness;
	teamManager: TeamManager;
	sessionManager: SessionManager;
	cookieStore: CookieStore;
	getGoalAcrossProjects(goalId: string): PersistedGoal | undefined;
	getGoalManagerForGoal(goalId: string): GoalManager;
	readBody(req: http.IncomingMessage): Promise<any>;
	json(body: unknown, status?: number): void;
	jsonError(status: number, err: unknown, extra?: Record<string, unknown>): void;
	broadcastToAll(event: any): void;
}

function resolveCandidateCwd(goal: PersistedGoal | undefined): string | undefined {
	if (!goal) return undefined;
	return goal.repoWorktrees?.["."] ?? goal.worktreePath;
}

export async function tryHandleSwarmRoute(req: http.IncomingMessage, url: URL, deps: SwarmRouteDeps): Promise<boolean> {
	const { json, jsonError, readBody, getGoalAcrossProjects, getGoalManagerForGoal, projectContextManager, verificationHarness, teamManager, cookieStore, broadcastToAll } = deps;

	function authorize(goalId: string, mutationClass: "orchestration" | "operator"): { ok: boolean; humanConfirmed: boolean } {
		const result = authorizeChildrenMutation({
			mutationClass,
			isHumanOperator: cookieTryAuth(req, cookieStore),
			authenticCallerSessionId: deps.sessionManager.sessionSecretStore.resolveSessionIdBySecret(
				firstHeader(req, "x-bobbit-session-secret"),
			),
			teamLeadSessionId: teamManager.getTeamState(goalId)?.teamLeadSessionId,
		});
		if (!result.ok) {
			json({ error: "Caller session is not authorized for this goal", code: "NOT_TEAM_LEAD" }, 403);
			return { ok: false, humanConfirmed: false };
		}
		return { ok: true, humanConfirmed: result.reason === "human-cookie" };
	}

	// POST /api/goals/:id/swarm/best-of-n
	const createMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/best-of-n$/);
	if (createMatch && req.method === "POST") {
		const parentId = createMatch[1];
		const parent = getGoalAcrossProjects(parentId);
		if (!parent) { json({ error: "Parent goal not found" }, 404); return true; }
		if (!authorize(parentId, "orchestration").ok) return true;
		const body = await readBody(req).catch(() => null);
		if (!body) { json({ error: "Missing body" }, 400); return true; }
		const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : parent.title;
		const spec = typeof body.spec === "string" ? body.spec : "";
		if (!spec) { json({ error: "spec is required" }, 400); return true; }
		const rawSiblings = Array.isArray(body.siblings) ? body.siblings : undefined;
		const n = typeof body.n === "number" ? Math.floor(body.n) : rawSiblings?.length;
		if (!n || n < 2 || n > 8) {
			json({ error: "n (or siblings.length) must be between 2 and 8", code: "INVALID_FAN_OUT" }, 400);
			return true;
		}
		const siblings: BestOfNSiblingSpec[] = Array.from({ length: n }, (_, i) => {
			const raw = rawSiblings?.[i];
			const suggestedRole = raw && typeof raw === "object" && typeof raw.suggestedRole === "string" ? raw.suggestedRole : undefined;
			return { suggestedRole };
		});
		const tokenBudgetPerNode = typeof body.tokenBudgetPerNode === "number" && body.tokenBudgetPerNode > 0 ? body.tokenBudgetPerNode : 200_000;
		const wallClockMsPerNode = typeof body.wallClockMsPerNode === "number" && body.wallClockMsPerNode > 0 ? body.wallClockMsPerNode : 30 * 60_000;
		const hardKillMarginMultiplier = typeof body.hardKillMarginMultiplier === "number" && body.hardKillMarginMultiplier > 1 ? body.hardKillMarginMultiplier : undefined;
		const verifyCommand = typeof body.verifyCommand === "string" ? body.verifyCommand : "";
		if (!verifyCommand) { json({ error: "verifyCommand is required — best-of-N MUST have a deterministic verifier, never an LLM grading its own output", code: "VERIFY_COMMAND_REQUIRED" }, 400); return true; }
		// SWARM-W4.1: opt-in early-kill (design/swarm-orchestration-w4.md §1.3)
		// — defaults false, byte-identical to pre-W4.1 behavior when omitted.
		const earlyKill = body.earlyKill === true;
		// SWARM-W4.3 — goal-create swarm-topology classifier consult (see
		// swarm-topology-classifier.ts's header + design/swarm-orchestration-w4.md
		// §3.3 step 2). `server.ts` registers the built-in observe-only rule
		// table, recorded via `dispatchDecision`'s own trace/transparency-panel
		// wiring. The topology created below is UNCONDITIONALLY the
		// caller-supplied best-of-N shape regardless of this decision's outcome
		// — nothing here reads or branches on it.
		await consultSwarmTopologyHub(deps, req, { goalId: parentId, spec, hasVerifyCommand: true, requestedFanOut: n }, resolveCandidateCwd(parent));
		try {
			const result = await createBestOfNSwarm(
				{
					getContextForGoal: (gid) => projectContextManager.getContextForGoal(gid) ?? undefined,
					getGoalManagerForGoal,
					harness: verificationHarness,
				},
				{ parentGoalId: parentId, title, spec, siblings, tokenBudgetPerNode, wallClockMsPerNode, hardKillMarginMultiplier, verifyCommand, earlyKill },
			);
			broadcastToAll({ type: "goal_created", goalId: parentId, swarmGroup: result.swarmGroup });
			json({ ...result }, 201);
		} catch (err) {
			jsonError(500, err);
		}
		return true;
	}

	// POST /api/goals/:id/swarm/plan-fan-in — SWARM-W4.5 (design/swarm-orchestration-w4.md §1.1).
	const planFanInCreateMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/plan-fan-in$/);
	if (planFanInCreateMatch && req.method === "POST") {
		const parentId = planFanInCreateMatch[1];
		const parent = getGoalAcrossProjects(parentId);
		if (!parent) { json({ error: "Parent goal not found" }, 404); return true; }
		if (!authorize(parentId, "orchestration").ok) return true;
		// Fail fast: the synthesis step (triggered once the plan-phase barrier
		// fires) needs `TeamManager.spawnRole(parentId, ...)`, which requires
		// an ACTIVE team for `parentId` — cheaper to reject here than to spend
		// N plan-phase fan-out budgets only to have synthesis fail afterward.
		if (!teamManager.getTeamState(parentId)) {
			json({ error: "Parent goal has no active team — plan-fan-in's synthesis step spawns a role into the parent's own team, so the parent's team must already be started", code: "PARENT_TEAM_NOT_ACTIVE" }, 409);
			return true;
		}
		const body = await readBody(req).catch(() => null);
		if (!body) { json({ error: "Missing body" }, 400); return true; }
		const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : parent.title;
		const spec = typeof body.spec === "string" ? body.spec : "";
		if (!spec) { json({ error: "spec is required" }, 400); return true; }
		const fanOut = typeof body.fanOut === "number" ? Math.floor(body.fanOut) : (typeof body.n === "number" ? Math.floor(body.n) : undefined);
		if (!fanOut || fanOut < 2 || fanOut > 8) {
			json({ error: "fanOut (or n) must be between 2 and 8", code: "INVALID_FAN_OUT" }, 400);
			return true;
		}
		const tokenBudgetPerNode = typeof body.tokenBudgetPerNode === "number" && body.tokenBudgetPerNode > 0 ? body.tokenBudgetPerNode : undefined;
		const wallClockMsPerNode = typeof body.wallClockMsPerNode === "number" && body.wallClockMsPerNode > 0 ? body.wallClockMsPerNode : undefined;
		const hardKillMarginMultiplier = typeof body.hardKillMarginMultiplier === "number" && body.hardKillMarginMultiplier > 1 ? body.hardKillMarginMultiplier : undefined;
		// SWARM-W4.2 consult — see the matching comment on the best-of-n route
		// above; identical discipline, `hasVerifyCommand: false` since
		// plan-fan-in groups never carry a real verifier.
		await consultSwarmTopologyHub(deps, req, { goalId: parentId, spec, hasVerifyCommand: false, requestedFanOut: fanOut }, resolveCandidateCwd(parent));
		try {
			const result = await createPlanFanInSwarm(
				{
					getContextForGoal: (gid) => projectContextManager.getContextForGoal(gid) ?? undefined,
					getGoalManagerForGoal,
					harness: verificationHarness,
				},
				{ parentGoalId: parentId, title, spec, fanOut, tokenBudgetPerNode, wallClockMsPerNode, hardKillMarginMultiplier },
			);
			broadcastToAll({ type: "goal_created", goalId: parentId, swarmGroup: result.swarmGroup });
			json({ ...result }, 201);
		} catch (err) {
			jsonError(500, err);
		}
		return true;
	}

	// POST /api/goals/:id/swarm/orchestrator-worker — SWARM-W4.6 merge-all.
	const orchestratorWorkerCreateMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/orchestrator-worker$/);
	if (orchestratorWorkerCreateMatch && req.method === "POST") {
		const parentId = orchestratorWorkerCreateMatch[1];
		const parent = getGoalAcrossProjects(parentId);
		if (!parent) { json({ error: "Parent goal not found" }, 404); return true; }
		if (!authorize(parentId, "orchestration").ok) return true;
		if (!teamManager.getTeamState(parentId)) {
			json({ error: "Parent goal has no active team — orchestrator-worker's decompose and synthesis steps spawn roles into the parent's own team", code: "PARENT_TEAM_NOT_ACTIVE" }, 409);
			return true;
		}
		const body = await readBody(req).catch(() => null);
		if (!body) { json({ error: "Missing body" }, 400); return true; }
		const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : parent.title;
		const spec = typeof body.spec === "string" ? body.spec : "";
		if (!spec) { json({ error: "spec is required" }, 400); return true; }
		const tokenBudgetPerNode = typeof body.tokenBudgetPerNode === "number" && body.tokenBudgetPerNode > 0 ? body.tokenBudgetPerNode : undefined;
		const wallClockMsPerNode = typeof body.wallClockMsPerNode === "number" && body.wallClockMsPerNode > 0 ? body.wallClockMsPerNode : undefined;
		const hardKillMarginMultiplier = typeof body.hardKillMarginMultiplier === "number" && body.hardKillMarginMultiplier > 1 ? body.hardKillMarginMultiplier : undefined;
		await consultSwarmTopologyHub(deps, req, { goalId: parentId, spec, hasVerifyCommand: false, requestedFanOut: undefined }, resolveCandidateCwd(parent));
		try {
			const result = await createOrchestratorWorkerSwarm(
				{
					getContextForGoal: (gid) => projectContextManager.getContextForGoal(gid) ?? undefined,
					getGoalManagerForGoal,
					harness: verificationHarness,
					teamManager,
					sessionManager: deps.sessionManager,
				},
				{ parentGoalId: parentId, title, spec, tokenBudgetPerNode, wallClockMsPerNode, hardKillMarginMultiplier },
			);
			broadcastToAll({ type: "goal_created", goalId: parentId, swarmGroup: result.swarmGroup });
			json({ ...result }, 201);
		} catch (err) {
			jsonError(500, err);
		}
		return true;
	}

	// GET/POST /api/goals/:id/swarm-groups/:swarmGroup(/verify|/confirm|/plan-verify|/plan-confirm|/plan-reject)?
	const groupMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm-groups\/([^/]+)(\/verify|\/confirm|\/plan-verify|\/plan-confirm|\/plan-reject)?$/);
	if (groupMatch) {
		const anchorGoalId = groupMatch[1];
		const swarmGroup = groupMatch[2];
		const suffix = groupMatch[3];
		const anchor = getGoalAcrossProjects(anchorGoalId);
		if (!anchor) { json({ error: "Goal not found" }, 404); return true; }
		const ctx = projectContextManager.getContextForGoal(anchorGoalId);
		if (!ctx) { json({ error: "Project context not found" }, 404); return true; }
		const group = ctx.swarmGroupStore.get(swarmGroup);
		if (!group) { json({ error: "Swarm group not found" }, 404); return true; }

		if (!suffix && req.method === "GET") {
			const expected = group.expectedSiblingIds ?? [];
			json({
				swarmGroup: group.swarmGroup,
				rootGoalId: group.rootGoalId,
				expectedCount: expected.length,
				capturedCount: group.artifacts.length,
				barrierFired: group.barrierFired,
				allFailed: group.allFailed,
				artifacts: group.artifacts.map(a => ({ goalId: a.goalId, status: a.status, branch: a.branch, commitSha: a.commitSha, capturedAt: a.capturedAt })),
				lastVerify: group.lastVerify,
				integratedGoalId: group.integratedGoalId,
				integratedAt: group.integratedAt,
				reconcileMode: group.reconcileMode,
				config: group.config,
				updatedAt: group.updatedAt,
				// SWARM-W4.5/W4.6 — present only for topologies with a reduce
				// role (`plan-fan-in` and `orchestrator-worker`); undefined for
				// best-of-n groups.
				synthesis: group.synthesis,
				buildGoalId: group.buildGoalId,
				planRejectedAt: group.planRejectedAt,
			});
			return true;
		}

		// Non-best-of-N topologies do not have a winner candidate for the
		// `/verify` → `/confirm` best-of-N route pair. Plan-fan-in has its own
		// pre-build gate routes; orchestrator-worker workers merge via ordinary
		// mergeChild calls under reconcileMode:"merge-all".
		const topology = (group.config as { topology?: string } | undefined)?.topology;
		const isPlanFanIn = topology === "plan-fan-in";
		const isOrchestratorWorker = topology === "orchestrator-worker";
		if ((isPlanFanIn || isOrchestratorWorker) && (suffix === "/verify" || suffix === "/confirm")) {
			json({
				error: isPlanFanIn
					? "This is a plan-fan-in group — use /plan-verify, /plan-confirm, or /plan-reject instead"
					: "This is an orchestrator-worker merge-all group — workers merge through ordinary mergeChild and there is no best-of-N winner to confirm",
				code: "WRONG_TOPOLOGY",
			}, 400);
			return true;
		}

		if (suffix === "/verify" && req.method === "POST") {
			const parentGoalId = (group.config as { parentGoalId?: string } | undefined)?.parentGoalId ?? anchorGoalId;
			const auth = authorize(parentGoalId, "operator");
			if (!auth.ok) return true;
			if (!group.barrierFired) {
				json({ outcome: "not-ready", scores: [] }, 409);
				return true;
			}
			const verifyCommand = (group.config as { verifyCommand?: string } | undefined)?.verifyCommand;
			if (!verifyCommand) { json({ error: "Swarm group has no verifyCommand configured" }, 500); return true; }
			const result = await verifyBestOfNGroup(
				group,
				(goalId) => resolveCandidateCwd(ctx.goalStore.get(goalId)),
				verifyCommand,
			);
			ctx.swarmGroupStore.recordVerifyResult(swarmGroup, {
				outcome: result.outcome,
				winnerGoalId: result.winnerGoalId,
				scores: result.scores.map(s => ({ goalId: s.goalId, passed: s.passed, score: s.score, exitCode: s.exitCode, timedOut: s.timedOut })),
				verifiedAt: Date.now(),
			});
			broadcastToAll({ type: "goal_state_changed", goalId: parentGoalId, swarmGroup });
			// Human-gate: mint a one-shot confirmation ONLY for a verified
			// human/UI caller, and ONLY when there's an actual pick to confirm.
			let confirmation: { token: string; expiresAt: number } | undefined;
			if (auth.humanConfirmed && result.outcome === "picked" && result.winnerGoalId) {
				confirmation = mintOperatorConfirmation({
					purpose: SWARM_PICK_CONFIRMATION_PURPOSE,
					binding: stableConfirmationBinding({ swarmGroup, winnerGoalId: result.winnerGoalId }),
				});
			}
			json({ outcome: result.outcome, winnerGoalId: result.winnerGoalId, scores: result.scores, ...(confirmation ? { confirmationToken: confirmation.token, confirmationExpiresAt: confirmation.expiresAt } : {}) });
			return true;
		}

		if (suffix === "/confirm" && req.method === "POST") {
			const parentGoalId = (group.config as { parentGoalId?: string } | undefined)?.parentGoalId ?? anchorGoalId;
			const auth = authorize(parentGoalId, "operator");
			if (!auth.ok) return true;
			if (!auth.humanConfirmed) {
				json({ error: "Integrating a swarm pick requires a verified human/UI session", code: "HUMAN_CONFIRMATION_REQUIRED" }, 403);
				return true;
			}
			if (group.integratedGoalId) {
				json({ error: `Group already integrated (${group.integratedGoalId})`, code: "ALREADY_INTEGRATED", integratedGoalId: group.integratedGoalId }, 409);
				return true;
			}
			const body = await readBody(req).catch(() => null);
			const winnerGoalId = typeof body?.winnerGoalId === "string" ? body.winnerGoalId : (group.lastVerify?.winnerGoalId);
			const token = typeof body?.confirmationToken === "string" ? body.confirmationToken : firstHeader(req, "x-bobbit-operator-confirmation");
			if (!winnerGoalId) { json({ error: "winnerGoalId is required (or run /verify first)" }, 400); return true; }
			const consumed = consumeOperatorConfirmation(token, {
				purpose: SWARM_PICK_CONFIRMATION_PURPOSE,
				binding: stableConfirmationBinding({ swarmGroup, winnerGoalId }),
			});
			if (!consumed) {
				json({ error: "Missing or invalid confirmation token for this exact pick — re-run /verify to mint a fresh one", code: "CONFIRMATION_REQUIRED" }, 403);
				return true;
			}
			const winner = ctx.goalStore.get(winnerGoalId);
			if (!winner || winner.parentGoalId !== parentGoalId) {
				json({ error: "winnerGoalId is not a sibling of this swarm group's parent", code: "PARENT_MISMATCH" }, 400);
				return true;
			}
			const goalManager = getGoalManagerForGoal(parentGoalId);
			try {
				const outcome = await goalManager.mergeChild(parentGoalId, winnerGoalId, { forceIntegrateSwarmWinner: true });
				if (!outcome.merged && !outcome.alreadyMerged) {
					json({ error: "Integration merge did not succeed", outcome }, 409);
					return true;
				}
				try {
					// A winner whose team already tore down (terminal integrate/archive
					// path) has no active team — mirror the losers' guard below.
					if (teamManager.getTeamState(winnerGoalId)) await teamManager.teardownTeam(winnerGoalId);
				} catch (err) { console.warn(`[swarm-routes] confirm: teardownTeam failed for winner ${winnerGoalId} (non-fatal):`, err); }
				await goalManager.archiveGoalAfterMerge(winnerGoalId);
				ctx.swarmGroupStore.recordIntegration(swarmGroup, winnerGoalId);
				// Losing siblings: archive (soft-delete) WITHOUT merging — their
				// branch is preserved (not pushed/merged), per design §5.3 "a
				// swarm sibling's branch is a merge CANDIDATE". Best-effort per
				// loser so one failure doesn't block reporting the others.
				const losers = (group.expectedSiblingIds ?? []).filter(id => id !== winnerGoalId);
				for (const loserId of losers) {
					try {
						if (teamManager.getTeamState(loserId)) await teamManager.teardownTeam(loserId);
						await goalManager.archiveGoal(loserId);
					} catch (err) {
						console.warn(`[swarm-routes] confirm: failed to archive losing sibling ${loserId} (non-fatal):`, err);
					}
				}
				broadcastToAll({ type: "goal_state_changed", goalId: parentGoalId, swarmGroup });
				broadcastToAll({ type: "goal_state_changed", goalId: winnerGoalId, swarmGroup });
				json({ integrated: true, winnerGoalId, losers, pushed: !!outcome.pushed });
			} catch (err) {
				const code = (err as any)?.code;
				if (code === "PARENT_MISMATCH") { jsonError(400, err, { code }); return true; }
				jsonError(500, err);
			}
			return true;
		}

		// SWARM-W4.5 — mint the pre-build gate token, once synthesis is done.
		// Mirrors `/verify`'s mint discipline exactly: mints ONLY for a
		// verified human/UI caller, never for an agent/team-lead credential —
		// an agent-triggered poll gets the synthesis status back but no token,
		// so it structurally cannot self-confirm its own plan.
		if (suffix === "/plan-verify" && req.method === "POST") {
			const parentGoalId = (group.config as { parentGoalId?: string } | undefined)?.parentGoalId ?? anchorGoalId;
			const auth = authorize(parentGoalId, "operator");
			if (!auth.ok) return true;
			if (group.planRejectedAt) { json({ error: "Plan already rejected", code: "PLAN_REJECTED", planRejectedAt: group.planRejectedAt }, 409); return true; }
			if (group.buildGoalId) { json({ error: `Plan already confirmed, build started (${group.buildGoalId})`, code: "ALREADY_CONFIRMED", buildGoalId: group.buildGoalId }, 409); return true; }
			if (!group.barrierFired || !group.synthesis || group.synthesis.status === "pending") {
				json({ outcome: "not-ready", synthesisStatus: group.synthesis?.status ?? "pending" }, 409);
				return true;
			}
			if (group.synthesis.status === "failed") {
				json({ outcome: "synthesis-failed", synthesisStatus: "failed", error: group.synthesis.error });
				return true;
			}
			// status === "done"
			let confirmation: { token: string; expiresAt: number } | undefined;
			if (auth.humanConfirmed) {
				confirmation = mintOperatorConfirmation({
					purpose: PLAN_FAN_IN_BUILD_START_PURPOSE,
					binding: stableConfirmationBinding({ swarmGroup, planHash: group.synthesis.planHash }),
				});
			}
			json({
				outcome: "synthesized",
				synthesisStatus: "done",
				output: group.synthesis.output,
				planHash: group.synthesis.planHash,
				...(confirmation ? { confirmationToken: confirmation.token, confirmationExpiresAt: confirmation.expiresAt } : {}),
			});
			return true;
		}

		// SWARM-W4.5 — consume the pre-build gate token, spawn the ONE ordinary
		// (non-swarm-tagged) build child. HARD RULE: no bypass — both the
		// human-cookie check AND the exact one-shot token are required, mirroring
		// `/confirm` verbatim.
		if (suffix === "/plan-confirm" && req.method === "POST") {
			const parentGoalId = (group.config as { parentGoalId?: string } | undefined)?.parentGoalId ?? anchorGoalId;
			const auth = authorize(parentGoalId, "operator");
			if (!auth.ok) return true;
			if (!auth.humanConfirmed) {
				json({ error: "Confirming a plan-fan-in build start requires a verified human/UI session", code: "HUMAN_CONFIRMATION_REQUIRED" }, 403);
				return true;
			}
			if (group.planRejectedAt) { json({ error: "Plan already rejected", code: "PLAN_REJECTED", planRejectedAt: group.planRejectedAt }, 409); return true; }
			if (group.buildGoalId) { json({ error: `Already confirmed (${group.buildGoalId})`, code: "ALREADY_CONFIRMED", buildGoalId: group.buildGoalId }, 409); return true; }
			if (!group.synthesis || group.synthesis.status !== "done" || !group.synthesis.planHash) {
				json({ error: "Synthesis is not done yet — run /plan-verify first", code: "SYNTHESIS_NOT_READY" }, 409);
				return true;
			}
			const body = await readBody(req).catch(() => null);
			const token = typeof body?.confirmationToken === "string" ? body.confirmationToken : firstHeader(req, "x-bobbit-operator-confirmation");
			const consumed = consumeOperatorConfirmation(token, {
				purpose: PLAN_FAN_IN_BUILD_START_PURPOSE,
				binding: stableConfirmationBinding({ swarmGroup, planHash: group.synthesis.planHash }),
			});
			if (!consumed) {
				json({ error: "Missing or invalid confirmation token for this exact plan — re-run /plan-verify to mint a fresh one", code: "CONFIRMATION_REQUIRED" }, 403);
				return true;
			}
			const parent = ctx.goalStore.get(parentGoalId);
			if (!parent) { json({ error: "Parent goal not found" }, 404); return true; }
			const goalManager = getGoalManagerForGoal(parentGoalId);
			try {
				const buildTitle = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : `${parent.title} (plan-fan-in build)`;
				// Ordinary, NON-swarm-tagged child — design §5's "ordinary
				// (non-swarm) goal row": its eventual merge goes through the
				// existing, completely unmodified nested-goal `mergeChild` path,
				// never `forceIntegrateSwarmWinner`. cwd/workflow resolution
				// mirrors `createBestOfNSwarm`'s own (root-repo-path, not the
				// parent's worktree cwd — see that file's matching comment).
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
				const buildChild = await goalManager.createGoal(buildTitle, childCwd, {
					spec: group.synthesis.output,
					workflowId,
					resolvedWorkflow: resolvedWorkflowForChild,
					projectId: parent.projectId,
					sandboxed: parent.sandboxed,
					parentGoalId,
				});
				const startOutcome = verificationHarness.requestChildStart(buildChild.id);
				if (startOutcome === "capacity-blocked") {
					try {
						await goalManager.updateGoal(buildChild.id, { state: "blocked" });
					} catch (err) {
						console.warn(`[swarm-routes] plan-confirm: failed to stamp capacity-blocked state for ${buildChild.id} (non-fatal):`, err);
					}
				}
				ctx.swarmGroupStore.recordBuildStart(swarmGroup, buildChild.id);
				broadcastToAll({ type: "goal_created", goalId: parentGoalId, swarmGroup });
				json({ confirmed: true, buildGoalId: buildChild.id, capacityBlocked: startOutcome === "capacity-blocked" }, 201);
			} catch (err) {
				jsonError(500, err);
			}
			return true;
		}

		// SWARM-W4.5 (orchestrator ruling #1 — plan-rejection path) — consume
		// the SAME one-shot token (exactly one decision, accept XOR reject, can
		// ever be made for a given synthesized plan), archive the plan
		// siblings, and stop: no auto-retry, no fallback build. Plan artifacts
		// are retained (archived, not deleted) and stay visible in the
		// dashboard so a human can manually start an ordinary goal from any of
		// them.
		if (suffix === "/plan-reject" && req.method === "POST") {
			const parentGoalId = (group.config as { parentGoalId?: string } | undefined)?.parentGoalId ?? anchorGoalId;
			const auth = authorize(parentGoalId, "operator");
			if (!auth.ok) return true;
			if (!auth.humanConfirmed) {
				json({ error: "Rejecting a plan-fan-in plan requires a verified human/UI session", code: "HUMAN_CONFIRMATION_REQUIRED" }, 403);
				return true;
			}
			if (group.planRejectedAt) { json({ error: "Plan already rejected", code: "ALREADY_REJECTED", planRejectedAt: group.planRejectedAt }, 409); return true; }
			if (group.buildGoalId) { json({ error: `Plan already confirmed, build started (${group.buildGoalId}) — cannot reject`, code: "ALREADY_CONFIRMED", buildGoalId: group.buildGoalId }, 409); return true; }
			if (!group.synthesis || group.synthesis.status !== "done" || !group.synthesis.planHash) {
				json({ error: "Synthesis is not done yet — nothing to reject", code: "SYNTHESIS_NOT_READY" }, 409);
				return true;
			}
			const body = await readBody(req).catch(() => null);
			const token = typeof body?.confirmationToken === "string" ? body.confirmationToken : firstHeader(req, "x-bobbit-operator-confirmation");
			const consumed = consumeOperatorConfirmation(token, {
				purpose: PLAN_FAN_IN_BUILD_START_PURPOSE,
				binding: stableConfirmationBinding({ swarmGroup, planHash: group.synthesis.planHash }),
			});
			if (!consumed) {
				json({ error: "Missing or invalid confirmation token for this exact plan — re-run /plan-verify to mint a fresh one", code: "CONFIRMATION_REQUIRED" }, 403);
				return true;
			}
			const goalManager = getGoalManagerForGoal(parentGoalId);
			const siblingIds = group.expectedSiblingIds ?? [];
			for (const siblingId of siblingIds) {
				try {
					if (teamManager.getTeamState(siblingId)) await teamManager.teardownTeam(siblingId);
					await goalManager.archiveGoal(siblingId);
				} catch (err) {
					console.warn(`[swarm-routes] plan-reject: failed to archive plan sibling ${siblingId} (non-fatal):`, err);
				}
			}
			ctx.swarmGroupStore.recordPlanRejected(swarmGroup);
			console.log(`[swarm-routes] plan-fan-in group ${swarmGroup} REJECTED by human operator at the pre-build gate — archived ${siblingIds.length} plan sibling(s); no build started, no auto-retry (plan artifacts retained for manual use).`);
			broadcastToAll({ type: "goal_state_changed", goalId: parentGoalId, swarmGroup });
			json({ rejected: true, archivedSiblingIds: siblingIds });
			return true;
		}
	}

	return false;
}

function firstHeader(req: http.IncomingMessage, name: string): string | undefined {
	const v = req.headers[name.toLowerCase()];
	return Array.isArray(v) ? v[0] : v;
}

/**
 * SWARM-W4.3 — consult the swarm-topology decision classifier for a best-of-N
 * creation. Never throws and never returns anything the caller reads — the
 * whole point this wave is a pure, discarded telemetry consult recorded via
 * `dispatchDecision`'s own trace/transparency-panel wiring. Fail-open, mirroring
 * `SessionManager.consultToolApproveHub`'s discipline exactly: no hub, an
 * unregistered (point,kind) pair, or the classifier itself erroring must
 * NEVER block or slow swarm creation.
 */
async function consultSwarmTopologyHub(
	deps: SwarmRouteDeps,
	req: http.IncomingMessage,
	arg: SwarmTopologyArg,
	cwd: string | undefined,
): Promise<void> {
	const hub = deps.sessionManager.lifecycleHub;
	if (!hub) return;
	try {
		const sessionId = deps.sessionManager.sessionSecretStore.resolveSessionIdBySecret(firstHeader(req, "x-bobbit-session-secret")) ?? arg.goalId;
		await hub.dispatchDecision<SwarmTopologyChoice>(
			SWARM_TOPOLOGY_POINT,
			SWARM_TOPOLOGY_KIND,
			{ sessionId, goalId: arg.goalId, cwd: cwd ?? "" },
			arg,
		);
	} catch (err) {
		console.warn(`[swarm-routes] swarm-topology dispatchDecision failed for goal ${arg.goalId} (non-fatal, observe-mode only): ${err instanceof Error ? err.message : String(err)}`);
	}
}
