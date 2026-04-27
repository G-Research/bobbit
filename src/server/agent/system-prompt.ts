import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAllConfigDirectories, type ProjectConfigReader } from "./config-directories.js";
import type { SlashSkill } from "../skills/slash-skills.js";

/** Module-level cache of the prompts directory. Set once by ensurePromptsDir(). */
let _promptsDir: string | undefined;
let _stateDir: string | undefined;

/** Initialize the prompts directory from a stateDir. Called by server startup. */
export function initPromptDirs(stateDir: string): void {
	_stateDir = stateDir;
	_promptsDir = path.join(stateDir, "session-prompts");
	if (!fs.existsSync(_promptsDir)) {
		fs.mkdirSync(_promptsDir, { recursive: true });
	}
}

function getPromptsDir(): string {
	if (!_promptsDir) throw new Error("system-prompt: initPromptDirs() not called");
	// Defensive recreate: the dir is created once at startup but may be removed
	// mid-run by external cleanup (test teardown, maintenance, AV quirks).
	// Recreating on access keeps writes robust without masking real errors.
	if (!fs.existsSync(_promptsDir)) fs.mkdirSync(_promptsDir, { recursive: true });
	return _promptsDir;
}

function getStateDir(): string {
	if (!_stateDir) throw new Error("system-prompt: initPromptDirs() not called");
	return _stateDir;
}

/**
 * Resolve `@path` references in markdown content, matching Claude Code behavior.
 *
 * `@path/to/file.ext` references are expanded inline wherever they appear on a
 * line. Both relative and absolute paths are supported; relative paths resolve
 * from `baseDir`. References are resolved recursively (a referenced file can
 * itself contain `@` references) up to a maximum depth of 5 hops. A `seen` set
 * prevents infinite loops. Paths starting with `~` expand to the home directory.
 *
 * When a `@ref` is the **only** content on a line (with optional leading
 * whitespace), the file content replaces the entire line and inherits the
 * leading indentation. When inline with other text, the file content is
 * inserted in place of the `@ref` token (no indentation adjustment).
 */
export function resolveMarkdownRefs(content: string, baseDir: string, seen?: Set<string>, depth = 0): string {
	if (!seen) seen = new Set();
	const MAX_DEPTH = 5;

	// First pass: whole-line refs (preserves indentation behavior)
	content = content.replace(/^([ \t]*)@(\S+)\s*$/gm, (_match, indent: string, refPath: string) => {
		return resolveOneRef(refPath, indent, baseDir, seen!, depth, MAX_DEPTH, /* wholeLine */ true);
	});

	// Second pass: inline refs (surrounded by other text)
	// Negative lookbehind excludes email addresses (word char before @)
	content = content.replace(/(?<!\w)@((?:~[/\\]|\.{0,2}[/\\])?[\w./_\\-]+\.\w+)/g, (_match, refPath: string) => {
		return resolveOneRef(refPath, "", baseDir, seen!, depth, MAX_DEPTH, /* wholeLine */ false);
	});

	return content;
}

function expandHomePath(p: string): string {
	if (p.startsWith("~")) {
		return path.join(os.homedir(), p.slice(1));
	}
	return p;
}

function resolveOneRef(
	refPath: string,
	indent: string,
	baseDir: string,
	seen: Set<string>,
	depth: number,
	maxDepth: number,
	wholeLine: boolean,
): string {
	const filePath = path.resolve(baseDir, expandHomePath(refPath));
	const canonical = path.normalize(filePath);

	if (seen.has(canonical)) {
		return wholeLine ? `${indent}<!-- circular reference: ${refPath} -->` : `<!-- circular reference: ${refPath} -->`;
	}

	if (!fs.existsSync(filePath)) {
		return wholeLine ? `${indent}<!-- file not found: ${refPath} -->` : `<!-- file not found: ${refPath} -->`;
	}

	if (depth >= maxDepth) {
		return wholeLine ? `${indent}<!-- max import depth reached: ${refPath} -->` : `<!-- max import depth reached: ${refPath} -->`;
	}

	seen.add(canonical);
	try {
		const refContent = fs.readFileSync(filePath, "utf-8");
		const resolved = resolveMarkdownRefs(refContent, path.dirname(filePath), seen, depth + 1);

		if (wholeLine && indent) {
			return resolved
				.split("\n")
				.map((line) => (line.trim() ? indent + line : line))
				.join("\n");
		}
		return resolved;
	} catch {
		return wholeLine ? `${indent}<!-- error reading: ${refPath} -->` : `<!-- error reading: ${refPath} -->`;
	}
}

