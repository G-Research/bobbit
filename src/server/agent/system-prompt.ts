import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAllConfigDirectories, type ProjectConfigReader } from "./config-directories.js";
import type { SlashSkill } from "../skills/slash-skills.js";
import { profile, bumpCount } from "./profiling.js";

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

	// ── Nested-goal awareness (design doc §14.1) ─────────────────────────────
	/** True only for team-lead role sessions; controls whether the mid-goal
	 *  nesting stanza is emitted at all (other roles never spawn children). */
	isTeamLead?: boolean;
	/** Set when this team-lead's goal is the root of a tree (`parentGoalId == null`).
	 *  Triggers the top-level team-lead stanza. Mutually exclusive with `parentGoal`. */
	isTopLevelTeamLead?: boolean;
	/** Set when this session belongs to a child goal. Triggers the child stanza,
	 *  which is spliced **before** the goal-spec block so the model reads context first. */
	parentGoal?: { id: string; title: string; branch: string; specExcerpt: string; rootTitle: string };
	/** Effective divergence policy (resolved through inheritance walk in §1.5).
	 *  Used by the top-level and mid-goal stanzas. Default `"strict"`. */
	divergencePolicy?: "strict" | "balanced" | "autonomous";
	/** Effective concurrency cap (root-only resolver in §1.5). Default 3. */
	maxConcurrentChildren?: number;
	/** The goal's workflowId — used to append the planning-loop one-liner to the
	 *  top-level stanza when set to `"parent"`. */
	goalWorkflowId?: string;
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

// ── Nested-goal stanzas (design doc §14.1) ─────────────────────────────────

/**
 * Top-level team-lead stanza. Emitted when `parts.isTeamLead && parts.isTopLevelTeamLead`.
 * Spliced AFTER the goal spec so the "if your goal is large enough" heuristic
 * has the spec to reason about.
 *
 * Literal text lifted from design doc §14.1.1. When `goalWorkflowId === "parent"`,
 * a one-liner about the planning loop is appended (the §14.1.1 "Planned" branch
 * already mentions the loop; the workflow=parent hint adds extra emphasis).
 */
