// src/server/routes/goal-read-routes.ts
//
// STR-01 goals cohort G1: pure-read goal/dashboard routes plus the
// taskManager-scoped task create route migrated out of handleApiRoute's legacy
// if/else chain into the core route registry. See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex captures.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.
// Exact segment-count registrations keep sibling routes such as
// gates/:gateId/inspect, /signal, /reset, /bypass, /signoff, and
// workflow-context from being shadowed.

import { collectDescendants, enrichDescendantsForPlan } from "../agent/goal-descendants.js";
import { computeTreeCost } from "../agent/cost-tracker.js";
import { buildGateStatusSummary } from "../gate-status-summary.js";
import { buildGateVerificationSnapshot } from "../gate-verification-snapshot.js";
import type { PersistedGoal } from "../agent/goal-store.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/goals/:goalId/descendants — live + archived descendants for the Plan tab.
// Feeds dashboardDescendants in goal-dashboard.ts so archived children render in the DAG
// and contribute to tree-cost rollups. Without this route, the Plan tab silently drops
// every archived/completed child.
async function handleGoalDescendants(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, projectContextManager, verificationHarness } = routeCtx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (!goal.projectId) { json({ goals: [] }); return; }
	const ctx = projectContextManager.getContextForGoal(goalId);
	if (!ctx) { json({ error: "Goal project context not found" }, 404); return; }
	// getAll() returns both live and archived.
	const allGoals = ctx.goalStore.getAll();
	// Enrich each descendant with the Plan-tab data contract: `mergeConflict`
	// (durable, from the goal record) and `gateStatus` (aggregated from the
	// child's workflow gates). The frontend consumes these exact names.
	const enriched = enrichDescendantsForPlan(collectDescendants(goalId, allGoals), {
		getGatesForGoal: (gid) => ctx.gateStore.getGatesForGoal(gid),
		hasActiveVerification: (gid) => verificationHarness.getActiveVerifications(gid).length > 0,
	});
	json({ goals: enriched });
	return;
}

// GET /api/goals/:goalId/tree-cost — cost rollup across descendant tree (live + archived).
async function handleGoalTreeCost(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, projectContextManager, requireSubgoalsEnabled, sessionManager } = routeCtx;
	if (!requireSubgoalsEnabled()) return;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	// Dashboard tree-cost is intentionally rooted at the REQUESTED goal,
	// not its topmost ancestor (`goal.rootGoalId`). Opening a subgoal's
	// dashboard must show the rollup of that subgoal + its descendants only;
	// using `rootGoalId` would leak the whole project's grand total down to
	// every descendant view. `computeTreeCost` consumes `walkGoalSubtree`
	// for the descendant walk — do not add another traversal helper here.
	// Pinned by tests/api-goals-tree-cost.test.ts and
	// tests/e2e/ui/tree-cost-rollup.spec.ts — do not "fix" this back to
	// `goal.rootGoalId ?? goal.id` without tripping those tests.
	if (!goal.projectId) {
		json({ rootGoalId: goalId, totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, breakdown: [] });
		return;
	}
	const ctx = projectContextManager.getContextForGoal(goalId);
	if (!ctx) { json({ error: "Goal project context not found" }, 404); return; }
	const allGoals = ctx.goalStore.getAll();
	const costTracker = sessionManager.getCostTracker(goal.projectId);
	const result = computeTreeCost(
		goalId,
		allGoals,
		costTracker,
		(gid) => sessionManager.getAllSessionIdsForGoal(gid),
	);
	// Surface the unattributable legacy bucket (cost entries whose
	// `goalId` could not be recovered by the boot backfill). NOT added
	// to `totalCostUsd` — it's an informational residual, separate from
	// the selected goal's subtree. Hidden entirely when empty.
	const legacy = costTracker.getUnattributableLegacyCostWithMetadata();
	if (legacy.totalCost > 0 || legacy.inputTokens > 0 || legacy.outputTokens > 0) {
		const payload: {
			goalId: string;
			title: string;
			costUsd: number;
			tokensIn: number;
			tokensOut: number;
			firstSeenAt?: number;
		} = {
			goalId: "__unattributable__",
			title: "Unattributable (legacy)",
			costUsd: legacy.totalCost,
			tokensIn: legacy.inputTokens,
			tokensOut: legacy.outputTokens,
		};
		if (typeof legacy.firstSeenAt === "number") payload.firstSeenAt = legacy.firstSeenAt;
		(result as typeof result & { unattributableLegacy?: unknown }).unattributableLegacy = payload;
	}
	json(result);
	return;
}

