/**
 * SWARM-W1 REST surface — fixed best-of-N pattern.
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
 */
import type http from "node:http";
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
import { verifyBestOfNGroup } from "./swarm-verifier.js";
import { SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND, type SwarmTopologyChoice, type SwarmTopologyArg } from "./swarm-topology-classifier.js";

const SWARM_PICK_CONFIRMATION_PURPOSE = "swarm-best-of-n-pick";

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
		// SWARM-W4.2 — goal-create decision seam HARNESS consult (see
		// swarm-topology-classifier.ts's header + design/swarm-orchestration-w4.md
		// §3.3 step 1). `server.ts` only allow-lists (goal-create,
		// swarm-topology) and registers NO classifier, so this always abstains
		// in production today — recorded via `dispatchDecision`'s own
		// trace/transparency-panel wiring only. The topology created below is
		// UNCONDITIONALLY the caller-supplied best-of-N shape regardless of
		// this decision's outcome — nothing here reads or branches on it.
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

	// GET/POST /api/goals/:id/swarm-groups/:swarmGroup(/verify|/confirm)?
	const groupMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm-groups\/([^/]+)(\/verify|\/confirm)?$/);
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
				config: group.config,
				updatedAt: group.updatedAt,
			});
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
	}

	return false;
}

function firstHeader(req: http.IncomingMessage, name: string): string | undefined {
	const v = req.headers[name.toLowerCase()];
	return Array.isArray(v) ? v[0] : v;
}

/**
 * SWARM-W4.2 — consult the swarm-topology decision seam (harness only, see
 * `swarm-topology-classifier.ts`) for a best-of-N creation. Never throws and
 * never returns anything the caller reads — the whole point this wave is a
 * pure, discarded telemetry consult recorded via `dispatchDecision`'s own
 * trace/transparency-panel wiring. Fail-open, mirroring
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
