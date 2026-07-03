/**
 * Team Lead tool extensions for Bobbit.
 *
 * Registers team management tools (spawn, dismiss, list, complete) for team lead
 * sessions only. Task and gate tools live in tasks/extension.ts and are loaded
 * independently by the tool activation system — do NOT import them here.
 *
 * Calls the gateway REST API directly — no CLI wrapper needed.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readGatewayCreds, apiCall, apiCallDetailed } from "../_shared/gateway.js";

export default function (pi: ExtensionAPI) {
	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!sessionId || !goalId) {
		// Expected for every non-team session — only surface under BOBBIT_DEBUG.
		if (process.env.BOBBIT_DEBUG) console.log("[team-lead-tools] BOBBIT_GOAL_ID / BOBBIT_SESSION_ID missing — tools not registered");
		return;
	}

	const credsResult = readGatewayCreds();
	if ("error" in credsResult) {
		console.error(`[team-lead-tools] Cannot read gateway credentials — tools not registered: ${credsResult.error}`);
		return;
	}
	const creds = credsResult;

	// The unforgeable per-session secret. The own-child fallback in the goal
	// `/team/{dismiss,steer,abort,prompt}` routes (H3) requires the AUTHENTIC
	// caller — resolved from this secret — to BE the team-lead owner before it
	// will orchestrate a team-lead's PRIVATE team_delegate child. Sending it on
	// every team call is harmless for the normal goal-member path (which does
	// not check it) and necessary for the fallback. See src/server/auth/session-secret.ts.
	const sessionSecret = process.env.BOBBIT_SESSION_SECRET;

	// ── HTTP helper ───────────────────────────────────────────────────
	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		const extraHeaders: Record<string, string> = {};
		if (sessionSecret) extraHeaders["X-Bobbit-Session-Secret"] = sessionSecret;
		return apiCall(creds, method, urlPath, body, { extraHeaders });
	}

	function ok(data: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: undefined };
	}

	const dismissStatuses = new Set(["dismissed", "already-dismissed", "not-owned", "not-found", "failed"]);

	function dismissText(result: any): string {
		return [
			`team_dismiss ${result?.status ?? "unknown"} for ${result?.sessionId ?? "unknown session"}`,
			result?.message ? `message: ${result.message}` : undefined,
			`retryable: ${result?.retryable === true ? "true" : "false"}`,
			"",
			JSON.stringify(result, null, 2),
		].filter(Boolean).join("\n");
	}

	function isStructuredDismissResult(value: unknown): value is { ok: boolean; status: string; sessionId: string; message: string; retryable: boolean } {
		if (!value || typeof value !== "object") return false;
		const v = value as Record<string, unknown>;
		return typeof v.ok === "boolean"
			&& typeof v.status === "string"
			&& dismissStatuses.has(v.status)
			&& typeof v.sessionId === "string"
			&& typeof v.message === "string"
			&& typeof v.retryable === "boolean";
	}

	function responseErrorText(body: unknown, fallback: string): string {
		if (body && typeof body === "object" && "error" in body) return String((body as Record<string, unknown>).error);
		if (typeof body === "string" && body.trim()) return body;
		return fallback;
	}

	function normalizeDismissResponse(resp: { ok: boolean; status: number; body: unknown }, sessionId: string) {
		if (isStructuredDismissResult(resp.body)) return resp.body;
		const retryable = resp.status === 401 || resp.status === 408 || resp.status === 429 || resp.status >= 500;
		return {
			ok: false,
			status: "failed",
			sessionId,
			message: resp.ok
				? `team_dismiss returned an unstructured response (HTTP ${resp.status}).`
				: `team_dismiss request failed (HTTP ${resp.status}): ${responseErrorText(resp.body, "unstructured gateway response")}`,
			retryable,
			httpStatus: resp.status,
			response: resp.body,
		};
	}

	async function apiDetailed(method: string, urlPath: string, body?: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
		const extraHeaders: Record<string, string> = {};
		if (sessionSecret) extraHeaders["X-Bobbit-Session-Secret"] = sessionSecret;
		const { ok, status, body: responseBody } = await apiCallDetailed(creds, method, urlPath, body, { extraHeaders });
		return { ok, status, body: responseBody };
	}

	function err(msg: string) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
	}

	// ── Team tools (team lead only) ───────────────────────────────────

	pi.registerTool({
		name: "team_spawn",
		label: "Spawn Team Agent",
		description: "Spawn a role agent in its own worktree. Returns session ID and worktree path.",
		promptSnippet: "Spawn a coder, reviewer, or tester agent with a task description.",
		parameters: Type.Object({
			role: Type.String({ description: "'coder', 'reviewer', or 'tester'." }),
			task: Type.String(),
			workflowGateId: Type.Optional(Type.String({ description: "Gate the agent works toward; auto-injects upstream gate content." })),
			inputGateIds: Type.Optional(Type.Array(Type.String(), { description: "Override DAG: gate IDs whose content to inject as context." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { role: params.role, task: params.task };
				if (params.workflowGateId) body.workflowGateId = params.workflowGateId;
				if (params.inputGateIds && params.inputGateIds.length > 0) body.inputGateIds = params.inputGateIds;
				return ok(await api("POST", `/api/goals/${goalId}/team/spawn`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_list",
		label: "List Team Agents",
		description: "List active team agents with role, status, worktree, and task.",
		promptSnippet: "List all agents in the team with their status.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/team/agents`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_dismiss",
		label: "Dismiss Team Agent",
		description: "Terminate/archive a role agent or report a structured non-retryable outcome. Returns { ok, status, sessionId, message, retryable } with status dismissed, already-dismissed, not-owned, not-found, or failed.",
		promptSnippet: "Dismiss a team agent by session ID. Inspect status/retryable; already-dismissed is idempotent success and should not be retried.",
		parameters: Type.Object({
			session_id: Type.String(),
		}),
		async execute(_id, params) {
			try {
				const targetSessionId = params.session_id;
				const resp = await apiDetailed("POST", `/api/goals/${goalId}/team/dismiss`, { sessionId: targetSessionId });
				const result = normalizeDismissResponse(resp, targetSessionId);
				return { content: [{ type: "text" as const, text: dismissText(result) }], details: result, isError: result.status === "failed" };
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_complete",
		label: "Complete Team",
		description: "Dismiss role agents and mark goal complete. All subgoals must be resolved first (else 409).",
		promptSnippet: "Complete the team: dismiss agents, keep team lead. Requires all subgoals merged/archived first.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/team/complete`, {}));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_steer",
		label: "Steer Team Agent",
		description: "Backward-compatible mid-turn redirect for a streaming agent. Fails if idle; prefer team_prompt(mode:'steer') for routine nudges.",
		promptSnippet: "Legacy steer for a running team agent (mid-turn only); prefer team_prompt(mode:'steer') unless you need compatibility.",
		parameters: Type.Object({
			session_id: Type.String(),
			message: Type.String(),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/team/steer`, { sessionId: params.session_id, message: params.message }));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_abort",
		label: "Abort Team Agent",
		description: "Force-abort a stuck team agent; kills and restarts its process.",
		promptSnippet: "Force-abort a stuck team agent by session ID.",
		parameters: Type.Object({
			session_id: Type.String(),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/team/abort`, { sessionId: params.session_id }));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_prompt",
		label: "Prompt Team Agent",
		description: "Prompt or steer a team agent or direct-child team-lead. Default mode is steer; use mode:'prompt' for next-turn queue semantics.",
		promptSnippet: "Send a prompt/steer to a team agent. Default mode:'steer'; use mode:'prompt' to run/queue a normal next-turn prompt.",
		parameters: Type.Object({
			session_id: Type.String(),
			message: Type.String(),
			mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer")], { description: "Delivery mode. Default steer.", default: "steer" })),
			workflowGateId: Type.Optional(Type.String({ description: "Gate the agent works toward; auto-injects upstream gate content." })),
			inputGateIds: Type.Optional(Type.Array(Type.String(), { description: "Override DAG: gate IDs whose content to inject as context." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { sessionId: params.session_id, message: params.message, mode: params.mode ?? "steer" };
				if (params.workflowGateId) body.workflowGateId = params.workflowGateId;
				if (params.inputGateIds?.length) body.inputGateIds = params.inputGateIds;
				return ok(await api("POST", `/api/goals/${goalId}/team/prompt`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	if (process.env.BOBBIT_DEBUG) console.log(`[team-lead-tools] Registered 7 team tools for session ${sessionId}, goal ${goalId}`);
}
