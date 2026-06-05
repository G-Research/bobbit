/**
 * Auto-prompt builder for the project-assistant first turn.
 *
 * This is the single source of truth for the text the Add-Project flow sends
 * to the project-assistant on session creation. Previously this string was
 * inlined in `src/app/session-manager.ts::connectToSession` (lines 1171–1182
 * pre-refactor); pulling it out makes the format unit-testable and lets the
 * Add-Project dialog forward a user-confirmed repo/subdirectory selection
 * into the assistant's first turn.
 *
 * The "subset selection" block format below is **pinned by**
 * `tests/project-assistant-autoprompt.test.ts`. Do not change the wording
 * without updating the test AND
 * `src/server/agent/project-assistant.ts`, which teaches the assistant to
 * recognise this exact block and treat `selectedIds` as authoritative
 * initial candidates for `propose_project.components`.
 */

/**
 * One normalized scan item — the shared shape used by both the V2 Add Project
 * scan checklist UI and the project-assistant handoff payload.
 *
 * Single source of truth: the V2 dialog builds these from the
 * `/api/projects/scan` response (`{ repos, monorepo }`); the same array
 * flows verbatim into `formatProjectAssistantAutoPrompt`'s machine-readable
 * JSON block so the assistant sees exactly what the user saw.
 */
export interface ProjectScanItem {
	/** Stable id used by the checklist + selectedIds. `repo:<folder>` or `workspace:<relativePath>`. */
	id: string;
	kind: "repo" | "workspace";
	/** Display label, e.g. "api", "packages/web", "(root)". */
	label: string;
	/** Component repo value: "." for single/monorepo, folder name for multi-repo. */
	repo: string;
	/** Optional sub-path within the repo (monorepo workspaces). */
	relativePath?: string;
	/** Absolute path on disk. */
	absolutePath: string;
	hasGit: boolean;
	detectedCommands: Record<string, string>;
}

export interface ProjectAssistantScanContext {
	rootPath: string;
	items: ProjectScanItem[];
	/** Subset of `items[].id` the user confirmed, serialized in display order. */
	selectedIds: string[];
}

export interface FormatProjectAssistantAutoPromptOptions {
	/** Project directory path. Required for both new and scaffolding modes. */
	dirPath: string;
	/** True when the target directory is empty / does not exist yet. */
	scaffolding?: boolean;
	/** Set when re-opening the assistant against an already-registered project. */
	editContext?: { name: string; rootPath: string };
	/**
	 * Optional user-confirmed repo/subdirectory selection from the Add Project
	 * scan checklist. Only meaningful in new-project (non-scaffolding,
	 * non-edit) mode. When present, the prompt is extended with a derived
	 * English summary AND a fenced JSON block carrying the raw payload.
	 */
	initialScanContext?: ProjectAssistantScanContext;
}

function labelOf(items: readonly ProjectScanItem[], id: string): string {
	const item = items.find(it => it.id === id);
	return item?.label ?? id;
}

function formatList(items: readonly ProjectScanItem[], ids: readonly string[]): string {
	return ids.map(id => `\`${labelOf(items, id)}\``).join(", ");
}

function formatScanSubsetBlock(ctx: ProjectAssistantScanContext): string {
	const total = ctx.items.length;
	const selectedSet = new Set(ctx.selectedIds);
	// Preserve display order from items, not selection order.
	const orderedSelected = ctx.items.filter(it => selectedSet.has(it.id)).map(it => it.id);
	const orderedUnselected = ctx.items.filter(it => !selectedSet.has(it.id)).map(it => it.id);
	const selectedLabels = formatList(ctx.items, orderedSelected);
	const unselectedLabels = formatList(ctx.items, orderedUnselected);

	// The JSON payload mirrors the input context exactly, with selectedIds
	// re-serialized in display order so the assistant doesn't have to
	// reconstruct it.
	const payload: ProjectAssistantScanContext = {
		rootPath: ctx.rootPath,
		items: ctx.items,
		selectedIds: orderedSelected,
	};
	const json = JSON.stringify(payload, null, 2);

	const lines: string[] = [];
	lines.push("");
	lines.push("User-confirmed initial repo/subdirectory selection from Add Project:");
	lines.push(`- Selected ${orderedSelected.length} of ${total} repo/subdirectory candidates: ${selectedLabels}`);
	if (orderedUnselected.length > 0) {
		lines.push(`- Not selected: ${unselectedLabels}`);
	} else {
		lines.push("- Not selected: (none — all candidates selected)");
	}
	lines.push("- Treat only the selected repos/subdirectories as candidates for the initial `propose_project.components`.");
	lines.push("- Do not include unselected entries by default, but tell the user they can add them back.");
	lines.push("");
	lines.push("Machine-readable selection:");
	lines.push("```json");
	lines.push(json);
	lines.push("```");
	return lines.join("\n");
}

/**
 * Build the auto-prompt sent to the project-assistant on its first turn.
 *
 * Modes (mutually exclusive in this order of precedence):
 *   1. `editContext`           → "Edit the existing project ..."
 *   2. `scaffolding`           → "Start the new project setup session ..."
 *   3. `initialScanContext`    → "Start the project registration session ..." + subset block
 *   4. default (plain new)     → "Start the project registration session ..."
 */
export function formatProjectAssistantAutoPrompt(
	opts: FormatProjectAssistantAutoPromptOptions,
): string {
	const { dirPath, scaffolding, editContext, initialScanContext } = opts;

	if (editContext) {
		return `Edit the existing project '${editContext.name}' at ${editContext.rootPath}. Read its current \`.bobbit/config/project.yaml\` and propose it back as-is via \`propose_project\`, then ask the user what they want to change or add.`;
	}

	if (scaffolding) {
		return `Start the new project setup session. The target directory is: ${dirPath}`;
	}

	const base = `Start the project registration session. The project directory is: ${dirPath}`;
	if (initialScanContext && initialScanContext.items.length > 0) {
		return `${base}\n${formatScanSubsetBlock(initialScanContext)}`;
	}
	return base;
}
