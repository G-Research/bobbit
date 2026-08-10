/** Compact, agent-facing projections for Bobbit gateway tool responses. */

export const COMPACT_TEXT_PREVIEW_CHARS = 200;
export const COMPACT_TRUNCATION_SUFFIX = "…(truncated)";

export type BobbitToolName = "bobbit_read" | "bobbit_orchestrate" | "bobbit_admin";

type ProfileName =
	| "goal"
	| "session"
	| "searchHit"
	| "task"
	| "gate"
	| "project"
	| "workflowSummary"
	| "workflowDetail"
	| "workflowGate"
	| "role"
	| "tool"
	| "staff"
	| "mcpServer"
	| "commit"
	| "generic"
	| "identity";

type ProjectionMode = "compact" | "list" | "detail";

export interface ProjectionSpec {
	profile: ProfileName;
	mode?: ProjectionMode;
	/** Entity profiles for named arrays in collection/envelope responses. */
	collections?: Readonly<Record<string, ProfileName>>;
}

const UNIVERSAL_KEEP_FIELDS = new Set([
	"id", "title", "name", "state", "status", "type", "projectId",
	"error", "code", "pagination", "total", "hasMore", "nextOffset",
	"nextCursor", "createdAt", "updatedAt", "lastActivity",
]);

const UNIVERSAL_DROP_FIELDS = new Set([
	"generation", "colorIndex", "accessory", "clientCount", "lastReadAt",
	"isCompacting", "spawnPinnedModel", "spawnPinnedThinkingLevel",
	"imageGenerationModel", "goalAssistant", "roleAssistant", "toolAssistant",
]);

const LIST_PROFILE_FIELDS: Readonly<Record<Exclude<ProfileName, "generic" | "identity">, ReadonlySet<string>>> = {
	goal: new Set([
		"id", "title", "state", "workflowId", "projectId", "parentGoalId", "rootGoalId",
		"archived", "archivedAt", "createdAt", "updatedAt", "setupError",
	]),
	session: new Set([
		"id", "title", "status", "assistantType", "role", "projectId", "goalId",
		"teamGoalId", "teamLeadSessionId", "taskId", "staffId", "delegateOf",
		"parentSessionId", "childKind", "readOnly", "reattemptGoalId", "archived",
		"archivedAt", "createdAt", "lastActivity",
		"lastTurnErrored", "consecutiveErrorTurns",
	]),
	searchHit: new Set([
		"id", "type", "title", "score", "projectId", "state", "status", "archived",
		"createdAt", "updatedAt", "lastActivity", "snippet",
	]),
	task: new Set([
		"id", "goalId", "parentTaskId", "title", "type", "state", "dependsOn",
		"assignedTo", "assignedSessionId", "workflowGateId", "inputGateIds",
		"createdAt", "updatedAt", "completedAt",
	]),
	gate: new Set([
		"id", "gateId", "goalId", "name", "type", "status", "state", "dependsOn",
		"assignedTo", "signalCount", "updatedAt", "hasContent", "contentLength",
		"whyBypassed", "bypassedAt", "optional", "phase", "awaitingSignoffCount",
		"passed", "failed", "pending", "running", "verifying", "verifyingCount", "total",
	]),
	project: new Set([
		"id", "name", "title", "state", "status", "createdAt", "updatedAt",
	]),
	workflowSummary: new Set([
		"id", "name", "title", "projectId", "type", "createdAt", "updatedAt",
	]),
	workflowDetail: new Set([
		"id", "name", "title", "projectId", "type", "createdAt", "updatedAt",
	]),
	workflowGate: new Set([
		"id", "name", "title", "type", "dependsOn", "optional", "phase",
	]),
	role: new Set([
		"id", "name", "label", "role", "type", "projectId", "status",
	]),
	tool: new Set([
		"id", "name", "label", "type", "group", "grantPolicy", "enabled", "status",
		"projectId",
	]),
	staff: new Set([
		"id", "name", "title", "status", "state", "role", "roleId", "projectId",
		"createdAt", "updatedAt", "lastActivity",
	]),
	mcpServer: new Set([
		"id", "name", "title", "type", "status", "projectId", "enabled", "error", "code",
	]),
	commit: new Set([
		"id", "sha", "shortSha", "hash", "title", "subject", "author", "createdAt",
		"timestamp", "status", "filesChanged", "insertions", "deletions",
	]),
};

