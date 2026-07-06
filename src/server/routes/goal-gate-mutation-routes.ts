// src/server/routes/goal-gate-mutation-routes.ts
//
// STR-01 goals cohort G3b: gate mutation routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry.
// See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.

import type { GateResetResult } from "../agent/gate-store.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// POST /api/goals/:goalId/gates/:gateId/reset — reset a gate and downstream dependents
async function handleGoalGateReset(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		broadcastToGoal,
		getGateAndTransitiveDependents,
		getGoalAcrossProjects,
		json,
		projectContextManager,
		sandboxScope,
		sessionManager,
		teamManager,
		verificationHarness,
	} = routeCtx;
	if (sandboxScope) {
		json({ error: "Forbidden: sandbox token cannot reset gates" }, 403);
		return;
	}

	const { goalId, gateId } = params;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
	if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }

	const gateResetCtx = projectContextManager.getContextForGoal(goalId);
	if (!gateResetCtx) { json({ error: "Goal not found in any project" }, 404); return; }
	const gateStore = gateResetCtx.gateStore;
	const requestedGateDef = goal.workflow.gates.find(g => g.id === gateId);
	if (!requestedGateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

	const affectedGateIds = getGateAndTransitiveDependents(goal.workflow, gateId);
	try {
		await verificationHarness.cancelStaleVerificationsForGates(goalId, affectedGateIds);
	} catch (err) {
		console.error(`[api] Error cancelling verifications for reset gates ${affectedGateIds.join(", ")}:`, err);
	}

	let resetResult: GateResetResult;
	try {
		resetResult = gateStore.resetGateAndDependents(goalId, gateId, goal.workflow);
	} catch (err: any) {
		json({ error: err?.message || `Unknown gate: ${gateId}` }, 404);
		return;
	}

	const affectedGates = resetResult.affectedGateIds.map(affectedGateId => {
		const def = goal.workflow!.gates.find(g => g.id === affectedGateId);
		const state = gateStore.getGate(goalId, affectedGateId);
		return {
			gateId: affectedGateId,
			name: def?.name || affectedGateId,
			status: state?.status || "pending",
		};
	});

	for (const gate of affectedGates) {
		broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId: gate.gateId, status: gate.status });
	}
	broadcastToGoal(goalId, {
		type: "gate_reset",
		goalId,
		gateId,
		affectedGateIds: resetResult.affectedGateIds,
		changedGateIds: resetResult.changedGateIds,
		unchangedGateIds: resetResult.unchangedGateIds,
	});

	const gateNameById = new Map(goal.workflow.gates.map(g => [g.id, g.name || g.id]));
	const namesFor = (ids: string[]) => ids.map(id => `- ${gateNameById.get(id) || id}`);
	const downstreamIds = resetResult.affectedGateIds.filter(id => id !== gateId);
	const clearedPassedIds = resetResult.affectedGateIds.filter(id => resetResult.previousStatuses[id] === "passed");
	const alreadyNotPassedIds = resetResult.affectedGateIds.filter(id => resetResult.previousStatuses[id] !== "passed");
	const notificationLines = [
		`Gate reset: ${requestedGateDef.name || gateId}`,
		"",
		"Reset by user action from the goal status widget.",
		"",
		"Selected gate:",
		`- ${requestedGateDef.name || gateId}`,
		"",
		"Invalidated dependent gates:",
		...(downstreamIds.length ? namesFor(downstreamIds) : ["- None"]),
		"",
		"Cleared passed state:",
		...(clearedPassedIds.length ? namesFor(clearedPassedIds) : ["- None"]),
		"",
		"Already not passed but included in reset scope:",
		...(alreadyNotPassedIds.length ? namesFor(alreadyNotPassedIds) : ["- None"]),
		"",
		"Why this matters:",
		"Downstream work may have relied on outputs from the reset gate. Please revisit dependent implementation, review, or verification work before continuing.",
	];
	const notification = notificationLines.join("\n");

	let teamLeadNotified = false;
	const team = teamManager.getTeamState(goalId);
	if (team?.teamLeadSessionId) {
		const teamLeadSession = sessionManager.getSession(team.teamLeadSessionId);
		if (teamLeadSession && teamLeadSession.status !== "terminated") {
			try {
				if (teamLeadSession.status === "streaming") {
					await sessionManager.deliverLiveSteer(team.teamLeadSessionId, notification, { source: "system" });
				} else {
					await sessionManager.enqueuePrompt(team.teamLeadSessionId, notification, { isSteered: true, source: "system" });
				}
				teamLeadNotified = true;
			} catch (err) {
				console.error(`[api] Failed to notify team lead for gate reset ${goalId}/${gateId}:`, err);
			}
		}
	}

	json({
		ok: true,
		gateId,
		affectedGateIds: resetResult.affectedGateIds,
		changedGateIds: resetResult.changedGateIds,
		unchangedGateIds: resetResult.unchangedGateIds,
		previousStatuses: resetResult.previousStatuses,
		gates: affectedGates,
		teamLeadNotified,
	});
	return;
}

