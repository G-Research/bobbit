import type { Component } from "./agent/project-config-store.js";
import { shouldCreateWorktree } from "./agent/worktree-decision.js";
import {
	resolveWorktreeSupport,
	type WorktreeSupportDeps,
} from "./agent/worktree-support.js";

export interface SessionWorktreeOptionsInput {
	worktree?: boolean;
	assistantType?: string;
	goalId?: string;
	projectId: string;
	headquartersProjectId: string;
	projectRoot?: string;
	components: Component[];
	configuredBaseRef?: string;
	cwd: string;
}

export type SessionWorktreeOptions = { repoPath: string };

/**
 * Pure session worktree-options decision used at the repository-detection
 * boundary. Git inspection is injected so one request never needs to mutate a
 * shared command runner or SessionManager in order to exercise this policy.
 */
export async function resolveSessionWorktreeOptions(
	input: SessionWorktreeOptionsInput,
	git: WorktreeSupportDeps | undefined = undefined,
): Promise<SessionWorktreeOptions | undefined> {
	if (
		input.projectId === input.headquartersProjectId
		|| !shouldCreateWorktree({
			worktree: input.worktree,
			assistantType: input.assistantType,
			goalId: input.goalId,
		}, true)
	) {
		return undefined;
	}

	try {
		const support = await resolveWorktreeSupport(
			input.components,
			input.projectRoot,
			input.cwd,
			git,
			{ configuredBaseRef: input.configuredBaseRef },
		);
		return support.supported && support.repoPath
			? { repoPath: support.repoPath }
			: undefined;
	} catch {
		// Repository discovery is best-effort; unsupported projects create a
		// normal session just as the HTTP route does today.
		return undefined;
	}
}
