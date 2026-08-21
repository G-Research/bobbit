import type { Component } from "./project-config-store.js";
import type { PersistedGoal } from "./goal-store.js";
import { snapshotPersistedInlineRoles, validateInlineRoles } from "./inline-role-validator.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { ProjectRegistry, RegisteredProject } from "./project-registry.js";
import { resolveProjectForRequest, validateExecutionCwd, type CwdOwnershipSource } from "./resolve-project.js";
import { checkCanSpawnChild, clampMaxDepth, inheritedChildOverrides, type SubgoalNestingPrefs } from "./subgoal-nesting-limit.js";
import { freezeWorkflowDefinition } from "./workflow-validator.js";
import type { Workflow } from "./workflow-store.js";
import type { Role } from "./role-store.js";
import { validateGoalProposalWorkflow } from "../proposals/goal-proposal-seed.js";
import { validateGoalInlineWorkflow } from "../proposals/proposal-types.js";

// Goal creation historically accepted descriptive titles without the shorter
// agent-facing naming guidance. Keep that guidance advisory while bounding the
// persisted/API value to prevent unbounded payloads.
export const MAX_GOAL_TITLE_LENGTH = 256;
export const MAX_GOAL_SPEC_LENGTH = 20_000;
// Ordinary root-goal payloads share the server/store's 1 MiB contract. The
// tighter MAX_INLINE_JSON_BYTES limit belongs only to child-plan spawning.
export const MAX_GOAL_STRUCTURED_BYTES = 1024 * 1024;

export type GoalCandidateSource =
	| { kind: "user-input" }
	| { kind: "current-session-promotion"; sessionId: string; serverDerivedProjectId: string; serverDerivedCwd: string }
	/** Server-owned child coordinates after the parent has been authenticated/resolved. */
	| { kind: "server-child"; parentGoalId: string; cwdAuthority: "goal" | "verification" };

export interface GoalCandidateTrustedSnapshots {
	/**
	 * Provenance is supplied only by server code after reading an existing draft
	 * or goal. Request bodies never populate this contract.
	 */
	kind: "persisted-proposal" | "inherited-goal";
	inlineWorkflow?: unknown;
	inlineRoles?: unknown;
}

export interface GoalCandidateContext {
	source: GoalCandidateSource;
	/** Authenticated parent authorization. Omit only for human/operator validation. */
	authorizeParent?: (parent: PersistedGoal) => true | GoalCandidateError;
	/** Host-derived unchanged snapshots; never derive this from request fields. */
	trustedSnapshots?: GoalCandidateTrustedSnapshots;
}

export interface GoalCandidateDeps {
	registry: ProjectRegistry;
	projectContextManager: ProjectContextManager;
	/** Workflows exposed by the project cascade (used for listings/errors). */
	workflows(projectId: string): Workflow[];
	/** Exact creation-time lookup, including store-only/hidden runtime entries. */
	workflow(projectId: string, workflowId: string): Workflow | undefined;
	/** Read-only defaults that creation would persist when the current store is empty. */
	defaultWorkflows(projectId: string): Workflow[];
	components(projectId: string): Component[];
	getGoal(id: string): PersistedGoal | undefined;
	nestingPrefs(): SubgoalNestingPrefs;
}

export interface RawGoalCandidate extends Record<string, unknown> {
	title?: unknown; spec?: unknown; projectId?: unknown; cwd?: unknown;
	workflow?: unknown; workflowId?: unknown; inlineWorkflow?: unknown;
	options?: unknown; enabledOptionalSteps?: unknown; parentGoalId?: unknown;
	inlineRoles?: unknown; subgoalsAllowed?: unknown; maxNestingDepth?: unknown;
	divergencePolicy?: unknown; maxConcurrentChildren?: unknown; metadata?: unknown;
}

export interface ValidatedGoalCandidate {
	title: string; spec: string; projectId: string; project: RegisteredProject; cwd: string;
	workflowId?: string; workflow?: Workflow; preserveWorkflowSnapshot?: boolean; enabledOptionalSteps?: string[];
	/** Creation must persist the validated in-memory defaults if the store is still empty. */
	seedDefaultWorkflows?: boolean;
	parentGoalId?: string; parent?: PersistedGoal; inlineRoles?: Record<string, Role>;
	subgoalsAllowed?: boolean; maxNestingDepth?: number;
	divergencePolicy?: "strict" | "balanced" | "autonomous";
	maxConcurrentChildren?: number; metadata?: Record<string, unknown>;
}