// GET /api/goals
async function handleGoalsList(routeCtx: CoreRouteCtx): Promise<void> {
	const {
		archivedGoalMatchesQuery,
		bfsEnrichArchived,
		colorStore,
		json,
		listGoalsAcrossProjects,
		normalizedArchivedQuery,
		projectContextManager,
		sessionManager,
		url,
	} = routeCtx;
	// Paginated archived goals — aggregate across all projects
	if (url.searchParams.get("archived") === "true") {
		const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50), 200);
		const afterParam = url.searchParams.get("after");
		const afterCursor = afterParam ? parseInt(afterParam, 10) : undefined;
		const filterProjectId = url.searchParams.get("projectId") || undefined;
		const archivedQuery = normalizedArchivedQuery(url.searchParams.get("q"));
		// Aggregate archived goals across all project contexts
		let allArchived: PersistedGoal[] = [];
		const sessionsForGoalQuery: any[] = [];
		for (const liveSession of sessionManager.listSessions()) {
			if (filterProjectId && liveSession.projectId !== filterProjectId) continue;
			sessionsForGoalQuery.push(liveSession);
		}
		for (const ctx of projectContextManager.visible()) {
			if (filterProjectId && ctx.project.id !== filterProjectId) continue;
			allArchived.push(...ctx.goalStore.getArchived());
			for (const s of ctx.sessionStore.getArchived()) {
				sessionsForGoalQuery.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
			}
		}
		if (archivedQuery) {
			allArchived = allArchived.filter(g => archivedGoalMatchesQuery(g, sessionsForGoalQuery, archivedQuery));
		}
		allArchived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
		const total = allArchived.length;
		if (afterCursor !== undefined) {
			allArchived = allArchived.filter(g => (g.archivedAt ?? 0) < afterCursor);
		}
		const page = allArchived.slice(0, limit);
		const hasMore = allArchived.length > limit;
		const nextCursor = page.length > 0 ? page[page.length - 1].archivedAt : undefined;

		// Collect archived sessions affiliated with goals in this page
		const goalIdsInPage = new Set(page.map((g: any) => g.id));
		const affiliatedSessions: any[] = [];
		const seenSessionIds = new Set<string>();
		for (const ctx of projectContextManager.visible()) {
			for (const s of ctx.sessionStore.getArchived()) {
				if (!seenSessionIds.has(s.id) && (goalIdsInPage.has((s as any).teamGoalId) || goalIdsInPage.has((s as any).goalId))) {
					seenSessionIds.add(s.id);
					affiliatedSessions.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
				}
			}
		}
		// BFS walk delegate/team chains from affiliated sessions
		const allArchivedForGoalsBfs: any[] = [];
		for (const ctx of projectContextManager.visible()) {
			for (const s of ctx.sessionStore.getArchived()) {
				allArchivedForGoalsBfs.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
			}
		}
		const delegateEnriched = bfsEnrichArchived(affiliatedSessions.map(s => s.id), allArchivedForGoalsBfs);
		for (const s of delegateEnriched) {
			if (!seenSessionIds.has(s.id)) {
				seenSessionIds.add(s.id);
				affiliatedSessions.push(s);
			}
		}

		json({ goals: page, total, hasMore, nextCursor, archivedSessions: affiliatedSessions });
		return;
	}

	const currentGen = projectContextManager.getGoalGeneration();
	const sinceParam = url.searchParams.get("since");
	if (sinceParam !== null) {
		const since = parseInt(sinceParam, 10);
		if (!isNaN(since) && since === currentGen) {
			json({ generation: currentGen, changed: false });
			return;
		}
	}
	const filterProjectId = url.searchParams.get("projectId") || undefined;
	const goals = listGoalsAcrossProjects({ projectId: filterProjectId });
	json({ generation: currentGen, goals });
	return;
}

