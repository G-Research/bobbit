// src/server/routes/goal-team-mutation-routes.ts
//
// STR-01 goals cohort G4b: goal team/PR mutation routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry.
// See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { checkGateDependencies } from "../agent/gate-dependency-check.js";
import { GoalPausedError } from "../agent/goal-paused-guard.js";
import { cascadeSubtree as cascadeGoalSubtree, walkGoalSubtree } from "../agent/goal-subtree.js";
import { dismissHttpStatus, OrchestrationCoreError } from "../agent/orchestration-core.js";
import {
	deliverSessionPrompt,
	parseSessionPromptMode,
	SessionPromptDeliveryError,
} from "../agent/session-prompt-delivery.js";
import { GateDependencyError } from "../agent/team-manager.js";
import { authorizeChildrenMutation } from "../auth/children-mutation-authz.js";
import {
	_prCache,
	buildGhPrMergeArgs,
	goalGitUnavailablePayload,
	hasGoalGitWorktree,
} from "../skills/git-gh.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

const execFileAsync = promisify(execFileCb);

function resolveAuthenticCallerFromSessionSecret(ctx: CoreRouteCtx): string | undefined {
	const { req, sessionManager } = ctx;
	const h = req.headers as Record<string, string | string[] | undefined>;
	const secretHeader = h["x-bobbit-session-secret"];
	const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
	return sessionManager.sessionSecretStore.resolveSessionIdBySecret(
		typeof secret === "string" && secret.trim() ? secret.trim() : undefined,
	);
}

// Finding #6 fallback: a team-lead's `team_delegate(non_blocking)` child is NOT a
// goal team member, so the goal /team/* routes would reject it — yet the team-lead
// holds team_prompt/dismiss/steer/abort (registered goal-scoped via team/extension.ts,
// NOT the own-child variants in agent/extension.ts, to avoid double-registration).
// When the target is an own child of THIS goal's team-lead (tracked by the shared
// OrchestrationCore), route the verb through the core so the documented verbs work
// on the lead's own delegate helpers. Goal-member behaviour is unchanged.
function teamLeadOwnChildOwner(ctx: CoreRouteCtx, goalId: string, targetId: string): string | undefined {
	const { orchestrationCore, sessionManager, teamManager } = ctx;
	const teamState = teamManager.getTeamState(goalId);
	if (!teamState?.teamLeadSessionId) return undefined;
	const lead = teamState.teamLeadSessionId;

	// Tracked goal team members must flow through TeamManager.dismissRoleForGoal()
	// so it can remove team-manager state, subscriptions, timers, and broadcasts.
	// They are also registered in OrchestrationCore under the team lead, so a
	// plain owner/child match would incorrectly route real team agents through
	// the private team_delegate fallback. Check both the goal state snapshot and
	// the session→goal index; tests and restart paths can observe one before the
	// other is refreshed.
	if (teamState.agents.some((agent) => agent.sessionId === targetId)) return undefined;
	if (teamManager.findAgentBySessionId(targetId)) return undefined;
	const persisted = sessionManager.getPersistedSession(targetId) as any;

	if (orchestrationCore.list(lead).some(h => h.sessionId === targetId && h.childKind !== "team")) return lead;
	if (orchestrationCore.dismissedOwnerOf(targetId) === lead) return lead;
	return persisted?.delegateOf === lead || (persisted?.parentSessionId === lead && persisted?.childKind !== "team") ? lead : undefined;
}

// H3 authz — the own-child fallback MUST enforce owner→caller authz, exactly
// like /orchestrate/* (server.ts ~9310). The goal /team/* routes accept a
// sandbox-scoped token, so without this a same-goal agent that learns a
// helper child's session id could prompt/steer/abort/dismiss the team-lead's
// PRIVATE team_delegate child. Bind to the unforgeable per-session secret and
// require the AUTHENTIC caller to BE the team-lead owner. Goal-MEMBER
// operations use TeamManager below; tracked team-agent dismiss has its own
// team-lead authz check before destructive cleanup. Returns the owner id when
// authorized, a `denied` sentinel when the target IS an own child but the
// caller is not its owner, or `undefined` when the target is not an own child
// (normal path continues).
function resolveOwnChildOwner(ctx: CoreRouteCtx, goalId: string, targetId: string): { owner: string } | { denied: true } | undefined {
	const owner = teamLeadOwnChildOwner(ctx, goalId, targetId);
	if (!owner) return undefined;
	const authenticCaller = resolveAuthenticCallerFromSessionSecret(ctx);
	if (!authenticCaller || authenticCaller !== owner) return { denied: true };
	return { owner };
}

