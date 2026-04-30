/**
 * Pure helpers for the Settings → Components editor (Phase 4b).
 *
 * Lives in its own module so unit tests can exercise the round-trip
 * conversion without bundling the entire settings-page module. The
 * settings-page imports from here.
 *
 * See docs/design/multi-repo-components.md §8.2.
 */

export interface ComponentEditState {
	name: string;
	repo: string;
	relative_path?: string;
	worktree_setup_command?: string;
	/** Flat name → shell map. Empty array ⇒ data-only component. */
	commands: Array<{ key: string; value: string }>;
}

export interface ServerComponent {
	name: string;
	repo: string;
	relativePath?: string;
	worktreeSetupCommand?: string;
	commands?: Record<string, string>;
}

export function componentToEditState(c: ServerComponent): ComponentEditState {
	const cmds = c.commands ? Object.entries(c.commands).map(([key, value]) => ({ key, value })) : [];
	return {
		name: c.name,
		repo: c.repo,
		relative_path: c.relativePath ?? "",
		worktree_setup_command: c.worktreeSetupCommand ?? "",
		commands: cmds,
	};
}

export function editStateToComponent(e: ComponentEditState): Record<string, unknown> {
	const out: Record<string, unknown> = { name: e.name, repo: e.repo || "." };
	if (e.relative_path) out.relative_path = e.relative_path;
	if (e.worktree_setup_command) out.worktree_setup_command = e.worktree_setup_command;
	// Empty commands array ⇒ data-only component (server treats absent commands
	// as data-only). Otherwise emit a flat name → shell map.
	if (e.commands.length > 0) {
		const cmds: Record<string, string> = {};
		for (const { key, value } of e.commands) {
			if (key.trim() && value.trim()) cmds[key.trim()] = value;
		}
		if (Object.keys(cmds).length > 0) out.commands = cmds;
	}
	return out;
}

/**
 * Build the PUT body the Components tab sends to /api/projects/:id/config.
 * Pure — takes a list of edit-state components and the inline workflows map.
 * `worktree_root` is owned by the General tab and is not sent from here.
 */
export function buildSavePayload(
	components: ComponentEditState[],
	workflows: Record<string, unknown>,
): Record<string, unknown> {
	return {
		components: components.map(editStateToComponent),
		workflows,
	};
}
