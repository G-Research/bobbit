import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitConfigDir } from "../bobbit-dir.js";
import { removeMount as removePreviewMount } from "../preview/mount.js";
import { getAllConfigDirectories, type ProjectConfigReader } from "./config-directories.js";
import type { SlashSkill } from "../skills/slash-skills.js";
import { profile, bumpCount } from "./profiling.js";
import { buildLspSymbolLookupHint } from "./lsp-hint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the active system-prompt.md path.
 * Prefers the user override at `<bobbitConfigDir()>/system-prompt.md`;
 * falls back to the shipped `<defaultsDir>/system-prompt.md`.
 * Returns `undefined` only when neither file exists.
 */
export function resolveSystemPromptPath(): string | undefined {
	const userPath = path.join(bobbitConfigDir(), "system-prompt.md");
	if (fs.existsSync(userPath)) return userPath;
	// __dirname here is dist/server/agent/, so defaults live at dist/server/defaults/.
	const defaultPath = path.join(__dirname, "..", "defaults", "system-prompt.md");
	if (fs.existsSync(defaultPath)) return defaultPath;
	return undefined;
}

/** Module-level cache of the prompts directory. Set once by ensurePromptsDir(). */
let _promptsDir: string | undefined;

/** Initialize the prompts directory from a stateDir. Called by server startup. */
export function initPromptDirs(stateDir: string): void {
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
	return profile("readAllAgentFiles", () => {
		if (!projectConfigStore) {
			return readAgentsMd(cwd);
		}

		const dirs = getAllConfigDirectories(cwd, projectConfigStore);
		const agentEntries = dirs.filter(d => d.types.includes("agents") && d.exists);
		bumpCount("readAllAgentFiles.files", agentEntries.length);

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
	});
}

export interface PromptParts {
	/** Path to the global system prompt file. Resolved via resolveSystemPromptPath():
	 *  prefers `<bobbitConfigDir()>/system-prompt.md`, falls back to the shipped default. */
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
	/** Pre-formatted tool documentation section to append */
	toolDocs?: string;
	/** Allowed tool names for this session — used to filter tool docs */
	allowedTools?: string[];
	/** Pre-formatted upstream gate context from workflow dependencies */
	workflowContext?: string;
	/** Project config store for multi-file agent discovery */
	projectConfigStore?: ProjectConfigReader;
	/** Skills available for autonomous activation via the `activate_skill` tool.
	 *  When non-empty, an "Available Skills" section is injected into the system prompt.
	 *  Skills with `disable-model-invocation: true` should be filtered out by the caller. */
	skillsCatalog?: SlashSkill[];
	/** Optional override for the skills-catalog byte budget (clamped to [MIN, MAX]).
	 *  When undefined, `SKILLS_CATALOG_BUDGET` is used. */
	skillsCatalogBudget?: number;
}

/**
 * Roles that perform symbol-level source-code lookup and therefore receive the
 * hard "LSP-over-grep" tool-selection rule injected into their role prompt.
 *
 * Kept as an exact, case-normalized set so project `.bobbit/config/roles/*.yaml`
 * overrides cannot accidentally suppress the rule by replacing role YAML content.
 */
const LSP_RULE_ROLES: ReadonlySet<string> = new Set([
	"team-lead",
	"coder",
	"reviewer",
	"code-reviewer",
	"security-reviewer",
	"architect",
	"spec-auditor",
]);

/** Exact header used to detect a pre-existing LSP rule section and to inject one. */
export const LSP_TOOL_SELECTION_HEADER = "## Tool selection — symbol queries";

/**
 * Canonical header for the protected LSP-before-text-search rule injected
 * into every assembled system prompt. Kept identical to the section header
 * shipped in `defaults/system-prompt.md` so existing base prompts that already
 * include the section are detected and not duplicated.
 */
export const LSP_CANONICAL_TOOL_SELECTION_HEADER = "## Tool selection — LSP before text search";

/**
 * Canonical LSP-before-text-search rule body. Source of truth for the
 * `ensureCanonicalLspRule()` injection — mirrors the section in
 * `defaults/system-prompt.md`. Must mention every LSP entry point and every
 * common text-search fallback so a project base-prompt override that omits the
 * header still receives the full guidance.
 */