/**
 * Read an AGENTS.md file from a directory, resolving `@` references.
 * Returns the resolved content, or empty string if no file exists.
 * Looks for AGENTS.md (case-sensitive).
 */
export function readAgentsMd(cwd: string): string {
	const agentsPath = path.join(cwd, "AGENTS.md");
	if (!fs.existsSync(agentsPath)) return "";

	try {
		const raw = fs.readFileSync(agentsPath, "utf-8");
		return resolveMarkdownRefs(raw, cwd);
	} catch {
		return "";
	}
}

/**
 * Read all agent markdown files from configured locations.
 * Collects entries with type "agents" from getAllConfigDirectories(),
 * reads each existing file, resolves @refs, and concatenates.
 * Falls back to readAgentsMd() if no projectConfigStore is provided.
 */
export function readAllAgentFiles(cwd: string, projectConfigStore?: ProjectConfigReader): string {
	if (!projectConfigStore) {
		return readAgentsMd(cwd);
	}

	const dirs = getAllConfigDirectories(cwd, projectConfigStore);
	const agentEntries = dirs.filter(d => d.types.includes("agents") && d.exists);

	const parts: string[] = [];
	for (const entry of agentEntries) {
		try {
			const content = fs.readFileSync(entry.path, "utf-8");
			const resolved = resolveMarkdownRefs(content, path.dirname(entry.path));
			if (resolved.trim()) {
				parts.push(resolved.trim());
			}
		} catch (err) {
			console.warn(`[system-prompt] Failed to read agent file ${entry.path}, skipping:`, err);
		}
	}

	return parts.join("\n\n");
}

export interface PromptParts {
	/** Path to the global system prompt file (config/system-prompt.md) */
	baseSystemPromptPath?: string;
	/** Working directory shown to the agent (may be container-internal for sandbox). */
	cwd: string;
	/** Host-accessible project root for AGENTS.md / config directory discovery.
	 *  Falls back to `cwd` when not set (non-sandbox sessions). */
	projectRoot?: string;
	/** Goal title (for header) */
	goalTitle?: string;
	/** Goal state */
	goalState?: string;
	/** Goal spec markdown content */
	goalSpec?: string;
	/** Role prompt template (separate from goalSpec for section display) */
	rolePrompt?: string;
	/** Role name for display */
	roleName?: string;

	/** Task title */
	taskTitle?: string;
	/** Task type (e.g. 'implementation', 'code-review', etc.) */
	taskType?: string;
	/** Task spec markdown content */
	taskSpec?: string;
	/** Human-readable descriptions of dependency tasks */
	taskDependsOn?: string[];
	/** Personalities to inject into the system prompt */
	personalities?: Array<{ label: string; promptFragment: string }>;
	/** Pre-formatted tool documentation section to append */
	toolDocs?: string;
	/** Allowed tool names for this session — used to filter tool docs */
	allowedTools?: string[];
	/** Pre-formatted upstream gate context from workflow dependencies */
	workflowContext?: string;
	/** Project config store for multi-file agent discovery */
	projectConfigStore?: ProjectConfigReader;
	/** Seed context for Continue-Archived: transcript of the prior archived session. */
	seedContext?: string;
	/** Source ID for the prior archived session — used for prompt-section provenance. */
	seedContextSource?: string;
	/** Skills available for autonomous activation via the `activate_skill` tool.
	 *  When non-empty, an "Available Skills" section is injected into the system prompt.
	 *  Skills with `disable-model-invocation: true` should be filtered out by the caller. */
	skillsCatalog?: SlashSkill[];
}

/** Max bytes of skills-catalog markdown to embed in the system prompt. */
export const SKILLS_CATALOG_BUDGET = 4096;

/**
 * Build the "Available Skills" section. Skills are listed alphabetically;
 * if the budget is exceeded, the tail is truncated with an `(N more …
 * omitted, alphabetically truncated)` footer.
 *
 * Caller is responsible for filtering out skills with
 * `disable-model-invocation: true` — this function trusts its input.
 */
