/**
 * Gate routes — list, detail, inspect, signals, content, workflow-context,
 * active-verifications, cancel-verification.
 *
 * Note: POST /api/goals/:goalId/gates/:gateId/signal stays in server.ts for
 * now — it's tightly coupled to verificationHarness, gate cascade reset,
 * and broadcast plumbing. Migrating it is tracked as follow-up work.
 */
import { getGoalAcrossProjects } from "./cross-project.js";
import type { Route } from "./types.js";

export const gatesRoutes: Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/gates$/,
		handler: ({ deps, params, url, json }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			const gateCtx = deps.projectContextManager.getContextForGoal(goalId);
			if (!gateCtx) { json({ error: "Goal not found in any project" }, 404); return; }
			const gateStore = gateCtx.gateStore;
			const gates = gateStore.getGatesForGoal(goalId);
			const enriched = gates.map(g => {
				const def = goal.workflow?.gates.find(wg => wg.id === g.gateId);
				return { ...g, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream, metadata: def?.metadata || g.currentMetadata, signalCount: g.signals.length };
			});
			if (url.searchParams.get("view") === "summary") {
				const slim = enriched.map(g => {
					const base: Record<string, unknown> = {
						gateId: g.gateId,
						name: g.name,
						status: g.status,
						dependsOn: g.dependsOn || [],
						signalCount: g.signalCount,
					};
					if (g.signals.length > 0) base.updatedAt = g.updatedAt;
					if (g.status === "failed") {
						const latest = g.signals[g.signals.length - 1];
						if (latest?.verification?.steps) {
							base.failedSteps = latest.verification.steps
								.filter((s: any) => !s.passed && !s.skipped)
								.map((s: any) => s.name);
						}
					}
					return base;
				});
				json({ gates: slim });
				return;
			}
			json({ gates: enriched });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/inspect$/,
		handler: ({ deps, params, url, json }) => {
			const [, goalId, gateId] = params;
			const ctx = deps.projectContextManager.getContextForGoal(goalId);
			if (!ctx) { json({ error: "Goal not found" }, 404); return; }
			const gate = ctx.gateStore.getGate(goalId, gateId);
			if (!gate) { json({ error: "Gate not found" }, 404); return; }

			const section = url.searchParams.get("section");
			if (!section || !["content", "verification", "signals"].includes(section)) {
				json({ error: "section query parameter is required: 'content', 'verification', or 'signals'" }, 400);
				return;
			}

			const resolveSignal = () => {
				const idxStr = url.searchParams.get("signal_index");
				let idx = idxStr !== null ? parseInt(idxStr, 10) : -1;
				if (isNaN(idx)) idx = -1;
				if (idx < 0) idx = gate.signals.length + idx;
				if (idx < 0 || idx >= gate.signals.length) return null;
				return { signal: gate.signals[idx], index: idx };
			};

			if (section === "content") {
				const resolved = resolveSignal();
				if (!resolved) { json({ error: "Signal not found" }, 404); return; }
				json({
					gateId, section: "content",
					signalIndex: resolved.index,
					signalId: resolved.signal.id,
					text: resolved.signal.content || null,
				});
				return;
			}

			if (section === "verification") {
				const resolved = resolveSignal();
				if (!resolved) { json({ error: "Signal not found" }, 404); return; }
				const v = resolved.signal.verification;
				json({
					gateId, section: "verification",
					signalIndex: resolved.index,
					signalId: resolved.signal.id,
					steps: v ? v.steps.map(s => ({
						name: s.name,
						type: s.type,
						passed: s.passed,
						skipped: s.skipped || undefined,
						duration_ms: s.duration_ms,
						output: s.output,
					})) : [],
				});
				return;
			}

			if (section === "signals") {
				json({
					gateId, section: "signals",
					signals: gate.signals.map((s, i) => ({
						index: i,
						id: s.id,
						timestamp: s.timestamp,
						sessionId: s.sessionId,
						commitSha: s.commitSha,
						verdict: s.verification?.status || "running",
						hasContent: !!s.content,
						metadataKeys: s.metadata ? Object.keys(s.metadata) : [],
					})),
				});
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signals$/,
		handler: ({ deps, params, json }) => {
			const [, goalId, gateId] = params;
			const ctx = deps.projectContextManager.getContextForGoal(goalId);
			if (!ctx) { json({ error: "Goal not found in any project" }, 404); return; }
			const gate = ctx.gateStore.getGate(goalId, gateId);
			if (!gate) { json({ error: "Gate not found" }, 404); return; }
			json({ signals: gate.signals });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/content$/,
		handler: ({ deps, params, json }) => {
			const [, goalId, gateId] = params;
			const ctx = deps.projectContextManager.getContextForGoal(goalId);
			if (!ctx) { json({ error: "Goal not found in any project" }, 404); return; }
			const gate = ctx.gateStore.getGate(goalId, gateId);
			if (!gate) { json({ error: "Gate not found" }, 404); return; }
			json({ content: gate.currentContent, version: gate.currentContentVersion });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/workflow-context\/([^/]+)$/,
		handler: ({ deps, params, json }) => {
			const goalId = params[1];
			const gateId = params[2];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			if (!goal.workflow) { json({ error: "Goal has no workflow" }, 404); return; }
			const gateDef = goal.workflow.gates.find(g => g.id === gateId);
			if (!gateDef) { json({ error: "Gate not found" }, 404); return; }

			const context = deps.teamManager.buildDependencyContext(goalId, gateId);
			json({ context, gate: gateDef });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/verifications\/active$/,
		handler: ({ deps, params, json }) => {
			const goalId = params[1];
			const active = deps.verificationHarness.getActiveVerifications(goalId);
			json({ verifications: active });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/cancel-verification$/,
		handler: async ({ deps, params, json }) => {
			const [, goalId, gateId] = params;
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
			if (goal.state === "shelved") { json({ error: "Goal is shelved" }, 400); return; }

			const activeVers = deps.verificationHarness.getActiveVerifications(goalId);
			const running = activeVers.find(v => v.gateId === gateId && v.overallStatus === "running");
			if (!running) {
				json({ cancelled: false, message: "No running verification to cancel" }, 200);
				return;
			}

			await deps.verificationHarness.cancelStaleVerifications(goalId, gateId);
			const cancelCtx = deps.projectContextManager.getContextForGoal(goalId);
			if (cancelCtx) cancelCtx.gateStore.updateGateStatus(goalId, gateId, "failed");
			json({ cancelled: true }, 200);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/gates\/([^/]+)$/,
		handler: ({ deps, params, url, json }) => {
			const [, goalId, gateId] = params;
			const ctx = deps.projectContextManager.getContextForGoal(goalId);
			if (!ctx) { json({ error: "Goal not found in any project" }, 404); return; }
			const gateStore = ctx.gateStore;
			const gate = gateStore.getGate(goalId, gateId);
			if (!gate) { json({ error: "Gate not found" }, 404); return; }
			const goal = getGoalAcrossProjects(deps, goalId);
			const def = goal?.workflow?.gates.find(wg => wg.id === gateId);
			if (url.searchParams.get("view") === "summary") {
				const latestSignal = gate.signals[gate.signals.length - 1];
				const MAX_TAIL_LINES = 40;
				const slim: Record<string, unknown> = {
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
					slim.latestSignal = {
						id: latestSignal.id,
						sessionId: latestSignal.sessionId,
						timestamp: latestSignal.timestamp,
						commitSha: latestSignal.commitSha,
						verification: latestSignal.verification ? {
							status: latestSignal.verification.status,
							steps: latestSignal.verification.steps.map(s => {
								const base: Record<string, unknown> = { name: s.name, passed: s.passed };
								if (!s.passed && !s.skipped && s.output) {
									const lines = s.output.split("\n");
									base.output = lines.length > MAX_TAIL_LINES
										? lines.slice(-MAX_TAIL_LINES).join("\n")
										: s.output;
								}
								return base;
							}),
						} : undefined,
					};
				}
				json(slim);
				return;
			}
			json({ ...gate, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream });
		},
	},
];
