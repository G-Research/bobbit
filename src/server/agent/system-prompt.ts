import fs from "node:fs";
import path from "node:path";
import { getAllConfigDirectories, type ProjectConfigReader } from "./config-directories.js";

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
	return _promptsDir;
}

function getStateDir(): string {
	if (!_stateDir) throw new Error("system-prompt: initPromptDirs() not called");
	return _stateDir;
}

/**
 * Resolve `@FILENAME.md` references in markdown content.
 *
 * Lines matching `@somefile.md` (optionally with leading whitespace) are
 * replaced with the contents of that file, resolved relative to `baseDir`.
 * References are resolved recursively (a referenced file can itself contain
 * `@` references). A `seen` set prevents infinite loops.
 */
export function resolveMarkdownRefs(content: string, baseDir: string, seen?: Set<string>): string {
	if (!seen) seen = new Set();

	return content.replace(/^([ \t]*)@(\S+\.md)\s*$/gm, (_match, indent: string, filename: string) => {
		const filePath = path.resolve(baseDir, filename);
		const canonical = path.normalize(filePath);

		if (seen!.has(canonical)) {
			return `${indent}<!-- circular reference: ${filename} -->`;
		}

		if (!fs.existsSync(filePath)) {
			return `${indent}<!-- file not found: ${filename} -->`;
		}

		seen!.add(canonical);
		try {
			const refContent = fs.readFileSync(filePath, "utf-8");
			const resolved = resolveMarkdownRefs(refContent, path.dirname(filePath), seen);
			// Preserve indentation for each line of the included content
			if (indent) {
				return resolved
					.split("\n")
					.map((line) => (line.trim() ? indent + line : line))
					.join("\n");
			}
			return resolved;
		} catch {
			return `${indent}<!-- error reading: ${filename} -->`;
		}
	});
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
	/** Working directory for the session — used to find AGENTS.md */
	cwd: string;
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
	/** Tool restrictions text (separate from goalSpec for section display) */
	toolRestrictions?: string;
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

	// 1. Global system prompt
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const base = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		if (base) sections.push(base);
	}

	// 2. Agent files from working directory and custom locations
	const agentsMd = readAllAgentFiles(parts.cwd, parts.projectConfigStore);
	if (agentsMd.trim()) {
		sections.push("# Project Context\n\n" + agentsMd.trim());
	}

	// 2.5. Working directory instructions
	if (parts.cwd) {
		sections.push(
			`# Working Directory\n\n` +
			`Your working directory is: \`${parts.cwd}\`\n\n` +
			`Stay in this directory for all file operations and git commands. ` +
			`Do not \`cd\` into other directories unless explicitly required by the task.`
		);
	}

	// 3. Goal spec (merge rolePrompt and toolRestrictions into goalSpec section for backward compat)
	{
		let effectiveGoalSpec = parts.goalSpec || "";
		if (parts.rolePrompt?.trim()) {
			effectiveGoalSpec = (effectiveGoalSpec ? effectiveGoalSpec + "\n\n---\n\n" : "") + parts.rolePrompt.trim();
		}
		if (parts.toolRestrictions?.trim()) {
			effectiveGoalSpec = (effectiveGoalSpec ? effectiveGoalSpec + "\n\n---\n\n" : "") + parts.toolRestrictions.trim();
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

	// 6. Workflow dependency context (accepted upstream gate content)
	if (parts.workflowContext?.trim()) {
		sections.push(parts.workflowContext.trim());
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

	// 1. Global system prompt
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const base = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		if (base) sections.push({ label: "System Prompt", source: parts.baseSystemPromptPath!, content: base, tokens: estimateTokens(base) });
	}

	// 2. Agent files (individual sections per file for provenance)
	if (parts.projectConfigStore) {
		const dirs = getAllConfigDirectories(parts.cwd, parts.projectConfigStore);
		const agentEntries = dirs.filter(d => d.types.includes("agents") && d.exists);
		for (const entry of agentEntries) {
			try {
				const content = fs.readFileSync(entry.path, "utf-8");
				const resolved = resolveMarkdownRefs(content, path.dirname(entry.path));
				if (resolved.trim()) {
					sections.push({ label: "Project Context", source: entry.path, content: resolved.trim(), tokens: estimateTokens(resolved.trim()) });
				}
			} catch {
				// skip unreadable files
			}
		}
	} else {
		// Legacy fallback: single AGENTS.md with absolute path
		const agentsPath = path.join(parts.cwd, "AGENTS.md");
		if (fs.existsSync(agentsPath)) {
			const content = readAgentsMd(parts.cwd);
			if (content.trim()) {
				sections.push({ label: "Project Context", source: agentsPath, content: content.trim(), tokens: estimateTokens(content.trim()) });
			}
		}
	}

	// 2.5. Working directory (display-only — not included in the actual prompt file;
	// the agent CLI injects its own "Current working directory" based on --cwd)
	if (parts.cwd) {
		const cwdContent = `Your working directory is: \`${parts.cwd}\`\n\n` +
			`Stay in this directory for all file operations and git commands. ` +
			`Do not \`cd\` into other directories unless explicitly required by the task.`;
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

	// 5. Tool restrictions
	if (parts.toolRestrictions?.trim()) {
		sections.push({ label: "Tool Restrictions", source: "Allowed tools filter", content: parts.toolRestrictions.trim(), tokens: estimateTokens(parts.toolRestrictions.trim()) });
	}

	// 6. Personalities
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

	// 9. Workflow context
	if (parts.workflowContext?.trim()) {
		sections.push({ label: "Workflow Context", source: "Upstream gates", content: parts.workflowContext.trim(), tokens: estimateTokens(parts.workflowContext.trim()) });
	}

	return sections;
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
