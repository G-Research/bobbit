/**
 * Bobbit gateway tool suite (three tiers).
 *
 * Registers three tools that wrap the Bobbit gateway REST API so agents can
 * drive the server without hand-rolling `curl`, resolving the gateway URL, or
 * hunting for the auth token:
 *
 *   - `bobbit_read`        (group Bobbit, grantPolicy allow) — GET-only introspection
 *   - `bobbit_orchestrate` (group Bobbit, grantPolicy never) — runtime state mutations
 *   - `bobbit_admin`       (group Bobbit, grantPolicy never) — config + destructive maintenance
 *
 * All three share the single `Bobbit` tool-group; tier separation is enforced
 * purely by each tool's grantPolicy (allow/never/never).
 *
 * Unlike `tasks`/`team`, this is a NORMAL built-in tool group: it does NOT gate
 * on BOBBIT_SESSION_ID / BOBBIT_GOAL_ID. It registers purely on gateway
 * credential availability (env or state files), exactly like `web`/`browser`.
 * Tier access is controlled by each tool's grantPolicy plus tool-group policies.
 *
 * See docs/design/bobbit-gateway-tool.md for the authoritative design.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/** Error carrying the gateway's HTTP status + machine-readable `code`. */
class ApiError extends Error {
	status: number;
	code?: string;
	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

type Params = Record<string, any>;

interface OpSpec {
	/** HTTP method, or a function of params for verb-multiplexed operations. */
	method: string | ((p: Params) => string);
	buildPath: (p: Params) => string;
	buildBody?: (p: Params) => unknown;
	/** Param names that must be present (non-empty) before dispatch. */
	required: string[];
}

/** Build a path with a query string, skipping undefined/null/"" values. */
function withQuery(base: string, entries: Array<[string, unknown]>): string {
	const qs = new URLSearchParams();
	for (const [k, v] of entries) {
		if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
	}
	const s = qs.toString();
	return s ? `${base}?${s}` : base;
}

// GET-only maintenance probes for bobbit_read.maintenance_inspect.
const PROBE_PATHS: Record<string, string> = {
	orphaned_worktrees: "/api/maintenance/orphaned-worktrees",
	orphaned_sessions: "/api/maintenance/orphaned-sessions",
	expired_archives: "/api/maintenance/expired-archives",
	orphaned_index_rows: "/api/maintenance/orphaned-index-rows",
	worktrees: "/api/maintenance/worktrees",
	archived_session_worktrees: "/api/maintenance/archived-session-worktrees",
	worktree_pool: "/api/worktree-pool",
	sandbox_pool: "/api/sandbox-pool",
	sandbox_status: "/api/sandbox-status",
	search_stats: "/api/search/stats",
};

// POST maintenance/search actions for bobbit_admin.maintenance_cleanup.
const CLEANUP_PATHS: Record<string, string> = {
	worktrees: "/api/maintenance/cleanup-worktrees",
	archived_session_worktrees: "/api/maintenance/cleanup-archived-session-worktrees",
	sessions: "/api/maintenance/cleanup-sessions",
	purge_archives: "/api/maintenance/purge-archives",
	cleanup_index_rows: "/api/maintenance/cleanup-index-rows",
	search_rebuild: "/api/search/rebuild",
	search_compact: "/api/search/compact",
};

// ── bobbit_read operation catalogue (all GET) ─────────────────────────
const READ_OPS: Record<string, OpSpec> = {
	health: { method: "GET", buildPath: () => "/api/health", required: [] },
	connection_info: { method: "GET", buildPath: () => "/api/connection-info", required: [] },
	list_goals: {
		method: "GET",
		buildPath: (p) => withQuery("/api/goals", [["archived", p.archived], ["q", p.q]]),
		required: [],
	},
	get_goal: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}`, required: ["goalId"] },
	goal_cost: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}/cost`, required: ["goalId"] },
	goal_git_status: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}/git-status`, required: ["goalId"] },
	goal_commits: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}/commits`, required: ["goalId"] },
	goal_pr_status: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}/pr-status`, required: ["goalId"] },
	list_sessions: {
		method: "GET",
		buildPath: (p) => withQuery("/api/sessions", [["include", p.include], ["q", p.q], ["projectId", p.projectId]]),
		required: [],
	},
	get_session: { method: "GET", buildPath: (p) => `/api/sessions/${p.sessionId}`, required: ["sessionId"] },
	session_cost: { method: "GET", buildPath: (p) => `/api/sessions/${p.sessionId}/cost`, required: ["sessionId"] },
	search: {
		method: "GET",
		buildPath: (p) =>
			withQuery("/api/search", [
				["q", p.q],
				["type", p.type],
				["limit", p.limit],
				["offset", p.offset],
				["projectId", p.projectId],
			]),
		required: ["q"],
	},
	list_projects: { method: "GET", buildPath: () => "/api/projects", required: [] },
	get_project: { method: "GET", buildPath: (p) => `/api/projects/${p.projectId}`, required: ["projectId"] },
	list_workflows: {
		method: "GET",
		buildPath: (p) => withQuery("/api/workflows", [["projectId", p.projectId]]),
		required: ["projectId"],
	},
	get_workflow: {
		method: "GET",
		buildPath: (p) => withQuery(`/api/workflows/${p.workflowId}`, [["projectId", p.projectId]]),
		required: ["workflowId"],
	},
	list_roles: { method: "GET", buildPath: () => "/api/roles", required: [] },
	list_tools: { method: "GET", buildPath: (p) => withQuery("/api/tools", [["projectId", p.projectId]]), required: [] },
	list_gates: {
		method: "GET",
		buildPath: (p) => withQuery(`/api/goals/${p.goalId}/gates`, [["view", p.view]]),
		required: ["goalId"],
	},
	list_tasks: {
		method: "GET",
		buildPath: (p) => withQuery(`/api/goals/${p.goalId}/tasks`, [["view", p.view]]),
		required: ["goalId"],
	},
	get_task: { method: "GET", buildPath: (p) => `/api/tasks/${p.taskId}`, required: ["taskId"] },
	list_staff: { method: "GET", buildPath: () => "/api/staff", required: [] },
	list_mcp_servers: { method: "GET", buildPath: () => "/api/mcp-servers", required: [] },
	maintenance_inspect: {
		method: "GET",
		buildPath: (p) => {
			const base = PROBE_PATHS[p.probe];
			if (!base) throw new Error(`unknown maintenance_inspect probe '${p.probe}'`);
			if (p.probe === "orphaned_index_rows" || p.probe === "search_stats") {
				return withQuery(base, [["projectId", p.projectId]]);
			}
			return base;
		},
		required: ["probe"],
	},
};

// ── bobbit_orchestrate operation catalogue ────────────────────────────
const ORCH_OPS: Record<string, OpSpec> = {
	create_goal: {
		method: "POST",
		buildPath: () => "/api/goals",
		buildBody: (p) => ({ projectId: p.projectId, title: p.title, ...(p.body ?? {}) }),
		required: ["projectId", "title"],
	},
	update_goal: {
		method: "PUT",
		buildPath: (p) => `/api/goals/${p.goalId}`,
		buildBody: (p) => p.body ?? {},
		required: ["goalId"],
	},
	archive_goal: {
		method: "DELETE",
		buildPath: (p) => withQuery(`/api/goals/${p.goalId}`, [["cascade", p.cascade], ["mergedManually", p.mergedManually]]),
		required: ["goalId", "cascade"],
	},
	create_session: {
		method: "POST",
		buildPath: () => "/api/sessions",
		buildBody: (p) => ({ projectId: p.projectId, ...(p.body ?? {}) }),
		required: ["projectId"],
	},
	terminate_session: { method: "DELETE", buildPath: (p) => `/api/sessions/${p.sessionId}`, required: ["sessionId"] },
	restart_session: { method: "POST", buildPath: (p) => `/api/sessions/${p.sessionId}/restart`, required: ["sessionId"] },
	create_task: {
		method: "POST",
		buildPath: (p) => `/api/goals/${p.goalId}/tasks`,
		buildBody: (p) => ({ title: p.title, type: p.type, ...(p.body ?? {}) }),
		required: ["goalId", "title", "type"],
	},
	update_task: {
		method: "PUT",
		buildPath: (p) => `/api/tasks/${p.taskId}`,
		buildBody: (p) => p.body ?? {},
		required: ["taskId"],
	},
	transition_task: {
		method: "POST",
		buildPath: (p) => `/api/tasks/${p.taskId}/transition`,
		buildBody: (p) => ({ state: p.state }),
		required: ["taskId", "state"],
	},
	assign_task: {
		method: "POST",
		buildPath: (p) => `/api/tasks/${p.taskId}/assign`,
		buildBody: (p) => ({ sessionId: p.sessionId }),
		required: ["taskId", "sessionId"],
	},
	signal_gate: {
		method: "POST",
		buildPath: (p) => `/api/goals/${p.goalId}/gates/${p.gateId}/signal`,
		buildBody: (p) => p.body ?? {},
		required: ["goalId", "gateId"],
	},
	reset_gate: {
		method: "POST",
		buildPath: (p) => `/api/goals/${p.goalId}/gates/${p.gateId}/reset`,
		required: ["goalId", "gateId"],
	},
	cancel_verification: {
		method: "POST",
		buildPath: (p) => `/api/goals/${p.goalId}/gates/${p.gateId}/cancel-verification`,
		required: ["goalId", "gateId"],
	},
	create_staff: {
		method: "POST",
		buildPath: () => "/api/staff",
		buildBody: (p) => ({ name: p.name, systemPrompt: p.systemPrompt, ...(p.body ?? {}) }),
		required: ["name", "systemPrompt"],
	},
	team_start: { method: "POST", buildPath: (p) => `/api/goals/${p.goalId}/team/start`, required: ["goalId"] },
	team_teardown: {
		method: "POST",
		buildPath: (p) => withQuery(`/api/goals/${p.goalId}/team/teardown`, [["cascade", p.cascade]]),
		required: ["goalId", "cascade"],
	},
};

// ── bobbit_admin operation catalogue ──────────────────────────────────
const ADMIN_OPS: Record<string, OpSpec> = {
	update_project_config: {
		method: "PUT",
		buildPath: (p) => `/api/projects/${p.projectId}/config`,
		buildBody: (p) => p.config ?? p.body ?? {},
		required: ["projectId", "config"],
	},
	set_provider_key: {
		method: "POST",
		buildPath: (p) => `/api/provider-keys/${encodeURIComponent(p.provider)}`,
		buildBody: (p) => ({ key: p.key }),
		required: ["provider", "key"],
	},
	delete_provider_key: {
		method: "DELETE",
		buildPath: (p) => `/api/provider-keys/${encodeURIComponent(p.provider)}`,
		required: ["provider"],
	},
	custom_providers: {
		method: (p) => (p.action === "list" ? "GET" : p.action === "delete" ? "DELETE" : "POST"),
		buildPath: (p) => {
			if (p.action === "delete") {
				const id = p.id ?? p.name;
				if (!id) throw new Error("custom_providers delete requires 'id'");
				return `/api/custom-providers/${encodeURIComponent(id)}`;
			}
			return "/api/custom-providers";
		},
		buildBody: (p) => (p.action === "upsert" ? (p.config ?? p.body) : undefined),
		required: ["action"],
	},
	aigw_configure: {
		method: (p) => (p.action === "remove" ? "DELETE" : "POST"),
		buildPath: () => "/api/aigw/configure",
		buildBody: (p) => (p.action === "remove" ? undefined : { url: p.url }),
		required: ["action"],
	},
	marketplace_install: {
		method: "POST",
		buildPath: () => "/api/marketplace/install",
		buildBody: (p) => ({ sourceId: p.sourceId, dirName: p.dirName, scope: p.scope, ...(p.projectId ? { projectId: p.projectId } : {}) }),
		required: ["sourceId", "dirName", "scope"],
	},
	marketplace_update: {
		method: "POST",
		buildPath: () => "/api/marketplace/update",
		buildBody: (p) => ({ packName: p.packName, scope: p.scope, ...(p.projectId ? { projectId: p.projectId } : {}) }),
		required: ["packName", "scope"],
	},
	marketplace_uninstall: {
		method: "DELETE",
		buildPath: () => "/api/marketplace/installed",
		buildBody: (p) => ({ packName: p.packName, scope: p.scope, ...(p.projectId ? { projectId: p.projectId } : {}) }),
		required: ["packName", "scope"],
	},
	tool_override: {
		method: "POST",
		buildPath: (p) => withQuery(`/api/tools/${encodeURIComponent(p.name)}/customize`, [["scope", p.scope], ["projectId", p.projectId]]),
		required: ["name"],
	},
	role_override: {
		method: "POST",
		buildPath: (p) => withQuery(`/api/roles/${encodeURIComponent(p.name)}/customize`, [["scope", p.scope], ["projectId", p.projectId]]),
		required: ["name"],
	},
	workflow_override: {
		method: "POST",
		buildPath: (p) => withQuery(`/api/workflows/${encodeURIComponent(p.workflowId)}/customize`, [["projectId", p.projectId]]),
		required: ["workflowId", "projectId"],
	},
	maintenance_cleanup: {
		method: "POST",
		buildPath: (p) => {
			const base = CLEANUP_PATHS[p.action];
			if (!base) throw new Error(`unknown maintenance_cleanup action '${p.action}'`);
			return base;
		},
		buildBody: (p) => p.body ?? (p.projectId ? { projectId: p.projectId } : undefined),
		required: ["action"],
	},
	sandbox_image_build: {
		method: "POST",
		buildPath: () => "/api/sandbox-image/build",
		buildBody: (p) => (p.projectId ? { projectId: p.projectId } : {}),
		required: [],
	},
	system_prompt_customise: { method: "POST", buildPath: () => "/api/system-prompt/customise", required: [] },
	harness_restart: { method: "POST", buildPath: () => "/api/harness/restart", required: [] },
	shutdown: { method: "POST", buildPath: () => "/api/shutdown", required: [] },
};

export default function (pi: ExtensionAPI) {
	// ── Credential / URL resolution (reuse tasks pattern, minus session gate) ──
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
			const urlFile = "gateway-url";
			token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
			baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
		} catch {
			console.error("[bobbit-tools] Cannot read gateway credentials — tools not registered");
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
		try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
		if (!resp.ok) {
			const structured = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
			const msg = structured && "error" in structured
				? `${structured.error}${structured.code ? ` [${structured.code}]` : ""} (HTTP ${resp.status})`
				: `HTTP ${resp.status}: ${text}`;
			throw new ApiError(msg, resp.status, structured?.code as string | undefined);
		}
		// 204 No Content / empty body → normalized success shape.
		if (resp.status === 204 || data === undefined) return { ok: true, status: resp.status };
		return data;
	}

	function ok(data: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: undefined };
	}
	function err(msg: string) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
	}

	/** Dispatch an operation through a tier's OpSpec table. */
	async function dispatch(ops: Record<string, OpSpec>, params: Params) {
		const spec = ops[params.operation];
		if (!spec) return err(`unknown operation '${params.operation}'`);
		for (const field of spec.required) {
			const v = params[field];
			if (v === undefined || v === null || v === "") {
				return err(`operation '${params.operation}' requires param '${field}'`);
			}
		}
		try {
			const method = typeof spec.method === "function" ? spec.method(params) : spec.method;
			const urlPath = spec.buildPath(params);
			const body = spec.buildBody ? spec.buildBody(params) : undefined;
			return ok(await api(method, urlPath, body));
		} catch (e: any) {
			return err(e.message);
		}
	}

	const opUnion = (ops: Record<string, OpSpec>) =>
		Type.Union(Object.keys(ops).map((o) => Type.Literal(o)), {
			description: "Gateway operation to run; see detail_docs for the catalogue.",
		});

	// ── bobbit_read ────────────────────────────────────────────────────
	pi.registerTool({
		name: "bobbit_read",
		label: "Bobbit Read",
		description: "Read-only gateway introspection: goals, sessions, projects, tasks, gates, search, maintenance probes.",
		promptSnippet: "Read gateway state by operation; see detail_docs for the catalogue.",
		parameters: Type.Object({
			operation: opUnion(READ_OPS),
			goalId: Type.Optional(Type.String({ description: "Goal id." })),
			sessionId: Type.Optional(Type.String({ description: "Session id." })),
			taskId: Type.Optional(Type.String({ description: "Task id." })),
			projectId: Type.Optional(Type.String({ description: "Project id." })),
			workflowId: Type.Optional(Type.String({ description: "Workflow id." })),
			q: Type.Optional(Type.String({ description: "Free-text query filter." })),
			type: Type.Optional(Type.String({ description: "search type: all|goals|sessions|messages|staff." })),
			limit: Type.Optional(Type.Number({ description: "search: max results." })),
			offset: Type.Optional(Type.Number({ description: "search: result offset." })),
			archived: Type.Optional(Type.Boolean({ description: "Include archived items." })),
			include: Type.Optional(Type.String({ description: "Inclusion flag, e.g. 'archived'." })),
			view: Type.Optional(Type.String({ description: "Response view, e.g. 'summary'." })),
			probe: Type.Optional(Type.String({ description: "maintenance_inspect probe selector." })),
		}),
		async execute(_id: string, params: Params) {
			return dispatch(READ_OPS, params);
		},
	});

	// ── bobbit_orchestrate ─────────────────────────────────────────────
	pi.registerTool({
		name: "bobbit_orchestrate",
		label: "Bobbit Orchestrate",
		description: "Mutate gateway runtime: goals, sessions, tasks, gates, staff, team lifecycle. Hidden unless enabled.",
		promptSnippet: "Mutate gateway runtime state by operation; see detail_docs.",
		parameters: Type.Object({
			operation: opUnion(ORCH_OPS),
			goalId: Type.Optional(Type.String({ description: "Goal id." })),
			sessionId: Type.Optional(Type.String({ description: "Session id." })),
			taskId: Type.Optional(Type.String({ description: "Task id." })),
			gateId: Type.Optional(Type.String({ description: "Gate id." })),
			projectId: Type.Optional(Type.String({ description: "Project id (required to create goals/sessions)." })),
			title: Type.Optional(Type.String({ description: "Title for create_goal / create_task." })),
			type: Type.Optional(Type.String({ description: "Task type for create_task." })),
			state: Type.Optional(Type.String({ description: "Target task state for transition_task." })),
			name: Type.Optional(Type.String({ description: "Staff name for create_staff." })),
			systemPrompt: Type.Optional(Type.String({ description: "System prompt for create_staff." })),
			cascade: Type.Optional(Type.Boolean({ description: "Cascade to descendants (archive/teardown)." })),
			mergedManually: Type.Optional(Type.Boolean({ description: "archive_goal: mark merged manually." })),
			body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
				description: "Operation body fields; see detail_docs per operation.",
			})),
		}),
		async execute(_id: string, params: Params) {
			return dispatch(ORCH_OPS, params);
		},
	});

	// ── bobbit_admin ───────────────────────────────────────────────────
	pi.registerTool({
		name: "bobbit_admin",
		label: "Bobbit Admin",
		description: "Config + destructive maintenance: project config, provider keys, marketplace, overrides, cleanup, restart.",
		promptSnippet: "High-privilege gateway config/maintenance by operation; see detail_docs.",
		parameters: Type.Object({
			operation: opUnion(ADMIN_OPS),
			projectId: Type.Optional(Type.String({ description: "Project id." })),
			workflowId: Type.Optional(Type.String({ description: "Workflow id." })),
			name: Type.Optional(Type.String({ description: "Resource name (tool/role)." })),
			provider: Type.Optional(Type.String({ description: "Provider id for provider-key ops." })),
			key: Type.Optional(Type.String({ description: "API key value for set_provider_key." })),
			scope: Type.Optional(Type.String({ description: "Config scope: server or project." })),
			action: Type.Optional(Type.String({ description: "Sub-action selector for grouped operations." })),
			id: Type.Optional(Type.String({ description: "Custom-provider id for delete." })),
			sourceId: Type.Optional(Type.String({ description: "Marketplace source id (install)." })),
			dirName: Type.Optional(Type.String({ description: "Marketplace pack dir name (install)." })),
			packName: Type.Optional(Type.String({ description: "Marketplace pack name (update/uninstall)." })),
			url: Type.Optional(Type.String({ description: "AI gateway URL for aigw_configure." })),
			config: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
				description: "Config key/values for update_project_config / custom_providers.",
			})),
			body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
				description: "Operation body fields; see detail_docs per operation.",
			})),
		}),
		async execute(_id: string, params: Params) {
			return dispatch(ADMIN_OPS, params);
		},
	});

	if (process.env.BOBBIT_DEBUG) {
		console.log("[bobbit-tools] Registered bobbit_read, bobbit_orchestrate, bobbit_admin");
	}
}

// Exposed for tests: the dispatched operation catalogue per tier (source of
// truth for the YAML detail_docs and the catalogue-drift guard).
export const BOBBIT_OPERATIONS = {
	bobbit_read: Object.keys(READ_OPS),
	bobbit_orchestrate: Object.keys(ORCH_OPS),
	bobbit_admin: Object.keys(ADMIN_OPS),
} as const;
