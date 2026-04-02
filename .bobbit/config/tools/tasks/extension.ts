/**
 * Goal tool extensions for Bobbit.
 *
 * Registers task and gate management tools for ANY session associated
 * with a goal. Loaded automatically via --extension when a session has a goalId.
 *
 * Team-specific tools (team_spawn, team_dismiss, etc.) live in team-lead-tools.ts
 * and are only loaded for team lead sessions.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!sessionId || !goalId) {
		return;
	}

	let token: string;
	let baseUrl: string;
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		token = envToken;
		baseUrl = envUrl.replace(/\/+$/, "");
	} else {
		try {
			const stateDir = process.env.BOBBIT_DIR
				? path.join(process.env.BOBBIT_DIR, "state")
				: path.join(homedir(), ".pi");
			const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
			const urlFile = process.env.BOBBIT_DIR ? "gateway-url" : "gateway-url";
			token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
			baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
		} catch {
			console.error("[goal-tools] Cannot read gateway credentials — tools not registered");
			return;
		}
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

	// ── Task tools ────────────────────────────────────────────────────

	pi.registerTool({
		name: "task_list",
		label: "List Tasks",
		description: "List all tasks for the current goal with their state, type, assignment, and dependencies.",
		promptSnippet: "List all tasks for the goal.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/tasks`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "task_create",
		label: "Create Task",
		description: [
			"Create a new task for the goal.",
			"Types: implementation, code-review, testing, bug-fix, refactor, custom.",
		].join(" "),
		promptSnippet: "Create a task with title, type, optional spec, and dependencies.",
		parameters: Type.Object({
			title: Type.String({ description: "Short task title" }),
			type: Type.String({ description: "Task type: implementation, code-review, testing, bug-fix, refactor, or custom" }),
			spec: Type.Optional(Type.String({ description: "Detailed specification for the task" })),
			depends_on: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on" })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { title: params.title, type: params.type };
				if (params.spec) body.spec = params.spec;
				if (params.depends_on?.length) body.dependsOn = params.depends_on;
				return ok(await api("POST", `/api/goals/${goalId}/tasks`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Update Task",
		description: [
			"Update a task's fields, assignment, and/or state in a single call.",
			"Provide any combination: field updates (title, spec, result_summary, head_sha),",
			"assignment (assigned_to session ID), and/or state transition (state).",
			"States: todo, in-progress, blocked, complete, skipped.",
		].join(" "),
		promptSnippet: "Update task fields, assign to a session, and/or transition state.",
		parameters: Type.Object({
			task_id: Type.String({ description: "Task ID" }),
			title: Type.Optional(Type.String({ description: "New title" })),
			spec: Type.Optional(Type.String({ description: "New spec" })),
			result_summary: Type.Optional(Type.String({ description: "Summary of results" })),
			head_sha: Type.Optional(Type.String({ description: "HEAD commit SHA of your finished work" })),
			assigned_to: Type.Optional(Type.String({ description: "Session ID to assign task to" })),
			state: Type.Optional(Type.String({ description: "Transition to: todo, in-progress, blocked, complete, skipped" })),
		}),
		async execute(_id, params) {
			try {
				const { task_id, assigned_to, state, ...fields } = params;
				const updateBody: Record<string, unknown> = {};
				if (fields.title !== undefined) updateBody.title = fields.title;
				if (fields.spec !== undefined) updateBody.spec = fields.spec;
				if (fields.result_summary !== undefined) updateBody.resultSummary = fields.result_summary;
				if (fields.head_sha !== undefined) updateBody.headSha = fields.head_sha;
				if (Object.keys(updateBody).length > 0) {
					await api("PUT", `/api/tasks/${task_id}`, updateBody);
				}
				if (assigned_to) {
					await api("POST", `/api/tasks/${task_id}/assign`, { sessionId: assigned_to });
				}
				if (state) {
					await api("POST", `/api/tasks/${task_id}/transition`, { state });
				}
				return ok(await api("GET", `/api/tasks/${task_id}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	// ── Gate tools ────────────────────────────────────────────────────

	pi.registerTool({
		name: "gate_list",
		label: "List Gates",
		description: "List all gates for the current goal with their status, dependencies, and signal count.",
		promptSnippet: "List all gates for the goal with status.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/gates`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "gate_status",
		label: "Gate Status",
		description: "Get current status of a specific gate (pending/passed/failed) plus latest verification results and signal history.",
		promptSnippet: "Get gate status, verification results, and signal history.",
		parameters: Type.Object({
			gate_id: Type.String({ description: "Gate ID (e.g. 'issue-analysis', 'implementation')" }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/gates/${params.gate_id}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "gate_signal",
		label: "Signal Gate",
		description: [
			"Signal that a gate is ready for verification.",
			"For content gates, provide markdown content.",
			"For metadata gates, provide key-value metadata.",
			"Triggers async verification. Returns signal info.",
		].join(" "),
		promptSnippet: "Signal a gate for verification with optional content and metadata.",
		parameters: Type.Object({
			gate_id: Type.String({ description: "Gate ID to signal (e.g. 'issue-analysis', 'reproducing-test')" }),
			content: Type.Optional(Type.String({ description: "Markdown content for content gates" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Key-value metadata (e.g. { test_command: 'npm test' })" })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { sessionId };
				if (params.content) body.content = params.content;
				if (params.metadata) body.metadata = params.metadata;
				return ok(await api("POST", `/api/goals/${goalId}/gates/${params.gate_id}/signal`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	// ── verification_result ──────────────────────────────────────────
	pi.registerTool({
		name: "verification_result",
		label: "Verification Result",
		description: "Submit your verification result when your review or QA testing is complete. The verification system receives your results through this tool.",
		promptSnippet: "Submit verification verdict, summary, and optional HTML report.",
		parameters: Type.Object({
			verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")], { description: "Whether verification passed or failed" }),
			summary: Type.String({ description: "Detailed markdown summary of findings — what was reviewed, specific issues found (with file:line references), and verdict rationale" }),
			report_html: Type.Optional(Type.String({ description: "Self-contained HTML report with embedded screenshots (for QA agents)" })),
		}),
		async execute(_id, params) {
			try {
				const body = { sessionId, verdict: params.verdict, summary: params.summary, report_html: params.report_html };
				return ok(await api("POST", "/api/internal/verification-result", body));
			} catch (e: any) { return err(e.message); }
		},
	});

	console.log(`[goal-tools] Registered 7 task/gate tools for session ${sessionId}, goal ${goalId}`);
}
