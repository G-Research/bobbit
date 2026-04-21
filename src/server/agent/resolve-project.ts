import type { ProjectRegistry, RegisteredProject } from "./project-registry.js";
import type { ProjectContextManager } from "./project-context-manager.js";

export type ResolvedProject =
	| { ok: true; projectId: string; project: RegisteredProject }
	| { ok: false; status: 400 | 404; error: string };

/**
 * Resolve a project for an API request from either an explicit `projectId`
 * or a `cwd` inside a registered project's rootPath.
 *
 * There is NO fallback to a "default project" — if neither is provided or
 * resolves, the helper returns a 400.
 *
 * Resolution order:
 *   1. body.projectId (non-empty string) matches a registered project  → ok
 *   2. body.cwd (string) matches via ProjectRegistry.findByCwd()       → ok
 *   3. Otherwise → 400 with a message that distinguishes "no projectId, no cwd"
 *      from "cwd did not match any project"
 *
 * Pure, synchronous, no side effects.
 */
export function resolveProjectForRequest(
	registry: ProjectRegistry,
	_pcm: ProjectContextManager,
	body: { projectId?: unknown; cwd?: unknown },
): ResolvedProject {
	const { projectId, cwd } = body;

	if (typeof projectId === "string" && projectId.length > 0) {
		const project = registry.get(projectId);
		if (project) {
			return { ok: true, projectId: project.id, project };
		}
		return { ok: false, status: 400, error: "Invalid project" };
	}

	if (typeof cwd === "string" && cwd.length > 0) {
		const matched = registry.findByCwd(cwd);
		if (matched) {
			return { ok: true, projectId: matched.id, project: matched };
		}
		return {
			ok: false,
			status: 400,
			error: `projectId required: no projectId was provided and cwd (${JSON.stringify(cwd)}) does not match any registered project`,
		};
	}

	return {
		ok: false,
		status: 400,
		error: "projectId required: no projectId was provided and cwd (\"\") does not match any registered project",
	};
}