// GET /api/goals/:goalId/tasks — list tasks for a goal
async function handleGoalTasksList(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getTaskManagerForGoal, json, url } = routeCtx;
	const tasks = getTaskManagerForGoal(params.goalId).getTasksForGoal(params.goalId);
	if (url.searchParams.get("view") === "summary") {
		const slim = tasks.map(t => ({
			id: t.id,
			title: t.title,
			type: t.type,
			state: t.state,
			assignedSessionId: t.assignedSessionId,
			branch: t.branch,
			headSha: t.headSha,
			workflowGateId: t.workflowGateId,
			dependsOn: t.dependsOn || [],
		}));
		json({ tasks: slim });
		return;
	}
	json({ tasks });
	return;
}

// POST /api/goals/:goalId/tasks — create a task
async function handleGoalTaskCreate(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, getTaskManagerForGoal, json, jsonError, readBody, req } = routeCtx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }

	const body = await readBody(req);
	const title = body?.title;
	const type = body?.type;
	if (!title || typeof title !== "string") {
		json({ error: "Missing title" }, 400);
		return;
	}
	if (!type || typeof type !== "string") {
		json({ error: "Missing type" }, 400);
		return;
	}
	try {
		const task = getTaskManagerForGoal(goalId).createTask(goalId, title, type, {
			parentTaskId: body.parentTaskId,
			spec: body.spec,
			dependsOn: body.dependsOn,
			workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
			inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
		});
		json(task, 201);
	} catch (err: any) {
		jsonError(400, err);
	}
	return;
}

// GET /api/goals/:goalId/gates — list gates for a goal
async function handleGoalGatesList(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, projectContextManager, url, verificationHarness } = routeCtx;
	const goalId = params.goalId;
	const goal = getGoalAcrossProjects(goalId);
	if (!goal) { json({ error: "Goal not found" }, 404); return; }
	const gateCtx = projectContextManager.getContextForGoal(goalId);
	if (!gateCtx) { json({ error: "Goal not found in any project" }, 404); return; }
	const gateStore = gateCtx.gateStore;
	const gates = gateStore.getGatesForGoal(goalId);
	// Enrich with workflow gate definitions
	const enriched = gates.map(g => {
		const def = goal.workflow?.gates.find(wg => wg.id === g.gateId);
		const base = { ...g, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream, metadata: def?.metadata || g.currentMetadata, signalCount: g.signals.length };
		// Surface human-bypass audit fields as canonical top-level fields so the
		// UI does not have to couple to internal signal shape.
		if (g.status === "bypassed") {
			const bypassSignal = gateStore.getLatestBypassSignal(g);
			if (bypassSignal?.metadata) {
				return {
					...base,
					whyBypassed: bypassSignal.metadata.whyBypassed,
					whoAmI: bypassSignal.metadata.whoAmI,
					bypassedAt: bypassSignal.metadata.bypassedAt,
				};
			}
		}
		return base;
	});
	if (url.searchParams.get("view") === "summary") {
		const summary = buildGateStatusSummary({
			workflow: goal.workflow,
			gates,
			activeVerifications: verificationHarness.getActiveVerifications(goalId),
		});
		const { gates: summaryGates, ...counts } = summary;
		json({ gates: summaryGates, ...counts, summary });
		return;
	}
	json({ gates: enriched });
	return;
}

