/**
 * Canonical configuration mutations shared by the public API and proposal
 * acceptance. Keep persistence here: proposal surfaces must never grow a
 * second, almost-the-same implementation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import type { Role, RoleStore } from "../agent/role-store.js";
import type { RoleManager } from "../agent/role-manager.js";
import type { PersistedGoal } from "../agent/goal-store.js";
import type { Workflow, WorkflowStore } from "../agent/workflow-store.js";
import {
  freezeWorkflowDefinition,
  validateWorkflowDefinition,
  type WorkflowComponentRef,
} from "../agent/workflow-validator.js";
import {
  buildDefaultWorkflows,
  buildParentWorkflow,
} from "../state-migration/seed-default-workflows.js";
import {
  checkCanSpawnChild,
  clampMaxDepth,
  inheritedChildOverrides,
  type SubgoalNestingPrefs,
} from "../agent/subgoal-nesting-limit.js";
import {
  GoalPausedError,
  requireAncestorsNotPaused,
} from "../agent/goal-paused-guard.js";
import { ToolManager, __resetToolScanCache } from "../agent/tool-manager.js";

/** Durable, server-owned idempotency marker. Callers must never take this from
 * proposal metadata or another user controlled field. */
export const CANONICAL_MUTATION_KEY = "bobbit.canonicalMutationKey";
const CANONICAL_APPLICATION_KEY = /^[A-Za-z0-9_.:-]{1,256}$/;

// Serializes same-process duplicate applications until the durable marker is
// flushed. A restart uses findByApplicationKey against the persisted record.
const inFlightGoalApplications = new Map<string, Promise<void>>();

function assertCanonicalApplicationKey(value: string | undefined): void {
	if (value !== undefined && !CANONICAL_APPLICATION_KEY.test(value)) {
		throw new CanonicalMutationError(400, "Invalid canonical application key");
	}
}

export class CanonicalMutationError extends Error {
	constructor(public readonly status: 400 | 403 | 404 | 409 | 422 | 500, message: string, public readonly code?: string, public readonly details?: unknown) {
		super(message);
	}
}

export const ROLE_POLICIES = new Set(["allow", "ask", "never", "always-allow", "ask-once", "always-ask", "never-ask"]);

export type RoleTarget =
	| { scope: "server"; store: RoleStore; manager: RoleManager }
	| { scope: "project"; store: RoleStore; projectId: string };

export async function createCanonicalRole(
	body: Record<string, any>,
	target: RoleTarget,
	deps: { normalizeThinking(value: unknown): string | undefined; validateModel(model: string): Promise<boolean> },
): Promise<Role> {
	const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
	if (model && /^[^/]+\/.+$/.test(model) && !(await deps.validateModel(model))) {
		throw new CanonicalMutationError(422, "Role model is not available");
	}
	if (target.scope === "server") {
		return target.manager.createRole({
			name: body.name,
			label: body.label,
			promptTemplate: body.promptTemplate || "",
			accessory: body.accessory,
			toolPolicies: body.toolPolicies,
			model,
			thinkingLevel: deps.normalizeThinking(body.thinkingLevel),
		});
	}
	const now = Date.now();
	const role: Role = {
		name: body.name,
		label: body.label ?? body.name,
		promptTemplate: body.promptTemplate || "",
		accessory: body.accessory ?? "none",
		toolPolicies: body.toolPolicies,
		model,
		thinkingLevel: deps.normalizeThinking(body.thinkingLevel),
		createdAt: now,
		updatedAt: now,
	};
	if (!role.name || typeof role.name !== "string") throw new CanonicalMutationError(400, "Missing name");
	const namePattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
	if (!namePattern.test(role.name)) throw new CanonicalMutationError(400, "Role name must be lowercase alphanumeric + hyphens");
	target.store.put(role);
	return role;
}

function cleanedPolicies(value: unknown): Record<string, any> {
	const result: Record<string, any> = {};
	if (value && typeof value === "object") {
		for (const [key, policy] of Object.entries(value)) {
			if (typeof policy === "string" && ROLE_POLICIES.has(policy)) result[key] = policy;
		}
	}
	return result;
}

