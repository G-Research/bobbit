import { applyPromptConditionals } from "./prompt-conditionals.js";
import type { NestingContext } from "./system-prompt.js";

/**
 * Declarative table of goal-nesting prompt stanzas for the team-lead system
 * prompt (see docs/nested-goals.md). Extracted from the previous
 * `buildNestingContextSection` imperative if/else chain
 * (EXTENSION-SEAM-AUDIT.md S6): stanza selection is now DATA — an `applies`
 * predicate per row — rather than nested code branches, so a new stanza
 * variant is added as a new table row, not a new `if`.
 *
 * Content uses the same `{{PLACEHOLDER}}` / `{if:NAME}…{endif:NAME}`
 * template syntax already used by role `promptTemplate`s (see
 * `role-prompt.ts`, `prompt-conditionals.ts`) so this stays consistent with
 * the rest of the codebase's declarative-prompt surface rather than
 * inventing a second templating scheme.
 *
 * CRITICAL — this is a PRODUCT PROMPT SURFACE: any edit to a `template`
 * string below changes what ships to the model. The byte-parity pin for
 * this table's assembly lives in
 * tests/goal-nesting-stanzas-snapshot.test.ts (fixture:
 * tests/fixtures/goal-nesting-stanzas.snapshot.json). If you intentionally
 * change stanza copy, regenerate that fixture — never hand-edit it to make
 * a failure go away.
 */
interface NestingStanzaSpec {
	/** Stable id for authoring clarity — not rendered into the prompt. */
	id: "root-orchestration" | "child-position" | "decision-table";
	/** Whether this stanza applies for a given team-lead nesting context. */
	applies: (ctx: NestingContext) => boolean;
	/** `{{PLACEHOLDER}}` substitutions computed for this stanza's template. */
	vars?: (ctx: NestingContext) => Record<string, string>;
	/** `{if:NAME}` flags evaluated for this stanza's template. */
	flags?: (ctx: NestingContext) => Record<string, boolean>;
	template: string;
}

const ROOT_ORCHESTRATION_TEMPLATE =
	"## Goal nesting context (TOP-LEVEL ROOT)\n\n" +
	"You are the team lead of a TOP-LEVEL (root) goal. This is the only goal in the tree that opens a pull request to `master`.\n\n" +
	"**Your special responsibilities:**\n" +
	"- After ready-to-merge passes, raise the PR via `gh pr create` (or, if `gh` is not installed in this environment, tell the user to create the PR manually). Child goals MUST NOT raise PRs.\n" +
	"- Decide whether to decompose this work into nested sub-goals: see \"When to use subgoal vs team_spawn vs task_create\" below.\n" +
	"- The root's `maxConcurrentChildren` (default 5, max 8) caps parallelism for the WHOLE tree — your tool `goal_set_policy` adjusts it.\n" +
	"- The root's `divergencePolicy` (strict / balanced / autonomous) controls how mid-flight plan mutations are classified — see plan-mutation classifier docs.";

const CHILD_POSITION_TEMPLATE =
	"## Goal nesting context (CHILD GOAL)\n\n" +
	"You are the team lead of a CHILD goal. Parent: `{{PARENT_TITLE}}` (id: `{{PARENT_ID}}`). Root: `{{ROOT_TITLE}}` (id: `{{ROOT_ID}}`).\n\n" +
	"**Your scope is STRICTLY your own `# Goal` spec above — nothing else.**\n\n" +
	"If your spec quotes, references, or describes your parent's broader mission, the other sibling goals, the parent's acceptance criteria, or the overall plan — that context is background only. **Do not act on it.** Your parent's team-lead is responsible for the parent's mission; siblings are handled by their own team-leads. If you find yourself about to spawn a child to cover work that reads like a sibling's responsibility, STOP — that is the parent's job.\n\n" +
	"**Critical constraints:**\n" +
	"- Your branch (`{{GOAL_BRANCH}}`) merges INTO the parent's branch (`{{PARENT_BRANCH}}`) LOCALLY when ready-to-merge passes. The parent's team-lead handles that merge automatically — you do not call `git merge` yourself.\n" +
	"- **DO NOT raise a PR.** Only the root team-lead raises a PR (to `master`). If you call `gh pr create`, you create work the root must clean up.\n" +
	"- **DO NOT spawn sibling goals.** Your siblings already exist (or will be spawned by your parent). If you need work that sounds like a sibling, surface it to your parent via `ready-to-merge` feedback rather than spawning it yourself.\n" +
	"- Your worktree was created off `{{PARENT_BRANCH}}` HEAD at spawn time. Sibling goals spawned later see your committed work after the parent's merge.\n" +
	"- If a sibling completed before you started, you should already see their commits via the parent's branch tip.{if:subGoalsEnabled}\n- You MAY decompose YOUR own work into deeper nested sub-goals (not siblings) via `goal_spawn_child` if the work is large enough to warrant its own team-lead. Rule of thumb: sub-goals are for decomposition WITHIN your spec, not expansion BEYOND your spec.{endif:subGoalsEnabled}";

