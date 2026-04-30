/**
 * Children tool extension for Bobbit.
 *
 * Registers the four "Children" group tools used by team-leads of nested
 * goals to spawn / merge / pause / resume sub-goals:
 *
 *   - goal_spawn_child         POST /api/goals/:id/spawn-child
 *   - goal_merge_child         POST /api/goals/:id/integrate-child/:childGoalId
 *   - goal_pause               POST /api/goals/:id/pause
 *   - goal_resume              POST /api/goals/:id/resume
 *
 * (`goal_plan_propose` and `goal_plan_status` are added in Phase 3.3.)
 *
 * Loaded automatically when the session has `BOBBIT_GOAL_ID` in its env —
 * which the gateway populates for any team-lead session via
 * `team-manager.ts::startTeam`. Without `BOBBIT_GOAL_ID`, no tools are
 * registered (the agent simply doesn't have access to the group).
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getGatewayUrl, getGatewayToken } from "../_shared/gateway.ts";

export default function (pi: ExtensionAPI) {
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!goalId) {
		// Not a goal-scoped session — silently no-op. The system prompt
		// will not surface this group either, since the role policy is
		// gated upstream.
		return;
	}

	let baseUrl: string;
	let token: string;
	try {
		baseUrl = getGatewayUrl();
		token = getGatewayToken();
	} catch (err: any) {
		console.error(`[children-tools] Cannot read gateway credentials — Children tools not registered: ${err?.message ?? err}`);
		return;
	}

	// ── HTTP helper ───────────────────────────────────────────────────
	// All Children endpoints are POST. We surface the response body verbatim
	// to the model on both success and failure so the team-lead can explain
	// 409 mutation classifications to the user.
	async function postJson(urlPath: string, body?: unknown): Promise<{ ok: true; data: unknown } | { ok: false; data: unknown; status: number }> {
		const resp = await fetch(`${baseUrl}${urlPath}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		let data: unknown;
		try { data = JSON.parse(text); } catch { data = text; }
		if (!resp.ok) return { ok: false, data, status: resp.status };
		return { ok: true, data };
	}

	function ok(data: unknown) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
			details: undefined,
		};
	}

	function err(toolName: string, status: number | null, data: unknown) {
		// Render the response body verbatim — for 409 it carries the structured
		// mutation classification (`error`, `classification`, `droppedCriteria`,
		// `addedNodes`, `removedNodes`, `summary`, `requiresApproval?`).
		const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
		const prefix = status !== null
			? `${toolName} failed (HTTP ${status}):`
			: `${toolName} failed:`;
		return {
			content: [{ type: "text" as const, text: `${prefix}\n${body}` }],
			details: undefined,
			isError: true,
		};
	}

	function netErr(toolName: string, e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text" as const, text: `${toolName} network error: ${msg}` }],
			details: undefined,
			isError: true,
		};
	}

	// ── goal_spawn_child ──────────────────────────────────────────────
	pi.registerTool({
		name: "goal_spawn_child",
		label: "Spawn Child Goal",
		description: [
			"Spawn a child goal under the current goal. The child branches off your branch HEAD",
			"and merges back when its `ready-to-merge` passes. Subject to your goal's divergence",
			"policy when the `goal-plan` gate has already been signalled.",
			"",
			"Use a subgoal when ALL of: (1) the work has its own design intent, (2) it is",
			"independently reviewable, (3) it merges meaningfully on its own. Use `team_spawn`",
			"for a cohesive review cycle; use `task_create` for a single tracked deliverable.",
		].join(" "),
		promptSnippet: "Spawn a child goal that branches off this goal's HEAD.",
		parameters: Type.Object({
			title: Type.String({ description: "Short child goal title (max 200 chars)." }),
			spec: Type.String({ description: "Markdown spec. Restate every covered acceptance criterion verbatim." }),
			workflowId: Type.Optional(Type.String({ description: "Workflow id (default: feature)." })),
			inlineWorkflow: Type.Optional(Type.Any({ description: "Inline workflow object — overrides workflowId." })),
			suggestedRole: Type.Optional(Type.String({ description: "Hint for the team-lead seed role." })),
			enabledOptionalSteps: Type.Optional(Type.Array(Type.String(), { description: "Optional-step ids to enable on the workflow." })),
			planId: Type.Optional(Type.String({ description: "Stable id for idempotency. Server generates one if omitted." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await postJson(`/api/goals/${goalId}/spawn-child`, params);
				if (!result.ok) return err("goal_spawn_child", result.status, result.data);
				return ok(result.data);
			} catch (e) {
				return netErr("goal_spawn_child", e);
			}
		},
	});

	// ── goal_merge_child ──────────────────────────────────────────────
	pi.registerTool({
		name: "goal_merge_child",
		label: "Merge Child Goal",
		description: [
			"Locally merge a completed child goal's branch into the current goal's branch.",
			"Called automatically by the harness when a `subgoal` verify step fires — you generally",
			"don't call this by hand. Fails on conflict; never auto-resolve. On conflict, escalate",
			"to the user via `ask_user_choices`.",
		].join(" "),
		promptSnippet: "Locally merge a completed child goal into this goal's branch.",
		parameters: Type.Object({
			childGoalId: Type.String({ description: "Id of the child goal whose branch should be merged." }),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await postJson(`/api/goals/${goalId}/integrate-child/${encodeURIComponent(params.childGoalId)}`, {});
				if (!result.ok) return err("goal_merge_child", result.status, result.data);
				return ok(result.data);
			} catch (e) {
				return netErr("goal_merge_child", e);
			}
		},
	});

	// ── goal_pause ────────────────────────────────────────────────────
	pi.registerTool({
		name: "goal_pause",
		label: "Pause Goal",
		description: [
			"Suspend verification-harness ticks for this goal-tree. Required by `strict` divergence",
			"policy before applying restructure mutations. Use sparingly — pausing halts all running",
			"child verifications.",
		].join(" "),
		promptSnippet: "Pause verification-harness ticks for this goal-tree.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const result = await postJson(`/api/goals/${goalId}/pause`, {});
				if (!result.ok) return err("goal_pause", result.status, result.data);
				return ok(result.data);
			} catch (e) {
				return netErr("goal_pause", e);
			}
		},
	});

	// ── goal_resume ───────────────────────────────────────────────────
	pi.registerTool({
		name: "goal_resume",
		label: "Resume Goal",
		description: "Resume verification-harness ticks for this goal-tree. Pair with `goal_pause`.",
		promptSnippet: "Resume verification-harness ticks for this goal-tree.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const result = await postJson(`/api/goals/${goalId}/resume`, {});
				if (!result.ok) return err("goal_resume", result.status, result.data);
				return ok(result.data);
			} catch (e) {
				return netErr("goal_resume", e);
			}
		},
	});
}