export async function updateCanonicalRole(
	name: string,
	body: Record<string, any>,
	target: RoleTarget,
	deps: { normalizeThinking(value: unknown): string | undefined; validateModel(model: string): Promise<boolean> },
): Promise<void> {
	const requestedModel = body.model !== undefined && typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
	if (requestedModel && /^[^/]+\/.+$/.test(requestedModel) && !(await deps.validateModel(requestedModel))) {
		throw new CanonicalMutationError(422, "Role model is not available");
	}
	if (target.scope === "project") {
		const existing = target.store.get(name);
		if (!existing) throw new CanonicalMutationError(404, "Role not found in project");
		const toolPolicies = body.toolPolicies !== undefined ? cleanedPolicies(body.toolPolicies) : existing.toolPolicies;
		const model = body.model !== undefined ? (typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined) : existing.model;
		const thinkingLevel = body.thinkingLevel !== undefined ? deps.normalizeThinking(body.thinkingLevel) : existing.thinkingLevel;
		target.store.put({ ...existing, label: body.label ?? existing.label, promptTemplate: body.promptTemplate ?? existing.promptTemplate,
			accessory: body.accessory ?? existing.accessory, toolPolicies, model, thinkingLevel, name, updatedAt: Date.now() });
		return;
	}
	const modelUpdate = body.model !== undefined ? (typeof body.model === "string" && body.model.trim() ? body.model.trim() : "") : undefined;
	const thinkingUpdate = body.thinkingLevel !== undefined ? (deps.normalizeThinking(body.thinkingLevel) ?? "") : undefined;
	if (modelUpdate !== undefined || thinkingUpdate !== undefined) {
		const existing = target.manager.getRole(name);
		if (existing) target.store.put({ ...existing, model: modelUpdate !== undefined ? (modelUpdate || undefined) : existing.model,
			thinkingLevel: thinkingUpdate !== undefined ? (thinkingUpdate || undefined) : existing.thinkingLevel, updatedAt: Date.now() });
	}
	const ok = target.manager.updateRole(name, {
		label: body.label, promptTemplate: body.promptTemplate, accessory: body.accessory,
		toolPolicies: body.toolPolicies !== undefined ? cleanedPolicies(body.toolPolicies) : undefined,
	});
	if (!ok) throw new CanonicalMutationError(404, "Role not found");
}

export function deleteCanonicalRole(name: string, target: RoleTarget): void {
	if (target.scope === "project") { target.store.remove(name); return; }
	if (!target.manager.deleteRole(name)) throw new CanonicalMutationError(404, "Role not found");
}

function assertWorkflow(candidate: unknown, components: WorkflowComponentRef[]): void {
	const errors = validateWorkflowDefinition(candidate, components);
	if (errors.length) throw new CanonicalMutationError(400, errors[0].message);
}

export function createCanonicalWorkflow(body: Record<string, any>, workflowStore: WorkflowStore, components: WorkflowComponentRef[]): Workflow {
	const now = Date.now();
	const workflow: Workflow = { id: body.id as string, name: (body.name as string) ?? body.id, description: (body.description as string) ?? "", gates: body.gates || [], createdAt: now, updatedAt: now };
	assertWorkflow(workflow, components);
	workflowStore.put(workflow);
	return workflow;
}

export function updateCanonicalWorkflow(id: string, body: Record<string, any>, workflowStore: WorkflowStore, components: WorkflowComponentRef[]): Workflow {
	const existing = workflowStore.get(id);
	if (!existing) throw new CanonicalMutationError(404, "Workflow not found in project");
	const updated: Workflow = { ...existing, name: body.name ?? existing.name, description: body.description ?? existing.description,
		gates: Array.isArray(body.gates) ? body.gates : existing.gates, id, updatedAt: Date.now() };
	assertWorkflow(updated, components);
	workflowStore.put(updated);
	return updated;
}

/** Staff persistence and its observable broadcast are one operation. Validation
 * stays injectable because request routes own their transport-specific errors. */
export async function createCanonicalStaff<T>(
	input: { name: string; description: string; systemPrompt: string; cwd: string; projectId: string; triggers?: unknown; roleId?: unknown; accessory?: unknown; sandboxed: boolean; worktree?: boolean },
	deps: {
		create(name: string, description: string, prompt: string, cwd: string, options: Record<string, unknown>): Promise<T>;
		broadcast(staff: T, projectId: string): void;
	},
): Promise<T> {
	const staff = await deps.create(input.name, input.description, input.systemPrompt, input.cwd, {
		triggers: input.triggers,
		roleId: input.roleId,
		accessory: input.accessory,
		projectId: input.projectId,
		sandboxed: input.sandboxed,
		...(typeof input.worktree === "boolean" ? { worktree: input.worktree } : {}),
	});
	deps.broadcast(staff, input.projectId);
	return staff;
}

export function updateCanonicalStaff<T>(
	id: string,
	updates: Record<string, unknown>,
	deps: { update(id: string, updates: Record<string, unknown>): boolean; read(id: string): T | undefined },
): T {
	if (!deps.update(id, updates)) throw new CanonicalMutationError(404, "Staff agent not found");
	const staff = deps.read(id);
	if (!staff) throw new CanonicalMutationError(404, "Staff agent not found");
	return staff;
}

export async function deleteCanonicalStaff<T>(
	id: string,
	deps: { read(id: string): T | undefined; remove(id: string): Promise<boolean> },
): Promise<T | undefined> {
	const staff = deps.read(id);
	if (!await deps.remove(id)) throw new CanonicalMutationError(404, "Staff agent not found");
	return staff;
}

export type ToolProposalAction = "create" | "update" | "delete";
export type ToolProposal = { action: ToolProposalAction; tool: string; content?: string };
export type ToolProposalResult = { action: ToolProposalAction; tool: string; groupDir: string };

