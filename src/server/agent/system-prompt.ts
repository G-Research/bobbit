import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitConfigDir } from "../bobbit-dir.js";
import { removeMount as removePreviewMount } from "../preview/mount.js";
import { getAllConfigDirectories, type ProjectConfigReader } from "./config-directories.js";
import type { SlashSkill } from "../skills/slash-skills.js";
import { profile, bumpCount } from "./profiling.js";
import { type ContextBlock, fenceBlock } from "./context-blocks.js";
import {
	containsReservedCorePromptDelimiter,
	EXTENSION_PROMPT_REGION_END,
	EXTENSION_PROMPT_REGION_START,
	extensionPromptSectionEnd,
	extensionPromptSectionStart,
} from "./prompt-delimiters.js";

export {
	EXTENSION_PROMPT_REGION_END,
	EXTENSION_PROMPT_REGION_START,
	extensionPromptSectionEnd,
	extensionPromptSectionStart,
} from "./prompt-delimiters.js";

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
 * Resolve the `session-prompts` directory for a gateway.
 *
 * Prefer the explicit per-gateway `stateDir` — this is the DI seam that keeps
 * multiple in-process gateways (v2 test harness / one-gateway-per-fork) from
 * clobbering each other's prompt scratch dir. Only when no `stateDir` is
 * threaded do we fall back to the process-global set once by initPromptDirs()
 * at server startup (legacy single-gateway path).
 */
function resolvePromptsDir(stateDir?: string): string {
	if (stateDir) {
		const dir = path.join(stateDir, "session-prompts");
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		return dir;
	}
	return getPromptsDir();
}

/** Resolve the prompt directory without recreating it during purge cleanup. */
function resolvePromptsDirForCleanup(stateDir?: string): string {
	if (stateDir) return path.join(stateDir, "session-prompts");
	if (!_promptsDir) throw new Error("system-prompt: initPromptDirs() not called");
	return _promptsDir;
}