function denyOwnChild(ctx: CoreRouteCtx): void {
	ctx.json({ error: "Caller session is not the owner of this child agent", code: "NOT_OWNER" }, 403);
}

function denyDismissNotOwned(ctx: CoreRouteCtx, sessionId: string, message = "Caller session is not the team lead for this goal"): void {
	ctx.json({
		ok: false,
		status: "not-owned",
		sessionId,
		message,
		retryable: false,
	}, 403);
}

function ocStatusForTeamFallback(err: unknown): number {
	if (err instanceof SessionPromptDeliveryError) return err.status;
	if (err instanceof OrchestrationCoreError) {
		if (err.code === "NOT_STREAMING") return 409;
		if (err.code === "NOT_OWN_CHILD" || err.code === "NO_GRANDCHILDREN") return 403;
		return 400;
	}
	return 500;
}

// POST /api/goals/:id/team/start — start a team for a goal
async function handleGoalTeamStart(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, jsonError, teamManager } = ctx;
	const goalId = params.goalId;
	// Guard: goal spec must be set before starting the team.
	const startGoal = getGoalAcrossProjects(goalId);
	const trimmedSpec = (startGoal?.spec ?? "").trim();
	if (!trimmedSpec || trimmedSpec.length < 20 || trimmedSpec.toLowerCase() === "placeholder") {
		json({ error: "Goal spec must be set before starting the team. Update via PUT /api/goals/:id.", code: "SPEC_REQUIRED" }, 400);
		return;
	}
	try {
		const session = await teamManager.startTeam(goalId);
		json({ sessionId: session.id, title: session.title }, 201);
	} catch (err) {
		jsonError(400, err);
	}
	return;
}

// POST /api/goals/:id/team/spawn — spawn a role agent
async function handleGoalTeamSpawn(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, jsonError, readBody, req, teamManager } = ctx;
	const goalId = params.goalId;
	// Guard: reject spawn if goal is archived
	const spawnGoal = getGoalAcrossProjects(goalId);
	if (spawnGoal?.archived) {
		json({ error: "Goal is archived" }, 409);
		return;
	}
	// Pause-cascade: refuse to spawn role agents on a paused goal.
	if (spawnGoal?.paused) {
		json({ error: `Goal ${goalId} is paused`, code: "GOAL_PAUSED", goalId }, 409);
		return;
	}
	// Guard: reject spawn if goal worktree is not ready
	if (spawnGoal && spawnGoal.setupStatus !== "ready") {
		json({ error: "Goal setup not complete" }, 409);
		return;
	}
	const body = await readBody(req);
	if (!body?.role || !body?.task) {
		json({ error: "Missing role or task" }, 400);
		return;
	}
	try {
		const spawnOpts: { workflowGateId?: string; inputGateIds?: string[] } = {};
		if (typeof body.workflowGateId === "string") spawnOpts.workflowGateId = body.workflowGateId;
		if (Array.isArray(body.inputGateIds)) spawnOpts.inputGateIds = body.inputGateIds as string[];
		const result = await teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);
		json(result, 201);
	} catch (err) {
		if (err instanceof GateDependencyError) {
			jsonError(409, err);
		} else if (err instanceof GoalPausedError) {
			json({ error: err.message, code: err.code, goalId: err.goalId }, 409);
		} else {
			jsonError(400, err);
		}
	}
	return;
}

