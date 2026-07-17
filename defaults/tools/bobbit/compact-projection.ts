/** Compact, agent-facing projections for Bobbit gateway tool responses. */

export const COMPACT_TEXT_PREVIEW_CHARS = 200;
export const COMPACT_TRUNCATION_SUFFIX = "…(truncated; pass verbose:true)";

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

export interface ProjectionSpec {
	profile: ProfileName;
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

const PROFILE_FIELDS: Readonly<Record<Exclude<ProfileName, "generic" | "identity">, ReadonlySet<string>>> = {
	goal: new Set([
		"id", "title", "state", "workflowId", "projectId", "branch", "mergeTarget",
		"setupStatus", "setupError", "team", "paused", "parentGoalId", "rootGoalId", "archived",
		"archivedAt", "createdAt", "updatedAt", "spec",
	]),
	session: new Set([
		"id", "title", "status", "assistantType", "role", "projectId", "goalId",
		"teamGoalId", "taskId", "delegateOf", "parentSessionId", "archived",
		"archivedAt", "createdAt", "lastActivity", "lastTurnErrored",
		"consecutiveErrorTurns", "completedTurnCount", "restoreError",
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
		"id", "name", "title", "state", "status", "rootPath", "primaryBranch",
		"defaultBranch", "baseRef", "createdAt", "updatedAt", "description",
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

function sanitizeGeneric(value: unknown, field?: string): unknown {
	if (typeof value === "string") return compactString(field, value);
	if (Array.isArray(value)) return value.map((item) => sanitizeGeneric(item));
	if (!isRecord(value)) return value;

	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (UNIVERSAL_DROP_FIELDS.has(key) || isRedundantIdAlias(key, child, value)) continue;
		if (key === "verify") continue;
		if (key === "workflow" && isRecord(child) && looksGoalOrSessionShaped(value)) continue;
		out[key] = sanitizeGeneric(child, key);
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

function projectEntity(value: unknown, profile: Exclude<ProfileName, "generic" | "identity">): unknown {
	if (Array.isArray(value)) return value.map((item) => projectEntity(item, profile));
	if (!isRecord(value)) return sanitizeGeneric(value);

	const allowed = PROFILE_FIELDS[profile];
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (UNIVERSAL_DROP_FIELDS.has(key) || isRedundantIdAlias(key, child, value)) continue;
		if (key === "workflow" && (profile === "goal" || profile === "session")) continue;
		if (!allowed.has(key) && !UNIVERSAL_KEEP_FIELDS.has(key)) continue;
		if (profile === "workflowDetail" && key === "gates" && Array.isArray(child)) {
			out.gates = child.map((gate) => projectEntity(gate, "workflowGate"));
			continue;
		}
		out[key] = sanitizeGeneric(child, key);
	}
	if ((profile === "goal" || profile === "session") && typeof value.workflowId !== "string" && isRecord(value.workflow) && typeof value.workflow.id === "string") {
		out.workflowId = value.workflow.id;
	}
	return out;
}

function projectProfileOrEnvelope(value: unknown, profile: Exclude<ProfileName, "generic" | "identity">): unknown {
	if (!isRecord(value) || looksLikeEntity(value, profile)) return projectEntity(value, profile);
	return sanitizeGeneric(value);
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
		list_goals: { profile: "generic", collections: { goals: "goal", archivedSessions: "session" } },
		get_goal: goal,
		goal_cost: identity,
		goal_git_status: generic,
		goal_commits: { profile: "generic", collections: { commits: "commit" } },
		goal_pr_status: generic,
		list_sessions: { profile: "generic", collections: { sessions: "session", archivedDelegates: "session" } },
		get_session: session,
		session_cost: identity,
		search: { profile: "generic", collections: { results: "searchHit" } },
		list_projects: { profile: "generic", collections: { projects: "project" } },
		get_project: project,
		list_workflows: { profile: "generic", collections: { workflows: "workflowSummary" } },
		get_workflow: { profile: "workflowDetail" },
		list_roles: { profile: "generic", collections: { roles: "role" } },
		list_tools: { profile: "generic", collections: { tools: "tool" } },
		list_gates: { profile: "generic", collections: { gates: "gate", "summary.gates": "gate" } },
		list_tasks: { profile: "generic", collections: { tasks: "task" } },
		get_task: task,
		list_staff: { profile: "generic", collections: { staff: "staff" } },
		list_mcp_servers: { profile: "generic", collections: { servers: "mcpServer" } },
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
export function projectBobbitResponse(tool: BobbitToolName, operation: string, data: unknown): unknown {
	const spec = (BOBBIT_COMPACT_PROJECTIONS[tool] as Record<string, ProjectionSpec>)[operation];
	if (!spec) throw new Error(`missing compact projection for ${tool}.${operation}`);
	if (spec.profile === "identity") return data;

	if (spec.collections) {
		const primaryEntry = Object.entries(spec.collections)[0];
		if (Array.isArray(data) && primaryEntry) return data.map((item) => projectEntity(item, primaryEntry[1] as Exclude<ProfileName, "generic" | "identity">));
		if (!isRecord(data)) return sanitizeGeneric(data);
		const projected = sanitizeGeneric(data) as Record<string, unknown>;
		for (const [path, profile] of Object.entries(spec.collections)) {
			const collection = valueAtPath(data, path);
			if (Array.isArray(collection)) {
				setValueAtPath(projected, path, projectEntity(collection, profile as Exclude<ProfileName, "generic" | "identity">));
			}
		}
		return projected;
	}

	if (spec.profile === "generic") return sanitizeGeneric(data);
	return projectProfileOrEnvelope(data, spec.profile);
}