export const LSP_CANONICAL_TOOL_SELECTION_RULE =
	`${LSP_CANONICAL_TOOL_SELECTION_HEADER}\n\n` +
	"For source-code questions about named symbols (functions, classes, types, variables, constants, interfaces) in TypeScript / JavaScript / Python source files, use LSP **before** any text/code search tool — including `grep`, `rg`, `ripgrep`, `git grep`, `ag`, `ack`, and any `bash`/shell command that invokes them:\n\n" +
	"- Where is X defined? → `lsp_workspace_symbol(\"X\")` or `lsp_definition({ symbolName: \"X\" })`.\n" +
	"- What calls X? → `lsp_references({ symbolName: \"X\" })` or `lsp_references(file, line, char)`.\n" +
	"- What's X's type/signature? → `lsp_hover({ symbolName: \"X\" })`.\n" +
	"- Is this file clean after my edit? → `lsp_diagnostics(file)`.\n" +
	"- What's in this file? → `lsp_document_symbols(file)`.\n\n" +
	"Use text search (`grep`, `rg`, `ripgrep`, `git grep`, `ag`, `ack`, or `bash`/shell wrappers around them) only for free text, string literals, comments, log lines, docs/configs, non-source files, or regex patterns LSP cannot express. If a text-search result includes a `[lsp-hint]` line, either switch to the suggested LSP call or explicitly state in your output why text search is correct for this query.";

/**
 * Ensure the assembled base prompt contains exactly one canonical
 * `## Tool selection — LSP before text search` section. If the base prompt
 * already contains the header (e.g. it came from `defaults/system-prompt.md`
 * or a project override that preserved the rule), it is returned unchanged.
 * Otherwise the canonical rule is inserted near the top of the base prompt:
 * after the opening identity paragraph when one exists, or before the first
 * top-level heading for heading-first prompts.
 *
 * This is the protected-core injection that prevents a project
 * `.bobbit/config/system-prompt.md` override from accidentally suppressing
 * the LSP-over-grep guidance while keeping the rule early enough for agents
 * to reliably follow it.
 */