// POST /api/goals/:id/team/dismiss — dismiss a role agent
async function handleGoalTeamDismiss(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, orchestrationCore, readBody, req, teamManager } = ctx;
	const body = await readBody(req);
	if (!body?.sessionId) {
		json({ error: "Missing sessionId" }, 400);
		return;
	}
	const goalId = params.goalId;
	// Own-child fallback: dismissRole only knows goal team members; a team-lead's
	// own team_delegate child is tracked by OrchestrationCore, not the team entry.
	const ownerResult = resolveOwnChildOwner(ctx, goalId, body.sessionId);
	if (ownerResult) {
		if ("denied" in ownerResult) {
			json({ ok: false, status: "not-owned", sessionId: body.sessionId, message: "Caller session is not the owner of this child agent", retryable: false }, 403);
			return;
		}
		const result = await orchestrationCore.dismiss(ownerResult.owner, body.sessionId);
		json(result, dismissHttpStatus(result));
		return;
	}
	const teamState = teamManager.getTeamState(goalId);
	const isTrackedTeamAgent = teamState?.agents.some((agent) => agent.sessionId === body.sessionId) ?? false;
	if (isTrackedTeamAgent) {
		const authz = authorizeChildrenMutation({
			mutationClass: "orchestration",
			isHumanOperator: false,
			authenticCallerSessionId: resolveAuthenticCallerFromSessionSecret(ctx),
			teamLeadSessionId: teamState?.teamLeadSessionId,
		});
		if (!authz.ok) {
			denyDismissNotOwned(ctx, body.sessionId);
			return;
		}
	}
	const result = await teamManager.dismissRoleForGoal(goalId, body.sessionId);
	json(result, dismissHttpStatus(result));
	return;
}

// POST /api/goals/:id/pr-merge — merge PR for goal branch
async function handleGoalPrMerge(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, readBody, req } = ctx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (!hasGoalGitWorktree(goal)) { json(goalGitUnavailablePayload(goal, "PR merge"), 409); return; }
	const cwd = goal.cwd;
	if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
	const body = await readBody(req);
	const method = body?.method ?? "squash";
	if (!["merge", "squash", "rebase"].includes(method)) {
		json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
		return;
	}
	const clientGoalBranch = typeof body?.branch === "string" ? body.branch : undefined;
	const resolvedGoalBranch = clientGoalBranch || goal.branch;
	try {
		await execFileAsync("gh", buildGhPrMergeArgs(resolvedGoalBranch, method, body?.admin), { cwd, encoding: "utf-8", timeout: 30000 });
		_prCache.delete(cwd);
		if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);
		json({ ok: true });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		json({ error: msg }, 500);
	}
	return;
}

// POST /api/goals/:id/team/steer — steer a team agent mid-turn
async function handleGoalTeamSteer(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, orchestrationCore, readBody, req, sessionManager, teamManager } = ctx;
	const goalId = params.goalId;
	const body = await readBody(req);
	if (!body?.sessionId || !body?.message) {
		json({ error: "Missing sessionId or message" }, 400);
		return;
	}
	// Validate target is a team agent
	const agents = teamManager.listAgents(goalId);
	if (!agents.find(a => a.sessionId === body.sessionId)) {
		const ownerResult = resolveOwnChildOwner(ctx, goalId, body.sessionId);
		if (ownerResult) {
			if ("denied" in ownerResult) { denyOwnChild(ctx); return; }
			try {
				await orchestrationCore.steer(ownerResult.owner, body.sessionId, body.message);
				json({ ok: true, dispatched: true });
			} catch (err) {
				json({ error: String(err instanceof Error ? err.message : err), code: err instanceof OrchestrationCoreError ? err.code : undefined }, ocStatusForTeamFallback(err));
			}
			return;
		}
		json({ error: "Session is not a member of this team" }, 403);
		return;
	}
	const session = sessionManager.getSession(body.sessionId);
	if (!session) {
		json({ error: "Session not found" }, 404);
		return;
	}
	// Allow steering non-interactive sessions (e.g. verification reviewers)
	// so the user can redirect them mid-run
	if (session.status !== "streaming") {
		json({ error: "Agent is not currently streaming — use team/prompt instead" }, 409);
		return;
	}
	try {
		await sessionManager.deliverLiveSteer(session.id, body.message);
		json({ ok: true, dispatched: true });
	} catch (err) {
		jsonError(500, err);
	}
	return;
}