// POST /api/goals/:goalId/gates/:gateId/bypass — human-only gate bypass.
// NOT advertised to agents: no MCP tool, no prompt/doc mention. The
// isInitiatedByHuman guard is the runtime backstop. Modeled on the reset
// endpoint above.
async function handleGoalGateBypass(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		broadcastToGoal,
		getGoalAcrossProjects,
		json,
		projectContextManager,
		readBody,
		req,
		sandboxScope,
		sessionManager,
		teamManager,
		verificationHarness,
	} = routeCtx;
	if (sandboxScope) {
		json({ error: "Forbidden: sandbox token cannot bypass gates" }, 403);
		return;
	}

	const { goalId, gateId } = params;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
	if (goal.state === "shelved") { json({ error: "Goal is shelved" }, 409); return; }
	if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }

	const gateBypassCtx = projectContextManager.getContextForGoal(goalId);
	if (!gateBypassCtx) { json({ error: "Goal not found in any project" }, 404); return; }
	const gateStore = gateBypassCtx.gateStore;
	const bypassGateDef = goal.workflow.gates.find(g => g.id === gateId);
	if (!bypassGateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

	const bypassBody = await readBody(req);
	if (bypassBody?.isInitiatedByHuman !== true) {
		json({ error: "This method is currently intended for human use only. Bypassing a gate as an agent is not acting in the best interest of the outcome." }, 400);
		return;
	}
	const whyBypassed = bypassBody?.whyBypassed;
	const whoAmI = bypassBody?.whoAmI;
	if (typeof whyBypassed !== "string" || !whyBypassed.trim()) { json({ error: "whyBypassed is required" }, 400); return; }
	if (typeof whoAmI !== "string" || !whoAmI.trim()) { json({ error: "whoAmI is required" }, 400); return; }

	try {
		await verificationHarness.cancelStaleVerificationsForGates(goalId, [gateId]);
	} catch (err) {
		console.error(`[api] Error cancelling verifications for bypassed gate ${gateId}:`, err);
	}

	const bypassSignal = gateStore.bypassGate(goalId, gateId, { whyBypassed, whoAmI });
	const bypassedAt = bypassSignal.metadata?.bypassedAt ?? String(bypassSignal.timestamp);

	broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId, status: "bypassed" });

	let teamLeadNotified = false;
	try {
		const notification = [
			`Gate bypassed: ${bypassGateDef.name || gateId}`,
			"",
			`This gate was forced past verification by a human overseer (${whoAmI}).`,
			"",
			"Reason:",
			whyBypassed,
			"",
			"The bypassed gate now counts as satisfied for dependency ordering, but the goal still requires explicit human confirmation before it can be completed.",
		].join("\n");
		const team = teamManager.getTeamState(goalId);
		if (team?.teamLeadSessionId) {
			const teamLeadSession = sessionManager.getSession(team.teamLeadSessionId);
			if (teamLeadSession && teamLeadSession.status !== "terminated") {
				if (teamLeadSession.status === "streaming") {
					await sessionManager.deliverLiveSteer(team.teamLeadSessionId, notification, { source: "system" });
				} else {
					await sessionManager.enqueuePrompt(team.teamLeadSessionId, notification, { isSteered: true, source: "system" });
				}
				teamLeadNotified = true;
			}
		}
	} catch (err) {
		console.error(`[api] Failed to notify team lead for gate bypass ${goalId}/${gateId}:`, err);
	}

	json({ ok: true, gateId, status: "bypassed", whyBypassed, whoAmI, bypassedAt, teamLeadNotified });
	return;
}