export function ensureCanonicalLspRule(basePrompt: string): string {
	if (basePrompt.includes(LSP_CANONICAL_TOOL_SELECTION_HEADER)) return basePrompt;
	const trimmed = basePrompt.trim();
	if (!trimmed) return `${LSP_CANONICAL_TOOL_SELECTION_RULE}\n`;

	const firstHeading = trimmed.search(/^# /m);
	if (firstHeading === 0) {
		return `${LSP_CANONICAL_TOOL_SELECTION_RULE}\n\n${trimmed}\n`;
	}
	if (firstHeading > 0) {
		const preamble = trimmed.slice(0, firstHeading).trimEnd();
		const rest = trimmed.slice(firstHeading).trimStart();
		return `${preamble}\n\n${LSP_CANONICAL_TOOL_SELECTION_RULE}\n\n${rest}\n`;
	}

	return `${trimmed}\n\n${LSP_CANONICAL_TOOL_SELECTION_RULE}\n`;
}

/**
 * Strip any `## Tool selection — LSP before text search` section(s) from a
 * markdown fragment, preserving all other content. Used to de-duplicate role
 * prompts, goal specs, or other appended content that may have inlined the
 * canonical rule — the protected-core injection in `ensureCanonicalLspRule()`
 * is the single source of truth for that section in the final assembled
 * prompt, so any copies in role/goal content would otherwise produce a
 * duplicate header.
 *
 * The canonical section extends from its `## ` header line to (but not
 * including) the next `# ` / `## ` heading or end of file. Any blank lines
 * immediately preceding the removed section are also trimmed back so the
 * surrounding content stays well-formed.
 */
export function stripCanonicalLspRule(content: string): string {
	if (!content || !content.includes(LSP_CANONICAL_TOOL_SELECTION_HEADER)) return content;
	const lines = content.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === LSP_CANONICAL_TOOL_SELECTION_HEADER) {
			// Trim trailing blank lines previously appended so we don't leave
			// an awkward gap where the section used to be.
			while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
			// Skip the header and the section body until next H1/H2 heading.
			i++;
			while (i < lines.length && !/^#{1,2} /.test(lines[i])) i++;
			continue;
		}
		out.push(lines[i]);
		i++;
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Global final-prompt de-duplication: keep the **first** canonical
 * `## Tool selection — LSP before text search` section in `text` and strip
 * every subsequent occurrence (with its body) from the remainder.
 *
 * This is the last-line-of-defense applied to the fully assembled prompt so
 * that no late-stage fragment — workflow context, AGENTS.md, tool docs, task
 * spec, role prompts, goal specs, or anything else concatenated into the
 * final prompt file — can introduce a duplicate canonical LSP section.
 *
 * Non-LSP content (including content between the first occurrence and any
 * later occurrence) is preserved exactly. If `text` contains zero or one
 * occurrence of the header, it is returned unchanged.
 */
export function dedupeCanonicalLspRule(text: string): string {
	if (!text) return text;
	const header = LSP_CANONICAL_TOOL_SELECTION_HEADER;
	const first = text.indexOf(header);
	if (first < 0) return text;
	const second = text.indexOf(header, first + header.length);
	if (second < 0) return text;

	// Find end-of-section for the first occurrence: scan forward line-by-line
	// from the line *after* the header to the next H1/H2 heading (or EOF).
	const lines = text.split("\n");
	// Locate the line index of the first occurrence.
	let firstLine = -1;
	for (let k = 0; k < lines.length; k++) {
		if (lines[k].trim() === header) { firstLine = k; break; }
	}
	if (firstLine < 0) return text;
	let endLine = firstLine + 1;
	while (endLine < lines.length && !/^#{1,2} /.test(lines[endLine])) endLine++;

	const kept = lines.slice(0, endLine).join("\n");
	const rest = lines.slice(endLine).join("\n");
	const restStripped = stripCanonicalLspRule(rest);
	if (!restStripped) return kept.replace(/\n+$/, "\n");
	return (kept + "\n" + restStripped).replace(/\n{3,}/g, "\n\n");
}

/**
 * Return the hard LSP-over-grep tool-selection rule for a given role, or
 * `undefined` when the role is not a code-lookup role or the supplied
 * `rolePrompt` already contains the header (duplication guard).
 *
 * Matching is exact on `roleName` after lower-casing and trimming.
 */
export function lspToolSelectionRuleForRole(roleName?: string, rolePrompt?: string): string | undefined {
	if (!roleName) return undefined;
	const norm = roleName.trim().toLowerCase();
	if (!LSP_RULE_ROLES.has(norm)) return undefined;
	if (rolePrompt && rolePrompt.includes(LSP_TOOL_SELECTION_HEADER)) return undefined;
	return (
		`${LSP_TOOL_SELECTION_HEADER}\n\n` +
		"For any query about a named symbol (function, class, type, variable, constant, interface) " +
		"in TypeScript / JavaScript / Python source files, you MUST use LSP before any text/code search tool — " +
		"including `grep`, `rg`, `ripgrep`, `git grep`, `ag`, `ack`, and `bash`/shell commands that invoke them:\n\n" +
		"- Where is X defined? → `lsp_workspace_symbol(\"X\")` or `lsp_definition({ symbolName: \"X\" })`.\n" +
		"- What calls X? → `lsp_references({ symbolName: \"X\" })` or `lsp_references(file, line, char)`.\n" +
		"- What's X's type/signature? → `lsp_hover({ symbolName: \"X\" })`.\n" +
		"- Is this file clean after my edit? → `lsp_diagnostics(file)`.\n" +
		"- What's in this file? → `lsp_document_symbols(file)`.\n\n" +
		"Use text search only for free-text/string-literal search, comments, logs, configs, non-source files, " +
		"or regex/text patterns LSP cannot express. If a text-search result (grep, rg, bash, etc.) includes " +
		"`[lsp-hint]`, either switch to LSP or explicitly justify why text search was correct."
	);
}

/**
 * Compute the effective role-prompt text for prompt assembly.
 *
 * Historically this also appended a per-role `## Tool selection — symbol queries`
 * section via `lspToolSelectionRuleForRole()`. That rule now lives as a single
 * canonical section (`## Tool selection — LSP before text search`) in the base
 * `defaults/system-prompt.md`, which every agent receives, so the per-role
 * injection is intentionally suppressed here to avoid duplicate competing
 * sections. `lspToolSelectionRuleForRole` and `LSP_TOOL_SELECTION_HEADER`
 * remain exported for backward compatibility with existing tests/callers.
 */
function effectiveRolePrompt(_roleName?: string, rolePrompt?: string): string | undefined {
	if (!rolePrompt) return undefined;
	// De-duplicate the protected-core canonical LSP section if a role prompt
	// (or project role override) happens to include it. The base prompt is the
	// single source of truth for that section in the assembled output.
	const stripped = stripCanonicalLspRule(rolePrompt).trim();
	return stripped ? stripped : undefined;
}

/** Default max bytes of skills-catalog markdown to embed in the system prompt. */
export const SKILLS_CATALOG_BUDGET = 16384;
/** Lower bound for a user-configured skills-catalog byte budget. */
export const SKILLS_CATALOG_BUDGET_MIN = 1024;
/** Upper bound for a user-configured skills-catalog byte budget. */
export const SKILLS_CATALOG_BUDGET_MAX = 131072;

/**
 * Resolve a possibly-undefined override into the effective skills-catalog budget.
 * - `undefined`, `NaN`, or non-finite → `SKILLS_CATALOG_BUDGET`.
 * - Otherwise clamps `Math.floor(override)` to `[MIN, MAX]`.
 */
export function resolveSkillsCatalogBudget(override?: number): number {
	if (override === undefined || override === null) return SKILLS_CATALOG_BUDGET;
	if (typeof override !== "number" || !Number.isFinite(override)) return SKILLS_CATALOG_BUDGET;
	const floored = Math.floor(override);
	if (floored < SKILLS_CATALOG_BUDGET_MIN) return SKILLS_CATALOG_BUDGET_MIN;
	if (floored > SKILLS_CATALOG_BUDGET_MAX) return SKILLS_CATALOG_BUDGET_MAX;
	return floored;
}

/**
 * Build the "Available Skills" section. Skills are listed alphabetically;
 * if the budget is exceeded, the tail is truncated with an `(N more …
 * omitted, alphabetically truncated)` footer.
 *
 * Caller is responsible for filtering out skills with
 * `disable-model-invocation: true` — this function trusts its input.
 */
export function buildSkillsCatalogSection(skills: SlashSkill[], budgetOverride?: number): string | undefined {
	if (!skills || skills.length === 0) return undefined;
	const budget = resolveSkillsCatalogBudget(budgetOverride);
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
		if (length + line.length + 1 > budget) {
			truncated = sorted.length - i;
			break;
		}
		lines.push(line);
		length += line.length + 1;
	}
	if (truncated > 0) {
		lines.push(`- _… (${truncated} more skill${truncated === 1 ? "" : "s"} omitted, alphabetically truncated)_`);
		console.warn(`[system-prompt] Skills catalog exceeded ${budget}B budget — truncated ${truncated} skill(s).`);
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
	return profile("assembleSystemPrompt", () => _assembleSystemPrompt(sessionId, parts));
}

function _assembleSystemPrompt(sessionId: string, parts: PromptParts): string | undefined {
	const sections: string[] = [];

	// 1. Global system prompt (resolve @refs relative to its directory).
	// Protected-core injection: ensure the canonical LSP-before-text-search rule
	// is present, even when a project `.bobbit/config/system-prompt.md` override
	// replaces the shipped default. Applied immediately after reading the base
	// prompt and before any role/AGENTS.md/goal/tool-docs/skills sections are
	// appended so the rule appears in the base-prompt portion of the final file.
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const raw = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		const base = raw ? resolveMarkdownRefs(raw, path.dirname(parts.baseSystemPromptPath)) : "";
		const withLsp = ensureCanonicalLspRule(base);
		if (withLsp.trim()) sections.push(withLsp);
	} else {
		// No base prompt configured/found — still inject the protected core rule so
		// agents in minimal-config environments retain LSP-over-grep guidance.
		sections.push(ensureCanonicalLspRule("").trim());
	}

	// 2. Agent files — use projectRoot (host-accessible) when available; for sandboxed
	// agents cwd is a container-internal path the host can't read.
	// Strip the canonical LSP section so an AGENTS.md that happens to include
	// it cannot produce a duplicate in the final prompt — the base prompt owns
	// that section.
	const filesRoot = parts.projectRoot || parts.cwd;
	const agentsMdRaw = readAllAgentFiles(filesRoot, parts.projectConfigStore);
	const agentsMd = stripCanonicalLspRule(agentsMdRaw).trim();
	if (agentsMd) {
		sections.push("# Project AGENTS.md\n\n" + agentsMd);
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

	// 3. Goal spec (merge rolePrompt into goalSpec section for backward compat).
	//    Strip the canonical LSP header from goalSpec too — the protected-core
	//    injection in step 1 owns that section.
	{
		let effectiveGoalSpec = parts.goalSpec ? stripCanonicalLspRule(parts.goalSpec).trim() : "";
		const role = effectiveRolePrompt(parts.roleName, parts.rolePrompt);
		if (role) {
			effectiveGoalSpec = (effectiveGoalSpec ? effectiveGoalSpec + "\n\n---\n\n" : "") + role;
		}
		if (effectiveGoalSpec.trim()) {
			const header = parts.goalTitle
				? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
				: "# Goal";
			sections.push(header + "\n\n" + effectiveGoalSpec.trim());
		}
	}

	// 4. Tool documentation — strip canonical LSP section to prevent duplicates
	// from late tool-doc fragments that include LSP-over-grep guidance.
	if (parts.toolDocs?.trim()) {
		const toolDocs = stripCanonicalLspRule(parts.toolDocs).trim();
		if (toolDocs) sections.push(toolDocs);
	}

	// 5. Task context — strip canonical LSP section from task spec.
	if (parts.taskTitle || parts.taskType) {
		const taskLines: string[] = ["# Current Task"];
		if (parts.taskType) taskLines.push(`\n**Type**: ${parts.taskType}`);
		if (parts.taskTitle) taskLines.push(`**Title**: ${parts.taskTitle}`);

		const taskSpec = parts.taskSpec ? stripCanonicalLspRule(parts.taskSpec).trim() : "";
		if (taskSpec) {
			taskLines.push(`\n## Task Specification\n${taskSpec}`);
		}

		if (parts.taskDependsOn && parts.taskDependsOn.length > 0) {
			taskLines.push("\n## Dependencies\nThis task depends on the following completed tasks:");
			for (const dep of parts.taskDependsOn) {
				taskLines.push(`- ${dep}`);
			}
		}

		sections.push(taskLines.join("\n"));
	}

	// 5.5. LSP symbol-lookup hint — superseded by the canonical
	// `## Tool selection — LSP before text search` section in the base system
	// prompt (`defaults/system-prompt.md`). The hint is no longer appended here
	// to avoid duplicate competing LSP sections in the final prompt.
	// `buildLspSymbolLookupHint` remains exported for backward compatibility.
	void buildLspSymbolLookupHint;

	// 5.6. Available Skills (autonomous activation catalog)
	if (parts.skillsCatalog && parts.skillsCatalog.length > 0) {
		const skillsSection = buildSkillsCatalogSection(parts.skillsCatalog, parts.skillsCatalogBudget);
		if (skillsSection) sections.push(skillsSection);
	}

	// 6. Workflow dependency context (accepted upstream gate content). Strip
	// canonical LSP section — upstream gate content (design docs, task specs,
	// goal specs from other agents) often quotes the canonical header verbatim
	// and would otherwise produce a duplicate section.
	if (parts.workflowContext?.trim()) {
		const wf = stripCanonicalLspRule(parts.workflowContext).trim();
		if (wf) sections.push(wf);
	}

	if (sections.length === 0) return undefined;

	// Final-output safety dedupe: even with proactive per-fragment stripping
	// above, run a global pass over the joined prompt so any unforeseen path
	// that re-introduces the canonical header cannot produce duplicates.
	const combined = dedupeCanonicalLspRule(sections.join("\n\n---\n\n")) + "\n";
	bumpCount("assembleSystemPrompt.bytes", combined.length);

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

	// 1. Global system prompt (resolve @refs relative to its directory).
	// Mirror the protected-core LSP rule injection from _assembleSystemPrompt so
	// the inspector view matches the on-disk prompt byte-for-byte in its base
	// section.
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const raw = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		const base = raw ? resolveMarkdownRefs(raw, path.dirname(parts.baseSystemPromptPath)) : "";
		const withLsp = ensureCanonicalLspRule(base);
		if (withLsp.trim()) sections.push({ label: "System Prompt", source: parts.baseSystemPromptPath!, content: withLsp, tokens: estimateTokens(withLsp) });
	} else {
		const injected = ensureCanonicalLspRule("").trim();
		if (injected) sections.push({ label: "System Prompt", source: "<protected-core>", content: injected, tokens: estimateTokens(injected) });
	}

	// 2. Agent files (individual sections per file for provenance). Strip
	// canonical LSP section from AGENTS.md content to keep base section as
	// the single source.
	const viewerRoot = parts.projectRoot || parts.cwd;
	if (parts.projectConfigStore) {
		const dirs = getAllConfigDirectories(viewerRoot, parts.projectConfigStore);
		const agentEntries = dirs.filter(d => d.types.includes("agents") && d.exists);
		for (const entry of agentEntries) {
			try {
				const content = fs.readFileSync(entry.path, "utf-8");
				const resolved = resolveMarkdownRefs(content, path.dirname(entry.path));
				const cleaned = stripCanonicalLspRule(resolved).trim();
				if (cleaned) {
					sections.push({ label: "Project AGENTS.md", source: entry.path, content: cleaned, tokens: estimateTokens(cleaned) });
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
			const cleaned = stripCanonicalLspRule(content).trim();
			if (cleaned) {
				sections.push({ label: "Project AGENTS.md", source: agentsPath, content: cleaned, tokens: estimateTokens(cleaned) });
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

	// 3. Goal spec (separate from role) — strip canonical LSP section if present
	//    so the inspector view shows the rule only once (in the base section).
	{
		const goalBody = parts.goalSpec ? stripCanonicalLspRule(parts.goalSpec).trim() : "";
		if (goalBody) {
			const header = parts.goalTitle
				? `**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
				: "";
			const goalContent = (header ? header + "\n\n" : "") + goalBody;
			sections.push({ label: "Goal", source: `Goal: ${parts.goalTitle || "Untitled"}`, content: goalContent, tokens: estimateTokens(goalContent) });
		}
	}

	// 4. Role prompt (with injected LSP rule for code-lookup roles)
	{
		const role = effectiveRolePrompt(parts.roleName, parts.rolePrompt);
		if (role) {
			sections.push({ label: "Role", source: `Role: ${parts.roleName || "unknown"}`, content: role, tokens: estimateTokens(role) });
		}
	}

	// 7. Tool docs — strip canonical LSP section to keep base section as sole source.
	if (parts.toolDocs?.trim()) {
		const td = stripCanonicalLspRule(parts.toolDocs).trim();
		if (td) {
			sections.push({ label: "Tools", source: "Tool documentation", content: td, tokens: estimateTokens(td) });
		}
	}

	// 8. Task context — strip canonical LSP section from task spec.
	if (parts.taskTitle || parts.taskType) {
		const taskLines: string[] = [];
		if (parts.taskType) taskLines.push(`**Type**: ${parts.taskType}`);
		if (parts.taskTitle) taskLines.push(`**Title**: ${parts.taskTitle}`);
		const taskSpec = parts.taskSpec ? stripCanonicalLspRule(parts.taskSpec).trim() : "";
		if (taskSpec) taskLines.push(`\n## Task Specification\n${taskSpec}`);
		if (parts.taskDependsOn?.length) {
			taskLines.push("\n## Dependencies");
			for (const dep of parts.taskDependsOn) taskLines.push(`- ${dep}`);
		}
		const taskContent = taskLines.join("\n");
		sections.push({ label: "Task", source: `Task: ${parts.taskTitle || "Untitled"}`, content: taskContent, tokens: estimateTokens(taskContent) });
	}

	// 8.5. Available Skills
	if (parts.skillsCatalog && parts.skillsCatalog.length > 0) {
		const skillsSection = buildSkillsCatalogSection(parts.skillsCatalog, parts.skillsCatalogBudget);
		if (skillsSection) {
			sections.push({ label: "Available Skills", source: "Slash skills catalog", content: skillsSection, tokens: estimateTokens(skillsSection) });
		}
	}

	// 9. Workflow context — strip canonical LSP section to prevent duplicates
	// from upstream gate content (design docs, prior task specs, etc.).
	if (parts.workflowContext?.trim()) {
		const wf = stripCanonicalLspRule(parts.workflowContext).trim();
		if (wf) {
			sections.push({ label: "Workflow Context", source: "Upstream gates", content: wf, tokens: estimateTokens(wf) });
		}
	}

	// Final safety dedupe across sections: if any section after the first
	// canonical-bearing section still contains the header, strip it from those
	// later sections so joined output has exactly one canonical occurrence.
	let seenCanonical = false;
	for (let i = 0; i < sections.length; i++) {
		const s = sections[i];
		if (!s.content.includes(LSP_CANONICAL_TOOL_SELECTION_HEADER)) continue;
		if (!seenCanonical) {
			seenCanonical = true;
			continue;
		}
		const cleaned = stripCanonicalLspRule(s.content).trim();
		sections[i] = { ...s, content: cleaned, tokens: estimateTokens(cleaned) };
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
	// Per-session preview mount (WP-A): <stateDir>/preview/<sid>/.
	try { removePreviewMount(sessionId); } catch { /* ignore */ }
}