type ParsedTool = { name: string; group: string; value: Record<string, unknown> };
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Group directories are data directories, never caller-controlled paths. */
export function canonicalToolGroupDir(group: string): string {
	const result = group.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (!result || result === "." || result === "..") throw new CanonicalMutationError(422, "Tool group must contain letters or numbers");
	return result;
}

function parseToolYaml(content: string, expectedName: string): ParsedTool {
	if (typeof content !== "string" || !content.trim()) throw new CanonicalMutationError(400, "Tool content is required");
	const document = parseDocument(content, { uniqueKeys: true });
	if (document.errors.length) throw new CanonicalMutationError(422, `Invalid tool YAML: ${document.errors[0].message}`);
	const value = document.toJSON();
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new CanonicalMutationError(422, "Tool YAML must be a mapping");
	const tool = value as Record<string, unknown>;
	if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name) || tool.name !== expectedName) throw new CanonicalMutationError(422, "Tool YAML name must exactly match tool");
	if (typeof tool.description !== "string") throw new CanonicalMutationError(422, "Tool YAML requires a string description");
	if (typeof tool.group !== "string" || !tool.group.trim()) throw new CanonicalMutationError(422, "Tool YAML requires a non-empty group");
	if (tool.provider !== undefined) {
		if (!tool.provider || typeof tool.provider !== "object" || Array.isArray(tool.provider)) throw new CanonicalMutationError(422, "Tool YAML provider must be a mapping");
		const provider = tool.provider as Record<string, unknown>;
		if (provider.type !== "builtin" && provider.type !== "bobbit-extension" && provider.type !== "mcp" && provider.type !== "pi-extension") {
			throw new CanonicalMutationError(422, "Tool YAML provider type is invalid");
		}
		for (const key of ["tool", "extension", "server", "mcpTool", "providerKey"] as const) {
			if (provider[key] !== undefined && typeof provider[key] !== "string") throw new CanonicalMutationError(422, `Tool YAML provider.${key} must be a string`);
		}
	}
	if (tool.params !== undefined && (!Array.isArray(tool.params) || tool.params.some(value => typeof value !== "string"))) throw new CanonicalMutationError(422, "Tool YAML params must be an array of strings");
	return { name: tool.name, group: tool.group, value: tool };
}

function localToolPath(toolsDir: string, name: string): { file: string; groupDir: string } | undefined {
	try {
		for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const groupPath = path.join(toolsDir, entry.name);
				for (const file of fs.readdirSync(groupPath, { withFileTypes: true })) {
					if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
					try {
						const doc = parseDocument(fs.readFileSync(path.join(groupPath, file.name), "utf8"));
						if (!doc.errors.length && (doc.toJSON() as any)?.name === name) return { file: path.join(groupPath, file.name), groupDir: entry.name };
					} catch { /* malformed local yaml cannot be a writable target */ }
				}
			} else if (entry.isFile() && entry.name.endsWith(".yaml")) {
				try {
					const doc = parseDocument(fs.readFileSync(path.join(toolsDir, entry.name), "utf8"));
					if (!doc.errors.length && (doc.toJSON() as any)?.name === name) return { file: path.join(toolsDir, entry.name), groupDir: "" };
				} catch { /* ignore */ }
			}
		}
	} catch { /* no local tools yet */ }
	return undefined;
}

function atomicWrite(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	try { fs.writeFileSync(temporary, content, "utf8"); fs.renameSync(temporary, file); }
	finally { try { fs.rmSync(temporary, { force: true }); } catch { /* no-op */ } }
}

function loaderAcceptsCandidate(content: string, parsed: ParsedTool, toolManager: ToolManager): boolean {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-tool-proposal-"));
	try {
		const configDir = path.join(root, "config");
		atomicWrite(path.join(configDir, "tools", canonicalToolGroupDir(parsed.group), `${parsed.name}.yaml`), content);
		const candidateManager = new ToolManager(configDir, toolManager.getBuiltinToolsDir());
		const visible = candidateManager.getLocalTools().some(tool => tool.name === parsed.name);
		const diagnostics = candidateManager.getToolDiagnostics().some(diagnostic => diagnostic.toolName === parsed.name || diagnostic.tool === parsed.name);
		return visible && !diagnostics;
	} finally {
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* no-op */ }
	}
}

function targetLoaderAccepts(toolManager: ToolManager, name: string): boolean {
	__resetToolScanCache();
	const visible = toolManager.getLocalTools().some(tool => tool.name === name);
	const diagnostics = toolManager.getToolDiagnostics().some(diagnostic => diagnostic.toolName === name || diagnostic.tool === name);
	return visible && !diagnostics;
}

/**
 * Applies a project-scoped tool proposal into the exact tree ToolManager scans.
 * Update/delete deliberately only address a local override; inherited tool packs
 * are immutable through this operation.
 */
/**
 * The typed shape shared by POST /api/goals and durable proposal application.
 * This deliberately describes the proposal, not the HTTP request: the route
 * only parses a body and supplies transport-only authorization.
 */