export interface GoalCandidateError { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> }
export type GoalCandidateResult = { ok: true; candidate: ValidatedGoalCandidate } | GoalCandidateError;

function fail(status: number, code: string, message: string, details?: Record<string, unknown>): GoalCandidateError {
	return { ok: false, status, code, message, ...(details ? { details } : {}) };
}
function plainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
function supplied(raw: RawGoalCandidate, key: keyof RawGoalCandidate): boolean {
	return Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined;
}
function jsonSnapshot(value: unknown, label: string, code: string): { ok: true; value: any } | GoalCandidateError {
	let json: string | undefined;
	try { json = JSON.stringify(value); } catch { return fail(400, code, `${label} must be JSON-serializable`); }
	if (json === undefined) return fail(400, code, `${label} must be JSON-serializable`);
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > MAX_GOAL_STRUCTURED_BYTES) return fail(400, code, `${label} exceeds the maximum size of ${MAX_GOAL_STRUCTURED_BYTES} bytes`, { limit: MAX_GOAL_STRUCTURED_BYTES, actual: bytes });
	return { ok: true, value: JSON.parse(json) };
}

function trustedJsonSnapshot(value: unknown, label: string, code: string): { ok: true; value: any } | GoalCandidateError {
	let json: string | undefined;
	try { json = JSON.stringify(value); } catch { return fail(400, code, `${label} must be JSON-serializable`); }
	if (json === undefined) return fail(400, code, `${label} must be JSON-serializable`);
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > MAX_GOAL_STRUCTURED_BYTES) return fail(400, code, `${label} exceeds the maximum size of ${MAX_GOAL_STRUCTURED_BYTES} bytes`, { limit: MAX_GOAL_STRUCTURED_BYTES, actual: bytes });
	return { ok: true, value: structuredClone(value) };
}