// GET /api/goals/:goalId/gates/:gateId — gate detail
async function handleGoalGateDetail(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { getGoalAcrossProjects, json, projectContextManager, url, verificationHarness } = routeCtx;
	const goalId = params.goalId;
	const gateId = params.gateId;
	const gateDetailCtx = projectContextManager.getContextForGoal(goalId);
	if (!gateDetailCtx) { json({ error: "Goal not found in any project" }, 404); return; }
	const gateStore = gateDetailCtx.gateStore;
	const gate = gateStore.getGate(goalId, gateId);
	if (!gate) { json({ error: "Gate not found" }, 404); return; }
	const goal = getGoalAcrossProjects(goalId);
	const def = goal?.workflow?.gates.find(wg => wg.id === gateId);
	if (url.searchParams.get("view") === "summary") {
		const latestSignal = gate.signals[gate.signals.length - 1];
		const slim: Record<string, unknown> = {
			goalId,
			gateId: gate.gateId,
			name: def?.name,
			status: gate.status,
			dependsOn: def?.dependsOn || [],
			signalCount: gate.signals.length,
			updatedAt: gate.updatedAt,
			hasContent: !!gate.currentContent,
			contentLength: gate.currentContent?.length || 0,
		};
		if (gate.currentMetadata) slim.currentMetadata = gate.currentMetadata;
		if (latestSignal) {
			const verificationSnapshot = latestSignal.verification ? buildGateVerificationSnapshot({
				goalId,
				gateId,
				signalId: latestSignal.id,
				verification: latestSignal.verification,
				activeVerification: verificationHarness.getActiveVerification(latestSignal.id),
				selectionOptions: { implicitDefault: true },
			}) : undefined;
			slim.latestSignal = {
				id: latestSignal.id,
				sessionId: latestSignal.sessionId,
				timestamp: latestSignal.timestamp,
				commitSha: latestSignal.commitSha,
				verification: verificationSnapshot ? {
					status: verificationSnapshot.status,
					summary: verificationSnapshot.summary,
					counts: verificationSnapshot.counts,
					active: verificationSnapshot.active,
					steps: verificationSnapshot.steps,
					selection: verificationSnapshot.selection,
				} : undefined,
			};
		}
		json(slim);
		return;
	}
	json({ ...gate, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream });
	return;
}

// GET /api/goals/:goalId/gates/:gateId/signals — signal history
async function handleGoalGateSignals(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager } = routeCtx;
	const goalId = params.goalId;
	const gateId = params.gateId;
	const gateSignalsCtx = projectContextManager.getContextForGoal(goalId);
	if (!gateSignalsCtx) { json({ error: "Goal not found in any project" }, 404); return; }
	const gateStore = gateSignalsCtx.gateStore;
	const gate = gateStore.getGate(goalId, gateId);
	if (!gate) { json({ error: "Gate not found" }, 404); return; }
	json({ signals: gate.signals });
	return;
}

// GET /api/goals/:goalId/verifications/active — get in-flight verification state
async function handleGoalActiveVerifications(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, verificationHarness } = routeCtx;
	const goalId = params.goalId;
	const active = verificationHarness.getActiveVerifications(goalId);
	json({ verifications: active });
	return;
}

// GET /api/goals/:goalId/gates/:gateId/content — gate content
async function handleGoalGateContent(routeCtx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager } = routeCtx;
	const goalId = params.goalId;
	const gateId = params.gateId;
	const gateContentCtx = projectContextManager.getContextForGoal(goalId);
	if (!gateContentCtx) { json({ error: "Goal not found in any project" }, 404); return; }
	const gateStore = gateContentCtx.gateStore;
	const gate = gateStore.getGate(goalId, gateId);
	if (!gate) { json({ error: "Gate not found" }, 404); return; }
	json({ content: gate.currentContent, version: gate.currentContentVersion });
	return;
}

export function registerGoalReadRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/goals/:goalId/descendants", handleGoalDescendants);
	table.register("GET", "/api/goals/:goalId/tree-cost", handleGoalTreeCost);
	table.register("GET", "/api/goals", handleGoalsList);
	table.register("GET", "/api/goals/:goalId/tasks", handleGoalTasksList);
	table.register("POST", "/api/goals/:goalId/tasks", handleGoalTaskCreate);
	table.register("GET", "/api/goals/:goalId/gates", handleGoalGatesList);
	table.register("GET", "/api/goals/:goalId/gates/:gateId", handleGoalGateDetail);
	table.register("GET", "/api/goals/:goalId/gates/:gateId/signals", handleGoalGateSignals);
	table.register("GET", "/api/goals/:goalId/gates/:gateId/content", handleGoalGateContent);
	table.register("GET", "/api/goals/:goalId/verifications/active", handleGoalActiveVerifications);
}