// POST /api/goals/:id/team/abort — force-abort a stuck team agent
async function handleGoalTeamAbort(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, orchestrationCore, readBody, req, sessionManager, teamManager } = ctx;
	const goalId = params.goalId;
	const body = await readBody(req);
	if (!body?.sessionId) {
		json({ error: "Missing sessionId" }, 400);
		return;
	}
	// Validate target is a team agent
	const agents = teamManager.listAgents(goalId);
	if (!agents.find(a => a.sessionId === body.sessionId)) {
		const ownerResult = resolveOwnChildOwner(ctx, goalId, body.sessionId);
		if (ownerResult) {
			if ("denied" in ownerResult) { denyOwnChild(ctx); return; }
			try {
				await orchestrationCore.abort(ownerResult.owner, body.sessionId);
				const afterSession = sessionManager.getSession(body.sessionId);
				json({ ok: true, status: afterSession?.status || "idle" });
			} catch (err) {
				json({ error: String(err instanceof Error ? err.message : err), code: err instanceof OrchestrationCoreError ? err.code : undefined }, ocStatusForTeamFallback(err));
			}
			return;
		}
		json({ error: "Session is not a member of this team" }, 403);
		return;
	}
	const session = sessionManager.getSession(body.sessionId);
	if (!session) {
		json({ error: "Session not found" }, 404);
		return;
	}
	try {
		await sessionManager.forceAbort(body.sessionId);
		const afterSession = sessionManager.getSession(body.sessionId);
		json({ ok: true, status: afterSession?.status || "idle" });
	} catch (err) {
		jsonError(500, err);
	}
	return;
}

// POST /api/goals/:id/team/prompt — prompt or steer a team agent, direct-child lead, or owned helper.
async function handleGoalTeamPrompt(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		getGoalAcrossProjects,
		json,
		jsonError,
		orchestrationCore,
		projectContextManager,
		readBody,
		req,
		sessionManager,
		teamManager,
	} = ctx;
	const goalId = params.goalId;
	const body = await readBody(req);
	if (typeof body?.sessionId !== "string" || typeof body?.message !== "string") {
		json({ error: "Missing sessionId or message" }, 400);
		return;
	}
	let mode: "prompt" | "steer";
	try {
		mode = parseSessionPromptMode(body.mode, "steer");
	} catch (err) {
		if (err instanceof SessionPromptDeliveryError) json({ error: err.message, code: err.code }, err.status);
		else jsonError(500, err);
		return;
	}

	// Validate target is a team agent OR a direct-child team-lead OR an owned helper child.
	const agents = teamManager.listAgents(goalId);
	let allowed = !!agents.find(a => a.sessionId === body.sessionId);
	let ownChildOwner: string | undefined;
	if (!allowed) {
		const targetSession = sessionManager.getSession(body.sessionId);
		if (targetSession?.role === "team-lead" && targetSession.goalId) {
			const targetGoal = getGoalAcrossProjects(targetSession.goalId);
			if (targetGoal?.parentGoalId === goalId) {
				allowed = true;
			}
		}
	}
	if (!allowed) {
		const ownerResult = resolveOwnChildOwner(ctx, goalId, body.sessionId);
		if (ownerResult) {
			if ("denied" in ownerResult) { denyOwnChild(ctx); return; }
			ownChildOwner = ownerResult.owner;
			allowed = true;
		}
	}
	if (!allowed) {
		json({
			error: "Session is not a member of this team and is not a direct-child team-lead",
			code: "NOT_TEAM_MEMBER_OR_DIRECT_CHILD",
		}, 403);
		return;
	}
	const session = sessionManager.getSession(body.sessionId);
	if (!session) {
		json({ error: "Session not found" }, 404);
		return;
	}

	// Enforce gate dependency check for team/prompt.
	const wfGateId = typeof body.workflowGateId === "string" ? body.workflowGateId : undefined;
	const inputIds = Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined;
	if (wfGateId) {
		const goal = getGoalAcrossProjects(goalId);
		const goalGateCtx = projectContextManager.getContextForGoal(goalId);
		const goalGateStore = goalGateCtx?.gateStore;
		if (goal?.workflow && goalGateStore) {
			const gateStates = goalGateStore.getGatesForGoal(goalId);
			const depError = checkGateDependencies(wfGateId, goal.workflow.gates, gateStates);
			if (depError) {
				json({ error: depError }, 409);
				return;
			}
		}
	}
	try {
		// Resolve workflow gate context and prepend to message if provided.
		let message = body.message as string;
		if (wfGateId || inputIds?.length) {
			const ctx = teamManager.buildDependencyContext(goalId, wfGateId, inputIds);
			if (ctx) {
				message = ctx + "\n\n---\n\n" + message;
			}
		}
		const result = ownChildOwner
			? await orchestrationCore.prompt(ownChildOwner, body.sessionId, message, { mode })
			: await deliverSessionPrompt({
				getSession: (id) => sessionManager.getSession(id),
				enqueuePrompt: (id, text, opts) => sessionManager.enqueuePrompt(id, text, opts),
				deliverLiveSteer: (id, text, opts) => sessionManager.deliverLiveSteer(id, text, opts),
			}, body.sessionId, message, { mode, defaultMode: "steer" });
		json(result);
	} catch (err) {
		if (err instanceof SessionPromptDeliveryError || err instanceof OrchestrationCoreError) {
			json({ error: String(err instanceof Error ? err.message : err), code: err instanceof Error ? (err as { code?: string }).code : undefined }, ocStatusForTeamFallback(err));
		} else {
			jsonError(500, err);
		}
	}
	return;
}