export function buildTopLevelTeamLeadStanza(opts: {
	maxConcurrentChildren?: number;
	divergencePolicy?: "strict" | "balanced" | "autonomous";
	goalWorkflowId?: string;
}): string {
	const maxConc = opts.maxConcurrentChildren ?? 3;
	const policy = opts.divergencePolicy ?? "strict";

	let body =
		"## Goal Decomposition\n\n" +
		"This is a **top-level goal** — its branch will eventually merge to\n" +
		"`master` via a PR raised by your `ready-to-merge` gate.\n\n" +
		"If this goal is large enough that one team can't reasonably ship it\n" +
		"without losing context, you have two ways to decompose it:\n\n" +
		"1. **Ad-hoc:** call `goal_spawn_child` at any point to break a piece off.\n" +
		"   The spawned child branches off your branch HEAD, runs its own workflow\n" +
		"   (default `feature`), and merges its branch back into yours when its\n" +
		"   `ready-to-merge` gate passes. You stay in charge of integration.\n\n" +
		"2. **Planned:** if your workflow is `parent` (or you switch to it via\n" +
		"   `goal_plan_propose`), you have a structured planning loop:\n" +
		"   - Signal **charter** with the user-visible outcome and acceptance\n" +
		"     criteria.\n" +
		"   - Signal **plan-review** with the proposed DAG of subgoals.\n" +
		"   - The user signals **goal-plan** to approve and freeze the plan.\n" +
		"   - The harness automatically spawns the planned children at the right\n" +
		`     phases, up to your concurrency cap (currently ${maxConc}).\n\n` +
		"**Heuristic — when to decompose.** Strongly prefer the planned approach\n" +
		"when any of the following hold:\n" +
		"- The spec exceeds ~5,000 characters.\n" +
		"- The spec mentions versions, milestones, or phases (`v0.1`, `phase 2`,\n" +
		"  `milestone 3`).\n" +
		"- The spec has 5+ acceptance criteria covering distinct deliverables.\n" +
		"- Multiple components or repos are touched.\n\n" +
		"**Worked example.** A spec like the agent-memory v0.1→v1.0 brief is a\n" +
		"multi-version delivery program. The right decomposition is:\n" +
		'- Charter: "Ship agent-memory v0.1 through v1.0 with semantic recall."\n' +
		"- Plan:\n" +
		"  - `v0.1 — schema + persistence` (phase 1)\n" +
		"  - `v0.2 — recall API` (phase 2, depends on v0.1)\n" +
		"  - `v0.3 — semantic similarity` (phase 2, depends on v0.1, parallel with v0.2)\n" +
		"  - `v1.0 — production hardening` (phase 3, depends on v0.2 + v0.3)\n" +
		"- Each child uses the `feature` workflow.\n" +
		"- Children run in parallel where their phases match.\n\n" +
		`**Divergence policy: ${policy}.** Determines whether you can\n` +
		"mutate the plan after `goal-plan` has been signalled. See the mid-goal\n" +
		"stanza below.";

	if (opts.goalWorkflowId === "parent") {
		body +=
			"\n\n" +
			"**Planning loop (because your workflow is `parent`).** Your gates run in\n" +
			"order: **charter → plan-review → goal-plan → execution → integration →\n" +
			"ready-to-merge**. Signal `charter` and `plan-review` to walk the user\n" +
			"through the proposed DAG; the user freezes the plan by signalling\n" +
			"`goal-plan`, after which the harness drives the `execution` gate's\n" +
			"subgoal verify steps.";
	}

	return body;
}

/**
 * Child team-lead stanza. Emitted when `parts.parentGoal` is set, **before**
 * the goal-spec block (so the model reads parenting context first).
 *
 * Literal text lifted from design doc §14.1.2. Inputs:
 * - `parentGoal.title` / `parentGoal.branch` / `parentGoal.rootTitle`
 * - `parentGoal.specExcerpt` — first 800 chars of the parent's spec, verbatim.
 */
export function buildChildTeamLeadStanza(parentGoal: { title: string; branch: string; specExcerpt: string; rootTitle: string }): string {
	return (
		"## You Are A Child Goal\n\n" +
		"This goal is part of a larger goal tree.\n\n" +
		`- **Parent goal:** _${parentGoal.title}_ (branch \`${parentGoal.branch}\`)\n` +
		`- **Root goal:** _${parentGoal.rootTitle}_\n\n` +
		"**Branching and merging — read this carefully:**\n\n" +
		`- Your branch was created off \`${parentGoal.branch}\`. Its commits\n` +
		"  layer on top of the parent's, not on top of `master`.\n" +
		"- When your `ready-to-merge` gate passes, the parent goal's verification\n" +
		"  harness automatically performs a **local** `git merge --no-ff` of your\n" +
		`  branch into \`${parentGoal.branch}\`. **You do not raise a PR.** The\n` +
		"  parent (or the root team-lead, transitively) handles the eventual PR\n" +
		"  to `master`.\n" +
		"- Do **not** run `gh pr create`, `gh pr merge`, or any command that\n" +
		'  pushes to `master`. The `ready-to-merge` gate\'s "PR raised" verify\n' +
		"  step is short-circuited for child goals — passing it requires only\n" +
		"  that your branch is on origin and has no conflicts with the parent.\n\n" +
		"**Adherence:**\n\n" +
		"The parent's acceptance criteria are sacred. Your spec is a slice of\n" +
		"those criteria — never drop a criterion the parent assigned to you,\n" +
		"and never add a criterion that contradicts the parent's spec. If your\n" +
		"in-progress work surfaces a real reason to revise the parent's plan,\n" +
		"**stop**, surface the issue to the parent's team-lead via a normal\n" +
		"human-readable comment, and let the parent decide.\n\n" +
		"**Parent spec excerpt (for context):**\n\n" +
		`> ${parentGoal.specExcerpt.replace(/\n/g, "\n> ")}\n\n` +
		"(Excerpt is the first 800 characters of the parent's spec. Read the\n" +
		"full spec via `bash`/`read` against the parent's worktree if you need\n" +
		"more.)"
	);
}

