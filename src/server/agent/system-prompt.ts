import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitConfigDir } from "../bobbit-dir.js";
import { removeMount as removePreviewMount } from "../preview/mount.js";
import { getAllConfigDirectories, type ProjectConfigReader } from "./config-directories.js";
import { resolveToolsMdMode, type ToolsMdMode } from "./tool-manager.js";
import type { SlashSkill } from "../skills/slash-skills.js";
import { profile, bumpCount } from "./profiling.js";
import { type ContextBlock, fenceBlock } from "./context-blocks.js";
import { buildNestingContextSection } from "./goal-nesting-stanzas.js";

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
export function resolveMarkdownRefs(content: string, baseDir: string, seen?: Set<string>, depth = 0, budget?: AgentsMdBudget): string {
	if (!seen) seen = new Set();
	const MAX_DEPTH = 5;

	// First pass: whole-line refs (preserves indentation behavior)
	content = content.replace(/^([ \t]*)@(\S+)\s*$/gm, (_match, indent: string, refPath: string) => {
		return resolveOneRef(refPath, indent, baseDir, seen!, depth, MAX_DEPTH, /* wholeLine */ true, budget);
	});

	// Second pass: inline refs (surrounded by other text)
	// Negative lookbehind excludes email addresses (word char before @)
	content = content.replace(/(?<!\w)@((?:~[/\\]|\.{0,2}[/\\])?[\w./_\\-]+\.\w+)/g, (_match, refPath: string) => {
		return resolveOneRef(refPath, "", baseDir, seen!, depth, MAX_DEPTH, /* wholeLine */ false, budget);
	});

	return content;
}

function expandHomePath(p: string): string {
	if (p.startsWith("~")) {
		return path.join(os.homedir(), p.slice(1));
	}
	return p;
}

/**
 * F19 — AGENTS.md cascade budget (see docs/internals.md "AGENTS.md cascade
 * budget" + docs/design/agents-md-cascade-budget.md for the measurement that
 * motivated this).
 *
 * Ground truth: the Project AGENTS.md cascade is, by construction, ONE
 * "nearest" file (the project's own root `AGENTS.md`/`CLAUDE.md`, plus any
 * additional `agents`-typed custom config directories a project explicitly
 * opts into) whose `@ref` includes are inlined recursively (up to 5 hops)
 * with NO size cap. Measured on a real managed project this reached ~21K
 * tokens = 56% of a code-reviewer prompt — driven almost entirely by the
 * `@ref` expansion, not by the root file's own prose (this repo's own
 * AGENTS.md, e.g., is independently pinned under 6KB by
 * tests/agents-md-budget.test.ts).
 *
 * Strategy (deterministic, no LLM summarization):
 *   - The NEAREST/most-specific agents file (the first discovered entry —
 *     always the project's own root AGENTS.md/CLAUDE.md when present) is
 *     ALWAYS kept whole: its own literal text is never truncated by this
 *     budget. Only the content it pulls in via `@ref` is capped.
 *   - Any ADDITIONAL agents-type entries (opt-in custom config directories
 *     beyond the nearest file) are treated as "ancestors": their own text,
 *     and everything they `@ref` in, is budgeted from the start.
 *   - Once the shared budget is exhausted, remaining content is replaced
 *     with an explicit `<!-- ... -->` marker naming the source path, so the
 *     agent always knows something was cut and where to read the rest —
 *     never a silent drop.
 *
 * Disabled (default) when no budget is supplied anywhere — behavior is then
 * byte-identical to pre-F19.
 */
export interface AgentsMdBudget {
	/** Remaining byte budget for @-ref-injected / non-nearest content. Mutated as content is consumed. */
	remainingBytes: number;
	/** Record of every truncation applied, for the per-section prompt breakdown / A-B measurement. */
	truncations: Array<{ path: string; cutBytes: number }>;
}

/** ~4 chars/token for Claude models — matches `estimateTokens()` below (kept in sync intentionally). */
export const AGENTS_MD_BUDGET_CHARS_PER_TOKEN = 4;
/** Guardrails on the `BOBBIT_AGENTSMD_BUDGET` env var / override — avoids a typo'd value silently disabling or effectively no-op'ing the cap. */
export const AGENTS_MD_BUDGET_MIN_TOKENS = 500;
export const AGENTS_MD_BUDGET_MAX_TOKENS = 500_000;

