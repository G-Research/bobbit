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

interface PageSpec {
	/** Primary array key exposed in the response and pagination metadata. */
	itemKey: string;
	/** Optional nested path to the array; defaults to [itemKey]. */
	itemPath?: string[];
	/** Default page size for this operation. */
	defaultLimit?: number;
	/** Maximum page size for this operation. */
	maxLimit?: number;
	/** Whether this operation should use cursor (`after`) pagination for these params. */
	cursor?: boolean | ((p: Params) => boolean);
}

interface OpSpec {
	/** HTTP method, or a function of params for verb-multiplexed operations. */
	method: string | ((p: Params) => string);
	buildPath: (p: Params) => string;
	buildBody?: (p: Params) => unknown;
	/** Param names that must be present (non-empty) before dispatch. */
	required: string[];
	/** Optional response sanitizer applied before tool pagination. */
	postProcess?: (data: unknown, params: Params) => unknown;
	/** Optional tool-output pagination for list-style read operations. */
	page?: PageSpec | ((p: Params) => PageSpec | undefined);
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

type PageMode = "offset" | "cursor";

interface NormalizedPaging {
	limit: number;
	offset: number;
	cursor?: string | number;
	mode: PageMode;
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

function parseInteger(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	const n = parseInteger(value) ?? fallback;
	return Math.min(Math.max(n, min), max);
}

function isCursorPaging(params: Params, spec: PageSpec): boolean {
	return typeof spec.cursor === "function" ? spec.cursor(params) : spec.cursor === true;
}

function normalizePaging(params: Params, spec: PageSpec): NormalizedPaging {
	const limit = clampInteger(params.limit, spec.defaultLimit ?? DEFAULT_PAGE_LIMIT, 1, spec.maxLimit ?? MAX_PAGE_LIMIT);
	const offset = Math.max(0, parseInteger(params.offset) ?? 0);
	const rawCursor = params.cursor ?? params.after;
	const cursor = rawCursor !== undefined && rawCursor !== null && rawCursor !== "" ? rawCursor as string | number : undefined;
	const mode: PageMode = isCursorPaging(params, spec) ? "cursor" : "offset";
	return { limit, offset, cursor, mode };
}

function appendPagingQuery(base: string, entries: Array<[string, unknown]>, params: Params, spec: PageSpec): string {
	const paging = normalizePaging(params, spec);
	const pagingEntries: Array<[string, unknown]> = [["limit", paging.limit]];
	if (paging.mode === "cursor" && paging.cursor !== undefined) {
		pagingEntries.push(["after", paging.cursor]);
	} else {
		pagingEntries.push(["offset", paging.offset]);
	}
	return withQuery(base, [...entries, ...pagingEntries]);
}

function getAtPath(value: unknown, itemPath: string[]): unknown {
	let current = value as any;
	for (const key of itemPath) {
		if (current === undefined || current === null) return undefined;
		current = current[key];
	}
	return current;
}

function setAtPath(value: Record<string, unknown>, itemPath: string[], replacement: unknown): Record<string, unknown> {
	const clone: Record<string, unknown> = Array.isArray(value) ? [...value] as any : { ...value };
	let current: any = clone;
	for (let i = 0; i < itemPath.length - 1; i += 1) {
		const key = itemPath[i];
		const next = current[key];
		current[key] = next && typeof next === "object" ? (Array.isArray(next) ? [...next] : { ...next }) : {};
		current = current[key];
	}
	current[itemPath[itemPath.length - 1]] = replacement;
	return clone;
}

function numberField(source: unknown, field: string): number | undefined {
	if (!source || typeof source !== "object") return undefined;
	const value = (source as Record<string, unknown>)[field];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(source: unknown, field: string): boolean | undefined {
	if (!source || typeof source !== "object") return undefined;
	const value = (source as Record<string, unknown>)[field];
	return typeof value === "boolean" ? value : undefined;
}

function valueField(source: unknown, field: string): string | number | undefined {
	if (!source || typeof source !== "object") return undefined;
	const value = (source as Record<string, unknown>)[field];
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function sliceByPath(data: unknown, spec: PageSpec, paging: NormalizedPaging): {
	result: unknown;
	items: unknown[];
	total?: number;
	hasRestPagination: boolean;
	pagedBy: "rest" | "tool";
	start: number;
	sourceLength: number;
} | undefined {
	const itemPath = spec.itemPath ?? [spec.itemKey];
	const pagination = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).pagination : undefined;
	const hasRestPagination = Boolean(
		pagination
		|| numberField(data, "total") !== undefined
		|| booleanField(data, "hasMore") !== undefined
		|| valueField(data, "nextCursor") !== undefined
		|| numberField(data, "nextOffset") !== undefined,
	);
	const sourceItems = Array.isArray(data) ? data : getAtPath(data, itemPath);
	if (!Array.isArray(sourceItems)) return undefined;

	const start = hasRestPagination ? 0 : paging.mode === "offset" ? paging.offset : 0;
	const end = start + paging.limit;
	const shouldSlice = !hasRestPagination;
	const items = shouldSlice ? sourceItems.slice(start, end) : sourceItems;
	const total = numberField(data, "total") ?? numberField(pagination, "total") ?? (hasRestPagination ? undefined : sourceItems.length);
	const pagedBy = shouldSlice ? "tool" : "rest";
	const result = Array.isArray(data)
		? { [spec.itemKey]: items }
		: setAtPath(data as Record<string, unknown>, itemPath, items);
	return { result, items, total, hasRestPagination, pagedBy, start, sourceLength: sourceItems.length };
}

function pageResult(data: unknown, params: Params, spec: PageSpec): unknown {
	const paging = normalizePaging(params, spec);
	const sliced = sliceByPath(data, spec, paging);
	if (!sliced) return data;
	const pagination = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).pagination : undefined;
	const total = sliced.total;
	const computedHasMore = (sliced.start + sliced.items.length) < (total ?? sliced.sourceLength);
	const topLevelHasMore = booleanField(data, "hasMore") ?? booleanField(pagination, "hasMore");
	const hasMore = Boolean(sliced.pagedBy === "tool" ? (topLevelHasMore || computedHasMore) : (topLevelHasMore ?? computedHasMore));
	const nextOffset = paging.mode === "offset" && hasMore
		? numberField(data, "nextOffset") ?? numberField(pagination, "nextOffset") ?? paging.offset + sliced.items.length
		: undefined;
	const nextCursor = paging.mode === "cursor"
		? valueField(data, "nextCursor") ?? valueField(pagination, "nextCursor")
		: undefined;
	return {
		...(sliced.result as Record<string, unknown>),
		pagination: {
			limit: paging.limit,
			...(paging.mode === "offset" ? { offset: paging.offset } : {}),
			...(total !== undefined ? { total } : {}),
			hasMore,
			...(nextOffset !== undefined ? { nextOffset } : {}),
			...(paging.mode === "cursor" && paging.cursor !== undefined ? { cursor: paging.cursor } : {}),
			...(nextCursor !== undefined ? { nextCursor } : {}),
			mode: paging.mode,
			itemKey: spec.itemKey,
			pagedBy: sliced.pagedBy,
		},
	};
}

function includeHasArchived(include: unknown): boolean {
	return String(include ?? "")
		.split(",")
		.some((part) => part.trim() === "archived");
}

/** True for boolean `true` or a case-insensitive "true" string (query params arrive as strings). */
function isTruthyFlag(value: unknown): boolean {
	return value === true || String(value ?? "").toLowerCase() === "true";
}

function searchIncludesArchived(params: Params): boolean {
	return isTruthyFlag(params.includeArchived) || includeHasArchived(params.include);
}

function isArchivedRow(row: unknown): boolean {
	return Boolean(row && typeof row === "object" && (row as Record<string, unknown>).archived === true);
}

/**
 * Decrement a `total` counter, but ONLY when it counted exactly the array we
 * just filtered (full-list responses where total === array length). For
 * REST-paginated responses `total` is a grand total spanning pages, so
 * subtracting page-level removals would corrupt it — and the downstream
 * hasMore/nextOffset math derived from it. In that case leave `total` untouched.
 */
function adjustFullListTotal(container: Record<string, unknown>, originalLength: number, removed: number): void {
	const total = container.total;
	if (typeof total === "number" && Number.isFinite(total) && total === originalLength) {
		container.total = Math.max(0, total - removed);
	}
}

function filterArchivedRows(data: unknown, itemKey: string, stripKeys: string[] = []): unknown {
	if (Array.isArray(data)) return data.filter((row) => !isArchivedRow(row));
	if (!data || typeof data !== "object") return data;

	const source = data as Record<string, unknown>;
	const rows = source[itemKey];
	const out: Record<string, unknown> = { ...source };
	if (Array.isArray(rows)) {
		const filtered = rows.filter((row) => !isArchivedRow(row));
		const removed = rows.length - filtered.length;
		out[itemKey] = filtered;
		if (removed > 0) {
			adjustFullListTotal(out, rows.length, removed);
			if (out.pagination && typeof out.pagination === "object" && !Array.isArray(out.pagination)) {
				const pagination = { ...(out.pagination as Record<string, unknown>) };
				adjustFullListTotal(pagination, rows.length, removed);
				out.pagination = pagination;
			}
		}
	}
	for (const key of stripKeys) delete out[key];
	return out;
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

const MAINTENANCE_PROJECT_FILTER_PROBES = new Set(["orphaned_index_rows", "search_stats", "worktree_pool", "sandbox_status"]);

const MAINTENANCE_PAGE_SPECS: Record<string, PageSpec | undefined> = {
	orphaned_worktrees: { itemKey: "worktrees" },
	orphaned_sessions: { itemKey: "sessions" },
	orphaned_index_rows: { itemKey: "sample" },
	archived_session_worktrees: { itemKey: "worktrees" },
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
		buildPath: (p) => appendPagingQuery("/api/goals", [["archived", p.archived], ["q", p.q], ["projectId", p.projectId]], p, {
			itemKey: "goals",
			cursor: (params) => isTruthyFlag(params.archived),
		}),
		required: [],
		postProcess: (data, p) => isTruthyFlag(p.archived) ? data : filterArchivedRows(data, "goals", ["archivedSessions"]),
		page: (p) => ({ itemKey: "goals", cursor: isTruthyFlag(p.archived) }),
	},
	get_goal: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}`, required: ["goalId"] },
	goal_cost: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}/cost`, required: ["goalId"] },
	goal_git_status: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}/git-status`, required: ["goalId"] },
	goal_commits: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}/commits`, required: ["goalId"] },
	goal_pr_status: { method: "GET", buildPath: (p) => `/api/goals/${p.goalId}/pr-status`, required: ["goalId"] },
	list_sessions: {
		method: "GET",
		buildPath: (p) => appendPagingQuery("/api/sessions", [["include", p.include], ["q", p.q], ["projectId", p.projectId]], p, {
			itemKey: "sessions",
			cursor: (params) => includeHasArchived(params.include),
		}),
		required: [],
		postProcess: (data, p) => includeHasArchived(p.include) ? data : filterArchivedRows(data, "sessions", ["archivedDelegates"]),
		page: (p) => ({ itemKey: "sessions", cursor: includeHasArchived(p.include) }),
	},
	get_session: { method: "GET", buildPath: (p) => `/api/sessions/${p.sessionId}`, required: ["sessionId"] },
	session_cost: { method: "GET", buildPath: (p) => `/api/sessions/${p.sessionId}/cost`, required: ["sessionId"] },
	search: {
		method: "GET",
		buildPath: (p) => appendPagingQuery("/api/search", [["q", p.q], ["type", p.type], ["projectId", p.projectId], ["includeArchived", searchIncludesArchived(p)]], p, {
			itemKey: "results",
			defaultLimit: DEFAULT_SEARCH_LIMIT,
			maxLimit: MAX_SEARCH_LIMIT,
		}),
		required: ["q"],
		postProcess: (data, p) => searchIncludesArchived(p) ? data : filterArchivedRows(data, "results"),
		page: { itemKey: "results", defaultLimit: DEFAULT_SEARCH_LIMIT, maxLimit: MAX_SEARCH_LIMIT },
	},
	list_projects: { method: "GET", buildPath: () => "/api/projects", required: [], page: { itemKey: "projects" } },
	get_project: { method: "GET", buildPath: (p) => `/api/projects/${p.projectId}`, required: ["projectId"] },
	list_workflows: {
		method: "GET",
		buildPath: (p) => withQuery("/api/workflows", [["projectId", p.projectId]]),
		required: ["projectId"],
		page: { itemKey: "workflows" },
	},
	get_workflow: {
		method: "GET",
		buildPath: (p) => withQuery(`/api/workflows/${p.workflowId}`, [["projectId", p.projectId]]),
		required: ["workflowId"],
	},
	list_roles: { method: "GET", buildPath: (p) => withQuery("/api/roles", [["projectId", p.projectId]]), required: [], page: { itemKey: "roles" } },
	list_tools: { method: "GET", buildPath: (p) => withQuery("/api/tools", [["projectId", p.projectId]]), required: [], page: { itemKey: "tools" } },
	list_gates: {
		method: "GET",
		buildPath: (p) => withQuery(`/api/goals/${p.goalId}/gates`, [["view", p.view]]),
		required: ["goalId"],
		page: { itemKey: "gates" },
	},
	list_tasks: {
		method: "GET",
		buildPath: (p) => withQuery(`/api/goals/${p.goalId}/tasks`, [["view", p.view]]),
		required: ["goalId"],
		page: { itemKey: "tasks" },
	},
	get_task: { method: "GET", buildPath: (p) => `/api/tasks/${p.taskId}`, required: ["taskId"] },
	list_staff: { method: "GET", buildPath: (p) => withQuery("/api/staff", [["projectId", p.projectId]]), required: [], page: { itemKey: "staff" } },
	list_mcp_servers: { method: "GET", buildPath: (p) => withQuery("/api/mcp-servers", [["projectId", p.projectId]]), required: [], page: { itemKey: "servers" } },
	maintenance_inspect: {
		method: "GET",
		buildPath: (p) => {
			const base = PROBE_PATHS[p.probe];
			if (!base) throw new Error(`unknown maintenance_inspect probe '${p.probe}'`);
			return MAINTENANCE_PROJECT_FILTER_PROBES.has(p.probe)
				? withQuery(base, [["projectId", p.projectId]])
				: base;
		},
		required: ["probe"],
		page: (p) => MAINTENANCE_PAGE_SPECS[p.probe],
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
	delete_staff: {
		method: "DELETE",
		buildPath: (p) => `/api/staff/${encodeURIComponent(p.staffId)}`,
		required: ["staffId"],
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
	create_project: {
		method: "POST",
		buildPath: () => "/api/projects",
		buildBody: (p) => ({ ...(p.body ?? {}), name: p.name, rootPath: p.rootPath }),
		required: ["name", "rootPath"],
	},
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

	function resolvePageSpec(spec: OpSpec, params: Params): PageSpec | undefined {
		return typeof spec.page === "function" ? spec.page(params) : spec.page;
	}

	/** Dispatch an operation through a tier's OpSpec table. */
	async function dispatch(ops: Record<string, OpSpec>, params: Params, options?: { pageResults?: boolean }) {
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
			const data = await api(method, urlPath, body);
			const processed = spec.postProcess ? spec.postProcess(data, params) : data;
			const pageSpec = options?.pageResults ? resolvePageSpec(spec, params) : undefined;
			return ok(pageSpec ? pageResult(processed, params, pageSpec) : processed);
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
			limit: Type.Optional(Type.Number({ description: "Page size. Defaults: lists 50, search 20; max: lists 200, search 100." })),
			offset: Type.Optional(Type.Number({ description: "Offset for list operations. Defaults to 0; ignored when cursor/after is used." })),
			after: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Cursor for cursor-backed list operations." })),
			cursor: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Alias for after on cursor-backed list operations." })),
			archived: Type.Optional(Type.Boolean({ description: "Include archived items." })),
			include: Type.Optional(Type.String({ description: "Inclusion flag, e.g. 'archived'." })),
			includeArchived: Type.Optional(Type.Boolean({ description: "REST-style search archive opt-in." })),
			view: Type.Optional(Type.String({ description: "Response view, e.g. 'summary'." })),
			probe: Type.Optional(Type.String({ description: "maintenance_inspect probe selector." })),
		}),
		async execute(_id: string, params: Params) {
			return dispatch(READ_OPS, params, { pageResults: true });
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
			staffId: Type.Optional(Type.String({ description: "Staff id for delete_staff." })),
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
			name: Type.Optional(Type.String({ description: "Resource name (tool/role) or project name for create_project." })),
			rootPath: Type.Optional(Type.String({ description: "Project root path for create_project." })),
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
