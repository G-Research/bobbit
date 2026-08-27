import type {
	HostGateSummary,
	HostGoalSummary,
	HostLookupResult,
	HostProjectRead,
	HostProjectSelector,
	HostSessionStatus,
	HostSessionSummary,
	HostStaffSummary,
	HostTaskSummary,
} from "../../shared/extension-host/host-api.js";
import type { PersistedGoal } from "../agent/goal-store.js";
import type { PersistedStaff } from "../agent/staff-store.js";
import { normalizeStaffAccessory } from "../agent/staff-store.js";
import type { PersistedTask } from "../agent/task-store.js";
import type { GateStatusSummaryGate } from "../gate-status-summary.js";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_IDS = 100;
const MAX_ID_LENGTH = 256;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/;
const SESSION_STATUSES = new Set<HostSessionStatus>([
	"starting",
	"preparing",
	"idle",
	"streaming",
	"aborting",
	"terminated",
	"archived",
]);

export type NormalizedHostProjectSelector =
	| { mode: "page"; cursor: number; limit: number }
	| { mode: "ids"; ids: readonly string[] };

export type HostProjectMissingIdStatus = "not-found" | "unauthorized";

/** Safe 400-class failure for a malformed caller-owned selector. */
export class HostProjectReadInputError extends TypeError {
	readonly code = "HOST_PROJECT_READ_INVALID_INPUT";
	readonly statusCode = 400;

