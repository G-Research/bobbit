import path from "node:path";
import type { ProjectContextManager } from "./project-context-manager.js";
import { isHeadquartersProject, isSystemProject } from "./project-registry.js";
import { walkGoalMetadataLineage, type GoalMetadata } from "./goal-metadata.js";
import type { HookScopeComponent, HookScopeContext } from "./lifecycle-hub.js";
import { isSafeRelPath, type Component } from "./project-config-store.js";

/** Coordinates owned by a lifecycle session boundary; never resolve outside them. */
export interface HookScopeResolutionInput {
	readonly projectId?: string;
	readonly goalId?: string;
	readonly roleName?: string;
	readonly cwd: string;
	readonly worktreePath?: string;
	readonly repoPath?: string;
	readonly repoWorktrees?: Readonly<Record<string, string>>;
}

export type HookScopeContextResolver = (
	input: Readonly<HookScopeResolutionInput>,
) => HookScopeContext | undefined;

/** Minimal path coordinates used to select one configured component safely. */
export interface ComponentCoordinateInput {
	readonly cwd: string;
	readonly worktreePath?: string;
	readonly repoPath?: string;
	readonly repoWorktrees?: Readonly<Record<string, string>>;
}

type ProjectContextForScope = {
	readonly project: { id: string; name?: string; kind?: "normal" | "headquarters" | "system"; hidden?: boolean; rootPath: string };
	readonly goalStore: {
		get(id: string): {
			id: string;
			title?: string;
			parentGoalId?: string;
			metadata?: GoalMetadata;
			archived?: boolean;
		} | undefined;
	};
	readonly goalManager: { getEffectiveGoalMetadata(goalId: string | undefined): GoalMetadata };
	readonly projectConfigStore: { getComponents(): Component[] };
};

/**
 * Resolve the advisory hook scope from one session-owned project only.
 * Missing, special, or malformed records deliberately degrade without finding
 * another project that happens to contain the requested goal.
 */
export function resolveHookScopeContext(
	projects: Pick<ProjectContextManager, "getOrCreate">,
	input: Readonly<HookScopeResolutionInput>,
): HookScopeContext | undefined {
	if (!input.projectId) return undefined;

	let context: ProjectContextForScope | null;
	try {
		context = projects.getOrCreate(input.projectId) as ProjectContextForScope | null;
	} catch {
		return undefined;
	}
	if (!context) return undefined;

	const project = context.project;
	if (
		project.id !== input.projectId
		|| isHeadquartersProject(project)
		|| isSystemProject(project)
		|| project.hidden
	) return undefined;

	const scope: {
		project: { id: string; name?: string };
		role?: string;
		goal?: NonNullable<HookScopeContext["goal"]>;
		component?: HookScopeComponent;
	} = {
		project: {
			id: project.id,
			...(project.name ? { name: project.name } : {}),
		},
		...(input.roleName ? { role: input.roleName } : {}),
	};

	if (input.goalId) {
		try {
			const leaf = context.goalStore.get(input.goalId);
			if (leaf && !leaf.archived) {
				const lineage = walkGoalMetadataLineage(context.goalStore, input.goalId);
				const visibleDescendantFirst: Array<(typeof lineage.entries)[number]> = [];
				let complete = lineage.complete;
				for (const entry of lineage.entries) {
					if (entry.node.archived) {
						complete = false;
						break;
					}
					visibleDescendantFirst.push(entry);
				}
				const ancestry = visibleDescendantFirst.slice().reverse().map(({ id, node }) => ({
					id,
					...(node.title ? { title: node.title } : {}),
				}));
				const goal: {
					id: string;
					title?: string;
					ancestry?: Array<{ id: string; title?: string }>;
					depth?: number;
					metadata?: Readonly<Record<string, unknown>>;
				} = {
					id: leaf.id,
					...(leaf.title ? { title: leaf.title } : {}),
					...(ancestry.length > 0 ? { ancestry } : {}),
				};
				if (complete && ancestry.length > 0) {
					goal.depth = ancestry.length;
					try {
						// GoalManager owns the established ancestor-first merge policy.
						const metadata = context.goalManager.getEffectiveGoalMetadata(input.goalId);
						if (metadata && typeof metadata === "object") goal.metadata = cloneMetadata(metadata);
					} catch {
						// Metadata is advisory; keep the verified scope without it.
					}
				}
				scope.goal = goal;
			}
		} catch {
			// A corrupt goal record must not prevent providers from running.
		}
	}

	const component = resolveComponent(context, input);
	if (component) scope.component = component;
	return deepFreeze(scope) as HookScopeContext;
}

