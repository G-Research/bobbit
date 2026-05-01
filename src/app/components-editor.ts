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
	/** Opaque key→string config map (e.g. qa_start_command). Empty array allowed. */
	config: Array<{ key: string; value: string }>;
}

export interface ServerComponent {
	name: string;
	repo: string;
	relativePath?: string;
	worktreeSetupCommand?: string;
	commands?: Record<string, string>;
	config?: Record<string, string>;
}

export function componentToEditState(c: ServerComponent): ComponentEditState {
	const cmds = c.commands ? Object.entries(c.commands).map(([key, value]) => ({ key, value })) : [];
	const cfg = c.config ? Object.entries(c.config).map(([key, value]) => ({ key, value })) : [];
	return {
		name: c.name,
		repo: c.repo,
		relative_path: c.relativePath ?? "",
		worktree_setup_command: c.worktreeSetupCommand ?? "",
		commands: cmds,
		config: cfg,
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
	// Per-component opaque config map (e.g. qa_start_command, qa_health_check).
	// Drop entries with empty key; preserve empty values is meaningless so
	// require both. Mirrors `commands` semantics.
	// `e.config` may be undefined when callers pass a partial edit-state
	// (e.g. legacy fixture tests). Treat absent as empty.
	if (e.config && e.config.length > 0) {
		const cfg: Record<string, string> = {};
		for (const { key, value } of e.config) {
			if (key.trim() && value !== "") cfg[key.trim()] = value;
		}
		if (Object.keys(cfg).length > 0) out.config = cfg;
	}
	return out;
}

/**
 * Build the PUT body the Components tab sends to /api/projects/:id/config.
 * Pure — takes a list of edit-state components and an optional `worktree_root`.
 *
 * NOTE: We deliberately do NOT include `workflows` here. The server validates
 * inline workflows against the supplied components when both are present.
 * Re-sending the unchanged workflow set on every component-only edit can
 * therefore reject a save against components that don't yet have commands
 * defined (a common state for a fresh project where the default-seeded
 * workflows reference build/test/check/e2e commands). The Workflows tab
 * has its own save path.
 *
 * `worktree_root` IS sent because the Components tab owns the Worktree-root
 * input on the per-project Settings page (the multi-repo flow E2E exercises
 * it). Empty string is sent verbatim so the user can clear it.
 */
export function buildSavePayload(
	components: ComponentEditState[],
	_workflows?: Record<string, unknown>,
	worktreeRoot?: string,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		components: components.map(editStateToComponent),
	};
	if (worktreeRoot !== undefined) body.worktree_root = worktreeRoot;
	return body;
}
