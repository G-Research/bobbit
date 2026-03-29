import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../app-context.js";
import { readBody, json, hasTransitiveDep } from "./utils.js";
import { execGitSafe } from "../services/github-service.js";

export async function handle(ctx: AppContext, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
	const { sessionManager, gateStore, verificationHarness, teamManager, broadcastToGoal } = ctx;

	// GET /api/goals/:goalId/gates — list gates for a goal
	const goalGatesMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates$/);
	if (goalGatesMatch && req.method === "GET") {
		const goalId = goalGatesMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		const gates = gateStore.getGatesForGoal(goalId);
		// Enrich with workflow gate definitions
		const enriched = gates.map(g => {
			const def = goal.workflow?.gates.find(wg => wg.id === g.gateId);
			return { ...g, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream, metadata: def?.metadata || g.currentMetadata, signalCount: g.signals.length };
		});
		json(res, { gates: enriched });
		return true;
	}

	// GET /api/goals/:goalId/gates/:gateId — gate detail
	const gateDetailMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)$/);
	if (gateDetailMatch && req.method === "GET") {
		const [, goalId, gateId] = gateDetailMatch;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json(res, { error: "Gate not found" }, 404); return true; }
		const goal = sessionManager.goalManager.getGoal(goalId);
		const def = goal?.workflow?.gates.find(wg => wg.id === gateId);
		json(res, { ...gate, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream });
		return true;
	}

	// POST /api/goals/:goalId/gates/:gateId/signal — signal a gate
	const gateSignalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signal$/);
	if (gateSignalMatch && req.method === "POST") {
		const [, goalId, gateId] = gateSignalMatch;
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		if (goal.archived) { json(res, { error: "Goal is archived" }, 409); return true; }
		if (!goal.workflow) { json(res, { error: "Goal has no workflow" }, 400); return true; }
		const gateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!gateDef) { json(res, { error: `Unknown gate: ${gateId}` }, 404); return true; }

		const body = await readBody(req);
		const signalSessionId = body?.sessionId || "unknown";

		// Validate dependencies are met
		for (const depId of gateDef.dependsOn) {
			const depGate = gateStore.getGate(goalId, depId);
			if (!depGate || depGate.status !== "passed") {
				const depDef = goal.workflow.gates.find(g => g.id === depId);
				json(res, { error: `Upstream gate "${depDef?.name || depId}" has not passed yet` }, 409);
				return true;
			}
		}

		// Validate metadata against gate's schema
		if (gateDef.metadata && body?.metadata) {
			for (const key of Object.keys(gateDef.metadata)) {
				if (!(key in body.metadata)) {
					json(res, { error: `Missing required metadata field: ${key}` }, 400);
					return true;
				}
			}
		} else if (gateDef.metadata && !body?.metadata) {
			const required = Object.keys(gateDef.metadata);
			if (required.length > 0) {
				json(res, { error: `Missing required metadata fields: ${required.join(", ")}` }, 400);
				return true;
			}
		}

		// Get commit SHA
		let commitSha = "unknown";
		try {
			commitSha = await execGitSafe("git rev-parse HEAD", goal.cwd, "unknown");
		} catch { /* ignore */ }

		// Compute content version
		const existingGate = gateStore.getGate(goalId, gateId);
		const contentVersion = body?.content ? (existingGate?.currentContentVersion || 0) + 1 : undefined;

		// Check if this is a re-signal of a passed gate — cascade reset
		if (existingGate && existingGate.status === "passed") {
			gateStore.cascadeReset(goalId, gateId, goal.workflow);
			// Broadcast resets for downstream gates
			for (const g of goal.workflow.gates) {
				if (g.dependsOn.includes(gateId) || hasTransitiveDep(goal.workflow, g.id, gateId)) {
					const downstream = gateStore.getGate(goalId, g.id);
					if (downstream) {
						broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId: g.id, status: downstream.status });
					}
				}
			}
		}

		// Create signal record
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

		// Update gate content/metadata if provided
		if (body?.content && contentVersion) {
			gateStore.updateGateContent(goalId, gateId, body.content, contentVersion);
		}
		if (body?.metadata) {
			gateStore.updateGateMetadata(goalId, gateId, body.metadata);
		}

		// Broadcast signal received
		broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: signal.id });

		// Build gate state map for metadata variable resolution + LLM reviewer context
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

		// Fire-and-forget verification
		verificationHarness.verifyGateSignal(
			signal, gateDef, goal.cwd, goal.branch, "master", allGateStates, goal.spec,
		).catch(err => console.error("[verification] Gate signal error:", err));

		const verifySteps = (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type }));
		json(res, { signal: { id: signal.id, gateId, goalId, status: "running", steps: verifySteps } }, 201);
		return true;
	}

	// GET /api/goals/:goalId/gates/:gateId/signals — signal history
	const gateSignalsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signals$/);
	if (gateSignalsMatch && req.method === "GET") {
		const [, goalId, gateId] = gateSignalsMatch;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json(res, { error: "Gate not found" }, 404); return true; }
		json(res, { signals: gate.signals });
		return true;
	}

	// GET /api/goals/:goalId/verifications/active — get in-flight verification state
	const activeVerifMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/verifications\/active$/);
	if (activeVerifMatch && req.method === "GET") {
		const [, goalId] = activeVerifMatch;
		const active = verificationHarness.getActiveVerifications(goalId);
		json(res, { verifications: active });
		return true;
	}

	// GET /api/goals/:goalId/gates/:gateId/content — gate content
	const gateContentMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/content$/);
	if (gateContentMatch && req.method === "GET") {
		const [, goalId, gateId] = gateContentMatch;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json(res, { error: "Gate not found" }, 404); return true; }
		json(res, { content: gate.currentContent, version: gate.currentContentVersion });
		return true;
	}

	// GET /api/goals/:goalId/workflow-context/:gateId — get dependency context for a gate
	const workflowContextMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/workflow-context\/([^/]+)$/);
	if (workflowContextMatch && req.method === "GET") {
		const goalId = workflowContextMatch[1];
		const gateId = workflowContextMatch[2];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json(res, { error: "Goal not found" }, 404); return true; }
		if (!goal.workflow) { json(res, { error: "Goal has no workflow" }, 404); return true; }
		const gateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!gateDef) { json(res, { error: "Gate not found" }, 404); return true; }

		const context = teamManager.buildDependencyContext(goalId, gateId);
		json(res, { context, gate: gateDef });
		return true;
	}

	return false;
}
