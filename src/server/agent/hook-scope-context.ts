import path from "node:path";
import type { ProjectContextManager } from "./project-context-manager.js";
import { isHeadquartersProject, isSystemProject } from "./project-registry.js";
import { walkGoalMetadataLineage, type GoalMetadata } from "./goal-metadata.js";
import type { HookScopeComponent, HookScopeContext } from "./lifecycle-hub.js";
import type { Component } from "./project-config-store.js";

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
	try {
		const components = context.projectConfigStore.getComponents();
		if (!components.length || !input.cwd) return undefined;
		const cwd = path.resolve(input.cwd);
		const multiRepo = components.some(component => component.repo !== ".");
		// A multi-repo branch container has no selected repository/component.
		if (multiRepo && input.worktreePath && samePath(cwd, path.resolve(input.worktreePath))) return undefined;

		const matches: Array<{ component: Component; depth: number }> = [];
		for (const component of components) {
			if (!component.name || !component.repo) continue;
			const root = componentRoot(component, context.project.rootPath, input, multiRepo);
			if (!root || !isWithin(cwd, root)) continue;
			matches.push({ component, depth: root.length });
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
		// Path normalization or a malformed project configuration is not scope data.
		return undefined;
	}
}

function componentRoot(
	component: Component,
	projectRoot: string,
	input: Readonly<HookScopeResolutionInput>,
	multiRepo: boolean,
): string | undefined {
	let repoRoot = input.repoWorktrees?.[component.repo];
	if (!repoRoot && component.repo === ".") {
		repoRoot = input.worktreePath ?? input.repoPath ?? projectRoot;
	}
	// A branch-container worktree does not identify one member repository.
	if (!repoRoot && multiRepo && input.worktreePath) return undefined;
	if (!repoRoot) repoRoot = component.repo === "." ? projectRoot : path.join(projectRoot, component.repo);
	return path.resolve(repoRoot, component.relativePath ?? "");
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