/**
 * Mid-goal nesting stanza. Emitted when `parts.isTeamLead === true`, regardless
 * of top-level / child status, regardless of workflow. Names the three
 * decomposition primitives, the divergence-policy values, the `criteria-drop`
 * hard rejection, and the `replanCount` cap.
 *
 * Literal text lifted from design doc §14.1.3 + §14.1.5.
 */
export function buildMidGoalNestingStanza(opts: { divergencePolicy?: "strict" | "balanced" | "autonomous" }): string {
	const policy = opts.divergencePolicy ?? "strict";
	return (
		"## Mid-Goal Decomposition\n\n" +
		"You have **three** decomposition primitives. Pick the right one.\n\n" +
		"- **`task_create`** — single tracked deliverable, no agent required (or\n" +
		"  a single agent picks it up later). The most common choice.\n" +
		"- **`team_spawn`** — spin up a coder + tester (or any role pair) within\n" +
		"  *this* goal's review cycle. Use when the work is one cohesive change\n" +
		"  set being collaborated on by multiple roles.\n" +
		"- **`goal_spawn_child`** — spawn a **child goal** with its own\n" +
		"  worktree, branch, workflow, and full review cycle. Use only when ALL\n" +
		"  three of the following hold: (1) the work has its own design intent\n" +
		"  (a meaningful unit a reviewer would want to see in isolation),\n" +
		"  (2) it is independently reviewable (its own design-doc / impl /\n" +
		"  review cycle makes sense), and (3) it merges meaningfully on its own\n" +
		"  (the parent branch is sensible with this subgoal merged but its\n" +
		"  siblings still pending).\n\n" +
		"**Default: keep the decomposition you would have used before nested\n" +
		"goals existed.** Only reach for `goal_spawn_child` when the parent goal\n" +
		"is genuinely a coordination layer over independently shippable units.\n" +
		"In close-call situations, prefer `team_spawn` or `task_create` — over-using\n" +
		"subgoals adds review overhead without paying for itself. Trust your\n" +
		"judgment; don't push toward subgoals when you're not sure.\n\n" +
		"When you do call `goal_spawn_child`, valid triggers include:\n\n" +
		"- You discover a sub-deliverable that's large enough to deserve its own\n" +
		"  design-doc → implementation → review cycle (and the three\n" +
		"  conditions above hold).\n" +
		"- A blocking bug needs a focused investigation that shouldn't pollute\n" +
		"  this goal's branch with experiments.\n" +
		"- You want parallel work on independent slices that can each merge\n" +
		"  meaningfully into the parent before the others finish.\n\n" +
		`**Divergence policy: \`${policy}\`** controls when mutations\n` +
		"are allowed after the `goal-plan` gate (if any) has been signalled:\n\n" +
		"- **`strict`** — Post-freeze mutations are rejected unless you first\n" +
		"  pause the goal (`goal_pause`). Even then, the user must explicitly\n" +
		"  approve via the dashboard banner. Default. Use it when shipping\n" +
		"  predictability matters more than agility.\n" +
		'- **`balanced`** — Adding leaf children at existing phases ("fix-up"\n' +
		"  mutations) auto-approves. Adding new top-level branches or new\n" +
		'  dependencies ("expansion") prompts the user. Removing or reordering\n' +
		'  nodes ("restructure") prompts the user.\n' +
		'- **`autonomous`** — Only "fix-up" auto-approves. **Expansion still\n' +
		"  prompts the user under autonomous** — the difference from `balanced`\n" +
		"  is only that the prompt is accompanied by a WebSocket notification so\n" +
		"  an autonomous-mode operator sees it without watching the dashboard.\n" +
		"  Restructure prompts. (The spec is explicit: every policy prompts on\n" +
		"  expansion. Do not assume autonomous lets you skip user approval for\n" +
		"  new branches.)\n\n" +
		"**Critical rule — `criteria-drop` is always rejected.** A mutation that\n" +
		"would leave one of the root goal's acceptance criteria uncovered\n" +
		'returns 409 with `classification: "criteria-drop"` regardless of policy.\n' +
		"Do not retry the same mutation; either restructure your proposal so the\n" +
		"dropped criterion is covered by a remaining or new subgoal, or stop and\n" +
		"surface the conflict to the user — the criterion may need to be\n" +
		"explicitly amended on the root goal first.\n\n" +
		"**`replanCount` cap.** After 5 post-freeze mutations the goal\n" +
		"auto-pauses. If you hit this cap, stop proposing changes and ask the\n" +
		"user to pause / amend the root spec / un-pause.\n\n" +
		"**The plan is in service of the spec.** Never drop or contradict an\n" +
		"acceptance criterion to make a mutation classifiable as fix-up.\n\n" +
		"**Restate acceptance criteria verbatim in at least one subgoal spec — paraphrasing risks losing adherence-check coverage.** When you draft\n" +
		"a subgoal's `spec` field, **copy the exact wording** of every root-goal\n" +
		"acceptance criterion that subgoal is responsible for — at least once, in\n" +
		"the spec body. The adherence checker (see the `criteria-drop` rule\n" +
		"above) does whitespace-normalised, case-insensitive **substring matching**\n" +
		"against the union of the root spec and the remaining subgoal specs, not\n" +
		"semantic similarity. A paraphrase that drops or rewords a key noun\n" +
		"phrase from the criterion can register as `criteria-drop` even when the\n" +
		"work plainly covers it. The cheapest way to stay on the safe side is\n" +
		"to quote the criterion verbatim somewhere in the spec — even just under\n" +
		"a `## Covers` heading."
	);
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
	//    + nested-goal stanzas per design doc §14.1.4 splice order:
	//      a. child stanza (before spec, so context is read first)
	//      b. spec
	//      c. top-level decomposition stanza (after spec, so heuristic has
	//         the spec to reason about)
	//      d. mid-goal stanza (every team-lead, regardless of nesting status)
	{
		let effectiveGoalSpec = parts.goalSpec || "";
		if (parts.rolePrompt?.trim()) {
			effectiveGoalSpec = (effectiveGoalSpec ? effectiveGoalSpec + "\n\n---\n\n" : "") + parts.rolePrompt.trim();
		}

		// 3a. Child stanza appears BEFORE the spec.
		if (parts.parentGoal) {
			sections.push(buildChildTeamLeadStanza(parts.parentGoal));
		}

		if (effectiveGoalSpec.trim()) {
			const header = parts.goalTitle
				? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
				: "# Goal";
			sections.push(header + "\n\n" + effectiveGoalSpec.trim());
		}

		// 3b. Top-level decomposition stanza appears AFTER the spec.
		if (parts.isTeamLead && parts.isTopLevelTeamLead) {
			sections.push(buildTopLevelTeamLeadStanza({
				maxConcurrentChildren: parts.maxConcurrentChildren ?? 3,
				divergencePolicy: parts.divergencePolicy ?? "strict",
				goalWorkflowId: parts.goalWorkflowId,
			}));
		}

		// 3c. Mid-goal stanza appears for every team-lead.
		if (parts.isTeamLead) {
			sections.push(buildMidGoalNestingStanza({
				divergencePolicy: parts.divergencePolicy ?? "strict",
			}));
		}
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