export interface CanonicalGoalProposal {
  title?: unknown;
  cwd?: unknown;
  spec?: unknown;
  workflowId?: unknown;
  workflow?: unknown;
  projectId?: unknown;
  sandboxed?: unknown;
  autoStartTeam?: unknown;
  enabledOptionalSteps?: unknown;
  metadata?: unknown;
  parentGoalId?: unknown;
  inlineRoles?: unknown;
  subgoalsAllowed?: unknown;
  maxNestingDepth?: unknown;
  divergencePolicy?: unknown;
  maxConcurrentChildren?: unknown;
  worktree?: unknown;
  reattemptOf?: unknown;
}

type CanonicalGoalContext = {
  goalManager: {
    getGoal(id: string): PersistedGoal | undefined;
    listGoals(): PersistedGoal[];
    createGoal(
      title: string,
      cwd: string,
      options: Record<string, unknown>,
    ): Promise<PersistedGoal>;
    updateGoal(id: string, updates: Record<string, unknown>): void;
    getGoalStore(): { flush(): Promise<void> };
  };
  gateStore: {
    initGatesForGoal(goalId: string, gateIds: string[]): void;
    flush(): Promise<void>;
  };
  workflowStore: WorkflowStore;
  projectConfigStore: {
    getComponents(): Array<{ name: string; commands?: Record<string, string> }>;
  };
};

export interface CanonicalGoalProposalDeps {
  resolveProject(projectId: unknown): {
    id: string;
    name: string;
    rootPath: string;
  };
  validateCwd(projectId: string, cwd: string): void;
  getContext(projectId: string): CanonicalGoalContext | undefined;
  ensureSandbox?(projectId: string): Promise<void>;
  findGoalAcrossProjects(goalId: string): PersistedGoal | undefined;
  getNestingPrefs(): SubgoalNestingPrefs;
  /** Auth is transport-owned; proposal application leaves it unset. */
  authorizeChild?(parent: PersistedGoal): void;
  findCascadeWorkflow(
    projectId: string,
    workflowId: string,
  ): Workflow | undefined;
  afterCreate(goal: PersistedGoal, parentGoalId?: string): void | Promise<void>;
  onAfterCreateError?(error: unknown, goal: PersistedGoal): void;
  /** Trusted server application identity; never accepted from proposal metadata. */
  applicationKey?: string;
}

/**
 * Resolve and apply a goal proposal as one canonical operation. All validation
 * precedes persistence, so a rejected cwd, parent, workflow, or option cannot
 * leave a goal or gate behind. The persistence/lifecycle half remains in
 * createCanonicalGoal for independently testable durable replay semantics.
 */