const PROFILE_FIELDS: Readonly<Record<Exclude<ProfileName, "generic" | "identity">, ReadonlySet<string>>> = {
	goal: new Set([
		"id", "title", "state", "workflowId", "projectId", "branch", "mergeTarget",
		"setupStatus", "setupError", "paused", "parentGoalId", "rootGoalId", "archived",
		"archivedAt", "createdAt", "updatedAt", "spec",
	]),
	session: new Set([
		"id", "title", "status", "assistantType", "role", "projectId", "goalId",
		"teamGoalId", "teamLeadSessionId", "taskId", "staffId", "delegateOf",
		"parentSessionId", "childKind", "readOnly", "reattemptGoalId", "archived",
		"archivedAt", "createdAt", "updatedAt",
		"lastActivity", "startedAt", "completedAt", "streamingStartedAt",
		"lastTurnErrored", "consecutiveErrorTurns", "completedTurnCount",
		"manualRetryRequired", "transientRetryAttempts", "recoverDrainAttempts",
		"condition", "progress",
	]),
	searchHit: new Set([
		"id", "type", "title", "score", "projectId", "state", "status", "archived",
		"createdAt", "updatedAt", "lastActivity", "snippet",
	]),
	task: new Set([
		"id", "goalId", "parentTaskId", "title", "type", "state", "dependsOn",
		"assignedTo", "assignedSessionId", "workflowGateId", "inputGateIds", "branch",
		"baseSha", "headSha", "createdAt", "updatedAt", "completedAt", "spec",
		"resultSummary",
	]),
	gate: new Set([
		"id", "gateId", "goalId", "name", "type", "status", "state", "dependsOn",
		"assignedTo", "signalCount", "updatedAt", "hasContent", "contentLength",
		"whyBypassed", "whoAmI", "bypassedAt", "currentContent", "content",
		"optional", "phase", "injectDownstream", "awaitingSignoffCount", "passed",
		"failed", "pending", "running", "verifying", "verifyingCount", "total",
	]),
	project: new Set([
		"id", "name", "title", "state", "status", "primaryBranch", "defaultBranch",
		"baseRef", "createdAt", "updatedAt", "description",
	]),
	workflowSummary: new Set([
		"id", "name", "title", "projectId", "type", "createdAt", "updatedAt",
		"description",
	]),
	workflowDetail: new Set([
		"id", "name", "title", "projectId", "type", "createdAt", "updatedAt",
		"description", "gates",
	]),
	workflowGate: new Set([
		"id", "name", "title", "type", "dependsOn", "optional", "phase",
		"injectDownstream", "description", "content",
	]),
	role: new Set([
		"id", "name", "label", "role", "type", "projectId", "status", "toolPolicies",
		"description", "prompt", "promptTemplate", "systemPrompt",
	]),
	tool: new Set([
		"id", "name", "label", "type", "group", "grantPolicy", "provider", "enabled",
		"status", "projectId", "description", "summary",
	]),
	staff: new Set([
		"id", "name", "title", "status", "state", "role", "roleId", "projectId",
		"createdAt", "updatedAt", "lastActivity", "description", "triggers",
	]),
	mcpServer: new Set([
		"id", "name", "title", "type", "status", "projectId", "enabled",
		"description", "error", "code",
	]),
	commit: new Set([
		"id", "sha", "shortSha", "hash", "title", "subject", "message", "author",
		"createdAt", "timestamp", "status", "filesChanged", "insertions", "deletions",
	]),
};

const CANONICAL_ID_FIELDS = new Set([
	"id", "projectId", "goalId", "gateId", "taskId", "workflowId", "sessionId",
	"staffId", "teamGoalId", "parentGoalId", "parentTaskId", "parentSessionId", "roleId",
]);