function isMissingFileError(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error
		&& (error as { code?: unknown }).code === "ENOENT";
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

/**
 * Nesting context — populated by callers (session-manager) when assembling
 * the team-lead system prompt for a goal that is part of a nested-goals tree.
 * When `team` is true and `nestingContext` is set, three stanzas are folded
 * into the prompt:
 *   - Stanza A (top-level root):   parentGoalId === undefined
 *   - Stanza B (child team-lead):  parentGoalId !== undefined
 *   - Stanza C (decision rule):    always included for team goals
 *
 * For non-team goals (assistant sessions, single-agent sessions), pass
 * `team: false` (or omit entirely) and no stanzas render.
 */
export interface NestingContext {
	/** Is this a team-lead session? */
	team?: boolean;
	/** Current goal's branch (for Stanza B's "Your branch (X) merges INTO" line). */
	goalBranch?: string;
	/** Set when this goal has a parent (i.e. it is a child team-lead). */
	parent?: { id: string; title: string; branch?: string };
	/** Set when this goal has a non-self root (i.e. it is a child or grandchild). */
	root?: { id: string; title: string; branch?: string };
	/**
	 * System-scope Subgoals feature flag. When false, the Children tools resolve
	 * to `never`, so the tool-dependent stanzas (root orchestration, the
	 * subgoal/team_spawn/task_create decision rule, and the "spawn deeper
	 * children" bullet) are omitted. A child goal's POSITION guardrails (don't
	 * raise a PR, branch merges into parent) are always emitted — a child can
	 * outlive the flag being turned off.
	 */
	subGoalsEnabled?: boolean;
}

/**
 * Build the nesting-awareness section for the team-lead system prompt.
 * Returns undefined when `ctx` is not a team goal — caller can skip.
 *
 * Stanza A (top-level root) appears when `ctx.parent` is undefined; Stanza B
 * (child team-lead) appears when `ctx.parent` is set; Stanza C (decision
 * rule for `subgoal` vs `team_spawn` vs `task_create`) appears for every
 * team goal regardless of role in the tree.
 */
export function buildNestingContextSection(ctx: NestingContext): string | undefined {
	if (!ctx.team) return undefined;

	const parts: string[] = [];

	if (!ctx.parent) {
		// Stanza A — top-level root. Tool-dependent (decompose / concurrency /
		// divergence), so omitted entirely when the Subgoals feature is off —
		// a root with no Children tools has nothing to act on here.
		if (ctx.subGoalsEnabled) {
			parts.push(
				"## Goal nesting context (TOP-LEVEL ROOT)\n\n" +
				"You are the team lead of a TOP-LEVEL (root) goal. This is the only goal in the tree that opens a pull request to `master`.\n\n" +
				"**Your special responsibilities:**\n" +
				"- After ready-to-merge passes, raise the PR via `gh pr create` (or, if `gh` is not installed in this environment, tell the user to create the PR manually). Child goals MUST NOT raise PRs.\n" +
				"- Decide whether to decompose this work into nested sub-goals: see \"When to use subgoal vs team_spawn vs task_create\" below.\n" +
				"- The root's `maxConcurrentChildren` (default 5, max 8) caps parallelism for the WHOLE tree — your tool `goal_set_policy` adjusts it.\n" +
				"- The root's `divergencePolicy` (strict / balanced / autonomous) controls how mid-flight plan mutations are classified — see plan-mutation classifier docs."
			);
		}
	} else {
		// Stanza B — child team-lead
		const parentTitle = ctx.parent.title || ctx.parent.id;
		const parentId = ctx.parent.id;
		const rootTitle = ctx.root?.title || ctx.root?.id || parentTitle;
		const rootId = ctx.root?.id || parentId;
		const parentBranch = ctx.parent.branch || `parent's branch`;
		const goalBranch = ctx.goalBranch || `your branch`;
		parts.push(
			"## Goal nesting context (CHILD GOAL)\n\n" +
			`You are the team lead of a CHILD goal. Parent: \`${parentTitle}\` (id: \`${parentId}\`). Root: \`${rootTitle}\` (id: \`${rootId}\`).\n\n` +
			"**Your scope is STRICTLY your own `# Goal` spec above — nothing else.**\n\n" +
			"If your spec quotes, references, or describes your parent's broader mission, the other sibling goals, the parent's acceptance criteria, or the overall plan — that context is background only. **Do not act on it.** Your parent's team-lead is responsible for the parent's mission; siblings are handled by their own team-leads. If you find yourself about to spawn a child to cover work that reads like a sibling's responsibility, STOP — that is the parent's job.\n\n" +
			"**Critical constraints:**\n" +
			`- Your branch (\`${goalBranch}\`) merges INTO the parent's branch (\`${parentBranch}\`) LOCALLY when ready-to-merge passes. The parent's team-lead handles that merge automatically — you do not call \`git merge\` yourself.\n` +
			"- **DO NOT raise a PR.** Only the root team-lead raises a PR (to `master`). If you call `gh pr create`, you create work the root must clean up.\n" +
			"- **DO NOT spawn sibling goals.** Your siblings already exist (or will be spawned by your parent). If you need work that sounds like a sibling, surface it to your parent via `ready-to-merge` feedback rather than spawning it yourself.\n" +
			`- Your worktree was created off \`${parentBranch}\` HEAD at spawn time. Sibling goals spawned later see your committed work after the parent's merge.\n` +
			"- If a sibling completed before you started, you should already see their commits via the parent's branch tip." +
			// Deeper-nesting bullet is tool-dependent — only when subgoals are on.
			(ctx.subGoalsEnabled
				? "\n- You MAY decompose YOUR own work into deeper nested sub-goals (not siblings) via `goal_spawn_child` if the work is large enough to warrant its own team-lead. Rule of thumb: sub-goals are for decomposition WITHIN your spec, not expansion BEYOND your spec."
				: "")
		);
	}

	// Stanza C — the subgoal/team_spawn/task_create decision rule. Tool-dependent
	// (references goal_spawn_child / goal_plan_propose), so only when subgoals are on.
	if (ctx.subGoalsEnabled) {
	parts.push(
		"## When to use `subgoal` vs `team_spawn` vs `task_create`\n\n" +
		"You have THREE delegation primitives. Pick the right one:\n\n" +
		"| Tool | Lifetime | Branch | Best for |\n" +
		"|---|---|---|---|\n" +
		"| `task_create` | Sub-second to minutes | Same branch (no worktree) | Tracking work items, todos, dependencies between work units within this goal |\n" +
		"| `team_spawn` | Minutes to hours | New worktree on a sub-branch of THIS goal's branch (e.g. `goal-X-coder-Y`) | Code-writing, review, QA — work that ends with the agent merging back into your goal branch |\n" +
		"| `subgoal` (via `goal_spawn_child` or via the `subgoal` verify-step in your plan) | Hours to days | Whole new goal record, own goal branch off YOUR branch HEAD, own team-lead, own ready-to-merge gate, own PR-or-local-merge | Independent units of work that themselves benefit from a full goal lifecycle (charter / plan / execution / integration / merge) — e.g. version slices (v0.1, v0.2, v1.0) of a feature, or distinct sub-features that each need their own coder + reviewer + QA flow |\n\n" +
		"Rule of thumb: if the work is small enough to verify in one gate signal, use `task_create` or `team_spawn`. If it's large enough to need its own gates and team, use `subgoal`. **Subgoals are not free** — each one spawns a full team-lead session and a worktree. Don't decompose a 10-minute task into a subgoal.\n\n" +
		"**Prefer fewer, larger subgoals.** When spawning subgoals, prefer fewer, logically coherent goals over many tiny ones. A subgoal should have a clear motivation, be independently reviewable, and be large enough to justify its own context window startup. If you find yourself spawning 10+ subgoals for related fixes, group them into 2–3 logically coherent goals instead.\n\n" +
		"### Subgoal workflow, roles, and spec\n\n" +
		"- **Workflow — reuse by default.** A subgoal without an explicit workflow inherits yours (with the parent's subgoal verify-steps stripped), which is the right behaviour when the child's work fits the same gate shape. Override with `inlineWorkflow` / `workflowId` ONLY when the user explicitly asked OR when no existing workflow genuinely fits (e.g. a research subgoal under a build→test→docs parent — there's nothing to build or test). Don't invent a custom workflow just because the inherited one isn't a perfect match.\n" +
		"- **Roles — reuse by default.** Your `inlineRoles` propagate to every subgoal, so custom roles you or the user defined are already available. Before adding a new inline role for a subgoal, check whether an existing project role or inherited inline role fits. Add new ones only when the user asked, or when no existing role's prompt matches the work.\n" +
		"- **The spec is the ENTIRE scope.** The `spec` you pass to `goal_spawn_child` becomes the child's full mission. Do not paste your own spec, do not list sibling goals, do not restate parent-level acceptance criteria — the child treats all of it as work it must complete. Write the child's spec as if the parent didn't exist.\n\n" +
		"### Declaring dependencies between subgoals\n\n" +
		"If a child genuinely depends on another sibling completing first, declare it via `dependsOn: [planId]` on the step in `goal_plan_propose` (preferred) or on a direct `goal_spawn_child` call. The Plan-tab DAG draws an edge ONLY where you've declared an explicit dependency — absent deps render as parallel siblings at column 0. Don't declare a dep just because two children happen to be similar; declare one only when B literally cannot start until A is done. Self-deps, unknown planId references, and cycles are rejected with a 400 error code.\n\n" +
		"**Dependency scheduling works on every workflow type**, but the full classifier + freeze + approve flow requires the `parent` workflow (or any workflow with an `execution` gate). Without an `execution` gate, `goal_plan_propose` falls back to direct spawning with `dependsOn` enforced by the scheduler — a child with unmet deps is created in the scheduler-managed `blocked` state (its team/worktree is not started) and auto-resumes (`blocked`→`todo`) when its last dependency merges. This is NOT operator pause: `blocked` is a distinct scheduler axis, and `goal_pause`/`goal_resume` neither set nor clear dependency-blocking. Plan-mutation classification is unavailable in this mode.\n\n" +
		"**Note: repeated plan changes (>5) on a parent-workflow goal trigger auto-pause for human review.** The freeze classifier (see plan-mutation docs) tracks `replanCount` per goal — if you keep restructuring the frozen plan, the system will pause the goal and surface a mutation-approval card to the user. Plan once, plan well; don't churn."
	);
	}

	// With subgoals off, a root goal contributes no stanzas at all.
	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
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
	/** Nesting-tree context for team-lead sessions in a nested-goals tree.
	 *  When set (and `team` true) renders the root/child role stanzas plus the
	 *  `subgoal` / `team_spawn` / `task_create` decision rule. */
	nestingContext?: NestingContext;

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
	/** Fresh provider-supplied context blocks appended as the final, lowest-authority prompt section. */
	dynamicContext?: ContextBlock[];
	/** Resolved, granted static extension sections. Callers must validate grants and budgets before setting these. */
	extensionPromptSections?: ResolvedSystemPromptSection[];
	/**
	 * Optional per-goal prompt section ordering (the `bobbit.promptSectionOrder`
	 * metadata convention). Labels listed here are emitted first, in the given
	 * order; any unlisted section keeps its original relative position after
	 * them. Unknown labels are ignored. Absent ⇒ today's fixed order, byte-
	 * identical. With active static extensions the protected core/extension/
	 * volatile partition is retained; labels may still reorder inside their
	 * partition. Without extensions, legacy ordering remains byte-identical.
	 */
	sectionOrder?: string[];
}

/**
 * Stable-reorder labeled sections so the labels in `order` come first (in the
 * given order), and any section whose label is not listed keeps its ORIGINAL
 * relative position after them. A label appearing more than once in `order`
 * uses its first occurrence. Returns the input array unchanged when `order` is
 * empty/undefined (byte-identical default behaviour).
 */
export function reorderLabeledSections<T extends { label: string }>(sections: T[], order?: string[]): T[] {
	if (!order || order.length === 0) return sections;
	const rank = new Map<string, number>();
	order.forEach((label, i) => { if (!rank.has(label)) rank.set(label, i); });
	return sections
		.map((section, index) => ({ section, index }))
		.sort((a, b) => {
			const ra = rank.has(a.section.label) ? rank.get(a.section.label)! : Number.POSITIVE_INFINITY;
			const rb = rank.has(b.section.label) ? rank.get(b.section.label)! : Number.POSITIVE_INFINITY;
			if (ra !== rb) return ra - rb;
			return a.index - b.index; // stable: preserve original relative order within a rank
		})
		.map((entry) => entry.section);
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

/**
 * A project-effective static prompt section, already resolved by the pack
 * registry. This module deliberately does not resolve packs, grants, or
 * budgets: it only gives the already-authorized result one canonical layout.
 */
export interface ResolvedSystemPromptSection {
	packId: string;
	packName: string;
	sectionId: string;
	title: string;
	content: string;
	/** Optional resolver-provided values; layout always computes authoritative bytes. */
	contentBytes?: number;
	renderedBytes?: number;
	source?: "manifest" | "project-override";
}

export interface PromptSection {
	label: string;
	source: string;
	content: string;
	/** Estimated token count (~4 chars/token for Claude models) */
	tokens: number;
	/** Additive attribution for a static extension contribution. */
	kind?: "extension";
	packId?: string;
	packName?: string;
	sectionId?: string;
	sectionTitle?: string;
	/** UTF-8 bytes of extension-authored content (not the delimiter wrappers). */
	contentBytes?: number;
	/** UTF-8 bytes of this contribution with its section delimiters. */
	renderedBytes?: number;
	/** UTF-8 bytes in the full effective prompt containing this section. */
	totalPromptBytes?: number;
}

/** The cache-boundary identity and inspector projection for one effective prompt. */
export interface SystemPromptLayout {
	/** Full bytes written by assembleSystemPrompt, including the historical trailing newline. */
	content: string | undefined;
	/** Alias for consumers that describe the layout as a prompt rather than file content. */
	prompt: string | undefined;
	sections: PromptSection[];
	totalPromptBytes: number;
	/** UTF-8 offset immediately after the stable core and before extension-specific bytes. */
	extensionRegionStartByteOffset: number;
	/** SHA-256 of the exact UTF-8 prefix ending at extensionRegionStartByteOffset. */
	stablePrefixSha256: string;
	/** UTF-8 bytes in the core-owned outer extension-region markers, if present. */
	extensionRegionBytes: number;
}

interface LayoutSection {
	label: string;
	promptContent: string;
	inspectorSections: PromptSection[];
}

const STABLE_CORE_LABELS = new Set([
	"System Prompt",
	"Project AGENTS.md",
	"Working Directory",
	"Tools",
	"Available Skills",
]);
const SECTION_SEPARATOR = "\n\n---\n\n";

/** Estimate token count from text (~4 chars per token for Claude models). */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function promptSection(label: string, source: string, content: string): PromptSection {
	return { label, source, content, tokens: estimateTokens(content) };
}

/** Build the one source of truth used by both file assembly and inspection. */
function buildBaseLayoutSections(parts: PromptParts): LayoutSection[] {
	const sections: LayoutSection[] = [];

	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const raw = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		const content = raw ? resolveMarkdownRefs(raw, path.dirname(parts.baseSystemPromptPath)) : "";
		if (content) {
			sections.push({
				label: "System Prompt",
				promptContent: content,
				inspectorSections: [promptSection("System Prompt", parts.baseSystemPromptPath, content)],
			});
		}
	}

	// Resolve agent files once. The prompt intentionally combines them into the
	// historical single section while the inspector retains per-file provenance.
	const filesRoot = parts.projectRoot || parts.cwd;
	const agentFiles: { source: string; content: string }[] = [];
	if (parts.projectConfigStore) {
		for (const entry of getAllConfigDirectories(filesRoot, parts.projectConfigStore)) {
			if (!entry.types.includes("agents") || !entry.exists) continue;
			try {
				const content = resolveMarkdownRefs(fs.readFileSync(entry.path, "utf-8"), path.dirname(entry.path)).trim();
				if (content) agentFiles.push({ source: entry.path, content });
			} catch (err) {
				console.warn(`[system-prompt] Failed to read agent file ${entry.path}, skipping:`, err);
			}
		}
	} else {
		const agentsPath = path.join(filesRoot, "AGENTS.md");
		const content = readAgentsMd(filesRoot).trim();
		if (content) agentFiles.push({ source: agentsPath, content });
	}
	if (agentFiles.length) {
		const content = agentFiles.map((file) => file.content).join("\n\n");
		sections.push({
			label: "Project AGENTS.md",
			promptContent: "# Project AGENTS.md\n\n" + content,
			inspectorSections: agentFiles.map((file) => promptSection("Project AGENTS.md", file.source, file.content)),
		});
	}

	if (parts.cwd) {
		const content = `Your working directory is: \`${parts.cwd}\`\n\n` +
			`Stay in this directory for all file operations and git commands. ` +
			`Do not \`cd\` into other directories unless explicitly required by the task.\n\n` +
			`**Why this is a hard constraint:** Other agents, the dev server, and the user may all be working in the primary worktree simultaneously. ` +
			`If you \`cd\` there and make changes, you risk merge conflicts during rebase, corrupting other agents' in-progress work, or breaking the running dev server. ` +
			`Even for infrastructure files (Dockerfiles, configs), the correct flow is: edit here → commit → push to origin → pull from primary. ` +
			`One \`cd\` violation cascades — all subsequent commands (edit, git add, commit) will operate on shared state.`;
		sections.push({
			label: "Working Directory",
			promptContent: "# Working Directory\n\n" + content,
			inspectorSections: [promptSection("Working Directory", parts.cwd, content)],
		});
	}

	if (parts.toolDocs?.trim()) {
		const content = parts.toolDocs.trim();
		sections.push({ label: "Tools", promptContent: content, inspectorSections: [promptSection("Tools", "Tool documentation", content)] });
	}

	if (parts.skillsCatalog?.length) {
		const content = buildSkillsCatalogSection(parts.skillsCatalog, parts.skillsCatalogBudget);
		if (content) sections.push({ label: "Available Skills", promptContent: content, inspectorSections: [promptSection("Available Skills", "Slash skills catalog", content)] });
	}

	if (parts.goalSpec?.trim()) {
		const promptHeader = parts.goalTitle
			? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
			: "# Goal";
		const inspectorHeader = parts.goalTitle ? `**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})` : "";
		const content = parts.goalSpec.trim();
		sections.push({
			label: "Goal",
			promptContent: promptHeader + "\n\n" + content,
			inspectorSections: [promptSection("Goal", `Goal: ${parts.goalTitle || "Untitled"}`, (inspectorHeader ? inspectorHeader + "\n\n" : "") + content)],
		});
	}

	if (parts.rolePrompt?.trim()) {
		const hasOrder = !!parts.sectionOrder?.length;
		const needsGoalHeader = !parts.goalSpec?.trim() && !hasOrder;
		const roleHeader = parts.goalTitle
			? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
			: "# Goal";
		const content = parts.rolePrompt.trim();
		sections.push({
			label: "Role",
			promptContent: needsGoalHeader ? roleHeader + "\n\n" + content : content,
			inspectorSections: [promptSection("Role", `Role: ${parts.roleName || "unknown"}`, content)],
		});
	}

	if (parts.nestingContext) {
		const content = buildNestingContextSection(parts.nestingContext);
		if (content) sections.push({
			label: "Goal Nesting",
			promptContent: content,
			inspectorSections: [promptSection("Goal Nesting", parts.nestingContext.parent ? "Child team-lead" : "Top-level team-lead", content)],
		});
	}

	if (parts.taskTitle || parts.taskType) {
		// Keep the prompt form byte-identical to the pre-layout assembler; the
		// inspector intentionally omits the heading, as it always has.
		const promptLines: string[] = ["# Current Task"];
		const inspectorLines: string[] = [];
		if (parts.taskType) {
			promptLines.push(`\n**Type**: ${parts.taskType}`);
			inspectorLines.push(`**Type**: ${parts.taskType}`);
		}
		if (parts.taskTitle) {
			promptLines.push(`**Title**: ${parts.taskTitle}`);
			inspectorLines.push(`**Title**: ${parts.taskTitle}`);
		}
		if (parts.taskSpec?.trim()) {
			const spec = `\n## Task Specification\n${parts.taskSpec.trim()}`;
			promptLines.push(spec);
			inspectorLines.push(spec);
		}
		if (parts.taskDependsOn?.length) {
			promptLines.push("\n## Dependencies\nThis task depends on the following completed tasks:");
			inspectorLines.push("\n## Dependencies");
			for (const dep of parts.taskDependsOn) {
				promptLines.push(`- ${dep}`);
				inspectorLines.push(`- ${dep}`);
			}
		}
		const inspectorContent = inspectorLines.join("\n");
		sections.push({
			label: "Task",
			promptContent: promptLines.join("\n"),
			inspectorSections: [promptSection("Task", `Task: ${parts.taskTitle || "Untitled"}`, inspectorContent)],
		});
	}

	if (parts.workflowContext?.trim()) {
		const content = parts.workflowContext.trim();
		sections.push({ label: "Workflow Context", promptContent: content, inspectorSections: [promptSection("Workflow Context", "Upstream gates", content)] });
	}

	if (parts.dynamicContext?.length) {
		const content = parts.dynamicContext.map(fenceBlock).join("\n\n");
		sections.push({
			label: "Dynamic Context",
			promptContent: "## Dynamic Context\n\n" + content,
			inspectorSections: [promptSection("Dynamic Context", "providers", content)],
		});
	}

	return sections;
}

function extensionLayoutSection(section: ResolvedSystemPromptSection): LayoutSection {
	// The registry rejects these before a section reaches PromptParts. Keep this
	// defensive guard at the final rendering boundary so raw prose can never
	// forge core-owned attribution markers through a stale or direct caller.
	if (containsReservedCorePromptDelimiter(section.content)) {
		throw new Error(`Extension prompt section ${section.packId}/${section.sectionId} contains a reserved delimiter`);
	}
	const start = extensionPromptSectionStart(section.packId, section.sectionId);
	const end = extensionPromptSectionEnd(section.packId, section.sectionId);
	const rendered = `${start}\n${section.content}\n${end}`;
	const contentBytes = Buffer.byteLength(section.content, "utf-8");
	const renderedBytes = Buffer.byteLength(rendered, "utf-8");
	return {
		label: `Extension: ${section.packId}/${section.sectionId}`,
		promptContent: rendered,
		inspectorSections: [{
			label: section.title,
			source: `Extension: ${section.packName || section.packId}`,
			content: rendered,
			tokens: estimateTokens(section.content),
			kind: "extension",
			packId: section.packId,
			packName: section.packName,
			sectionId: section.sectionId,
			sectionTitle: section.title,
			contentBytes,
			renderedBytes,
		}],
	};
}

function flattenInspectorSections(sections: LayoutSection[], totalPromptBytes: number): PromptSection[] {
	return sections.flatMap((section) => section.inspectorSections.map((inspector) =>
		inspector.kind === "extension" ? { ...inspector, totalPromptBytes } : inspector,
	));
}

function joinPromptSections(sections: LayoutSection[]): string | undefined {
	if (sections.length === 0) return undefined;
	return sections.map((section) => section.promptContent).join(SECTION_SEPARATOR) + "\n";
}

/**
 * Return the canonical layout used for both the on-disk prompt and the prompt
 * inspector. When extensions are present their protected region is always
 * between the stable core and volatile suffix; section-order metadata may still
 * reorder inside either partition, but cannot move an extension across it.
 */
export function getSystemPromptLayout(parts: PromptParts): SystemPromptLayout {
	const baseSections = buildBaseLayoutSections(parts);
	const resolvedExtensions = parts.extensionPromptSections ?? [];
	// Section-order metadata is applied exactly once, before either layout path
	// derives its splice point. This makes the cacheable prefix independent of
	// whether extensions are presently resolved.
	const reorderedSections = reorderLabeledSections(baseSections, parts.sectionOrder);
	// Dynamic Context is provider-supplied and protected-last. Normalize it
	// after custom ordering for every layout, so metadata cannot move it into
	// the stable prefix or ahead of the extension region.
	const orderedSections = [
		...reorderedSections.filter((section) => section.label !== "Dynamic Context"),
		...reorderedSections.filter((section) => section.label === "Dynamic Context"),
	];
	const extensionBoundary = orderedSections.reduce((last, section, index) =>
		STABLE_CORE_LABELS.has(section.label) ? index : last, -1) + 1;
	const extensionRegionStartByteOffset = extensionBoundary > 0
		? Buffer.byteLength(
			orderedSections.slice(0, extensionBoundary).map((section) => section.promptContent).join(SECTION_SEPARATOR),
			"utf-8",
		)
		: 0;
	let promptSections: LayoutSection[];
	let inspectorLayout: LayoutSection[];
	let extensionRegionBytes = 0;

	if (resolvedExtensions.length === 0) {
		// Exact legacy path: no marker and no byte changes when EP-13 is inactive.
		promptSections = orderedSections;
		inspectorLayout = orderedSections;
	} else {
		const extensionSections = resolvedExtensions.map(extensionLayoutSection);
		const regionContent = [
			EXTENSION_PROMPT_REGION_START,
			...extensionSections.map((section) => section.promptContent),
			EXTENSION_PROMPT_REGION_END,
		].join("\n");
		extensionRegionBytes = Buffer.byteLength(regionContent, "utf-8");
		const region: LayoutSection = { label: "Extension Prompt Region", promptContent: regionContent, inspectorSections: [] };
		promptSections = [
			...orderedSections.slice(0, extensionBoundary),
			region,
			...orderedSections.slice(extensionBoundary),
		];
		inspectorLayout = [
			...orderedSections.slice(0, extensionBoundary),
			...extensionSections,
			...orderedSections.slice(extensionBoundary),
		];
	}

	const content = joinPromptSections(promptSections);
	const totalPromptBytes = content ? Buffer.byteLength(content, "utf-8") : 0;
	const prefix = content ? Buffer.from(content, "utf-8").subarray(0, extensionRegionStartByteOffset) : Buffer.alloc(0);
	return {
		content,
		prompt: content,
		sections: flattenInspectorSections(inspectorLayout, totalPromptBytes),
		totalPromptBytes,
		extensionRegionStartByteOffset,
		stablePrefixSha256: createHash("sha256").update(prefix).digest("hex"),
		extensionRegionBytes,
	};
}

/** Backwards-friendly alias for consumers that model this as a builder. */
export const buildSystemPromptLayout = getSystemPromptLayout;

/**
 * Assemble the full system prompt from its parts and write to a temp file.
 * Returns undefined when no content is available.
 */
export function assembleSystemPrompt(sessionId: string, parts: PromptParts, stateDir?: string): string | undefined {
	return profile("assembleSystemPrompt", () => {
		const layout = getSystemPromptLayout(parts);
		if (!layout.content) return undefined;
		bumpCount("assembleSystemPrompt.bytes", layout.totalPromptBytes);
		const promptPath = path.join(resolvePromptsDir(stateDir), `${sessionId}.md`);
		fs.writeFileSync(promptPath, layout.content, "utf-8");
		return promptPath;
	});
}

/** Return the inspector projection from the exact same layout used for assembly. */
export function getPromptSections(parts: PromptParts): PromptSection[] {
	return getSystemPromptLayout(parts).sections;
}

/**
 * Persist the resolved prompt sections as a JSON snapshot at session creation time.
 * This captures the actual prompt that was used, not a reconstruction from current files.
 */
export function persistPromptSections(sessionId: string, parts: PromptParts, stateDir?: string): void {
	try {
		const layout = getSystemPromptLayout(parts);
		const totalTokens = layout.sections.reduce((sum, s) => sum + s.tokens, 0);
		const data = {
			sections: layout.sections,
			totalTokens,
			totalPromptBytes: layout.totalPromptBytes,
			extensionRegionStartByteOffset: layout.extensionRegionStartByteOffset,
			stablePrefixSha256: layout.stablePrefixSha256,
			extensionRegionBytes: layout.extensionRegionBytes,
			createdAt: new Date().toISOString(),
		};
		const jsonPath = path.join(resolvePromptsDir(stateDir), `${sessionId}-prompt.json`);
		fs.writeFileSync(jsonPath, JSON.stringify(data), "utf-8");
	} catch (err) {
		console.error(`[system-prompt] Failed to persist prompt sections for ${sessionId}:`, err);
	}
}

/**
 * Load persisted prompt sections snapshot for a session.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function loadPersistedPromptSections(sessionId: string, stateDir?: string): {
	sections: PromptSection[];
	totalTokens: number;
	totalPromptBytes?: number;
	extensionRegionStartByteOffset?: number;
	stablePrefixSha256?: string;
	extensionRegionBytes?: number;
	createdAt: string;
} | null {
	try {
		const jsonPath = path.join(resolvePromptsDir(stateDir), `${sessionId}-prompt.json`);
		if (!fs.existsSync(jsonPath)) return null;
		return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Delete the persisted prompt sections JSON for a session (archive purge only).
 */
export function purgePromptSectionsJson(sessionId: string, stateDir?: string): void {
	try {
		const jsonPath = path.join(resolvePromptsDir(stateDir), `${sessionId}-prompt.json`);
		if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
	} catch { /* ignore */ }
}

/**
 * Promise-based archive-purge seam for the persisted prompt-section snapshot.
 * Missing files are an idempotent success; other errors stay owned by the
 * awaited purge caller rather than disappearing behind a synchronous helper.
 */
export async function purgePromptSectionsJsonAsync(sessionId: string, stateDir?: string): Promise<void> {
	const jsonPath = path.join(resolvePromptsDirForCleanup(stateDir), `${sessionId}-prompt.json`);
	try {
		await fs.promises.unlink(jsonPath);
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
}

/**
 * Clean up a session's assembled prompt file.
 */
export function cleanupSessionPrompt(sessionId: string, stateDir?: string): void {
	const promptPath = path.join(resolvePromptsDir(stateDir), `${sessionId}.md`);
	try {
		if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
	} catch { /* ignore */ }
	// Per-session preview mount (WP-A): <stateDir>/preview/<sid>/. Keep the
	// legacy void API best-effort even when removeMount is promise-based.
	try { void Promise.resolve(removePreviewMount(sessionId)).catch(() => {}); } catch { /* ignore */ }
}

/**
 * Promise-based archive-purge cleanup. Prompt deletion and preview-mount
 * removal are both attempted in the historical order. The mount call is
 * awaited so purge completion includes its bounded asynchronous tree removal.
 */
export async function cleanupSessionPromptAsync(sessionId: string, stateDir?: string): Promise<void> {
	const promptPath = path.join(resolvePromptsDirForCleanup(stateDir), `${sessionId}.md`);
	let failure: unknown;
	try {
		await fs.promises.unlink(promptPath);
	} catch (error) {
		if (!isMissingFileError(error)) failure = error;
	}
	try {
		await removePreviewMount(sessionId);
	} catch (error) {
		failure ??= error;
	}
	if (failure) throw failure;
}