// POST /api/goals/:goalId/gates/:gateId/cancel-verification — cancel a stuck verification
async function handleGoalGateCancelVerification(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		getGoalAcrossProjects,
		json,
		projectContextManager,
		verificationHarness,
	} = routeCtx;
	const { goalId, gateId } = params;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
	if (goal.state === "shelved") { json({ error: "Goal is shelved" }, 400); return; }

	const activeVers = verificationHarness.getActiveVerifications(goalId);
	const running = activeVers.find(v => v.gateId === gateId && v.overallStatus === "running");
	if (!running) {
		json({ cancelled: false, message: "No running verification to cancel" }, 200);
		return;
	}

	await verificationHarness.cancelStaleVerifications(goalId, gateId);
	// Explicit user cancel: also update gate status to "failed"
	const cancelCtx = projectContextManager.getContextForGoal(goalId);
	if (cancelCtx) cancelCtx.gateStore.updateGateStatus(goalId, gateId, "failed");
	json({ cancelled: true }, 200);
	return;
}

// POST /api/goals/:goalId/gates/:gateId/signoff — resolve a parked human-signoff step.
// Body: { signalId, stepName, decision: "pass" | "fail", feedback? }.
// Idempotent — already-resolved steps respond 409 with the current step state.
async function handleGoalGateSignoff(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		getGoalAcrossProjects,
		json,
		projectContextManager,
		readBody,
		req,
		verificationHarness,
	} = routeCtx;
	const { goalId, gateId } = params;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
	if (goal.state === "shelved") { json({ error: "Goal is shelved" }, 400); return; }

	const body = await readBody(req);
	if (!body
		|| typeof body.signalId !== "string" || !body.signalId
		|| typeof body.stepName !== "string" || !body.stepName
		|| (body.decision !== "pass" && body.decision !== "fail")) {
		json({ error: "Invalid body: { signalId, stepName, decision: 'pass'|'fail', feedback? }" }, 400);
		return;
	}

	const active = verificationHarness.getActiveVerification(body.signalId);
	if (!active || active.goalId !== goalId || active.gateId !== gateId) {
		// No in-flight verification — the signal may have already completed.
		// Distinguish "signal genuinely unknown" (404) from "signal exists but
		// the step is already resolved" (409, idempotent surface).
		const histCtx = projectContextManager.getContextForGoal(goalId);
		const histGate = histCtx?.gateStore.getGate(goalId, gateId);
		const histSignal = histGate?.signals.find(s => s.id === body.signalId);
		if (histSignal) {
			const histStep = histSignal.verification.steps.find(s => s.name === body.stepName);
			if (histStep && histStep.type === "human-signoff") {
				json({
					error: "step is no longer awaiting human input",
					stepName: histStep.name,
					status: histStep.passed ? "passed" : (histStep.skipped ? "skipped" : "failed"),
				}, 409);
				return;
			}
			if (histStep) {
				json({ error: "The specified step is not a human-signoff step" }, 409);
				return;
			}
		}
		json({ error: "No active verification for that signal/goal/gate" }, 404);
		return;
	}
	const step = active.steps.find(s => s.name === body.stepName);
	if (!step) {
		json({ error: `Step "${body.stepName}" not found in active verification` }, 404);
		return;
	}
	if (!step.awaitingHuman) {
		json({
			error: "step is no longer awaiting human input",
			stepName: step.name,
			status: step.status,
		}, 409);
		return;
	}

	const feedback = typeof body.feedback === "string" ? body.feedback : undefined;
	const resolved = verificationHarness.resolveSignoff(body.signalId, body.stepName, {
		decision: body.decision,
		feedback,
	});
	if (!resolved) {
		// Raced with cancellation or a prior resolve — idempotent surface.
		json({ error: "step is no longer awaiting human input" }, 409);
		return;
	}
	json({ resolved: true }, 200);
	return;
}

// GET /api/goals/:goalId/workflow-context/:gateId — get dependency context for a gate
async function handleGoalWorkflowContext(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, teamManager } = routeCtx;
	const { goalId, gateId } = params;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (!goal.workflow) { json({ error: "Goal has no workflow" }, 404); return; }
	const gateDef = goal.workflow.gates.find(g => g.id === gateId);
	if (!gateDef) { json({ error: "Gate not found" }, 404); return; }

	const context = teamManager.buildDependencyContext(goalId, gateId);
	json({ context, gate: gateDef });
	return;
}

export function registerGoalGateMutationRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/goals/:goalId/gates/:gateId/reset", handleGoalGateReset);
	table.register("POST", "/api/goals/:goalId/gates/:gateId/bypass", handleGoalGateBypass);
	table.register("POST", "/api/goals/:goalId/gates/:gateId/signoff", handleGoalGateSignoff);
	table.register("POST", "/api/goals/:goalId/gates/:gateId/cancel-verification", handleGoalGateCancelVerification);
	table.register("GET", "/api/goals/:goalId/workflow-context/:gateId", handleGoalWorkflowContext);
}