	constructor(message = "Invalid project read selector") {
		super(message);
		this.name = "HostProjectReadInputError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every(key => allowedKeys.has(key));
}

function validId(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_ID_LENGTH
		&& SAFE_ID.test(value);
}

/** Validate and normalize the closed page-or-IDs selector contract. */
export function parseHostProjectSelector(value: unknown): NormalizedHostProjectSelector {
	if (value === undefined) return { mode: "page", cursor: 0, limit: DEFAULT_PAGE_LIMIT };
	if (!isRecord(value)) throw new HostProjectReadInputError();

	if (value.mode === "ids") {
		if (!hasOnlyKeys(value, ["mode", "ids"])
			|| !Array.isArray(value.ids)
			|| value.ids.length < 1
			|| value.ids.length > MAX_IDS
			|| !value.ids.every(validId)) {
			throw new HostProjectReadInputError();
		}
		return { mode: "ids", ids: [...value.ids] };
	}

	if (value.mode !== undefined && value.mode !== "page") throw new HostProjectReadInputError();
	if (!hasOnlyKeys(value, ["mode", "cursor", "limit"])) throw new HostProjectReadInputError();
	const cursor = value.cursor === undefined ? 0 : value.cursor;
	const limit = value.limit === undefined ? DEFAULT_PAGE_LIMIT : value.limit;
	if (!Number.isSafeInteger(cursor) || (cursor as number) < 0 || !Number.isSafeInteger(limit)) {
		throw new HostProjectReadInputError();
	}
	return {
		mode: "page",
		cursor: cursor as number,
		limit: Math.min(MAX_PAGE_LIMIT, Math.max(1, limit as number)),
	};
}

/**
 * Apply the shared bounded offset-page or complete exact-ID semantics to an
 * already-redacted, stable-order projection. Duplicate requested IDs remain
 * duplicate results. Foreign classification receives identity only.
 */
export function selectHostProjectRead<T>(
	items: readonly T[],
	selector: HostProjectSelector | undefined,
	idOf: (item: T) => string,
	missingStatus: (id: string) => HostProjectMissingIdStatus = () => "not-found",
): HostProjectRead<T> {
	const normalized = parseHostProjectSelector(selector);
	if (normalized.mode === "ids") {
		const byId = new Map<string, T>();
		for (const item of items) {
			const id = idOf(item);
			if (!byId.has(id)) byId.set(id, item);
		}
		const results: HostLookupResult<T>[] = normalized.ids.map(id => {
			const value = byId.get(id);
			return value === undefined
				? { id, status: missingStatus(id) }
				: { id, status: "found", value };
		});
		return { mode: "ids", results };
	}

	const total = items.length;
	const start = Math.min(normalized.cursor, total);
	const end = start + normalized.limit;
	const pageItems = items.slice(start, end);
	const hasMore = end < total;
	return {
		mode: "page",
		items: pageItems,
		page: {
			cursor: normalized.cursor,
			limit: normalized.limit,
			total,
			hasMore,
			...(hasMore ? { nextCursor: end } : {}),
		},
	};
}

/** Fresh allowlisted staff projection; prompts, paths, triggers, and metadata never cross. */
export function projectHostStaffSummary(staff: PersistedStaff): HostStaffSummary {
	return {
		id: staff.id,
		name: staff.name,
		state: staff.state,
		accessory: normalizeStaffAccessory(staff.accessory),
		createdAt: staff.createdAt,
		updatedAt: staff.updatedAt,
		...(staff.roleId === undefined ? {} : { roleId: staff.roleId }),
		...(staff.currentSessionId === undefined ? {} : { currentSessionId: staff.currentSessionId }),
		...(staff.lastWakeAt === undefined ? {} : { lastWakeAt: staff.lastWakeAt }),
	};
}

/** Structural source shared by live and archived canonical session lists. */
export interface HostSessionProjectionSource {
	id: string;
	title: string;
	status: string;
	createdAt: number;
	lastActivity: number;
	archived?: boolean;
	archivedAt?: number;
	goalId?: string;
	teamGoalId?: string;
	taskId?: string;
	staffId?: string;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	teamLeadSessionId?: string;
	role?: string;
	readOnly?: boolean;
	hasUnansweredQuestion?: boolean;
}

/** Return undefined rather than widening the contract when internal status is malformed. */
export function projectHostSessionSummary(session: HostSessionProjectionSource): HostSessionSummary | undefined {
	const archived = session.archived === true || session.status === "archived";
	const status: HostSessionStatus = archived ? "archived" : session.status as HostSessionStatus;
	if (!SESSION_STATUSES.has(status)) return undefined;
	return {
		id: session.id,
		title: session.title,
		status,
		createdAt: session.createdAt,
		lastActivity: session.lastActivity,
		archived,
		...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
		...(session.goalId === undefined ? {} : { goalId: session.goalId }),
		...(session.teamGoalId === undefined ? {} : { teamGoalId: session.teamGoalId }),
		...(session.taskId === undefined ? {} : { taskId: session.taskId }),
		...(session.staffId === undefined ? {} : { staffId: session.staffId }),
		...(session.delegateOf === undefined ? {} : { delegateOf: session.delegateOf }),
		...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
		...(session.childKind === undefined ? {} : { childKind: session.childKind }),
		...(session.teamLeadSessionId === undefined ? {} : { teamLeadSessionId: session.teamLeadSessionId }),
		...(session.role === undefined ? {} : { role: session.role }),
		...(session.readOnly === undefined ? {} : { readOnly: session.readOnly }),
		...(session.hasUnansweredQuestion === undefined ? {} : { hasUnansweredQuestion: session.hasUnansweredQuestion }),
	};
}

/** Fresh allowlisted goal projection; workflow bodies, specs, git, paths, and metadata never cross. */
export function projectHostGoalSummary(goal: PersistedGoal): HostGoalSummary {
	return {
		id: goal.id,
		title: goal.title,
		state: goal.state,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		team: goal.team === true,
		archived: goal.archived === true,
		...(goal.archivedAt === undefined ? {} : { archivedAt: goal.archivedAt }),
		...(goal.workflowId === undefined ? {} : { workflowId: goal.workflowId }),
		...(goal.parentGoalId === undefined ? {} : { parentGoalId: goal.parentGoalId }),
		...(goal.rootGoalId === undefined ? {} : { rootGoalId: goal.rootGoalId }),
		...(goal.teamLeadSessionId === undefined ? {} : { teamLeadSessionId: goal.teamLeadSessionId }),
		...(goal.setupStatus === undefined ? {} : { setupStatus: goal.setupStatus }),
		...(goal.paused === undefined ? {} : { paused: goal.paused }),
		...(goal.mergeConflict === undefined ? {} : { mergeConflict: goal.mergeConflict }),
	};
}

/** Fresh allowlisted task core shared with first-party summary semantics. */
export function projectHostTaskSummary(task: PersistedTask): HostTaskSummary {
	return {
		id: task.id,
		goalId: task.goalId,
		title: task.title,
		type: task.type,
		state: task.state,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		dependsOn: [...(task.dependsOn ?? [])],
		...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
		...(task.assignedSessionId === undefined ? {} : { assignedSessionId: task.assignedSessionId }),
		...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
		...(task.workflowGateId === undefined ? {} : { workflowGateId: task.workflowGateId }),
	};
}

/** Copy only the safe gate-summary fields, deliberately excluding failedSteps evidence. */
export function projectHostGateSummary(gate: GateStatusSummaryGate): HostGateSummary {
	return {
		gateId: gate.gateId,
		status: gate.status,
		effectiveStatus: gate.effectiveStatus,
		running: gate.running,
		awaitingSignoffCount: gate.awaitingSignoffCount,
		dependsOn: [...gate.dependsOn],
		signalCount: gate.signalCount,
		...(gate.name === undefined ? {} : { name: gate.name }),
		...(gate.updatedAt === undefined ? {} : { updatedAt: gate.updatedAt }),
	};
}