export async function applyCanonicalGoalProposal(
  proposal: CanonicalGoalProposal,
  deps: CanonicalGoalProposalDeps,
): Promise<{ goal: PersistedGoal; replayed: boolean }> {
  const title = proposal.title;
  if (!title || typeof title !== "string")
    throw new CanonicalMutationError(400, "Missing title");
  const explicitCwd =
    typeof proposal.cwd === "string" && proposal.cwd.trim().length > 0
      ? proposal.cwd.trim()
      : undefined;
  const project = deps.resolveProject(proposal.projectId);
  const cwd = explicitCwd || project.rootPath;
  deps.validateCwd(project.id, cwd);
  const context = deps.getContext(project.id);
  if (!context) throw new CanonicalMutationError(400, "Invalid project");
  const sandboxed = proposal.sandboxed === true;
  if (sandboxed && deps.ensureSandbox) {
    try {
      await deps.ensureSandbox(project.id);
    } catch (error) {
      throw new CanonicalMutationError(
        500,
        `Sandbox init failed: ${(error as Error).message || error}`,
      );
    }
  }
  const parentGoalId =
    typeof proposal.parentGoalId === "string" && proposal.parentGoalId.trim()
      ? proposal.parentGoalId.trim()
      : undefined;
  let parent: PersistedGoal | undefined;
  if (parentGoalId) {
    parent = context.goalManager.getGoal(parentGoalId);
    if (!parent) {
      if (deps.findGoalAcrossProjects(parentGoalId))
        throw new CanonicalMutationError(
          422,
          "Parent goal belongs to a different project. Select a parent in the same project.",
          "PARENT_CROSS_PROJECT",
        );
      throw new CanonicalMutationError(
        422,
        "Parent goal not found",
        "PARENT_NOT_FOUND",
      );
    }
    deps.authorizeChild?.(parent);
    try {
      requireAncestorsNotPaused(
        parentGoalId,
        (id) =>
          context.goalManager.getGoal(id) ?? deps.findGoalAcrossProjects(id),
      );
    } catch (error) {
      if (error instanceof GoalPausedError)
        throw new CanonicalMutationError(409, error.message, error.code, {
          goalId: error.goalId,
        });
      throw error;
    }
    const spawn = checkCanSpawnChild(
      parent,
      deps.getNestingPrefs(),
      (id) =>
        context.goalManager.getGoal(id) ?? deps.findGoalAcrossProjects(id),
    );
    if (!spawn.ok) {
      if (spawn.code === "SUBGOALS_DISABLED")
        throw new CanonicalMutationError(
          422,
          "Subgoals are disabled",
          spawn.code,
        );
      if (spawn.code === "PARENT_SUBGOALS_DISABLED")
        throw new CanonicalMutationError(
          422,
          `Parent goal "${parent.title}" doesn't allow sub-goals`,
          spawn.code,
        );
      throw new CanonicalMutationError(
        422,
        `Nesting depth cap reached: ${spawn.currentDepth} / ${spawn.maxDepth}`,
        spawn.code,
        { currentDepth: spawn.currentDepth, maxDepth: spawn.maxDepth },
      );
    }
  }
  const requestedWorkflowId =
    typeof proposal.workflowId === "string" && proposal.workflowId
      ? proposal.workflowId
      : "general";
  let workflowId = requestedWorkflowId;
  let workflow: Workflow | undefined;
  if (proposal.workflow && typeof proposal.workflow === "object") {
    workflow = proposal.workflow as Workflow;
    workflowId = workflow.id || requestedWorkflowId;
  } else {
    workflow = requestedWorkflowId
      ? (deps.findCascadeWorkflow(project.id, requestedWorkflowId) ??
        context.workflowStore.get(requestedWorkflowId))
      : undefined;
    if (!workflow && context.workflowStore.getAll().length === 0) {
      const components = context.projectConfigStore.getComponents();
      const component =
        components.find(
          (item) =>
            item.name === project.name &&
            Object.keys(item.commands ?? {}).length > 0,
        ) ??
        components.find(
          (item) => Object.keys(item.commands ?? {}).length > 0,
        ) ??
        components.find((item) => item.name === project.name) ??
        components.find((item) => item.name.length > 0);
      const seeds = buildDefaultWorkflows(
        component?.name || project.name || "project",
        component ? Object.keys(component.commands ?? {}) : [],
      );
      seeds.parent = buildParentWorkflow();
      for (const seeded of Object.values(seeds))
        context.workflowStore.put(seeded as Workflow);
      workflow = requestedWorkflowId
        ? context.workflowStore.get(requestedWorkflowId)
        : (context.workflowStore.get("general") ??
          context.workflowStore.getAll()[0]);
      workflowId = workflow?.id || "general";
    }
    if (
      requestedWorkflowId &&
      !workflow &&
      context.workflowStore.getAll().length > 0
    ) {
      const available = context.workflowStore.getAll().map((item) => item.id);
      throw new CanonicalMutationError(
        400,
        `Workflow "${requestedWorkflowId}" not found. Available: ${available.join(", ")}`,
        "WORKFLOW_NOT_FOUND",
        { workflowId: requestedWorkflowId, available },
      );
    }
  }
  if (workflow)
    workflow = freezeWorkflowDefinition(
      workflow,
      context.projectConfigStore.getComponents() as WorkflowComponentRef[],
      workflowId,
      { validateComponentReferences: false },
    );
  const nesting = deps.getNestingPrefs();
  const inherited = parent
    ? inheritedChildOverrides(
        parent,
        nesting,
        (id) =>
          context.goalManager.getGoal(id) ?? deps.findGoalAcrossProjects(id),
      )
    : undefined;
  const subgoalsAllowed =
    typeof proposal.subgoalsAllowed === "boolean"
      ? proposal.subgoalsAllowed &&
        (inherited?.subgoalsAllowed ?? nesting.subgoalsEnabled)
      : inherited?.subgoalsAllowed;
  const maxNestingDepth =
    typeof proposal.maxNestingDepth === "number" &&
    Number.isFinite(proposal.maxNestingDepth)
      ? Math.min(
          clampMaxDepth(proposal.maxNestingDepth),
          inherited?.maxNestingDepth ?? nesting.maxNestingDepth,
        )
      : inherited?.maxNestingDepth;
  const root = !parentGoalId;
  const divergencePolicy =
    root &&
    (proposal.divergencePolicy === "strict" ||
      proposal.divergencePolicy === "balanced" ||
      proposal.divergencePolicy === "autonomous")
      ? proposal.divergencePolicy
      : undefined;
  const maxConcurrentChildren =
    root &&
    typeof proposal.maxConcurrentChildren === "number" &&
    Number.isFinite(proposal.maxConcurrentChildren) &&
    Math.floor(proposal.maxConcurrentChildren) >= 1 &&
    Math.floor(proposal.maxConcurrentChildren) <= 8
      ? Math.floor(proposal.maxConcurrentChildren)
      : undefined;
  const metadata =
    proposal.metadata &&
    typeof proposal.metadata === "object" &&
    !Array.isArray(proposal.metadata) &&
    Object.keys(proposal.metadata).length > 0
      ? (proposal.metadata as Record<string, unknown>)
      : undefined;
  if (
    proposal.enabledOptionalSteps !== undefined &&
    (!Array.isArray(proposal.enabledOptionalSteps) ||
      !proposal.enabledOptionalSteps.every((item) => typeof item === "string"))
  ) {
    throw new CanonicalMutationError(
      400,
      "enabledOptionalSteps must be an array of strings",
    );
  }
  const enabledOptionalSteps = proposal.enabledOptionalSteps as
    string[] | undefined;
  if (enabledOptionalSteps && workflow) {
    const optionalNames = new Set(
      workflow.gates.flatMap((gate) =>
        (gate.verify ?? [])
          .filter((step) => step.optional)
          .map((step) => step.name),
      ),
    );
    const invalidOption = enabledOptionalSteps.find(
      (name) => !optionalNames.has(name),
    );
    if (invalidOption)
      throw new CanonicalMutationError(
        400,
        `Unknown optional workflow step: ${invalidOption}`,
        "OPTION_NOT_FOUND",
      );
  }
  const inlineRoles =
    proposal.inlineRoles &&
    typeof proposal.inlineRoles === "object" &&
    !Array.isArray(proposal.inlineRoles)
      ? (proposal.inlineRoles as Record<string, Role>)
      : undefined;
  return createCanonicalGoal(
    {
      title,
      cwd,
      projectId: project.id,
      reattemptOf:
        typeof proposal.reattemptOf === "string"
          ? proposal.reattemptOf
          : undefined,
      autoStartTeam: proposal.autoStartTeam !== false,
      applicationKey: deps.applicationKey,
      options: {
        spec: proposal.spec || "",
        workflowId,
        workflowStore: context.workflowStore,
        resolvedWorkflow: workflow,
        sandboxed,
        enabledOptionalSteps,
        projectId: project.id,
        parentGoalId,
        inlineRoles,
        subgoalsAllowed,
        maxNestingDepth,
        divergencePolicy,
        maxConcurrentChildren,
        metadata,
        worktree:
          typeof proposal.worktree === "boolean"
            ? proposal.worktree
            : undefined,
      },
    },
    {
      findByApplicationKey: (key) =>
        context.goalManager
          .listGoals()
          .find(
            (candidate) => candidate.metadata?.[CANONICAL_MUTATION_KEY] === key,
          ),
      create: (goalTitle, goalCwd, options) =>
        context.goalManager.createGoal(
          goalTitle,
          goalCwd,
          options,
        ) as Promise<PersistedGoal>,
      update: (id, updates) => context.goalManager.updateGoal(id, updates),
      initGates: (id, gateIds) =>
        context.gateStore.initGatesForGoal(id, gateIds),
      flush: () =>
        Promise.all([
          context.goalManager.getGoalStore().flush(),
          context.gateStore.flush(),
        ]).then(() => undefined),
      afterCreate: (goal) => deps.afterCreate(goal, parentGoalId),
      onAfterCreateError: deps.onAfterCreateError,
    },
  );
}