/** Select only an unambiguous deepest configured component; derived paths never escape. */
function resolveComponent(context: ProjectContextForScope, input: Readonly<HookScopeResolutionInput>): HookScopeComponent | undefined {
	return resolveConfiguredComponent(
		context.projectConfigStore.getComponents(),
		context.project.rootPath,
		input,
	);
}

/**
 * Select one unambiguous configured component from server-owned path coordinates.
 * This is shared by lifecycle hook scope and repository-bound PR routes so neither
 * path may fall through to a sibling component based on declaration order.
 */
export function resolveConfiguredComponent(
	components: readonly Component[],
	projectRoot: string,
	input: Readonly<ComponentCoordinateInput>,
): HookScopeComponent | undefined {
	try {
		if (!components.length || !input.cwd) return undefined;
		const containerCwd = parseSandboxContainerCwd(input.cwd);
		if (containerCwd === "invalid") return undefined;
		const cwd = containerCwd ? undefined : path.resolve(input.cwd);
		const multiRepo = components.some(component => component.repo !== ".");
		// A multi-repo branch container has no selected repository/component. Some
		// legacy entity records instead store the selected member worktree here; an
		// exact repoWorktrees coordinate remains an authoritative component binding.
		if (
			!containerCwd
			&& multiRepo
			&& input.worktreePath
			&& samePath(cwd!, path.resolve(input.worktreePath))
			&& !Object.values(input.repoWorktrees ?? {}).some(repoWorktree => samePath(cwd!, path.resolve(repoWorktree)))
		) return undefined;

		const matches: Array<{ component: Component; depth: number }> = [];
		for (const component of components) {
			if (!component.name || !component.repo) continue;
			const coordinates = componentCoordinates(component, projectRoot, input, multiRepo);
			if (!coordinates) continue;
			const comparableCwd = containerCwd
				? mapSandboxCwdToHost(containerCwd, component, multiRepo, coordinates.repoRoot, input)
				: cwd;
			if (!comparableCwd || !isWithin(comparableCwd, coordinates.root)) continue;
			matches.push({ component, depth: coordinates.root.length });
		}
		if (!matches.length) return undefined;
		const deepest = Math.max(...matches.map(match => match.depth));
		const winners = matches.filter(match => match.depth === deepest);
		if (winners.length !== 1) return undefined;
		const component = winners[0].component;
		return {
			name: component.name,
			repo: component.repo,
			...(component.relativePath ? { relativePath: component.relativePath } : {}),
		};
	} catch {
		// Path normalization or malformed project configuration fails closed.
		return undefined;
	}
}

function componentCoordinates(
	component: Component,
	projectRoot: string,
	input: Readonly<ComponentCoordinateInput>,
	multiRepo: boolean,
): { repoRoot: string; root: string } | undefined {
	if (!isSafeComponentPath(component.repo, component.repo === ".") || !isSafeComponentPath(component.relativePath ?? "", true)) return undefined;
	let repoRoot = input.repoWorktrees?.[component.repo];
	if (!repoRoot && component.repo === ".") {
		repoRoot = input.worktreePath ?? input.repoPath ?? projectRoot;
	}
	// A branch-container worktree does not identify one member repository.
	if (!repoRoot && multiRepo && input.worktreePath) return undefined;
	if (!repoRoot) repoRoot = component.repo === "." ? projectRoot : path.join(input.repoPath ?? projectRoot, ...componentPathParts(component.repo));
	const resolvedRepoRoot = path.resolve(repoRoot);
	const root = path.resolve(resolvedRepoRoot, ...componentPathParts(component.relativePath ?? ""));
	return isWithin(root, resolvedRepoRoot) ? { repoRoot: resolvedRepoRoot, root } : undefined;
}

type SandboxContainerCwd = { base: "workspace" | "worktree"; rest: string[] };