/** Canonical, read-only validation for every goal-creation-equivalent candidate. */
export function validateGoalCandidate(raw: RawGoalCandidate, context: GoalCandidateContext, deps: GoalCandidateDeps): GoalCandidateResult {
	const title = typeof raw.title === "string" ? raw.title.trim() : "";
	if (!title) return fail(400, "TITLE_REQUIRED", "title must be a non-empty string");
	if (title.length > MAX_GOAL_TITLE_LENGTH) return fail(400, "TITLE_TOO_LONG", `title exceeds the maximum length of ${MAX_GOAL_TITLE_LENGTH} characters`, { limit: MAX_GOAL_TITLE_LENGTH, actual: title.length });
	const spec = raw.spec === undefined || raw.spec === null ? "" : raw.spec;
	if (typeof spec !== "string") return fail(400, "SPEC_INVALID", "spec must be a string");
	if (spec.length > MAX_GOAL_SPEC_LENGTH) return fail(400, "SPEC_TOO_LONG", `spec exceeds the maximum length of ${MAX_GOAL_SPEC_LENGTH} characters`, { limit: MAX_GOAL_SPEC_LENGTH, actual: spec.length });

	if (supplied(raw, "projectId") && typeof raw.projectId !== "string") {
		return fail(400, "PROJECT_ID_REQUIRED", "projectId must be a non-empty string");
	}
	const resolved = resolveProjectForRequest(deps.registry, { projectId: raw.projectId });
	if (!resolved.ok) return fail(resolved.status, resolved.code, resolved.error);
	if (context.source.kind === "current-session-promotion" && resolved.projectId !== context.source.serverDerivedProjectId) return fail(422, "PROJECT_SCOPE_MISMATCH", "projectId does not match the server-owned promotion project");
	const requestedCwd = typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : resolved.project.rootPath;
	if (raw.cwd !== undefined && typeof raw.cwd !== "string") return fail(422, "CWD_OUTSIDE_PROJECT", "cwd must be a path string inside the selected project");
	let cwdSource: CwdOwnershipSource = { kind: "user-input" };
	if (context.source.kind === "current-session-promotion") cwdSource = { kind: "session", sessionId: context.source.sessionId };
	if (context.source.kind === "server-child") cwdSource = { kind: context.source.cwdAuthority, goalId: context.source.parentGoalId };
	const cwdResult = validateExecutionCwd(deps.registry, deps.projectContextManager, resolved.projectId, requestedCwd, cwdSource);
	if (!cwdResult.ok) return fail(cwdResult.status, cwdResult.code, cwdResult.error);
	if (context.source.kind === "current-session-promotion") {
		const owned = validateExecutionCwd(deps.registry, deps.projectContextManager, resolved.projectId, context.source.serverDerivedCwd, cwdSource);
		const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
		if (!owned.ok || comparable(cwdResult.cwd ?? requestedCwd) !== comparable(owned.cwd ?? context.source.serverDerivedCwd)) return fail(422, "CWD_OUTSIDE_PROJECT", "cwd does not match the server-owned promotion worktree");
	}

	const parentGoalId = typeof raw.parentGoalId === "string" && raw.parentGoalId.trim() ? raw.parentGoalId.trim() : undefined;
	if (supplied(raw, "parentGoalId") && !parentGoalId) return fail(422, "PARENT_NOT_FOUND", "parentGoalId must be a non-empty string");
	if (context.source.kind === "server-child" && parentGoalId !== context.source.parentGoalId) return fail(422, "PARENT_SCOPE_MISMATCH", "parentGoalId does not match the server-owned child parent");
	let parent: PersistedGoal | undefined;
	const prefs = deps.nestingPrefs();
	if (parentGoalId) {
		parent = deps.getGoal(parentGoalId);
		if (!parent) return fail(422, "PARENT_NOT_FOUND", "Parent goal not found");
		if (parent.projectId !== resolved.projectId) return fail(422, "PARENT_CROSS_PROJECT", "Parent goal belongs to a different project. Select a parent in the same project.");
		const authorized = context.authorizeParent?.(parent);
		if (authorized !== undefined && authorized !== true) return authorized;
		let cursor: PersistedGoal | undefined = parent;
		const seen = new Set<string>();
		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			if (cursor.paused) return fail(409, "GOAL_PAUSED", `Goal "${cursor.title}" is paused`, { goalId: cursor.id });
			cursor = cursor.parentGoalId ? deps.getGoal(cursor.parentGoalId) : undefined;
		}
		const nesting = checkCanSpawnChild(parent, prefs, deps.getGoal);
		if (!nesting.ok) {
			if (nesting.code === "SUBGOALS_DISABLED") return fail(422, nesting.code, "Subgoals are disabled");
			if (nesting.code === "PARENT_SUBGOALS_DISABLED") return fail(422, nesting.code, `Parent goal "${parent.title}" doesn't allow sub-goals`);
			return fail(422, nesting.code, `Nesting depth cap reached: ${nesting.currentDepth} / ${nesting.maxDepth}`, { currentDepth: nesting.currentDepth, maxDepth: nesting.maxDepth });
		}
	}

	const cascadeWorkflows = deps.workflows(resolved.projectId);
	if (supplied(raw, "workflowId") && typeof raw.workflowId !== "string") {
		return fail(400, "WORKFLOW_INVALID", "workflowId must be a workflow ID string");
	}
	if (supplied(raw, "workflow") && typeof raw.workflow !== "string" && !plainObject(raw.workflow)) {
		return fail(400, "WORKFLOW_INVALID", "workflow must be a workflow ID string or inline workflow object");
	}
	if (supplied(raw, "options") && typeof raw.options !== "string") {
		return fail(400, "OPTIONS_INVALID", "options must be a comma-separated string of optional step names");
	}
	const trustedInlineWorkflow = context.trustedSnapshots?.inlineWorkflow;
	const inlineWorkflow = trustedInlineWorkflow !== undefined
		? trustedInlineWorkflow
		: raw.inlineWorkflow ?? (plainObject(raw.workflow) ? raw.workflow : undefined);
	const explicitWorkflowId = typeof raw.workflowId === "string" ? raw.workflowId.trim() : typeof raw.workflow === "string" ? raw.workflow.trim() : "";
	const options = typeof raw.options === "string" ? raw.options : Array.isArray(raw.enabledOptionalSteps) ? raw.enabledOptionalSteps.join(",") : "";
	if (raw.enabledOptionalSteps !== undefined && (!Array.isArray(raw.enabledOptionalSteps) || !raw.enabledOptionalSteps.every(v => typeof v === "string"))) return fail(400, "UNKNOWN_OPTIONAL_STEP", "enabledOptionalSteps must be an array of step names");
	const registeredWorkflow = explicitWorkflowId ? deps.workflow(resolved.projectId, explicitWorkflowId) : undefined;
	// Creation historically resolves an explicit id through the visible cascade,
	// then falls back to the live project store. Add that exact match to the
	// validation set so hidden/runtime workflows retain full option validation
	// without exposing every hidden workflow in UNKNOWN_WORKFLOW guidance.
	let workflows = registeredWorkflow && !cascadeWorkflows.some(workflow => workflow.id === registeredWorkflow.id)
		? [...cascadeWorkflows, registeredWorkflow]
		: cascadeWorkflows;
	// An empty live store is not unconstrained: goal creation installs a known set
	// of defaults. Validate against an in-memory copy of exactly that set so an
	// invalid proposal cannot reach the later persistence boundary. When the
	// caller omitted a selection, normalize to the first default supplied by the
	// same dependency that creation will persist; default workflow ids are data,
	// never a magic constant.
	const workflowSelectionSupplied = supplied(raw, "workflowId") || supplied(raw, "workflow") || supplied(raw, "inlineWorkflow");
	// An empty live store will persist generated defaults after successful goal
	// creation. Validate explicit selections against those defaults too, but only
	// auto-select the first default when selection was truly omitted.
	const seedDefaultWorkflows = !inlineWorkflow && workflows.length === 0 && !registeredWorkflow;
	if (seedDefaultWorkflows) workflows = deps.defaultWorkflows(resolved.projectId);
	if (!inlineWorkflow && workflows.length === 0) {
		return fail(400, "MISSING_WORKFLOW", "Workflow is required for this project. Configure at least one workflow and retry.", { availableWorkflows: [] });
	}
	const workflowId = explicitWorkflowId || (!workflowSelectionSupplied && seedDefaultWorkflows ? workflows[0]?.id ?? "" : "");
	const workflowArgs = { inlineWorkflow, workflow: workflowId, options };
	const workflowError = validateGoalProposalWorkflow(workflowArgs, workflows);
	if (workflowError) return fail(400, workflowError.code, workflowError.message, { ...(workflowError.availableWorkflows ? { availableWorkflows: workflowError.availableWorkflows } : {}), ...(workflowError.validOptionalSteps ? { validOptionalSteps: workflowError.validOptionalSteps } : {}) });
	const selected = inlineWorkflow ?? registeredWorkflow ?? workflows.find(w => w.id === workflowId);
	let frozenWorkflow: Workflow | undefined;
	if (selected) {
		if (trustedInlineWorkflow !== undefined) {
			const size = trustedJsonSnapshot(selected, "inline workflow", "WORKFLOW_TOO_LARGE"); if (!size.ok) return size;
			const compatibilityError = validateGoalInlineWorkflow(size.value);
			if (compatibilityError) return fail(400, "WORKFLOW_INVALID", compatibilityError.message);
			frozenWorkflow = size.value as Workflow;
		} else {
			const size = jsonSnapshot(selected, "inline workflow", "WORKFLOW_TOO_LARGE"); if (!size.ok) return size;
			try { frozenWorkflow = freezeWorkflowDefinition(size.value, deps.components(resolved.projectId), workflowId, { validateComponentReferences: false }); }
			catch (error) { return fail(400, "WORKFLOW_INVALID", error instanceof Error ? error.message : "Invalid workflow definition"); }
		}
	}
	const enabledOptionalSteps = options.split(",").map(v => v.trim()).filter(Boolean);

	let trustedRoles: Record<string, Role> | undefined;
	if (context.trustedSnapshots?.inlineRoles !== undefined) {
		const size = trustedJsonSnapshot(context.trustedSnapshots.inlineRoles, "inline roles", "ROLES_TOO_LARGE"); if (!size.ok) return size;
		const snapshot = snapshotPersistedInlineRoles(size.value);
		if (!snapshot.ok) return fail(400, "INLINE_ROLES_INVALID", snapshot.message);
		trustedRoles = snapshot.roles;
	}
	const rawRoles = context.trustedSnapshots?.kind === "persisted-proposal" && trustedRoles !== undefined
		? undefined
		: raw.inlineRoles;
	const roleSize = rawRoles === undefined ? { ok: true as const, value: undefined } : jsonSnapshot(rawRoles, "inline roles", "ROLES_TOO_LARGE"); if (!roleSize.ok) return roleSize;
	const roleResult = validateInlineRoles(roleSize.value);
	if (!roleResult.ok) return fail(400, "INLINE_ROLES_INVALID", roleResult.message);
	const inlineRoles = trustedRoles || roleResult.roles
		? { ...(trustedRoles ?? {}), ...(roleResult.roles ?? {}) }
		: undefined;

	let metadata: Record<string, unknown> | undefined;
	if (raw.metadata !== undefined) {
		if (!plainObject(raw.metadata)) return fail(400, "METADATA_INVALID", "metadata must be a plain object");
		const metadataSize = jsonSnapshot(raw.metadata, "metadata", "METADATA_TOO_LARGE"); if (!metadataSize.ok) return metadataSize;
		metadata = metadataSize.value;
	}
	if (raw.subgoalsAllowed !== undefined && typeof raw.subgoalsAllowed !== "boolean") return fail(400, "SUBGOALS_ALLOWED_INVALID", "subgoalsAllowed must be boolean");
	if (raw.maxNestingDepth !== undefined && (typeof raw.maxNestingDepth !== "number" || !Number.isInteger(raw.maxNestingDepth) || raw.maxNestingDepth < 1)) return fail(400, "MAX_NESTING_DEPTH_INVALID", "maxNestingDepth must be an integer of at least 1");
	const inherited = parent ? inheritedChildOverrides(parent, prefs, deps.getGoal) : undefined;
	const subgoalsAllowed = raw.subgoalsAllowed === undefined ? inherited?.subgoalsAllowed : raw.subgoalsAllowed && (inherited?.subgoalsAllowed ?? prefs.subgoalsEnabled);
	const maxNestingDepth = raw.maxNestingDepth === undefined ? inherited?.maxNestingDepth : Math.min(clampMaxDepth(raw.maxNestingDepth as number), inherited?.maxNestingDepth ?? prefs.maxNestingDepth);
	const divergence = raw.divergencePolicy;
	if (divergence !== undefined && divergence !== "strict" && divergence !== "balanced" && divergence !== "autonomous") return fail(400, "DIVERGENCE_POLICY_INVALID", "divergencePolicy must be strict, balanced, or autonomous");
	if (parent && divergence !== undefined) return fail(422, "ROOT_POLICY_ON_CHILD", "divergencePolicy is only valid for root goals");
	const concurrency = raw.maxConcurrentChildren;
	if (concurrency !== undefined && (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)) return fail(400, "MAX_CONCURRENT_CHILDREN_INVALID", "maxConcurrentChildren must be an integer from 1 to 8");
	if (parent && concurrency !== undefined) return fail(422, "ROOT_POLICY_ON_CHILD", "maxConcurrentChildren is only valid for root goals");

	return { ok: true, candidate: { title, spec, projectId: resolved.projectId, project: resolved.project, cwd: cwdResult.cwd ?? requestedCwd, ...(frozenWorkflow ? { workflow: frozenWorkflow, workflowId: frozenWorkflow.id } : workflowId ? { workflowId } : {}), ...(trustedInlineWorkflow !== undefined ? { preserveWorkflowSnapshot: true } : {}), ...(seedDefaultWorkflows ? { seedDefaultWorkflows: true } : {}), ...(enabledOptionalSteps.length ? { enabledOptionalSteps } : {}), ...(parentGoalId ? { parentGoalId, parent } : {}), ...(inlineRoles && Object.keys(inlineRoles).length ? { inlineRoles } : {}), ...(subgoalsAllowed !== undefined ? { subgoalsAllowed } : {}), ...(maxNestingDepth !== undefined ? { maxNestingDepth } : {}), ...(divergence !== undefined ? { divergencePolicy: divergence } : {}), ...(concurrency !== undefined ? { maxConcurrentChildren: concurrency } : {}), ...(metadata ? { metadata } : {}) } };
}
