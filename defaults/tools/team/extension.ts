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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readGatewayCreds, apiCall } from "../_shared/gateway.js";

export default function (pi: ExtensionAPI) {
	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!sessionId || !goalId) {
		console.error("[team-lead-tools] BOBBIT_GOAL_ID / BOBBIT_SESSION_ID missing — tools not registered");
		return;
	}

	const credsResult = readGatewayCreds();
	if ("error" in credsResult) {
		console.error(`[team-lead-tools] Cannot read gateway credentials — tools not registered: ${credsResult.error}`);
		return;
	}
	const creds = credsResult;

	// ── HTTP helper ───────────────────────────────────────────────────
	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		return apiCall(creds, method, urlPath, body);
	}

	function ok(data: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: undefined };
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
		description: "Terminate a role agent and clean up its worktree.",
		promptSnippet: "Dismiss (terminate) a team agent by session ID.",
		parameters: Type.Object({
			session_id: Type.String(),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/team/dismiss`, { sessionId: params.session_id }));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_complete",
		label: "Complete Team",
		description: "Dismiss all role agents and mark the goal complete; team lead stays active. All spawned subgoals must first be resolved via goal_merge_child or goal_archive_child (else 409 HAS_LIVE_CHILDREN).",
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
		description: "Send an urgent mid-turn redirect to a streaming agent. Fails if idle; use team_prompt.",
		promptSnippet: "Steer a running team agent with an urgent message (mid-turn only).",
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
		description: "Prompt a team agent. Runs immediately if idle, else queues for next turn.",
		promptSnippet: "Send a prompt to a team agent (immediate if idle, queued if busy).",
		parameters: Type.Object({
			session_id: Type.String(),
			message: Type.String(),
			workflowGateId: Type.Optional(Type.String({ description: "Gate the agent works toward; auto-injects upstream gate content." })),
			inputGateIds: Type.Optional(Type.Array(Type.String(), { description: "Override DAG: gate IDs whose content to inject as context." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { sessionId: params.session_id, message: params.message };
				if (params.workflowGateId) body.workflowGateId = params.workflowGateId;
				if (params.inputGateIds?.length) body.inputGateIds = params.inputGateIds;
				return ok(await api("POST", `/api/goals/${goalId}/team/prompt`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	console.log(`[team-lead-tools] Registered 7 team tools for session ${sessionId}, goal ${goalId}`);
}
