/**
 * Gate routes — list, detail, inspect, signals, content, workflow-context,
 * active-verifications, cancel-verification.
 *
 * Note: POST /api/goals/:goalId/gates/:gateId/signal stays in server.ts for
 * now — it's tightly coupled to verificationHarness, gate cascade reset,
 * and broadcast plumbing. Migrating it is tracked as follow-up work.
 */
import { randomUUID } from "node:crypto";
import { getGoalAcrossProjects } from "./cross-project.js";
import { execGitSafe } from "../git/git-exec.js";
import { detectPrimaryBranch } from "../skills/git.js";
import { hasTransitiveDep } from "../agent/gate-deps.js";
import type { Route } from "./types.js";

export const gatesRoutes: Route[] = [
	{
		method: "POST",
		pattern: /^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signal$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const { projectContextManager, verificationHarness, broadcastToGoal } = deps;
			const [, goalId, gateId] = params;
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			if (goal.archived) { jsonError(409, new Error("Goal is archived")); return; }
			if (!goal.workflow) { jsonError(400, new Error("Goal has no workflow")); return; }
			const gateSignalCtx = projectContextManager.getContextForGoal(goalId);
			if (!gateSignalCtx) { jsonError(404, new Error("Goal not found in any project")); return; }
			const gateStore = gateSignalCtx.gateStore;
			const gateDef = goal.workflow.gates.find(g => g.id === gateId);
			if (!gateDef) { jsonError(404, new Error(`Unknown gate: ${gateId}`)); return; }

			const body = await readBody();
			const signalSessionId = body?.sessionId || "unknown";

			for (const depId of gateDef.dependsOn) {
				const depGate = gateStore.getGate(goalId, depId);
				if (!depGate || depGate.status !== "passed") {
					const depDef = goal.workflow.gates.find(g => g.id === depId);
					jsonError(409, new Error(`Upstream gate "${depDef?.name || depId}" has not passed yet`));
					return;
				}
			}

			if (gateDef.metadata && body?.metadata) {
				for (const key of Object.keys(gateDef.metadata)) {
					if (!(key in body.metadata)) {
						jsonError(400, new Error(`Missing required metadata field: ${key}`));
						return;
					}
				}
			} else if (gateDef.metadata && !body?.metadata) {
				const required = Object.keys(gateDef.metadata);
				if (required.length > 0) {
					jsonError(400, new Error(`Missing required metadata fields: ${required.join(", ")}`));
					return;
				}
			}

			let commitSha = "unknown";
			try {
				commitSha = await execGitSafe("git rev-parse HEAD", goal.cwd, "unknown");
			} catch { /* ignore */ }

			if (commitSha !== "unknown") {
				const activeVers = verificationHarness.getActiveVerifications(goalId);
				const runningDup = activeVers.find(v => {
					if (v.gateId !== gateId || v.overallStatus !== "running") return false;
					const gs = gateStore.getGate(goalId, gateId);
					const s = gs?.signals.find(s => s.id === v.signalId);
					return s?.commitSha === commitSha;
				});
				if (runningDup) {
					const alive = verificationHarness.areVerificationSessionsAlive(runningDup.signalId);
					if (!alive) {
						console.log(`[api] Auto-cancelling zombie verification ${runningDup.signalId} for gate ${gateId}`);
						await verificationHarness.cancelStaleVerifications(goalId, gateId);
					} else {
						jsonError(409, new Error("Verification already in progress for this commit"), { existingSignalId: runningDup.signalId });
						return;
					}
				}
			}

			if (commitSha !== "unknown") {
				const existingGateForCache = gateStore.getGate(goalId, gateId);
				if (existingGateForCache) {
					const priorPassed = existingGateForCache.signals.find(s =>
						s.commitSha === commitSha && s.verification?.status === "passed"
					);
					if (priorPassed?.verification) {
						const cachedSignal = {
							id: randomUUID(),
							gateId,
							goalId,
							sessionId: body?.sessionId || "unknown",
							timestamp: Date.now(),
							commitSha,
							metadata: body?.metadata,
							content: body?.content,
							contentVersion: body?.content ? (existingGateForCache.currentContentVersion || 0) + 1 : undefined,
							verification: {
								status: "passed" as const,
								steps: priorPassed.verification.steps.map(s => ({ ...s, output: `[cached from prior signal] ${s.output}` })),
							},
						};
						gateStore.recordSignal(cachedSignal);
						if (body?.content && cachedSignal.contentVersion) {
							gateStore.updateGateContent(goalId, gateId, body.content, cachedSignal.contentVersion);
						}
						if (body?.metadata) {
							gateStore.updateGateMetadata(goalId, gateId, body.metadata);
						}
						gateStore.updateGateStatus(goalId, gateId, "passed");
						broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: cachedSignal.id });
						broadcastToGoal(goalId, { type: "gate_verification_complete", goalId, gateId, signalId: cachedSignal.id, status: "passed" });
						broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId, status: "passed" });
						const verifySteps = (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type }));
						json({ signal: { id: cachedSignal.id, gateId, goalId, status: "passed", steps: verifySteps, cached: true } }, 201);
						return;
					}
				}
			}

			const existingGate = gateStore.getGate(goalId, gateId);
			const contentVersion = body?.content ? (existingGate?.currentContentVersion || 0) + 1 : undefined;

			if (existingGate && existingGate.status === "passed") {
				gateStore.cascadeReset(goalId, gateId, goal.workflow);
				for (const g of goal.workflow.gates) {
					if (g.dependsOn.includes(gateId) || hasTransitiveDep(goal.workflow, g.id, gateId)) {
						const downstream = gateStore.getGate(goalId, g.id);
						if (downstream) {
							broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId: g.id, status: downstream.status });
						}
					}
				}
			}

			const signal = {
				id: randomUUID(),
				gateId,
				goalId,
				sessionId: signalSessionId,
				timestamp: Date.now(),
				commitSha,
				metadata: body?.metadata,
				content: body?.content,
				contentVersion,
				verification: { status: "running" as const, steps: [] },
			};

			gateStore.recordSignal(signal);

			if (body?.content && contentVersion) {
				gateStore.updateGateContent(goalId, gateId, body.content, contentVersion);
			}
			if (body?.metadata) {
				gateStore.updateGateMetadata(goalId, gateId, body.metadata);
			}

			broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: signal.id });

			const allGateStates = new Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>();
			for (const gs of gateStore.getGatesForGoal(goalId)) {
				const def = goal.workflow?.gates?.find((g: any) => g.id === gs.gateId);
				allGateStates.set(gs.gateId, {
					metadata: gs.currentMetadata,
					content: gs.currentContent,
					status: gs.status,
					injectDownstream: def?.injectDownstream,
				});
			}

			await verificationHarness.cancelStaleVerifications(goalId, gateId);

			const primary = await detectPrimaryBranch(goal.cwd).catch(() => "master");
			verificationHarness.verifyGateSignal(
				signal, gateDef, goal.cwd, goal.branch, primary, allGateStates, goal.spec,
			).catch(err => console.error("[verification] Gate signal error:", err));

			const verifySteps = (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type }));
			json({ signal: { id: signal.id, gateId, goalId, status: "running", steps: verifySteps } }, 201);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/gates$/,
		handler: ({ deps, params, url, json, jsonError }) => {
			const goalId = params[1];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			const gateCtx = deps.projectContextManager.getContextForGoal(goalId);
			if (!gateCtx) { jsonError(404, new Error("Goal not found in any project")); return; }
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
		handler: ({ deps, params, url, json, jsonError }) => {
			const [, goalId, gateId] = params;
			const ctx = deps.projectContextManager.getContextForGoal(goalId);
			if (!ctx) { jsonError(404, new Error("Goal not found")); return; }
			const gate = ctx.gateStore.getGate(goalId, gateId);
			if (!gate) { jsonError(404, new Error("Gate not found")); return; }

			const section = url.searchParams.get("section");
			if (!section || !["content", "verification", "signals"].includes(section)) {
				jsonError(400, new Error("section query parameter is required: 'content', 'verification', or 'signals'"));
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
				if (!resolved) { jsonError(404, new Error("Signal not found")); return; }
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
				if (!resolved) { jsonError(404, new Error("Signal not found")); return; }
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
		handler: ({ deps, params, json, jsonError }) => {
			const [, goalId, gateId] = params;
			const ctx = deps.projectContextManager.getContextForGoal(goalId);
			if (!ctx) { jsonError(404, new Error("Goal not found in any project")); return; }
			const gate = ctx.gateStore.getGate(goalId, gateId);
			if (!gate) { jsonError(404, new Error("Gate not found")); return; }
			json({ signals: gate.signals });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/content$/,
		handler: ({ deps, params, json, jsonError }) => {
			const [, goalId, gateId] = params;
			const ctx = deps.projectContextManager.getContextForGoal(goalId);
			if (!ctx) { jsonError(404, new Error("Goal not found in any project")); return; }
			const gate = ctx.gateStore.getGate(goalId, gateId);
			if (!gate) { jsonError(404, new Error("Gate not found")); return; }
			json({ content: gate.currentContent, version: gate.currentContentVersion });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/goals\/([^/]+)\/workflow-context\/([^/]+)$/,
		handler: ({ deps, params, json, jsonError }) => {
			const goalId = params[1];
			const gateId = params[2];
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			if (!goal.workflow) { jsonError(404, new Error("Goal has no workflow")); return; }
			const gateDef = goal.workflow.gates.find(g => g.id === gateId);
			if (!gateDef) { jsonError(404, new Error("Gate not found")); return; }

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
		handler: async ({ deps, params, json, jsonError }) => {
			const [, goalId, gateId] = params;
			const goal = getGoalAcrossProjects(deps, goalId);
			if (!goal) { jsonError(404, new Error("Goal not found")); return; }
			if (goal.archived) { jsonError(409, new Error("Goal is archived")); return; }
			if (goal.state === "shelved") { jsonError(400, new Error("Goal is shelved")); return; }

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
		handler: ({ deps, params, url, json, jsonError }) => {
			const [, goalId, gateId] = params;
			const ctx = deps.projectContextManager.getContextForGoal(goalId);
			if (!ctx) { jsonError(404, new Error("Goal not found in any project")); return; }
			const gateStore = ctx.gateStore;
			const gate = gateStore.getGate(goalId, gateId);
			if (!gate) { jsonError(404, new Error("Gate not found")); return; }
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