const DECISION_TABLE_TEMPLATE =
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
	"**Note: repeated plan changes (>5) on a parent-workflow goal trigger auto-pause for human review.** The freeze classifier (see plan-mutation docs) tracks `replanCount` per goal — if you keep restructuring the frozen plan, the system will pause the goal and surface a mutation-approval card to the user. Plan once, plan well; don't churn.";

/**
 * The stanza table, in render order.
 *
 * - `root-orchestration` (Stanza A): only when this goal has no parent AND
 *   the Subgoals feature is on — a tool-dependent stanza, so it's omitted
 *   entirely (not just trimmed) when subgoals are off.
 * - `child-position` (Stanza B): whenever this goal has a parent, regardless
 *   of the feature flag — a child's position guardrails (don't raise a PR,
 *   branch merges into parent) must always show, since a child can outlive
 *   the flag being turned off. Only the trailing "deeper nesting" bullet is
 *   flag-gated via `{if:subGoalsEnabled}`.
 * - `decision-table` (Stanza C): whenever the feature flag is on, regardless
 *   of root/child position.
 */
export const NESTING_STANZAS: readonly NestingStanzaSpec[] = [
	{
		id: "root-orchestration",
		applies: (ctx) => !ctx.parent && !!ctx.subGoalsEnabled,
		template: ROOT_ORCHESTRATION_TEMPLATE,
	},
	{
		id: "child-position",
		applies: (ctx) => !!ctx.parent,
		vars: (ctx) => {
			const parentTitle = ctx.parent!.title || ctx.parent!.id;
			const parentId = ctx.parent!.id;
			const rootTitle = ctx.root?.title || ctx.root?.id || parentTitle;
			const rootId = ctx.root?.id || parentId;
			const parentBranch = ctx.parent!.branch || `parent's branch`;
			const goalBranch = ctx.goalBranch || `your branch`;
			return {
				PARENT_TITLE: parentTitle,
				PARENT_ID: parentId,
				ROOT_TITLE: rootTitle,
				ROOT_ID: rootId,
				PARENT_BRANCH: parentBranch,
				GOAL_BRANCH: goalBranch,
			};
		},
		flags: (ctx) => ({ subGoalsEnabled: !!ctx.subGoalsEnabled }),
		template: CHILD_POSITION_TEMPLATE,
	},
	{
		id: "decision-table",
		applies: (ctx) => !!ctx.subGoalsEnabled,
		template: DECISION_TABLE_TEMPLATE,
	},
];

/** Substitute every `{{KEY}}` occurrence with its value. Plain split/join
 * (not regex-replace) so a value containing regex-special characters (e.g.
 * `$&`) can never corrupt the substitution. */
function substitutePlaceholders(template: string, vars: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(vars)) {
		out = out.split(`{{${key}}}`).join(value);
	}
	return out;
}

function renderStanza(spec: NestingStanzaSpec, ctx: NestingContext): string {
	let out = spec.template;
	const vars = spec.vars?.(ctx);
	if (vars) out = substitutePlaceholders(out, vars);
	const flags = spec.flags?.(ctx);
	if (flags) out = applyPromptConditionals(out, flags);
	return out;
}

/**
 * Build the nesting-awareness section for the team-lead system prompt.
 * Returns undefined when `ctx` is not a team goal, or when no stanza in the
 * table applies (e.g. a root goal with subgoals off contributes nothing) —
 * caller can skip.
 *
 * See docs/nested-goals.md and `NestingContext`'s doc comment
 * (system-prompt.ts) for stanza semantics. Byte-parity with the pre-table
 * implementation is pinned by tests/goal-nesting-stanzas-snapshot.test.ts.
 */
export function buildNestingContextSection(ctx: NestingContext): string | undefined {
	if (!ctx.team) return undefined;
	const parts = NESTING_STANZAS.filter((s) => s.applies(ctx)).map((s) => renderStanza(s, ctx));
	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
}