// POST /api/goals/:id/team/complete — complete a team (dismiss agents, keep team lead)
async function handleGoalTeamComplete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, projectContextManager, readBody, req, sandboxScope, teamManager } = ctx;
	const goalId = params.goalId;
	// Guard: a goal cannot be marked complete while it still has unresolved
	// live descendant goals. Nested child work must be rolled up (merged +
	// completed) or archived before the parent completes — otherwise the
	// parent's branch/PR would land without its children's work. This is
	// independent of gate-requirement state (the gate checks in
	// completeTeam() can be absent/skipped/stale, so we enforce here too).
	// Archived and already-complete descendants don't block.
	const completeCtx = projectContextManager.getContextForGoal(goalId);
	const completeAllGoals = completeCtx?.goalStore.getAll() ?? [];
	const unresolvedChildIds = walkGoalSubtree(goalId, completeAllGoals, { includeRoot: false, includeArchived: false })
		.filter(g => g.state !== "complete")
		.map(g => g.id);
	if (unresolvedChildIds.length > 0) {
		json({
			error: `Cannot complete: ${unresolvedChildIds.length} unresolved child goal(s) must be completed or archived first`,
			code: "UNRESOLVED_CHILDREN",
			childIds: unresolvedChildIds,
		}, 409);
		return;
	}
	const completeBody = await readBody(req);
	const confirmBypassedGates = completeBody?.confirmBypassedGates === true;
	// Bypassed-gate confirmation is a HUMAN-only override. A sandbox-scoped
	// agent token must not be able to confirm completion past bypassed gates
	// by hitting this REST endpoint directly — that would defeat the
	// human-in-the-loop trust boundary the bypass feature enforces.
	if (confirmBypassedGates && sandboxScope) {
		json({ error: "Forbidden: sandbox token cannot confirm completion of bypassed gates" }, 403);
		return;
	}
	try {
		await teamManager.completeTeam(goalId, { allowBypassedGates: confirmBypassedGates });
		json({ ok: true });
	} catch (err) {
		jsonError(400, err);
	}
	return;
}