const MACHINE_STRING_FIELDS = new Set([
	"id", "projectId", "goalId", "teamGoalId", "taskId", "gateId", "workflowId",
	"parentGoalId", "parentTaskId", "parentSessionId", "delegateOf", "assignedTo",
	"assignedSessionId", "workflowGateId", "roleId", "sessionId", "staffId",
	"state", "status", "type", "branch", "mergeTarget", "baseSha", "headSha",
	"sha", "shortSha", "hash", "cursor", "nextCursor", "createdAt", "updatedAt",
	"lastActivity", "archivedAt", "completedAt", "bypassedAt", "timestamp", "error", "code",
]);

const ENTITY_MARKERS: Readonly<Record<Exclude<ProfileName, "generic" | "identity">, readonly string[]>> = {
	goal: ["spec", "workflowId", "workflow", "setupStatus", "parentGoalId"],
	session: ["assistantType", "lastTurnErrored", "completedTurnCount", "delegateOf"],
	searchHit: ["score", "snippet"],
	task: ["dependsOn", "workflowGateId", "assignedSessionId", "resultSummary"],
	gate: ["gateId", "signalCount", "hasContent", "contentLength"],
	project: ["rootPath", "primaryBranch", "defaultBranch", "baseRef"],
	workflowSummary: ["gates", "description"],
	workflowDetail: ["gates", "description"],
	workflowGate: ["dependsOn", "optional", "phase", "injectDownstream"],
	role: ["toolPolicies", "promptTemplate", "systemPrompt"],
	tool: ["grantPolicy", "provider", "group"],
	staff: ["triggers", "roleId"],
	mcpServer: ["enabled", "tools"],
	commit: ["sha", "hash", "shortSha", "filesChanged"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function previewString(value: string): string {
	const chars = Array.from(value);
	return chars.length <= COMPACT_TEXT_PREVIEW_CHARS
		? value
		: `${chars.slice(0, COMPACT_TEXT_PREVIEW_CHARS).join("")}${COMPACT_TRUNCATION_SUFFIX}`;
}

function compactString(field: string | undefined, value: string): string {
	if (field && (MACHINE_STRING_FIELDS.has(field) || field.endsWith("Id") || field.endsWith("Ids") || field.endsWith("At"))) {
		return value;
	}
	return previewString(value);
}

function looksGoalOrSessionShaped(value: Record<string, unknown>): boolean {
	return "spec" in value || "setupStatus" in value || "assistantType" in value
		|| "completedTurnCount" in value || "consecutiveErrorTurns" in value
		|| ("id" in value && ("state" in value || "status" in value || "goalId" in value));
}

function isRedundantIdAlias(field: string, value: unknown, owner: Record<string, unknown>): boolean {
	return !CANONICAL_ID_FIELDS.has(field) && field.endsWith("Id")
		&& typeof owner.id === "string" && value === owner.id;
}

function sanitizeGeneric(value: unknown, field?: string, truncate = true): unknown {
	if (typeof value === "string") return truncate ? compactString(field, value) : value;
	if (Array.isArray(value)) return value.map((item) => sanitizeGeneric(item, undefined, truncate));
	if (!isRecord(value)) return value;

	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (UNIVERSAL_DROP_FIELDS.has(key) || isRedundantIdAlias(key, child, value)) continue;
		if (key === "workflow" && isRecord(child) && looksGoalOrSessionShaped(value)) continue;
		out[key] = sanitizeGeneric(child, key, truncate);
	}
	if (typeof value.workflowId !== "string" && isRecord(value.workflow) && looksGoalOrSessionShaped(value) && typeof value.workflow.id === "string") {
		out.workflowId = value.workflow.id;
	}
	return out;
}

function looksLikeEntity(value: Record<string, unknown>, profile: Exclude<ProfileName, "generic" | "identity">): boolean {
	if (typeof value.id === "string") return true;
	return ENTITY_MARKERS[profile].some((field) => field in value);
}

function projectEntity(
	value: unknown,
	profile: Exclude<ProfileName, "generic" | "identity">,
	mode: ProjectionMode = "compact",
): unknown {
	if (Array.isArray(value)) return value.map((item) => projectEntity(item, profile, mode));
	if (!isRecord(value)) return sanitizeGeneric(value, undefined, mode !== "detail");

	const allowed = mode === "list" ? LIST_PROFILE_FIELDS[profile] : PROFILE_FIELDS[profile];
	const out: Record<string, unknown> = {};
	// Restore failures may contain raw stacks, stderr, paths, and credentials. Agent
	// projections expose only the fact of failure; direct REST/UI data is unchanged.
	if (profile === "session" && value.restoreError) out.restoreFailed = true;
	for (const [key, child] of Object.entries(value)) {
		if (UNIVERSAL_DROP_FIELDS.has(key) || isRedundantIdAlias(key, child, value)) continue;
		if (key === "workflow" && (profile === "goal" || profile === "session")) continue;
		if (!allowed.has(key) && !UNIVERSAL_KEEP_FIELDS.has(key)
			&& !(mode === "compact" && profile === "project" && key === "rootPath")) continue;
		if (profile === "workflowDetail" && key === "gates" && Array.isArray(child)) {
			out.gates = child.map((gate) => projectEntity(gate, "workflowGate", mode));
			continue;
		}
		out[key] = sanitizeGeneric(child, key, mode !== "detail");
	}
	if ((profile === "goal" || profile === "session") && typeof value.workflowId !== "string" && isRecord(value.workflow) && typeof value.workflow.id === "string") {
		out.workflowId = value.workflow.id;
	}
	return out;
}

function projectProfileOrEnvelope(
	value: unknown,
	profile: Exclude<ProfileName, "generic" | "identity">,
	mode: ProjectionMode,
): unknown {
	if (!isRecord(value) || looksLikeEntity(value, profile)) return projectEntity(value, profile, mode);
	return sanitizeGeneric(value, undefined, mode !== "detail");
}

function valueAtPath(value: Record<string, unknown>, path: string): unknown {
	let current: unknown = value;
	for (const segment of path.split(".")) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function setValueAtPath(value: Record<string, unknown>, path: string, replacement: unknown): void {
	const segments = path.split(".");
	let current = value;
	for (const segment of segments.slice(0, -1)) {
		if (!isRecord(current[segment])) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1]] = replacement;
}

const LIST_ENVELOPE_FIELDS = new Set([
	"error", "code", "pagination", "count", "total", "hasMore", "nextOffset",
	"nextCursor", "createdAt", "updatedAt", "scannedAt", "checkedAt", "generatedAt",
]);

const LIST_DIAGNOSTIC_FIELDS = new Set([
	"level", "status", "state", "type", "code", "error", "message", "count",
]);

const LIST_SUMMARY_FIELDS = new Set([
	"status", "state", "passed", "failed", "pending", "running", "verifying",
	"verifyingCount", "total", "bypassed", "bypassedCount", "awaitingSignoffCount",
	"runningGateIds", "error", "code",
]);

const GOAL_SUMMARY_FIELDS = [
	"id", "title", "state", "projectId", "workflowId", "parentGoalId", "rootGoalId",
	"paused", "archived", "archivedAt", "setupStatus", "setupError", "createdAt", "updatedAt",
] as const;

const GIT_STATUS_SCALAR_FIELDS = [
	"branch", "primaryBranch", "isOnPrimary", "primaryRef", "hasUpstream",
	"ahead", "behind", "aheadOfPrimary", "behindPrimary", "mergedIntoPrimary",
	"insertionsVsPrimary", "deletionsVsPrimary", "clean", "summary", "unpushed",
	"partial", "untrackedIncluded",
] as const;

const GIT_STATUS_FRESHNESS_FIELDS = [
	"observedAt", "refreshedAt", "stale", "source", "ageMs",
] as const;

function projectGoalSummary(value: unknown): unknown {
	if (!isRecord(value)) return sanitizeGeneric(value);
	const out: Record<string, unknown> = {};
	for (const field of GOAL_SUMMARY_FIELDS) {
		let child = value[field];
		if (field === "workflowId" && typeof child !== "string" && isRecord(value.workflow)) child = value.workflow.id;
		if (child !== undefined) out[field] = sanitizeGeneric(child, field);
	}
	return out;
}

function projectGitStatusSummary(value: unknown): unknown {
	if (!isRecord(value)) return sanitizeGeneric(value);
	const aggregateSource = isRecord(value.aggregate) ? value.aggregate : value;
	const aggregate: Record<string, unknown> = {};
	for (const field of GIT_STATUS_SCALAR_FIELDS) {
		const child = aggregateSource[field];
		if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
			aggregate[field] = sanitizeGeneric(child, field);
		}
	}
	if (Array.isArray(aggregateSource.status)) aggregate.changedFiles = aggregateSource.status.length;

	const out: Record<string, unknown> = { aggregate };
	for (const field of GIT_STATUS_FRESHNESS_FIELDS) {
		const child = value[field];
		if (child !== undefined) out[field] = sanitizeGeneric(child, field);
	}
	if (value.lastError !== undefined) out.lastError = sanitizeGeneric(value.lastError, "lastError");
	return out;
}