export function buildSkillsCatalogSection(skills: SlashSkill[]): string | undefined {
	if (!skills || skills.length === 0) return undefined;
	const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));

	const header = "## Available Skills\n\n" +
		"You can autonomously activate any of the following skills mid-turn by calling " +
		"the `activate_skill` tool with `{ name, args? }`. The tool returns the skill's " +
		"instructions as the tool result; follow them as if the user had typed `/<name> <args>`.\n\n";

	const lines: string[] = [];
	let length = header.length;
	let truncated = 0;
	for (let i = 0; i < sorted.length; i++) {
		const s = sorted[i];
		const desc = (s.description || "").replace(/\s+/g, " ").trim();
		const hint = s.argumentHint ? ` _args: ${s.argumentHint}_` : "";
		const line = `- **${s.name}** — ${desc}${hint}`;
		if (length + line.length + 1 > SKILLS_CATALOG_BUDGET) {
			truncated = sorted.length - i;
			break;
		}
		lines.push(line);
		length += line.length + 1;
	}
	if (truncated > 0) {
		lines.push(`- _… (${truncated} more skill${truncated === 1 ? "" : "s"} omitted, alphabetically truncated)_`);
		console.warn(`[system-prompt] Skills catalog exceeded ${SKILLS_CATALOG_BUDGET}B budget — truncated ${truncated} skill(s).`);
	}
	return header + lines.join("\n");
}

export interface PromptSection {
	label: string;
	source: string;
	content: string;
	/** Estimated token count (~4 chars/token for Claude models) */
	tokens: number;
}

/**
 * Assemble the full system prompt from its parts and write to a temp file.
 *
 * Order:
 *   1. Global system prompt (config/system-prompt.md)
 *   2. AGENTS.md from the session's working directory (with @refs resolved inline)
 *   3. Goal spec (if session belongs to a goal)
 *
 * Returns the path to the assembled prompt file, or undefined if all parts
 * are empty (in which case no --system-prompt should be passed to the agent).
 */
export function assembleSystemPrompt(sessionId: string, parts: PromptParts): string | undefined {
	const sections: string[] = [];

	// 1. Global system prompt (resolve @refs relative to its directory)
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const raw = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		const base = raw ? resolveMarkdownRefs(raw, path.dirname(parts.baseSystemPromptPath)) : "";
		if (base) sections.push(base);
	}

	// 2. Agent files — use projectRoot (host-accessible) when available; for sandboxed
	// agents cwd is a container-internal path the host can't read.
	const filesRoot = parts.projectRoot || parts.cwd;
	const agentsMd = readAllAgentFiles(filesRoot, parts.projectConfigStore);
	if (agentsMd.trim()) {
		sections.push("# Project AGENTS.md\n\n" + agentsMd.trim());
	}

	// 2.5. Working directory instructions
	if (parts.cwd) {
		sections.push(
			`# Working Directory\n\n` +
			`Your working directory is: \`${parts.cwd}\`\n\n` +
			`Stay in this directory for all file operations and git commands. ` +
			`Do not \`cd\` into other directories unless explicitly required by the task.\n\n` +
			`**Why this is a hard constraint:** Other agents, the dev server, and the user may all be working in the primary worktree simultaneously. ` +
			`If you \`cd\` there and make changes, you risk merge conflicts during rebase, corrupting other agents' in-progress work, or breaking the running dev server. ` +
			`Even for infrastructure files (Dockerfiles, configs), the correct flow is: edit here → commit → push to origin → pull from primary. ` +
			`One \`cd\` violation cascades — all subsequent commands (edit, git add, commit) will operate on shared state.`
		);
	}

	// 3. Goal spec (merge rolePrompt into goalSpec section for backward compat)
	{
		let effectiveGoalSpec = parts.goalSpec || "";
		if (parts.rolePrompt?.trim()) {
			effectiveGoalSpec = (effectiveGoalSpec ? effectiveGoalSpec + "\n\n---\n\n" : "") + parts.rolePrompt.trim();
		}
		if (effectiveGoalSpec.trim()) {
			const header = parts.goalTitle
				? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
				: "# Goal";
			sections.push(header + "\n\n" + effectiveGoalSpec.trim());
		}
	}

	// 3.5. Personalities
	if (parts.personalities && parts.personalities.length > 0) {
		const lines = ["## Personality\n", "You should embody these personalities in how you work:"];
		for (const personality of parts.personalities) {
			lines.push(`- **${personality.label}**: ${personality.promptFragment}`);
		}
		sections.push(lines.join("\n"));
	}

	// 4. Tool documentation
	if (parts.toolDocs?.trim()) {
		sections.push(parts.toolDocs.trim());
	}

	// 5. Task context
	if (parts.taskTitle || parts.taskType) {
		const taskLines: string[] = ["# Current Task"];
		if (parts.taskType) taskLines.push(`\n**Type**: ${parts.taskType}`);
		if (parts.taskTitle) taskLines.push(`**Title**: ${parts.taskTitle}`);

		if (parts.taskSpec?.trim()) {
			taskLines.push(`\n## Task Specification\n${parts.taskSpec.trim()}`);
		}

		if (parts.taskDependsOn && parts.taskDependsOn.length > 0) {
			taskLines.push("\n## Dependencies\nThis task depends on the following completed tasks:");
			for (const dep of parts.taskDependsOn) {
				taskLines.push(`- ${dep}`);
			}
		}

		sections.push(taskLines.join("\n"));
	}

	// 5.5. Available Skills (autonomous activation catalog)
	if (parts.skillsCatalog && parts.skillsCatalog.length > 0) {
		const skillsSection = buildSkillsCatalogSection(parts.skillsCatalog);
		if (skillsSection) sections.push(skillsSection);
	}

	// 6. Workflow dependency context (accepted upstream gate content)
	if (parts.workflowContext?.trim()) {
		sections.push(parts.workflowContext.trim());
	}

	// 7. Prior session transcript (Continue-Archived seed context)
	if (parts.seedContext?.trim()) {
		sections.push(
			`## Prior Session Transcript\n\n` +
			`The user previously worked in an archived session. The full conversation (or a summary) follows. ` +
			`This is for context only — do not act on it unless the user asks you to continue a specific task from it.\n\n` +
			parts.seedContext.trim()
		);
	}

	if (sections.length === 0) return undefined;

	const combined = sections.join("\n\n---\n\n") + "\n";

	const promptPath = path.join(getPromptsDir(), `${sessionId}.md`);
	fs.writeFileSync(promptPath, combined, "utf-8");
	return promptPath;
}