// POST /api/goals/:id/team/teardown — fully tear down a team (dismiss agents + terminate team lead).
// Cascade required — mirror of `tests/api-team-teardown-cascade.test.ts::teardownRoute`.
async function handleGoalTeamTeardown(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, projectContextManager, teamManager, url } = ctx;
	const goalId = params.goalId;
	const cascadeParam = url.searchParams.get("cascade");
	if (cascadeParam !== "true" && cascadeParam !== "false") {
		json({ error: "cascade=true|false query parameter is required", code: "CASCADE_REQUIRED" }, 422);
		return;
	}
	const cascade = cascadeParam === "true";
	// Validate goal exists before attempting teardown.
	if (!getGoalAcrossProjects(goalId)) { json({ error: "Goal not found" }, 404); return; }
	const tdCtx = projectContextManager.getContextForGoal(goalId);
	const tdAllGoals = tdCtx?.goalStore.getAll() ?? [];

	// cascade=false + live descendant teams → 409 HAS_DESCENDANT_TEAMS.
	if (!cascade) {
		const descendants = walkGoalSubtree(goalId, tdAllGoals, { includeRoot: false, includeArchived: false });
		const descendantsWithTeams = descendants
			.filter(d => !!teamManager.getTeamState(d.id))
			.map(d => ({ id: d.id, title: d.title }));
		if (descendantsWithTeams.length > 0) {
			json({
				code: "HAS_DESCENDANT_TEAMS",
				count: descendantsWithTeams.length,
				descendants: descendantsWithTeams,
				message: `Goal has ${descendantsWithTeams.length} descendant team(s) still running. Re-call with ?cascade=true to stop them all.`,
			}, 409);
			return;
		}
	}

	// Bottom-up: children torn down before parents. Skip archived
	// nodes. cascade=false collapses to root-only by capping depth at 0.
	const result = await cascadeGoalSubtree(
		goalId,
		tdAllGoals,
		{ includeRoot: true, includeArchived: false, ...(cascade ? {} : { maxDepth: 0 }) },
		{
			order: "bottom-up",
			apply: async (g) => {
				if (!teamManager.getTeamState(g.id)) return false;
				await teamManager.teardownTeam(g.id);
				return true;
			},
		},
	);
	const toreDown = result.processed.filter(p => p.result === true).length;
	json({
		ok: true,
		toreDown,
		errors: result.errors.map(e => ({ goalId: e.goalId, error: e.error.message })),
	});
	return;
}

export function registerGoalTeamMutationRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/goals/:goalId/team/start", handleGoalTeamStart);
	table.register("POST", "/api/goals/:goalId/swarm/start", handleGoalTeamStart);
	table.register("POST", "/api/goals/:goalId/team/spawn", handleGoalTeamSpawn);
	table.register("POST", "/api/goals/:goalId/swarm/spawn", handleGoalTeamSpawn);
	table.register("POST", "/api/goals/:goalId/team/dismiss", handleGoalTeamDismiss);
	table.register("POST", "/api/goals/:goalId/swarm/dismiss", handleGoalTeamDismiss);
	table.register("POST", "/api/goals/:goalId/pr-merge", handleGoalPrMerge);
	table.register("POST", "/api/goals/:goalId/team/steer", handleGoalTeamSteer);
	table.register("POST", "/api/goals/:goalId/swarm/steer", handleGoalTeamSteer);
	table.register("POST", "/api/goals/:goalId/team/abort", handleGoalTeamAbort);
	table.register("POST", "/api/goals/:goalId/swarm/abort", handleGoalTeamAbort);
	table.register("POST", "/api/goals/:goalId/team/prompt", handleGoalTeamPrompt);
	table.register("POST", "/api/goals/:goalId/swarm/prompt", handleGoalTeamPrompt);
	table.register("POST", "/api/goals/:goalId/team/complete", handleGoalTeamComplete);
	table.register("POST", "/api/goals/:goalId/swarm/complete", handleGoalTeamComplete);
	table.register("POST", "/api/goals/:goalId/team/teardown", handleGoalTeamTeardown);
	table.register("POST", "/api/goals/:goalId/swarm/teardown", handleGoalTeamTeardown);
}