function pickCompactFields(value: unknown, fields: ReadonlySet<string>): unknown {
	if (!isRecord(value)) return sanitizeGeneric(value);
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (fields.has(key)) out[key] = sanitizeGeneric(child, key);
	}
	return out;
}

const ARCHIVED_WORKTREE_SESSION_FIELDS = new Set([
	"id", "sessionId", "title", "name", "projectId", "goalId", "status", "state", "count",
]);
const ARCHIVED_WORKTREE_GROUP_FIELDS = new Set([
	"id", "key", "label", "name", "description", "count", "hasMore", "actionable", "status", "state",
]);

function projectArchivedSessionWorktrees(value: unknown): unknown {
	if (!isRecord(value)) return sanitizeGeneric(value);
	const out: Record<string, unknown> = {};
	if (Array.isArray(value.items)) out.items = value.items.map((item) => sanitizeGeneric(item));
	if (Array.isArray(value.sessions)) {
		out.sessions = value.sessions.map((session) => pickCompactFields(session, ARCHIVED_WORKTREE_SESSION_FIELDS));
	}
	if (Array.isArray(value.groups)) {
		out.groups = value.groups.map((group) => pickCompactFields(group, ARCHIVED_WORKTREE_GROUP_FIELDS));
	}
	for (const field of ["counts", "pagination", "generatedAt", "scannedAt", "checkedAt"] as const) {
		if (value[field] !== undefined) out[field] = sanitizeGeneric(value[field], field);
	}
	return out;
}

