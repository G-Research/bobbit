/**
 * Pure helpers for the Settings → Components editor (Phase 4b).
 *
 * Lives in its own module so unit tests can exercise the round-trip
 * conversion without bundling the entire settings-page module. The
 * settings-page imports from here.
 *
 * See docs/design/multi-repo-components.md §8.2.
 */

export const COMMAND_ENV_MAX_ENTRIES = 100;
export const COMMAND_ENV_MAX_KEY_LENGTH = 128;
export const COMMAND_ENV_MAX_VALUE_LENGTH = 16_384;
const COMMAND_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CommandEnvironmentEntry {
	key: string;
	value: string;
}

export interface CommandEnvironmentEntryError {
	key?: string;
	value?: string;
}

/**
 * UI-side mirror of command-environment validation. It keeps incomplete rows
 * visible for correction and intentionally never trims values: they are
 * literal configuration, including an explicitly blank value.
 */
export function validateCommandEnvironmentEntries(entries: CommandEnvironmentEntry[]): Map<number, CommandEnvironmentEntryError> {
	const errors = new Map<number, CommandEnvironmentEntryError>();
	const addError = (index: number, field: keyof CommandEnvironmentEntryError, message: string) => {
		const error = errors.get(index) ?? {};
		error[field] = message;
		errors.set(index, error);
	};
	const names = new Map<string, number>();

	entries.forEach((entry, index) => {
		if (!entry.key) addError(index, "key", "Variable name is required.");
		else if (!COMMAND_ENV_KEY_PATTERN.test(entry.key)) addError(index, "key", "Use letters, numbers, and underscores; start with a letter or underscore.");
		else if (entry.key.length > COMMAND_ENV_MAX_KEY_LENGTH) addError(index, "key", `Variable names can be at most ${COMMAND_ENV_MAX_KEY_LENGTH} characters.`);
		if (entry.value.length > COMMAND_ENV_MAX_VALUE_LENGTH) addError(index, "value", `Values can be at most ${COMMAND_ENV_MAX_VALUE_LENGTH} characters.`);

		// Valid names contain ASCII only, so toLowerCase is locale-independent here.
		const normalized = entry.key.toLowerCase();
		const existing = names.get(normalized);
		if (entry.key && existing !== undefined) {
			const otherName = entries[existing].key;
			addError(index, "key", `“${entry.key}” duplicates “${otherName}”. Variable names must be unique ignoring case.`);
			addError(existing, "key", `“${otherName}” duplicates “${entry.key}”. Variable names must be unique ignoring case.`);
		} else if (entry.key) {
			names.set(normalized, index);
		}
	});
	return errors;
}

export interface ComponentEditState {
	name: string;
	repo: string;
	relative_path?: string;
	worktree_setup_command?: string;
	/** Flat name → shell map. Empty array ⇒ data-only component. */
	commands: Array<{ key: string; value: string }>;
	/** Plaintext environment injected only into this component's named commands. */
	env: CommandEnvironmentEntry[];
	/** Opaque key→string config map (e.g. qa_start_command). Empty array allowed. */
	config: Array<{ key: string; value: string }>;
}

export interface ServerComponent {
	name: string;
	repo: string;
	relativePath?: string;
	worktreeSetupCommand?: string;
	commands?: Record<string, string>;
	env?: Record<string, string>;
	config?: Record<string, string>;
}

export function componentToEditState(c: ServerComponent): ComponentEditState {
	const cmds = c.commands ? Object.entries(c.commands).map(([key, value]) => ({ key, value })) : [];
	const env = c.env ? Object.entries(c.env).map(([key, value]) => ({ key, value })) : [];
	const cfg = c.config ? Object.entries(c.config).map(([key, value]) => ({ key, value })) : [];
	return {
		name: c.name,
		repo: c.repo,
		relative_path: c.relativePath ?? "",
		worktree_setup_command: c.worktreeSetupCommand ?? "",
		commands: cmds,
		env,
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
	// Environment values are literal and blank values are meaningful. The editor
	// blocks incomplete/invalid rows before save, so this conversion only omits
	// a genuinely absent map.
	if (e.env && e.env.length > 0) {
		const env: Record<string, string> = {};
		for (const { key, value } of e.env) {
			if (key) env[key] = value;
		}
		if (Object.keys(env).length > 0) out.env = env;
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