/**
 * Return the system prompt broken into labeled sections for the inspector UI.
 * Takes the same PromptParts as assembleSystemPrompt but returns structured
 * sections instead of writing to disk.
 */
/** Estimate token count from text (~4 chars per token for Claude models) */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function getPromptSections(parts: PromptParts): PromptSection[] {
	const sections: PromptSection[] = [];

	// 1. Global system prompt (resolve @refs relative to its directory)
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const raw = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		const base = raw ? resolveMarkdownRefs(raw, path.dirname(parts.baseSystemPromptPath)) : "";
		if (base) sections.push({ label: "System Prompt", source: parts.baseSystemPromptPath!, content: base, tokens: estimateTokens(base) });
	}

	// 2. Agent files (individual sections per file for provenance)
	const viewerRoot = parts.projectRoot || parts.cwd;
	if (parts.projectConfigStore) {
		const dirs = getAllConfigDirectories(viewerRoot, parts.projectConfigStore);
		const agentEntries = dirs.filter(d => d.types.includes("agents") && d.exists);
		for (const entry of agentEntries) {
			try {
				const content = fs.readFileSync(entry.path, "utf-8");
				const resolved = resolveMarkdownRefs(content, path.dirname(entry.path));
				if (resolved.trim()) {
					sections.push({ label: "Project AGENTS.md", source: entry.path, content: resolved.trim(), tokens: estimateTokens(resolved.trim()) });
				}
			} catch {
				// skip unreadable files
			}
		}
	} else {
		// Legacy fallback: single AGENTS.md with absolute path
		const agentsPath = path.join(viewerRoot, "AGENTS.md");
		if (fs.existsSync(agentsPath)) {
			const content = readAgentsMd(viewerRoot);
			if (content.trim()) {
				sections.push({ label: "Project AGENTS.md", source: agentsPath, content: content.trim(), tokens: estimateTokens(content.trim()) });
			}
		}
	}

	// 2.5. Working directory (also included in the prompt file via assembleSystemPrompt;
	// the agent CLI may additionally inject its own "Current working directory" based on --cwd)
	if (parts.cwd) {
		const cwdContent = `Your working directory is: \`${parts.cwd}\`\n\n` +
			`Stay in this directory for all file operations and git commands. ` +
			`Do not \`cd\` into other directories unless explicitly required by the task.\n\n` +
			`**Why this is a hard constraint:** Other agents, the dev server, and the user may all be working in the primary worktree simultaneously. ` +
			`If you \`cd\` there and make changes, you risk merge conflicts during rebase, corrupting other agents' in-progress work, or breaking the running dev server. ` +
			`Even for infrastructure files (Dockerfiles, configs), the correct flow is: edit here → commit → push to origin → pull from primary. ` +
			`One \`cd\` violation cascades — all subsequent commands (edit, git add, commit) will operate on shared state.`;
		sections.push({ label: "Working Directory", source: parts.cwd, content: cwdContent, tokens: estimateTokens(cwdContent) });
	}

	// 3. Goal spec (separate from role)
	if (parts.goalSpec?.trim()) {
		const header = parts.goalTitle
			? `**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
			: "";
		const goalContent = (header ? header + "\n\n" : "") + parts.goalSpec.trim();
		sections.push({ label: "Goal", source: `Goal: ${parts.goalTitle || "Untitled"}`, content: goalContent, tokens: estimateTokens(goalContent) });
	}

	// 4. Role prompt
	if (parts.rolePrompt?.trim()) {
		sections.push({ label: "Role", source: `Role: ${parts.roleName || "unknown"}`, content: parts.rolePrompt.trim(), tokens: estimateTokens(parts.rolePrompt.trim()) });
	}

	// 5. Personalities
	if (parts.personalities && parts.personalities.length > 0) {
		const lines = parts.personalities.map(p => `- **${p.label}**: ${p.promptFragment}`);
		const personalityContent = lines.join("\n");
		sections.push({ label: "Personality", source: "Personalities", content: personalityContent, tokens: estimateTokens(personalityContent) });
	}

	// 7. Tool docs
	if (parts.toolDocs?.trim()) {
		sections.push({ label: "Tools", source: "Tool documentation", content: parts.toolDocs.trim(), tokens: estimateTokens(parts.toolDocs.trim()) });
	}

	// 8. Task context
	if (parts.taskTitle || parts.taskType) {
		const taskLines: string[] = [];
		if (parts.taskType) taskLines.push(`**Type**: ${parts.taskType}`);
		if (parts.taskTitle) taskLines.push(`**Title**: ${parts.taskTitle}`);
		if (parts.taskSpec?.trim()) taskLines.push(`\n## Task Specification\n${parts.taskSpec.trim()}`);
		if (parts.taskDependsOn?.length) {
			taskLines.push("\n## Dependencies");
			for (const dep of parts.taskDependsOn) taskLines.push(`- ${dep}`);
		}
		const taskContent = taskLines.join("\n");
		sections.push({ label: "Task", source: `Task: ${parts.taskTitle || "Untitled"}`, content: taskContent, tokens: estimateTokens(taskContent) });
	}

	// 8.5. Available Skills
	if (parts.skillsCatalog && parts.skillsCatalog.length > 0) {
		const skillsSection = buildSkillsCatalogSection(parts.skillsCatalog);
		if (skillsSection) {
			sections.push({ label: "Available Skills", source: "Slash skills catalog", content: skillsSection, tokens: estimateTokens(skillsSection) });
		}
	}

	// 9. Workflow context
	if (parts.workflowContext?.trim()) {
		sections.push({ label: "Workflow Context", source: "Upstream gates", content: parts.workflowContext.trim(), tokens: estimateTokens(parts.workflowContext.trim()) });
	}

	// 10. Prior session transcript (Continue-Archived)
	if (parts.seedContext?.trim()) {
		const src = parts.seedContextSource
			? `Continued from archived session ${parts.seedContextSource}`
			: "Continued from archived session";
		sections.push({
			label: "Prior Session Transcript",
			source: src,
			content: parts.seedContext.trim(),
			tokens: estimateTokens(parts.seedContext.trim()),
		});
	}

	return sections;
}