/** Parse only canonical container paths; never normalize away traversal. */
function parseSandboxContainerCwd(cwd: string): SandboxContainerCwd | "invalid" | undefined {
	if (typeof cwd !== "string") return "invalid";
	const isContainerPath = cwd === "/workspace"
		|| cwd.startsWith("/workspace/")
		|| cwd === "/workspace-wt"
		|| cwd.startsWith("/workspace-wt/");
	// Only paths in the exact container namespace receive container syntax
	// validation. In particular, a native Windows host cwd contains backslashes.
	if (!isContainerPath) return undefined;
	if (cwd.includes("\\") || cwd.includes("\0")) return "invalid";
	const parts = cwd.split("/");
	if (!parts.slice(1).every(isSafePathSegment)) return "invalid";
	if (parts[1] === "workspace") return { base: "workspace", rest: parts.slice(2) };
	// `/workspace-wt` is a branch container, not a repository root.
	if (parts.length < 3) return "invalid";
	return { base: "worktree", rest: parts.slice(3) };
}

/** Convert a container-relative repo path to the selected component's host root. */
function mapSandboxCwdToHost(
	cwd: SandboxContainerCwd,
	component: Component,
	multiRepo: boolean,
	repoRoot: string,
	input: Readonly<ComponentCoordinateInput>,
): string | undefined {
	if (!isSafeAbsoluteHostPath(repoRoot)) return undefined;
	let relative = cwd.rest;
	if (multiRepo) {
		const repoParts = componentPathParts(component.repo);
		if (!repoParts.every(isSafePathSegment) || !repoParts.every((part, index) => relative[index] === part)) return undefined;
		relative = relative.slice(repoParts.length);
		// A container worktree needs its own host worktree. `/workspace` may
		// instead compare against the project repo root for a no-worktree session.
		const repoWorktree = input.repoWorktrees?.[component.repo];
		if (repoWorktree !== undefined && !isSafeAbsoluteHostPath(repoWorktree)) return undefined;
		if (cwd.base === "worktree" && !isSafeAbsoluteHostPath(repoWorktree)) return undefined;
		if (cwd.base === "workspace" && !isSafeAbsoluteHostPath(repoWorktree) && !isSafeAbsoluteHostPath(input.repoPath)) return undefined;
	} else if (component.repo !== ".") {
		return undefined;
	} else if (!isSafeAbsoluteHostPath(input.worktreePath ?? input.repoPath)) {
		return undefined;
	}
	return path.resolve(repoRoot, ...relative);
}

function isSafeComponentPath(value: string, allowEmptyOrDot: boolean): boolean {
	if (typeof value !== "string") return false;
	if ((value === "" || value === ".") && allowEmptyOrDot) return true;
	return !!value && isSafeRelPath(value);
}

/** Config paths accept either native separator; use path segments for local joins. */
function componentPathParts(value: string): string[] {
	return value.split(/[\\/]+/).filter(Boolean);
}

function isSafeAbsoluteHostPath(value: unknown): value is string {
	return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && !isSandboxContainerPath(value);
}

function isSandboxContainerPath(value: string): boolean {
	return value === "/workspace" || value.startsWith("/workspace/") || value === "/workspace-wt" || value.startsWith("/workspace-wt/");
}

function isSafePathSegment(value: string): boolean {
	return !!value && value !== "." && value !== "..";
}

function isWithin(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
	return path.relative(left, right) === "";
}

/** Clone the manager's metadata result before freezing; never freeze store data. */
function cloneMetadata(metadata: GoalMetadata): Readonly<Record<string, unknown>> {
	return cloneValue(metadata, new Map<object, unknown>()) as Readonly<Record<string, unknown>>;
}

function cloneValue(value: unknown, seen: Map<object, unknown>): unknown {
	if (!value || typeof value !== "object") return value;
	const cached = seen.get(value);
	if (cached) return cached;
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		seen.set(value, result);
		for (const item of value) result.push(cloneValue(item, seen));
		return result;
	}
	const result: Record<string, unknown> = {};
	seen.set(value, result);
	for (const [key, item] of Object.entries(value)) result[key] = cloneValue(item, seen);
	return result;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
	if (!value || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value) as T;
}