export function createAgentsMdBudget(tokens: number): AgentsMdBudget {
	return { remainingBytes: Math.max(0, Math.floor(tokens)) * AGENTS_MD_BUDGET_CHARS_PER_TOKEN, truncations: [] };
}

/**
 * Resolve the effective AGENTS.md cascade budget (in tokens), or `undefined`
 * when the cap is OFF (today's uncapped behavior). `overrideTokens` (e.g. a
 * per-goal/session preference) wins when provided; otherwise falls back to
 * the `BOBBIT_AGENTSMD_BUDGET` env var. Absent/invalid/non-positive on both
 * ⇒ disabled. Valid values are clamped to `[AGENTS_MD_BUDGET_MIN_TOKENS, AGENTS_MD_BUDGET_MAX_TOKENS]`.
 */
export function resolveAgentsMdBudgetTokens(overrideTokens?: number): number | undefined {
	const raw = overrideTokens !== undefined ? overrideTokens : parseAgentsMdBudgetEnv();
	if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
	const floored = Math.floor(raw);
	if (floored < AGENTS_MD_BUDGET_MIN_TOKENS) return AGENTS_MD_BUDGET_MIN_TOKENS;
	if (floored > AGENTS_MD_BUDGET_MAX_TOKENS) return AGENTS_MD_BUDGET_MAX_TOKENS;
	return floored;
}

