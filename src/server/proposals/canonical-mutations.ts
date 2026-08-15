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
import type { Workflow, WorkflowStore } from "../agent/workflow-store.js";
import { validateWorkflowDefinition, type WorkflowComponentRef } from "../agent/workflow-validator.js";
import { ToolManager, __resetToolScanCache } from "../agent/tool-manager.js";

/** Durable, server-owned idempotency marker. Callers must never take this from
 * proposal metadata or another user controlled field. */
export const CANONICAL_MUTATION_KEY = "bobbit.canonicalMutationKey";

export class CanonicalMutationError extends Error {
	constructor(public readonly status: 400 | 404 | 409 | 422, message: string, public readonly code?: string) {
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
 * The persistence boundary for goal creation. Route and proposal callers do
 * their own authentication/transport validation, then pass the resolved
 * workflow and policy-clamped options here. This keeps a replay from creating
 * a second goal while deliberately retaining the public route's semantics.
 */
export async function createCanonicalGoal<T extends { id: string; workflow?: { gates: Array<{ id: string }> }; metadata?: Record<string, unknown> }>(
	input: {
		title: string;
		cwd: string;
		options: Record<string, unknown>;
		projectId?: string;
		reattemptOf?: string;
		autoStartTeam: boolean;
		applicationKey?: string;
	},
	deps: {
		findByApplicationKey(key: string): T | undefined;
		create(title: string, cwd: string, options: Record<string, unknown>): Promise<T>;
		update(id: string, updates: Record<string, unknown>): void;
		initGates(goalId: string, gateIds: string[]): void;
		flush(): Promise<void>;
		afterCreate(goal: T): void | Promise<void>;
	},
): Promise<{ goal: T; replayed: boolean }> {
	if (input.applicationKey) {
		const existing = deps.findByApplicationKey(input.applicationKey);
		if (existing) return { goal: existing, replayed: true };
	}
	const metadata = input.options.metadata && typeof input.options.metadata === "object" && !Array.isArray(input.options.metadata)
		? { ...(input.options.metadata as Record<string, unknown>) }
		: {};
	// Always overwrite the reserved field. A proposal cannot claim an operation
	// identity by placing this key in its arbitrary metadata bag.
	if (input.applicationKey) metadata[CANONICAL_MUTATION_KEY] = input.applicationKey;
	const goal = await deps.create(input.title, input.cwd, {
		...input.options,
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
	(goal as T & { autoStartTeam?: boolean }).autoStartTeam = input.autoStartTeam;
	if (goal.workflow) deps.initGates(goal.id, goal.workflow.gates.map(gate => gate.id));
	await deps.flush();
	// The HTTP route publishes the creation response before its historical
	// fire-and-forget setup/start work. Deferring retains that observable order
	// while proposal callers still share the exact same lifecycle hook.
	queueMicrotask(() => { void deps.afterCreate(goal); });
	return { goal, replayed: false };
}

export type CanonicalProjectMode = "register" | "update" | "promote";

/**
 * Canonical project mutation transaction. Configuration is supplied as one
 * already-validated callback because ProjectConfigStore owns the complex
 * atomic config/secrets format; registration, replacement rollback and the
 * durable idempotency marker stay in one reusable operation.
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
		configure(project: T): Promise<void> | void;
		removeRegistered(project: T): void;
		removeContext(projectId: string): Promise<void>;
		openContext(projectId: string): Promise<boolean>;
		suspendServices(projectId: string): Promise<void>;
		stopServices(projectId: string): Promise<void>;
		reconcileServices(projectId: string): Promise<void>;
	},
): Promise<{ project: T; replayed: boolean }> {
	if (input.mode === "register") {
		if (input.applicationKey) {
			const existing = deps.findByApplicationKey(input.applicationKey);
			if (existing) return { project: existing, replayed: true };
		}
		const project = deps.register(input.applicationKey);
		try {
			await deps.configure(project);
			return { project, replayed: false };
		} catch (error) {
			// A rejected initial config must never leave a half-registered project.
			deps.removeRegistered(project);
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
		await deps.configure(project);
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
		await deps.configure(project);
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
