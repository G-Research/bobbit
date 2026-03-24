/**
 * Team Lead tool extensions for Bobbit.
 *
 * Registers team management tools (spawn, dismiss, list, complete) for team lead
 * sessions only. Task and gate tools are in goal-tools.ts, which is loaded
 * automatically for ALL goal sessions.
 *
 * Calls the gateway REST API directly — no CLI wrapper needed.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// Also register goal-tools (task + gate management)
import goalTools from "./goal-tools.js";

export default function (pi: ExtensionAPI) {
	// Register goal tools first (task_list, task_create, gate_signal, etc.)
	goalTools(pi);

	// Self-signed TLS
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!sessionId || !goalId) {
		console.error("[team-lead-tools] Missing BOBBIT_SESSION_ID or BOBBIT_GOAL_ID — tools not registered");
		return;
	}

	let token: string;
	let baseUrl: string;
	try {
		const stateDir = process.env.BOBBIT_DIR
			? path.join(process.env.BOBBIT_DIR, "state")
			: path.join(homedir(), ".pi");
		const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
		const urlFile = process.env.BOBBIT_DIR ? "gateway-url" : "gateway-url";
		token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
		baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
	} catch {
		console.error("[team-lead-tools] Cannot read gateway credentials — tools not registered");
		return;
	}

	// ── HTTP helper ───────────────────────────────────────────────────
	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		const resp = await fetch(`${baseUrl}${urlPath}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		let data: unknown;
		try { data = JSON.parse(text); } catch { data = text; }
		if (!resp.ok) {
			const msg = typeof data === "object" && data !== null && "error" in data
				? String((data as Record<string, unknown>).error)
				: `HTTP ${resp.status}: ${text}`;
			throw new Error(msg);
		}
		return data;
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
		description: "Spawn a new role agent with its own git worktree. Returns the new session ID and worktree path. Optionally specify personalities to shape how the agent works. Returns 409 if workflowGateId is provided and its upstream dependency gates have not all passed.",
		promptSnippet: "Spawn a coder, reviewer, or tester agent with a task description and optional personalities.",
		parameters: Type.Object({
			role: Type.String({ description: "Agent role: 'coder', 'reviewer', or 'tester'" }),
			task: Type.String({ description: "Task description sent as the agent's first prompt" }),
			personalities: Type.Optional(Type.Array(Type.String(), { description: "Personality names (e.g. 'thorough', 'creative'). If omitted, uses the role's default personalities." })),
			workflowGateId: Type.Optional(Type.String({ description: "Gate ID this agent is working toward. If inputGateIds is not set, content from upstream passed gates is auto-injected as context." })),
			inputGateIds: Type.Optional(Type.Array(Type.String(), { description: "Gate IDs whose passed content should be injected into the agent's context. Overrides automatic DAG resolution." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { role: params.role, task: params.task };
				if (params.personalities && params.personalities.length > 0) body.personalities = params.personalities;
				if (params.workflowGateId) body.workflowGateId = params.workflowGateId;
				if (params.inputGateIds && params.inputGateIds.length > 0) body.inputGateIds = params.inputGateIds;
				return ok(await api("POST", `/api/goals/${goalId}/team/spawn`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_list",
		label: "List Team Agents",
		description: "List all active agents in the team with their role, status, worktree path, and task.",
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
		description: "Terminate a role agent and clean up its git worktree.",
		promptSnippet: "Dismiss (terminate) a team agent by session ID.",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID of the agent to dismiss" }),
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
		description: "Dismiss all role agents and mark the goal as complete. The team lead stays active to present a report.",
		promptSnippet: "Complete the team: dismiss all agents, keep team lead active.",
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
		description: "Send an urgent mid-turn redirect to a running agent. Only works when the agent is actively streaming (between tool calls). Use this for course corrections, clarifications, or priority changes that can't wait until the agent finishes. Fails if the agent is idle — use team_prompt instead.",
		promptSnippet: "Steer a running team agent with an urgent message (mid-turn only).",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID of the agent to steer" }),
			message: Type.String({ description: "Steering message — the agent sees this between tool calls" }),
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
		description: "Force-abort a stuck team agent that won't respond to steering. Use this when an agent is stuck in a long-running tool call and team_steer has no effect. The agent's process will be killed and restarted, and it will be ready for new prompts.",
		promptSnippet: "Force-abort a stuck team agent by session ID.",
		parameters: Type.Object({
			session_id: Type.String({ description: "The session ID of the agent to abort" }),
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
		description: "Send a prompt to a team agent. If the agent is idle, it starts working immediately. If the agent is busy, the message is queued and dispatched when the current turn ends. Use this to assign follow-up work, nudge idle agents, or queue instructions. Returns 409 if workflowGateId is provided and its upstream dependency gates have not all passed.",
		promptSnippet: "Send a prompt to a team agent (immediate if idle, queued if busy).",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID of the agent to prompt" }),
			message: Type.String({ description: "Prompt message for the agent" }),
			workflowGateId: Type.Optional(Type.String({ description: "Gate ID this agent is working toward. If inputGateIds is not set, content from upstream passed gates is auto-injected as context." })),
			inputGateIds: Type.Optional(Type.Array(Type.String(), { description: "Gate IDs whose passed content should be injected into the agent's context. Overrides automatic DAG resolution." })),
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

	pi.registerTool({
		name: "personalities_list",
		label: "List Personalities",
		description: "List all available personalities that can be applied to spawned agents. Each personality modifies how the agent approaches its work.",
		promptSnippet: "List all available personalities with descriptions.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", "/api/personalities"));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "personalities_create",
		label: "Create Personality",
		description: "Define a new personality that can be applied to agents via team_spawn.",
		promptSnippet: "Define a new personality for team agents.",
		parameters: Type.Object({
			name: Type.String({ description: "Lowercase alphanumeric + hyphens identifier" }),
			label: Type.String({ description: "Human-readable display name" }),
			description: Type.String({ description: "Short tooltip description" }),
			prompt_fragment: Type.String({ description: "1-2 sentences injected into the agent's system prompt" }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", "/api/personalities", {
					name: params.name,
					label: params.label,
					description: params.description,
					promptFragment: params.prompt_fragment,
				}));
			} catch (e: any) { return err(e.message); }
		},
	});

	console.log(`[team-lead-tools] Registered 9 team tools for session ${sessionId}, goal ${goalId}`);
}