/**
 * The persistence boundary for goal creation. It strips user-owned replay
 * markers before spreading options so an empty sanitized metadata object cannot
 * accidentally resurrect a forged marker from input.options.
 */
export async function createCanonicalGoal<
  T extends {
    id: string;
    workflow?: { gates: Array<{ id: string }> };
    metadata?: Record<string, unknown>;
  },
>(
  input: {
    title: string;
    cwd: string;
    options: Record<string, unknown>;
    projectId?: string;
    reattemptOf?: string;
    autoStartTeam: boolean;
    /** Assigned by a trusted application, never copied from proposal metadata. */
    applicationKey?: string;
  },
  deps: {
    findByApplicationKey(key: string): T | undefined;
    create(
      title: string,
      cwd: string,
      options: Record<string, unknown>,
    ): Promise<T>;
    update(id: string, updates: Record<string, unknown>): void;
    initGates(goalId: string, gateIds: string[]): void;
    flush(): Promise<void>;
    afterCreate(goal: T): void | Promise<void>;
    onAfterCreateError?(error: unknown, goal: T): void;
  },
): Promise<{ goal: T; replayed: boolean }> {
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new CanonicalMutationError(400, "Goal title is required");
  }
  if (
    typeof input.cwd !== "string" ||
    !(path.posix.isAbsolute(input.cwd) || path.win32.isAbsolute(input.cwd))
  ) {
    throw new CanonicalMutationError(400, "Goal cwd must be an absolute path");
  }
  if (
    !input.options ||
    typeof input.options !== "object" ||
    Array.isArray(input.options)
  ) {
    throw new CanonicalMutationError(400, "Goal options must be an object");
  }
  assertCanonicalApplicationKey(input.applicationKey);
  let finishApplication: (() => void) | undefined;
  let applicationCompletion: Promise<void> | undefined;
  if (input.applicationKey) {
    const inFlight = inFlightGoalApplications.get(input.applicationKey);
    if (inFlight) await inFlight;
    const existing = deps.findByApplicationKey(input.applicationKey);
    if (existing) return { goal: existing, replayed: true };
    applicationCompletion = new Promise<void>((resolve) => {
      finishApplication = resolve;
    });
    inFlightGoalApplications.set(input.applicationKey, applicationCompletion);
  }
  try {
    const metadata =
      input.options.metadata &&
      typeof input.options.metadata === "object" &&
      !Array.isArray(input.options.metadata)
        ? { ...(input.options.metadata as Record<string, unknown>) }
        : {};
    // Never copy a caller-supplied marker from arbitrary proposal metadata. Only
    // a trusted application may attach the durable replay identity.
    delete metadata[CANONICAL_MUTATION_KEY];
    if (input.applicationKey)
      metadata[CANONICAL_MUTATION_KEY] = input.applicationKey;
    // Omit the original metadata before spreading. Otherwise an empty sanitized
    // object would skip the conditional below and revive a forged marker through
    // `...input.options`.
    const { metadata: _untrustedMetadata, ...optionsWithoutMetadata } =
      input.options;
    const goal = await deps.create(input.title, input.cwd, {
      ...optionsWithoutMetadata,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    if (input.projectId) {
      deps.update(goal.id, { projectId: input.projectId });
      (goal as T & { projectId?: string }).projectId = input.projectId;
    }
    if (input.reattemptOf) {
      deps.update(goal.id, { reattemptOf: input.reattemptOf });
      (goal as T & { reattemptOf?: string }).reattemptOf = input.reattemptOf;
    }
    deps.update(goal.id, { autoStartTeam: input.autoStartTeam });
    (goal as T & { autoStartTeam?: boolean }).autoStartTeam =
      input.autoStartTeam;
    if (goal.workflow)
      deps.initGates(
        goal.id,
        goal.workflow.gates.map((gate) => gate.id),
      );
    await deps.flush();
    // The HTTP route publishes the creation response before its historical
    // fire-and-forget setup/start work. Deferring retains that observable order
    // while proposal callers still share the exact same lifecycle hook.
    queueMicrotask(() => {
      Promise.resolve()
        .then(() => deps.afterCreate(goal))
        .catch((error) => {
          // Lifecycle scheduling must never surface as an unhandled microtask.
          deps.onAfterCreateError?.(error, goal);
        });
    });
    return { goal, replayed: false };
  } finally {
    finishApplication?.();
    if (
      input.applicationKey &&
      applicationCompletion &&
      inFlightGoalApplications.get(input.applicationKey) ===
        applicationCompletion
    ) {
      inFlightGoalApplications.delete(input.applicationKey);
    }
  }
}

export type CanonicalProjectMode = "register" | "update" | "promote";

/**
 * Canonical project mutation transaction. The configuration application is an
 * explicit persistence primitive: callers must validate and atomically publish
 * the complete candidate before it returns. Registration, root replacement,
 * promotion and replay ownership live here so proposal application never has
 * to recreate route lifecycle semantics.
 */
export async function mutateCanonicalProject<T extends { id: string; rootPath: string; importDecisionRun?: { id: string; state: "configuring" | "ready" } }>(
	input: {
		mode: CanonicalProjectMode;
		name?: string;
		rootPath?: string;
		updates?: Record<string, unknown>;
		applicationKey?: string;
		sameRootPath?(left: string, right: string): boolean;
	},
	deps: {
		findByApplicationKey(key: string): T | undefined;
		register(applicationKey?: string): T;
		get(id: string): T | undefined;
		update(id: string, updates: Record<string, unknown>): T;
		promote(id: string, updates: { name?: string }): T;
		applyConfiguration(project: T): Promise<void> | void;
		/** Clear transient context/config state when registration config rejects. */
		rollbackRegistration?(project: T): Promise<void> | void;
		removeRegistered(project: T): void;
		removeContext(projectId: string): Promise<void>;
		openContext(projectId: string): Promise<boolean>;
		suspendServices(projectId: string): Promise<void>;
		stopServices(projectId: string): Promise<void>;
		reconcileServices(projectId: string): Promise<void>;
	},
): Promise<{ project: T; replayed: boolean }> {
	if (input.mode === "register") {
		if (typeof input.name !== "string" || !input.name.trim()) {
			throw new CanonicalMutationError(400, "Project name is required");
		}
		if (typeof input.rootPath !== "string" || !(path.posix.isAbsolute(input.rootPath) || path.win32.isAbsolute(input.rootPath))) {
			throw new CanonicalMutationError(400, "Project rootPath must be an absolute path");
		}
	}
	if (input.mode === "update" && input.updates?.rootPath !== undefined
		&& (typeof input.updates.rootPath !== "string" || !(path.posix.isAbsolute(input.updates.rootPath) || path.win32.isAbsolute(input.updates.rootPath)))) {
		throw new CanonicalMutationError(400, "Project rootPath must be an absolute path");
	}
	assertCanonicalApplicationKey(input.applicationKey);
	if (input.mode === "register") {
		if (input.applicationKey) {
			const existing = deps.findByApplicationKey(input.applicationKey);
			if (existing) return { project: existing, replayed: true };
		}
		const project = deps.register(input.applicationKey);
		try {
			await deps.applyConfiguration(project);
			return { project, replayed: false };
		} catch (error) {
			// A rejected initial config must never leave a half-registered project.
			try { await deps.rollbackRegistration?.(project); } catch { /* original validation error wins */ }
			try { deps.removeRegistered(project); } catch { /* original validation error wins */ }
			throw error;
		}
	}
	if (!input.updates?.id || typeof input.updates.id !== "string") {
		throw new CanonicalMutationError(400, "Project mutation target is required");
	}
	const projectId = input.updates.id;
	const existing = deps.get(projectId);
	if (!existing) throw new CanonicalMutationError(422, `Unknown project: ${projectId}`, "UNKNOWN_PROJECT");
	// Registry implementations mutate their project record in place. Capture the
	// old immutable scope before update so a failed root transaction can recover.
	const previousRootPath = existing.rootPath;
	if (input.mode === "promote") {
		const project = deps.promote(projectId, { name: input.name });
		await deps.applyConfiguration(project);
		return { project, replayed: false };
	}
	const updates = { ...input.updates };
	delete updates.id;
	const replacingRoot = typeof updates.rootPath === "string" && !(input.sameRootPath ?? ((left, right) => left === right))(updates.rootPath, existing.rootPath);
	let removed = false;
	let committed = false;
	let replacementOpened = false;
	try {
		if (replacingRoot) {
			await deps.suspendServices(projectId);
			removed = true;
			await deps.removeContext(projectId);
		}
		const project = deps.update(projectId, updates);
		committed = true;
		if (replacingRoot) {
			replacementOpened = await deps.openContext(projectId);
			if (!replacementOpened) throw new Error("Project context could not be reopened after root replacement");
			await deps.stopServices(projectId);
			await deps.reconcileServices(projectId);
		}
		await deps.applyConfiguration(project);
		return { project, replayed: false };
	} catch (error) {
		if (replacingRoot && removed) {
			if (replacementOpened) await deps.removeContext(projectId).catch(() => undefined);
			if (committed) { try { deps.update(projectId, { rootPath: previousRootPath }); } catch { /* original error wins */ } }
			try { await deps.openContext(projectId); } catch { /* best effort recovery */ }
			await deps.reconcileServices(projectId).catch(() => undefined);
		}
		throw error;
	}
}

export function applyCanonicalToolProposal(proposal: ToolProposal, deps: { configDir: string; toolManager: ToolManager }): ToolProposalResult {
	if (!proposal || !TOOL_NAME.test(proposal.tool || "")) throw new CanonicalMutationError(400, "Invalid tool name");
	if (proposal.action !== "create" && proposal.action !== "update" && proposal.action !== "delete") throw new CanonicalMutationError(400, "Tool action must be create, update, or delete");
	const toolsDir = deps.toolManager.getToolsDir();
	const local = localToolPath(toolsDir, proposal.tool);
	if (proposal.action === "delete") {
		if (!local) throw new CanonicalMutationError(404, "Tool override not found in project");
		fs.rmSync(local.file, { force: true });
		try { if (local.groupDir) fs.rmdirSync(path.join(toolsDir, local.groupDir)); } catch { /* group has siblings */ }
		return { action: proposal.action, tool: proposal.tool, groupDir: local.groupDir };
	}
	const content = proposal.content ?? "";
	const parsed = parseToolYaml(content, proposal.tool);
	const groupDir = canonicalToolGroupDir(parsed.group);
	if (proposal.action === "create" && local) throw new CanonicalMutationError(409, "Tool override already exists in project");
	if (proposal.action === "update" && !local) throw new CanonicalMutationError(404, "Tool override not found in project");
	// Exercise the same parser, contribution preflight and diagnostics as the
	// runtime loader in an isolated tree before publishing any candidate bytes.
	if (!loaderAcceptsCandidate(content, parsed, deps.toolManager)) {
		throw new CanonicalMutationError(422, "Tool YAML was rejected by the tool loader");
	}
	// Preserve an existing layout on update: the declaration controls display
	// grouping while the override's existing on-disk group remains canonical.
	const file = local?.file ?? path.join(toolsDir, groupDir, `${parsed.name}.yaml`);
	const previous = local ? fs.readFileSync(file, "utf8") : undefined;
	atomicWrite(file, content);
	if (!targetLoaderAccepts(deps.toolManager, parsed.name)) {
		// A target group can have an invalid shared extension even though a clean
		// candidate was valid. Restore byte-for-byte rather than deleting a valid
		// override on update.
		try {
			if (previous !== undefined) atomicWrite(file, previous);
			else fs.rmSync(file, { force: true });
			__resetToolScanCache();
		} catch { /* preservation failure is surfaced as a rejected mutation */ }
		throw new CanonicalMutationError(422, "Tool YAML was rejected by the tool loader");
	}
	return { action: proposal.action, tool: parsed.name, groupDir: local?.groupDir ?? groupDir };
}