/**
 * Persist the resolved prompt sections as a JSON snapshot at session creation time.
 * This captures the actual prompt that was used, not a reconstruction from current files.
 */
export function persistPromptSections(sessionId: string, parts: PromptParts): void {
	try {
		const sections = getPromptSections(parts);
		const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
		const data = { sections, totalTokens, createdAt: new Date().toISOString() };
		const jsonPath = path.join(getPromptsDir(), `${sessionId}-prompt.json`);
		fs.writeFileSync(jsonPath, JSON.stringify(data), "utf-8");
	} catch (err) {
		console.error(`[system-prompt] Failed to persist prompt sections for ${sessionId}:`, err);
	}
}

/**
 * Load persisted prompt sections snapshot for a session.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function loadPersistedPromptSections(sessionId: string): { sections: PromptSection[]; totalTokens: number; createdAt: string } | null {
	try {
		const jsonPath = path.join(getPromptsDir(), `${sessionId}-prompt.json`);
		if (!fs.existsSync(jsonPath)) return null;
		return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Delete the persisted prompt sections JSON for a session (archive purge only).
 */
export function purgePromptSectionsJson(sessionId: string): void {
	try {
		const jsonPath = path.join(getPromptsDir(), `${sessionId}-prompt.json`);
		if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
	} catch { /* ignore */ }
}

/**
 * Clean up a session's assembled prompt file.
 */
export function cleanupSessionPrompt(sessionId: string): void {
	const promptPath = path.join(getPromptsDir(), `${sessionId}.md`);
	try {
		if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
	} catch { /* ignore */ }
	// Also clean up per-session preview file
	const previewPath = path.join(getStateDir(), `preview-${sessionId}.html`);
	try {
		if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
	} catch { /* ignore */ }
}