function parseAgentsMdBudgetEnv(): number | undefined {
	const v = process.env.BOBBIT_AGENTSMD_BUDGET;
	if (!v) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/** Cut `text` at or before `maxBytes`, snapping to the last newline so the cut never lands mid-line. */
function cutAtLineBoundary(text: string, maxBytes: number): string {
	if (text.length <= maxBytes) return text;
	if (maxBytes <= 0) return "";
	const slice = text.slice(0, maxBytes);
	const lastNl = slice.lastIndexOf("\n");
	return lastNl > 0 ? slice.slice(0, lastNl) : slice;
}

/**
 * Debit `raw` against `budget`, truncating deterministically at a line
 * boundary when it doesn't fit. Returns the (possibly truncated) text the
 * caller should keep resolving `@ref`s within — never re-debits the same
 * bytes twice. Mutates `budget` in place and records the cut for the
 * per-section breakdown.
 */
function debitAgentsMdBudget(raw: string, budget: AgentsMdBudget, sourcePath: string): { text: string; truncated: boolean } {
	if (budget.remainingBytes <= 0) {
		budget.truncations.push({ path: sourcePath, cutBytes: raw.length });
		return { text: "", truncated: true };
	}
	if (raw.length <= budget.remainingBytes) {
		budget.remainingBytes -= raw.length;
		return { text: raw, truncated: false };
	}
	const kept = cutAtLineBoundary(raw, budget.remainingBytes);
	budget.truncations.push({ path: sourcePath, cutBytes: raw.length - kept.length });
	budget.remainingBytes = 0;
	return { text: kept, truncated: true };
}

function agentsMdTruncatedMarker(sourcePath: string): string {
	return `\n\n<!-- [AGENTS.md cascade budget: truncated — see ${sourcePath} for full content] -->`;
}

function agentsMdOmittedMarker(sourcePath: string): string {
	return `<!-- [AGENTS.md cascade budget: omitted ${sourcePath} entirely — token budget exhausted; read the file directly] -->`;
}

function resolveOneRef(
	refPath: string,
	indent: string,
	baseDir: string,
	seen: Set<string>,
	depth: number,
	maxDepth: number,
	wholeLine: boolean,
	budget?: AgentsMdBudget,
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

	if (budget && budget.remainingBytes <= 0) {
		budget.truncations.push({ path: filePath, cutBytes: -1 });
		const marker = agentsMdOmittedMarker(refPath);
		return wholeLine && indent ? `${indent}${marker}` : marker;
	}

	seen.add(canonical);
	try {
		let refContent = fs.readFileSync(filePath, "utf-8");
		let truncatedHere = false;
		if (budget) {
			const debited = debitAgentsMdBudget(refContent, budget, filePath);
			refContent = debited.text;
			truncatedHere = debited.truncated;
		}
		const resolved = resolveMarkdownRefs(refContent, path.dirname(filePath), seen, depth + 1, budget) +
			(truncatedHere ? agentsMdTruncatedMarker(filePath) : "");

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
export function readAgentsMd(cwd: string, budget?: AgentsMdBudget): string {
	const agentsPath = path.join(cwd, "AGENTS.md");
	if (!fs.existsSync(agentsPath)) return "";

	try {
		const raw = fs.readFileSync(agentsPath, "utf-8");
		return resolveMarkdownRefs(raw, cwd, undefined, 0, budget);
	} catch {
		return "";
	}
}

/**
 * Read all agent markdown files from configured locations.
 * Collects entries with type "agents" from getAllConfigDirectories(),
 * reads each existing file, resolves @refs, and concatenates.
 * Falls back to readAgentsMd() if no projectConfigStore is provided.
 *
 * `budgetTokens` (F19) optionally caps the cascade — see
 * `resolveAgentsMdBudgetTokens()`/`BOBBIT_AGENTSMD_BUDGET`. `undefined`
 * (default) is uncapped and byte-identical to pre-F19 behavior. The FIRST
 * discovered agents entry (the nearest/most-specific — normally the
 * project's own root AGENTS.md/CLAUDE.md) is always kept whole; only its
 * `@ref` expansions are budgeted. Any additional agents-type entries are
 * budgeted from their own first byte.
 */
export function readAllAgentFiles(cwd: string, projectConfigStore?: ProjectConfigReader, budgetTokens?: number): string {
	return profile("readAllAgentFiles", () => {
		const budget = budgetTokens !== undefined ? createAgentsMdBudget(budgetTokens) : undefined;

		if (!projectConfigStore) {
			return readAgentsMd(cwd, budget);
		}

		const dirs = getAllConfigDirectories(cwd, projectConfigStore);
		const agentEntries = dirs.filter(d => d.types.includes("agents") && d.exists);
		bumpCount("readAllAgentFiles.files", agentEntries.length);

		const parts: string[] = [];
		for (let i = 0; i < agentEntries.length; i++) {
			const entry = agentEntries[i];
			try {
				const raw = fs.readFileSync(entry.path, "utf-8");
				let resolved: string;
				if (budget && i > 0) {
					// Not the nearest/most-specific file — budgeted like an @-ref, own text included.
					if (budget.remainingBytes <= 0) {
						budget.truncations.push({ path: entry.path, cutBytes: raw.length });
						parts.push(agentsMdOmittedMarker(entry.path));
						continue;
					}
					const { text: kept, truncated } = debitAgentsMdBudget(raw, budget, entry.path);
					resolved = resolveMarkdownRefs(kept, path.dirname(entry.path), undefined, 0, budget) +
						(truncated ? agentsMdTruncatedMarker(entry.path) : "");
				} else {
					// Nearest/most-specific file (or budget disabled): own text always kept whole.
					resolved = resolveMarkdownRefs(raw, path.dirname(entry.path), undefined, 0, budget);
				}
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
 *
 * Conditional wiring only — the stanza copy itself, and the predicates that
 * select which stanza applies, are DATA in `goal-nesting-stanzas.ts`'s
 * declarative table (EXTENSION-SEAM-AUDIT.md S6: "should-be-declarative").
 * Adding a new stanza variant means adding a row to that table, not a new
 * branch here.
 */
export { buildNestingContextSection };

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
	/** Optional override for the AGENTS.md cascade token budget (F19). When
	 *  undefined, falls back to the `BOBBIT_AGENTSMD_BUDGET` env var; when
	 *  neither is set, the cascade is uncapped (today's behavior). See
	 *  `resolveAgentsMdBudgetTokens()`. */
	agentsMdBudgetTokens?: number;
	/** Skills available for autonomous activation via the `activate_skill` tool.
	 *  When non-empty, an "Available Skills" section is injected into the system prompt.
	 *  Skills with `disable-model-invocation: true` should be filtered out by the caller. */
	skillsCatalog?: SlashSkill[];
	/** Optional override for the skills-catalog byte budget (clamped to [MIN, MAX]).
	 *  When undefined, `SKILLS_CATALOG_BUDGET` is used. */
	skillsCatalogBudget?: number;
	/** Fresh provider-supplied context blocks appended as the final, lowest-authority prompt section. */
	dynamicContext?: ContextBlock[];
	/**
	 * Optional per-goal prompt section ordering (the `bobbit.promptSectionOrder`
	 * metadata convention). Labels listed here are emitted first, in the given
	 * order; any unlisted section keeps its original relative position after
	 * them. Unknown labels are ignored. Absent ⇒ today's fixed order, byte-
	 * identical. NOTE: reordering the stable/volatile split can change the
	 * provider prompt-cache hit rate — a legitimate A/B experiment variable.
	 */
	sectionOrder?: string[];
	/**
	 * F2/F22 (RECONCILIATION-2026-07-05.md NEXT QUEUE items 4/5) — optional
	 * prompt-slimming profile. `undefined` (default) ⇒ full prompt, byte-
	 * identical to pre-profile behavior.
	 *  - `"reviewer"`: read-only verification sessions (llm-review/agent-qa,
	 *    spawned with `nonInteractive: true` — see verification-reviewer-meta.ts)
	 *    that only ever call `verification_result`. Drops
	 *    `REVIEWER_EXCLUDED_STANZAS` (Git conventions + the mutate-same-target
	 *    concurrency stanza) from the base system prompt — both are exclusively
	 *    about actions these sessions structurally never take.
	 *  - `"narrow-worker"`: a `team_delegate` child whose spawn-time
	 *    `allowedTools` is PROVABLY restricted to pure file/shell primitives
	 *    (see `isNarrowDelegateAllowedTools` in session-manager.ts). The
	 *    Working Directory section drops the multi-agent branch-discipline
	 *    rationale, since a narrow delegate has no branch of its own and never
	 *    leaves the parent's worktree. (The AGENTS.md cascade trim to
	 *    nearest-only is done by the caller omitting `projectConfigStore`, not
	 *    by this flag — see `buildDelegatePromptParts`.)
	 */
	promptProfile?: PromptProfile;
}

/**
 * F2/F22 prompt-slimming profile — see `PromptParts.promptProfile`.
 */
export type PromptProfile = "reviewer" | "narrow-worker";

/**
 * F2 — base system-prompt.md H1 stanzas that are exclusively about actions a
 * `nonInteractive` review session never takes (it only calls
 * `verification_result`): branch/commit/PR mechanics, and Edit/Write
 * mutation-race guidance. Matched by exact H1 heading text (see
 * `stripPromptStanzas`) against the LIVE `defaults/system-prompt.md` (or a
 * user override) — if a future rewrite renames/removes one of these headings,
 * stripping silently becomes a no-op for that stanza rather than erroring;
 * `tests/system-prompt.test.ts` pins the savings this list is expected to buy.
 */
export const REVIEWER_EXCLUDED_STANZAS: readonly string[] = [
	"Git conventions",
	"Parallel tool calls that mutate the same target",
];

/**
 * Remove each H1 section named in `headings` (its heading line through the
 * line before the next H1, or end of text) from `text`. Runs of 3+ newlines
 * left by a removed section are collapsed to a single blank line. No-op when
 * `headings` is empty or none of the names appear.
 */
export function stripPromptStanzas(text: string, headings: readonly string[]): string {
	if (headings.length === 0) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let skipping = false;
	for (const line of lines) {
		if (line.startsWith("# ")) {
			skipping = headings.includes(line.slice(2).trim());
		}
		if (!skipping) out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * F22 — Working Directory section body, shared by `_assembleSystemPrompt` and
 * `getPromptSections` so both stay byte-identical to each other. The
 * `"narrow-worker"` profile drops the "why this is a hard constraint"
 * paragraph: it exists to warn about OTHER agents/branches colliding in a
 * shared primary worktree, a scenario a provably narrow delegate (confined to
 * its parent's worktree, no branch of its own) cannot cause.
 */
function workingDirectoryBody(cwd: string, profile?: PromptProfile): string {
	const core = `Your working directory is: \`${cwd}\`\n\n` +
		`Stay in this directory for all file operations and git commands. ` +
		`Do not \`cd\` into other directories unless explicitly required by the task.`;
	if (profile === "narrow-worker") return core;
	return core + `\n\n` +
		`**Why this is a hard constraint:** Other agents, the dev server, and the user may all be working in the primary worktree simultaneously. ` +
		`If you \`cd\` there and make changes, you risk merge conflicts during rebase, corrupting other agents' in-progress work, or breaking the running dev server. ` +
		`Even for infrastructure files (Dockerfiles, configs), the correct flow is: edit here → commit → push to origin → pull from primary. ` +
		`One \`cd\` violation cascades — all subsequent commands (edit, git add, commit) will operate on shared state.`;
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

export interface PromptSection {
	label: string;
	source: string;
	content: string;
	/** Estimated token count (~4 chars/token for Claude models) */
	tokens: number;
	/** True when this section's content was capped by the AGENTS.md cascade
	 *  budget (F19) — recorded so the persisted `-prompt.json` breakdown can
	 *  A/B measure the effect of `BOBBIT_AGENTSMD_BUDGET`. Absent/false when
	 *  the budget is off or this section wasn't affected. */
	truncated?: boolean;
	/** F22: the `# Tools` markdown rendering mode (`"full"` | `"index"`) in
	 *  effect for this section — only set on the "Tools" section — so the
	 *  persisted `-prompt.json` breakdown can A/B measure `BOBBIT_TOOLS_MD`.
	 *  See `resolveToolsMdMode()` in tool-manager.ts. */
	toolsMdMode?: ToolsMdMode;
}

/**
 * Assemble the full system prompt from its parts and write to a temp file.
 *
 * Order (stable prefix first, volatile sections last, for provider prompt-cache reuse):
 *   1. Global system prompt (config/system-prompt.md)
 *   2. AGENTS.md from the session's working directory (with @refs resolved inline)
 *   2.5. Working directory instructions
 *   3. Tool documentation
 *   4. Available Skills catalog
 *   5. Goal spec + role (if session belongs to a goal)
 *   6. Current Task
 *   7. Workflow upstream-gate context
 *
 * Returns the path to the assembled prompt file, or undefined if all parts
 * are empty (in which case no --system-prompt should be passed to the agent).
 */
export function assembleSystemPrompt(sessionId: string, parts: PromptParts): string | undefined {
	return profile("assembleSystemPrompt", () => _assembleSystemPrompt(sessionId, parts));
}

function _assembleSystemPrompt(sessionId: string, parts: PromptParts): string | undefined {
	const sections: { label: string; content: string }[] = [];

	// 1. Global system prompt (resolve @refs relative to its directory)
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const raw = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		let base = raw ? resolveMarkdownRefs(raw, path.dirname(parts.baseSystemPromptPath)) : "";
		if (base && parts.promptProfile === "reviewer") base = stripPromptStanzas(base, REVIEWER_EXCLUDED_STANZAS).trim();
		if (base) sections.push({ label: "System Prompt", content: base });
	}

	// 2. Agent files — use projectRoot (host-accessible) when available; for sandboxed
	// agents cwd is a container-internal path the host can't read.
	const filesRoot = parts.projectRoot || parts.cwd;
	const agentsMdBudgetTokens = resolveAgentsMdBudgetTokens(parts.agentsMdBudgetTokens);
	const agentsMd = readAllAgentFiles(filesRoot, parts.projectConfigStore, agentsMdBudgetTokens);
	if (agentsMd.trim()) {
		sections.push({ label: "Project AGENTS.md", content: "# Project AGENTS.md\n\n" + agentsMd.trim() });
	}

	// 2.5. Working directory instructions
	if (parts.cwd) {
		sections.push({ label: "Working Directory", content: `# Working Directory\n\n` + workingDirectoryBody(parts.cwd, parts.promptProfile) });
	}

	// 3. Tool documentation (stable across turns — kept in the prefix for prompt caching)
	if (parts.toolDocs?.trim()) {
		sections.push({ label: "Tools", content: parts.toolDocs.trim() });
	}

	// 4. Available Skills (autonomous activation catalog — stable across turns)
	if (parts.skillsCatalog && parts.skillsCatalog.length > 0) {
		const skillsSection = buildSkillsCatalogSection(parts.skillsCatalog, parts.skillsCatalogBudget);
		if (skillsSection) sections.push({ label: "Available Skills", content: skillsSection });
	}

	// 5. Goal spec + role as SEPARATE labeled sections so each can be reordered
	// independently via `bobbit.promptSectionOrder` and the assembled prompt
	// mirrors the inspector (getPromptSections) which already exposes Goal and
	// Role distinctly. Joined by the section separator below, the default order
	// (Goal then Role) is byte-identical to the previous merged `Goal` section.
	// Volatile sections (goal/role/task/workflow context) follow the stable prefix
	// above so provider prompt caches reuse the tool docs + skills catalog.
	if (parts.goalSpec?.trim()) {
		const header = parts.goalTitle
			? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
			: "# Goal";
		sections.push({ label: "Goal", content: header + "\n\n" + parts.goalSpec.trim() });
	}
	if (parts.rolePrompt?.trim()) {
		// Backward compatibility: historically the role prompt rendered INSIDE the
		// `# Goal` section. When there is no goal spec AND no explicit
		// `bobbit.promptSectionOrder`, a role-only session must keep that exact
		// shape (a `# Goal` header preceding the role prompt) so absent-metadata
		// output is byte-identical to before. When metadata supplies a section
		// order, `Role` stays a standalone, independently-reorderable section.
		const hasOrder = !!parts.sectionOrder && parts.sectionOrder.length > 0;
		const needsGoalHeader = !parts.goalSpec?.trim() && !hasOrder;
		const roleHeader = parts.goalTitle
			? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
			: "# Goal";
		const roleContent = needsGoalHeader
			? roleHeader + "\n\n" + parts.rolePrompt.trim()
			: parts.rolePrompt.trim();
		sections.push({ label: "Role", content: roleContent });
	}

	// 5.5. Goal nesting context — three stanzas for team-lead sessions
	// describing root/child role + the subgoal/team_spawn/task_create decision rule.
	if (parts.nestingContext) {
		const nesting = buildNestingContextSection(parts.nestingContext);
		if (nesting) sections.push({ label: "Goal Nesting", content: nesting });
	}

	// 6. Task context
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

		sections.push({ label: "Task", content: taskLines.join("\n") });
	}

	// 7. Workflow dependency context (accepted upstream gate content)
	if (parts.workflowContext?.trim()) {
		sections.push({ label: "Workflow Context", content: parts.workflowContext.trim() });
	}

	// 8. Dynamic Context (provider-supplied, freshest/lowest-authority tail)
	if (parts.dynamicContext?.length) {
		sections.push({ label: "Dynamic Context", content: "## Dynamic Context\n\n" + parts.dynamicContext.map(fenceBlock).join("\n\n") });
	}

	if (sections.length === 0) return undefined;

	// Apply the optional per-goal section ordering (absent ⇒ byte-identical default).
	const combined = reorderLabeledSections(sections, parts.sectionOrder).map((s) => s.content).join("\n\n---\n\n") + "\n";
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

	// 1. Global system prompt (resolve @refs relative to its directory)
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const raw = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		let base = raw ? resolveMarkdownRefs(raw, path.dirname(parts.baseSystemPromptPath)) : "";
		if (base && parts.promptProfile === "reviewer") base = stripPromptStanzas(base, REVIEWER_EXCLUDED_STANZAS).trim();
		if (base) sections.push({ label: "System Prompt", source: parts.baseSystemPromptPath!, content: base, tokens: estimateTokens(base) });
	}

	// 2. Agent files (individual sections per file for provenance).
	// Mirrors readAllAgentFiles()'s cascade-budget logic (F19) so the inspector
	// shows exactly what the assembled prompt actually contains, including
	// any truncation markers.
	const viewerRoot = parts.projectRoot || parts.cwd;
	const agentsMdBudgetTokens = resolveAgentsMdBudgetTokens(parts.agentsMdBudgetTokens);
	const agentsMdBudget = agentsMdBudgetTokens !== undefined ? createAgentsMdBudget(agentsMdBudgetTokens) : undefined;
	if (parts.projectConfigStore) {
		const dirs = getAllConfigDirectories(viewerRoot, parts.projectConfigStore);
		const agentEntries = dirs.filter(d => d.types.includes("agents") && d.exists);
		for (let i = 0; i < agentEntries.length; i++) {
			const entry = agentEntries[i];
			try {
				const raw = fs.readFileSync(entry.path, "utf-8");
				let resolved: string;
				let truncated = false;
				if (agentsMdBudget && i > 0) {
					if (agentsMdBudget.remainingBytes <= 0) {
						agentsMdBudget.truncations.push({ path: entry.path, cutBytes: raw.length });
						sections.push({ label: "Project AGENTS.md", source: entry.path, content: agentsMdOmittedMarker(entry.path), tokens: 0, truncated: true });
						continue;
					}
					const debited = debitAgentsMdBudget(raw, agentsMdBudget, entry.path);
					truncated = debited.truncated;
					resolved = resolveMarkdownRefs(debited.text, path.dirname(entry.path), undefined, 0, agentsMdBudget) +
						(truncated ? agentsMdTruncatedMarker(entry.path) : "");
				} else {
					const before = agentsMdBudget?.truncations.length ?? 0;
					resolved = resolveMarkdownRefs(raw, path.dirname(entry.path), undefined, 0, agentsMdBudget);
					truncated = agentsMdBudget ? agentsMdBudget.truncations.length > before : false;
				}
				if (resolved.trim()) {
					sections.push({ label: "Project AGENTS.md", source: entry.path, content: resolved.trim(), tokens: estimateTokens(resolved.trim()), truncated });
				}
			} catch {
				// skip unreadable files
			}
		}
	} else {
		// Legacy fallback: single AGENTS.md with absolute path
		const agentsPath = path.join(viewerRoot, "AGENTS.md");
		if (fs.existsSync(agentsPath)) {
			const before = agentsMdBudget?.truncations.length ?? 0;
			const content = readAgentsMd(viewerRoot, agentsMdBudget);
			const truncated = agentsMdBudget ? agentsMdBudget.truncations.length > before : false;
			if (content.trim()) {
				sections.push({ label: "Project AGENTS.md", source: agentsPath, content: content.trim(), tokens: estimateTokens(content.trim()), truncated });
			}
		}
	}

	// 2.5. Working directory (also included in the prompt file via assembleSystemPrompt;
	// the agent CLI may additionally inject its own "Current working directory" based on --cwd)
	if (parts.cwd) {
		const cwdContent = workingDirectoryBody(parts.cwd, parts.promptProfile);
		sections.push({ label: "Working Directory", source: parts.cwd, content: cwdContent, tokens: estimateTokens(cwdContent) });
	}

	// 3. Tool docs (stable prefix — kept ahead of volatile goal/role/task for cache reuse)
	if (parts.toolDocs?.trim()) {
		sections.push({ label: "Tools", source: "Tool documentation", content: parts.toolDocs.trim(), tokens: estimateTokens(parts.toolDocs.trim()), toolsMdMode: resolveToolsMdMode() });
	}

	// 4. Available Skills (stable prefix)
	if (parts.skillsCatalog && parts.skillsCatalog.length > 0) {
		const skillsSection = buildSkillsCatalogSection(parts.skillsCatalog, parts.skillsCatalogBudget);
		if (skillsSection) {
			sections.push({ label: "Available Skills", source: "Slash skills catalog", content: skillsSection, tokens: estimateTokens(skillsSection) });
		}
	}

	// 5. Goal spec (separate from role — volatile section follows the stable prefix)
	if (parts.goalSpec?.trim()) {
		const header = parts.goalTitle
			? `**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
			: "";
		const goalContent = (header ? header + "\n\n" : "") + parts.goalSpec.trim();
		sections.push({ label: "Goal", source: `Goal: ${parts.goalTitle || "Untitled"}`, content: goalContent, tokens: estimateTokens(goalContent) });
	}

	// 6. Role prompt
	if (parts.rolePrompt?.trim()) {
		sections.push({ label: "Role", source: `Role: ${parts.roleName || "unknown"}`, content: parts.rolePrompt.trim(), tokens: estimateTokens(parts.rolePrompt.trim()) });
	}

	// 6.5. Goal nesting context — see _assembleSystemPrompt for shape.
	if (parts.nestingContext) {
		const nesting = buildNestingContextSection(parts.nestingContext);
		if (nesting) {
			sections.push({ label: "Goal Nesting", source: parts.nestingContext.parent ? "Child team-lead" : "Top-level team-lead", content: nesting, tokens: estimateTokens(nesting) });
		}
	}

	// 7. Task context
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

	// 8. Workflow context
	if (parts.workflowContext?.trim()) {
		sections.push({ label: "Workflow Context", source: "Upstream gates", content: parts.workflowContext.trim(), tokens: estimateTokens(parts.workflowContext.trim()) });
	}

	// 9. Dynamic Context (provider-supplied, freshest/lowest-authority tail)
	if (parts.dynamicContext?.length) {
		const content = parts.dynamicContext.map(fenceBlock).join("\n\n");
		sections.push({ label: "Dynamic Context", source: "providers", content, tokens: estimateTokens(content) });
	}

	// Apply the optional per-goal section ordering so the inspector mirrors the
	// assembled prompt (absent ⇒ byte-identical default).
	return reorderLabeledSections(sections, parts.sectionOrder);
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
