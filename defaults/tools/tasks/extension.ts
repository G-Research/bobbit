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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
		description: "List all tasks for the current goal as a slim summary.",
		promptSnippet: "List all tasks for the goal.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/tasks?view=summary`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "task_create",
		label: "Create Task",
		description: "Create a new task. Types: implementation, code-review, testing, bug-fix, refactor, custom.",
		promptSnippet: "Create a task with title, type, optional spec, and dependencies.",
		parameters: Type.Object({
			title: Type.String(),
			type: Type.String({ description: "implementation, code-review, testing, bug-fix, refactor, or custom." }),
			spec: Type.Optional(Type.String()),
			depends_on: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on." })),
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
		description: "Update task fields, assignment, and/or state. States: todo, in-progress, blocked, complete, skipped.",
		promptSnippet: "Update task fields, assign to a session, and/or transition state.",
		parameters: Type.Object({
			task_id: Type.String(),
			title: Type.Optional(Type.String()),
			spec: Type.Optional(Type.String()),
			result_summary: Type.Optional(Type.String()),
			head_sha: Type.Optional(Type.String({ description: "HEAD commit SHA of finished work." })),
			assigned_to: Type.Optional(Type.String({ description: "Session ID to assign to." })),
			state: Type.Optional(Type.String({ description: "todo, in-progress, blocked, complete, or skipped." })),
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
		description: "List all gates for the current goal as a slim summary.",
		promptSnippet: "List all gates for the goal with status.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/gates?view=summary`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "gate_status",
		label: "Gate Status",
		description: "Get latest signal details for a gate. Use gate_inspect for full content or history.",
		promptSnippet: "Get gate status, latest verification results, and metadata.",
		parameters: Type.Object({
			gate_id: Type.String(),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/gates/${params.gate_id}?view=summary`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "gate_signal",
		label: "Signal Gate",
		description: "Signal a gate ready for verification. Triggers async verification.",
		promptSnippet: "Signal a gate for verification with optional content and metadata.",
		parameters: Type.Object({
			gate_id: Type.String(),
			content: Type.Optional(Type.String({ description: "Markdown for content gates." })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Key-value metadata for metadata gates." })),
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

	pi.registerTool({
		name: "gate_inspect",
		label: "Inspect Gate",
		description: "Read gate content, verification output, or signal history.",
		promptSnippet: "Read detailed gate data: content, verification output, or signal history.",
		parameters: Type.Object({
			gate_id: Type.String(),
			section: Type.Union([
				Type.Literal("content"),
				Type.Literal("verification"),
				Type.Literal("signals"),
			]),
			signal_index: Type.Optional(Type.Number({ description: "0-based, negative from end. Default -1 (latest)." })),
			step: Type.Optional(Type.String({ description: "Verification step name to scope to (section=verification only)." })),
			mode: Type.Optional(Type.Union([
				Type.Literal("full"),
				Type.Literal("grep"),
				Type.Literal("head"),
				Type.Literal("tail"),
				Type.Literal("slice"),
			], { description: "Retrieval mode. Default is bounded tail." })),
			pattern: Type.Optional(Type.String({ description: "Regex pattern for mode=grep." })),
			context: Type.Optional(Type.Number({ description: "Surrounding context lines for mode=grep." })),
			max_results: Type.Optional(Type.Number({ description: "Maximum matching lines for mode=grep." })),
			lines: Type.Optional(Type.Number({ description: "Line count for mode=head or mode=tail." })),
			from: Type.Optional(Type.Number({ description: "1-indexed start line for mode=slice." })),
			to: Type.Optional(Type.Number({ description: "1-indexed inclusive end line for mode=slice." })),
		}),
		async execute(_id, params) {
			try {
				const qs = new URLSearchParams({ section: params.section });
				if (params.signal_index !== undefined) qs.set("signal_index", String(params.signal_index));
				if (params.step !== undefined) qs.set("step", String(params.step));
				if (params.mode !== undefined) qs.set("mode", String(params.mode));
				if (params.pattern !== undefined) qs.set("pattern", String(params.pattern));
				if (params.context !== undefined) qs.set("context", String(params.context));
				if (params.max_results !== undefined) qs.set("max_results", String(params.max_results));
				if (params.lines !== undefined) qs.set("lines", String(params.lines));
				if (params.from !== undefined) qs.set("from", String(params.from));
				if (params.to !== undefined) qs.set("to", String(params.to));
				return ok(await api("GET", `/api/goals/${goalId}/gates/${params.gate_id}/inspect?${qs}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	// ── verification_result ──────────────────────────────────────────
	pi.registerTool({
		name: "verification_result",
		label: "Verification Result",
		description: "Submit verification result when review or QA testing is complete.",
		promptSnippet: "Submit verification verdict, summary, and optional HTML report.",
		parameters: Type.Object({
			verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
			summary: Type.String({ description: "Markdown findings: what was reviewed, issues with file:line, rationale." }),
			report_html: Type.Optional(Type.String({ description: "Self-contained HTML report. Mutually exclusive with report_html_file." })),
			report_html_file: Type.Optional(Type.String({ description: "Absolute path to HTML report file. Use for large reports." })),
		}),
		async execute(_id, params) {
			if (params.report_html && params.report_html_file) {
				return err("Provide either report_html or report_html_file, not both.");
			}
			try {
				const body: Record<string, unknown> = { sessionId, verdict: params.verdict, summary: params.summary };
				if (params.report_html) body.report_html = params.report_html;
				if (params.report_html_file) body.report_html_file = params.report_html_file;
				return ok(await api("POST", "/api/internal/verification-result", body));
			} catch (e: any) { return err(e.message); }
		},
	});

	console.log(`[goal-tools] Registered 8 task/gate tools for session ${sessionId}, goal ${goalId}`);
}