function projectListEnvelope(
	value: Record<string, unknown>,
	collections: Readonly<Record<string, ProfileName>>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (LIST_ENVELOPE_FIELDS.has(key)) out[key] = sanitizeGeneric(child, key);
	}
	if (Array.isArray(value.diagnostics)) {
		out.diagnostics = value.diagnostics.map((diagnostic) => {
			if (!isRecord(diagnostic)) return sanitizeGeneric(diagnostic);
			const projected: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(diagnostic)) {
				if (LIST_DIAGNOSTIC_FIELDS.has(key)) projected[key] = sanitizeGeneric(child, key);
			}
			return projected;
		});
	}
	if (isRecord(value.summary)) {
		const summary: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value.summary)) {
			if (LIST_SUMMARY_FIELDS.has(key)) summary[key] = sanitizeGeneric(child, key);
		}
		if (Object.keys(summary).length > 0) out.summary = summary;
	}
	for (const [path, profile] of Object.entries(collections)) {
		const collection = valueAtPath(value, path);
		if (Array.isArray(collection)) {
			setValueAtPath(out, path, projectEntity(collection, profile as Exclude<ProfileName, "generic" | "identity">, "list"));
		}
	}
	return out;
}

const generic = Object.freeze({ profile: "generic" as const });
const identity = Object.freeze({ profile: "identity" as const });
const goal = Object.freeze({ profile: "goal" as const });
const session = Object.freeze({ profile: "session" as const });
const task = Object.freeze({ profile: "task" as const });
const gate = Object.freeze({ profile: "gate" as const });
const project = Object.freeze({ profile: "project" as const });
const staff = Object.freeze({ profile: "staff" as const });

/** The sole operation-to-compact-projection map for all Bobbit gateway tools. */
export const BOBBIT_COMPACT_PROJECTIONS = {
	bobbit_read: {
		health: generic,
		connection_info: generic,
		list_goals: { profile: "generic", mode: "list", collections: { goals: "goal", archivedSessions: "session" } },
		get_goal: { profile: "goal", mode: "detail" },
		goal_cost: identity,
		goal_git_status: generic,
		goal_commits: { profile: "generic", mode: "list", collections: { commits: "commit" } },
		goal_pr_status: generic,
		list_sessions: { profile: "generic", mode: "list", collections: { sessions: "session", archivedDelegates: "session" } },
		get_session: { profile: "session", mode: "detail" },
		session_cost: identity,
		search: { profile: "generic", mode: "list", collections: { results: "searchHit" } },
		list_projects: { profile: "generic", mode: "list", collections: { projects: "project" } },
		get_project: { profile: "project", mode: "detail" },
		list_workflows: { profile: "generic", mode: "list", collections: { workflows: "workflowSummary" } },
		get_workflow: { profile: "workflowDetail", mode: "detail" },
		list_roles: { profile: "generic", mode: "list", collections: { roles: "role" } },
		list_tools: { profile: "generic", mode: "list", collections: { tools: "tool" } },
		list_gates: { profile: "generic", mode: "list", collections: { gates: "gate" } },
		list_tasks: { profile: "generic", mode: "list", collections: { tasks: "task" } },
		get_task: { profile: "task", mode: "detail" },
		list_staff: { profile: "generic", mode: "list", collections: { staff: "staff" } },
		list_mcp_servers: { profile: "generic", mode: "list", collections: { servers: "mcpServer" } },
		maintenance_inspect: generic,
	},
	bobbit_orchestrate: {
		create_goal: goal,
		update_goal: goal,
		archive_goal: generic,
		create_session: session,
		terminate_session: generic,
		restart_session: session,
		create_task: task,
		update_task: task,
		transition_task: task,
		assign_task: task,
		signal_gate: gate,
		reset_gate: generic,
		cancel_verification: generic,
		create_staff: staff,
		delete_staff: generic,
		team_start: generic,
		team_teardown: generic,
	},
	bobbit_admin: {
		create_project: project,
		update_project_config: generic,
		set_provider_key: generic,
		delete_provider_key: generic,
		custom_providers: generic,
		aigw_configure: generic,
		marketplace_install: generic,
		marketplace_update: generic,
		marketplace_uninstall: generic,
		tool_override: generic,
		role_override: generic,
		workflow_override: generic,
		maintenance_cleanup: generic,
		sandbox_image_build: generic,
		system_prompt_customise: generic,
		harness_restart: generic,
		shutdown: generic,
	},
} as const satisfies Record<BobbitToolName, Record<string, ProjectionSpec>>;

/** Apply the selected operation's compact projection. */
export function projectBobbitResponse(
	tool: BobbitToolName,
	operation: string,
	data: unknown,
	params: Readonly<Record<string, unknown>> = {},
): unknown {
	const spec = (BOBBIT_COMPACT_PROJECTIONS[tool] as Record<string, ProjectionSpec>)[operation];
	if (!spec) throw new Error(`missing compact projection for ${tool}.${operation}`);
	if (tool === "bobbit_read" && operation === "get_goal" && params.view === "summary") {
		return projectGoalSummary(data);
	}
	if (tool === "bobbit_read" && operation === "goal_git_status" && params.view === "summary") {
		return projectGitStatusSummary(data);
	}
	if (tool === "bobbit_read" && operation === "maintenance_inspect" && params.probe === "archived_session_worktrees") {
		return projectArchivedSessionWorktrees(data);
	}
	if (spec.profile === "identity") return data;

	const mode = spec.mode ?? "compact";
	if (spec.collections) {
		const primaryEntry = Object.entries(spec.collections)[0];
		if (Array.isArray(data) && primaryEntry) {
			return data.map((item) => projectEntity(item, primaryEntry[1] as Exclude<ProfileName, "generic" | "identity">, "list"));
		}
		if (!isRecord(data)) return sanitizeGeneric(data);
		return projectListEnvelope(data, spec.collections);
	}

	if (spec.profile === "generic") return sanitizeGeneric(data);
	return projectProfileOrEnvelope(data, spec.profile, mode);
}
