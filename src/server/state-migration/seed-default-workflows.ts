/**
 * Canonical inline-workflow definitions for the four built-in workflow IDs:
 * `general`, `feature`, `bug-fix`, `quick-fix`.
 *
 * Used by the project.yaml migration (`migrate-project-yaml.ts`) to seed
 * workflows for legacy projects that previously relied on the now-deleted
 * `defaults/workflows/*.yaml` builtin fallbacks (Follow-up A).
 *
 * Structural step refs use `{ component, command }` — the component name is
 * caller-supplied (defaults to the project name per the multi-repo migration
 * convention; see docs/design/multi-repo-components.md §1.3).
 *
 * Mirrors the canonical shape produced by `scripts/migrate-dev-project-workflows.mjs`
 * (which is now obsolete now that `defaults/workflows/*.yaml` is gone).
 */

/**
 * Subgoal verify-step parameters — mirror of
 * `workflow-store.ts::SubgoalStepParams`. Re-declared here (rather than
 * imported) so this file remains free of agent-runtime imports, matching
 * the pattern of the other seeded shapes.
 */
export interface SeededSubgoalStepParams {
	title: string;
	spec: string;
	workflowId?: string;
	/** Free-form workflow definition; structurally a Workflow but kept as `unknown` here. */
	inlineWorkflow?: unknown;
	suggestedRole?: string;
	enabledOptionalSteps?: string[];
	planId: string;
	phase?: number;
}

export interface SeededVerifyStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa" | "subgoal";
	component?: string;
	command?: string;
	run?: string;
	role?: string;
	prompt?: string;
	phase?: number;
	timeout?: number;
	expect?: "success" | "failure";
	optional?: boolean;
	label?: string;
	description?: string;
	/**
	 * Subgoal step parameters when `type === "subgoal"` (nested goals,
	 * see docs/design/nested-goals.md §2.1 / §6).
	 */
	subgoal?: SeededSubgoalStepParams;
	[key: string]: unknown;
}

export interface SeededGate {
	id: string;
	name: string;
	/**
	 * Self-documenting gate-level prose (nested goals —
	 * docs/design/nested-goals.md §14.4). Surfaced in the dashboard's
	 * gate-detail panel so a reader understands the orchestration intent
	 * without external docs.
	 */
	description?: string;
	depends_on?: string[];
	content?: boolean;
	inject_downstream?: boolean;
	/** Manual gate — no LLM verify steps, signalled by the user. */
	manual?: boolean;
	metadata?: Record<string, string>;
	verify?: SeededVerifyStep[];
}

export interface SeededWorkflow {
	id: string;
	name: string;
	description?: string;
	gates: SeededGate[];
}

/** Ralph-loop description applied to canonical implementation gates. */
export const RALPH_LOOP_DESCRIPTION = "Ralph loop: implement the design, then run the verification suite. Failures circle the agent back to fix-and-retry until the gate passes.";

/** Standard "Ready to Merge" verification gate — identical across all four flows. */
export function readyToMergeGate(): SeededGate {
	return {
		id: "ready-to-merge",
		name: "Ready to Merge",
		depends_on: ["documentation"],
		verify: [
			{ name: "Branch pushed to remote", type: "command", run: "git push origin {{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." },
			{ name: "Master merged into branch", type: "command", run: "git fetch origin {{master}} && git merge-base --is-ancestor origin/{{master}} {{branch}}" },
			{ name: "PR raised", type: "command", run: "gh pr list --head {{branch}} --base {{master}} --state open --json url -q \".[0].url\" | grep -q ." },
		],
	};
}

export const DOC_PROMPT = `Review documentation for the changes on branch {{branch}} vs origin/{{master}}.

Run \`git diff origin/{{master}}...{{branch}} -- . ':!package-lock.json'\` to see all changes.
Read the key documentation files: AGENTS.md, README.md, and files in docs/.

The goal spec is:
{{goal_spec}}

**Check 1 — Every feature is documented:**
- Every new user-facing feature, API endpoint, config option, or behavioral change introduced in this branch must be documented somewhere.
- If a feature is only described in code comments, that is NOT sufficient — it must appear in a .md file (AGENTS.md, README.md, or a file in docs/).
- List any undocumented features.

**Check 2 — Existing documentation is updated:**
- If the changes modify behavior that is already documented, the documentation must be updated to reflect the new behavior.
- Check for stale references: old API signatures, removed config options, renamed files, changed defaults, altered workflows.
- List any stale documentation that was not updated.

Summarize with PASS/FAIL for each check and specific items to address.`;

export const DESIGN_REVIEW_PROMPT = `Review this design document for structure, clarity, and completeness. Verify:
1. Approach is clearly described with rationale
2. File changes are listed with specific descriptions
3. Acceptance criteria are specific and testable
4. Edge cases and error handling are considered
5. **E2E test plan** — the design MUST include a section describing browser-based E2E tests that validate the user journey end-to-end. If no E2E test plan section is present, FAIL this review.`;

export const GAP_ANALYSIS_DESIGN_PROMPT = `Compare the goal specification to this design document.

The goal spec is:
{{goal_spec}}

Identify:
1. Requirements in the goal spec not addressed in the design
2. Acceptance criteria not covered by the proposed changes
3. Edge cases mentioned in the goal but missing from the design
4. Any contradictions between the goal and the design

Use your tools to read the design document content from the signal.`;

export const GAP_ANALYSIS_IMPL_PROMPT = `Compare the goal specification and design document to the actual implementation on this branch.

The goal spec is:
{{goal_spec}}

Run \`git diff origin/{{master}}...{{branch}} -- . ':!package-lock.json'\` to see the implementation diff.
Read the design document content from upstream gates.

Identify:
1. Features described in the goal/design but not implemented
2. Acceptance criteria not met by the code changes
3. Implemented behavior that contradicts the specification`;

export const CODE_REVIEW_PROMPT = `Review the code changes on branch {{branch}} vs origin/{{master}} for quality.

Start with \`git diff --stat origin/{{master}}...{{branch}} -- . ':!package-lock.json'\` to see which files changed.
Then use \`git diff origin/{{master}}...{{branch}} -M -- . ':!package-lock.json'\` (with rename detection) to see actual content changes.
For large diffs, review files individually with \`read\` rather than dumping the entire diff into context.

Check:
1. Correctness — logic errors, off-by-one, race conditions
2. Error handling — missing try/catch, unhandled promise rejections
3. Edge cases — null/undefined, empty arrays, boundary values
4. Code style — consistent naming, no dead code, clear intent
5. Test coverage — are new behaviors tested?`;

export const SECURITY_REVIEW_PROMPT = `Security review of changes on branch {{branch}} vs origin/{{master}}.

Run \`git diff origin/{{master}}...{{branch}} -- . ':!package-lock.json'\` to see changes.

Check:
1. Injection risks — command injection, path traversal, template injection
2. Auth/authz — are new endpoints properly authenticated?
3. Data validation — are inputs validated and sanitized?
4. Secrets handling — no hardcoded secrets, tokens, or credentials
5. Dependency risks — any new dependencies with known vulnerabilities?`;

// ── Parent workflow prompts (nested goals — docs/design/nested-goals.md §6) ──

const CHARTER_PROMPT = `Review the charter for goal {{branch}}.

The goal spec is:
{{goal_spec}}

A charter must:
1. State the user-visible outcome in plain English.
2. List 3-7 acceptance criteria that are independently verifiable.
3. Identify the natural decomposition into 2-8 child goals (subtasks).
4. Flag any acceptance criterion that cannot be assigned to exactly one child.

PASS only when all four checks hold.`;

const PLAN_REVIEW_DAG_PROMPT = `Inspect the proposed plan ({{branch}} execution.verify[]).

Verify:
1. Every node has a non-empty title and spec.
2. The phase numbers form a valid DAG (no cycles by construction — they are
   layer numbers).
3. No two siblings at the same phase share a planId.
4. workflowId values resolve through the cascade (call out unknowns).

PASS only when all four checks hold.`;

const PLAN_REVIEW_COMPLETENESS_PROMPT = `Compare the plan against the
acceptance criteria from the charter.

For each criterion, identify which planned subgoal addresses it. Flag any
criterion left uncovered. PASS when every criterion is covered.`;

/** Build the four canonical workflows targeting `componentName` (typically the project name). */
export function buildDefaultWorkflows(componentName: string): Record<string, SeededWorkflow> {
	const c = componentName;

	const general: SeededWorkflow = {
		id: "general",
		name: "General",
		description: "Lightweight workflow for general-purpose goals.",
		gates: [
			{
				id: "design-doc",
				name: "Design Document",
				content: true,
				inject_downstream: true,
				verify: [
					{ name: "Design review", type: "llm-review", role: "architect", prompt: DESIGN_REVIEW_PROMPT },
					{ name: "Gap analysis", type: "llm-review", role: "spec-auditor", prompt: GAP_ANALYSIS_DESIGN_PROMPT },
				],
			},
			{
				id: "implementation",
				name: "Implementation",
				description: RALPH_LOOP_DESCRIPTION,
				depends_on: ["design-doc"],
				verify: [
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600 },
					{ name: "Type check passes", type: "command", phase: 1, component: c, command: "check" },
					{ name: "Unit tests", type: "command", phase: 1, timeout: 900, component: c, command: "unit" },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Gap analysis", type: "llm-review", role: "spec-auditor", phase: 2, prompt: GAP_ANALYSIS_IMPL_PROMPT },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
				],
			},
			{
				id: "documentation",
				name: "Documentation",
				depends_on: ["implementation"],
				verify: [
					{ name: "Documentation coverage", type: "llm-review", prompt: DOC_PROMPT },
				],
			},
			readyToMergeGate(),
		],
	};

	const feature: SeededWorkflow = {
		id: "feature",
		name: "Feature",
		description: "Implement a new feature with design, implementation, and review.",
		gates: [
			{
				id: "design-doc",
				name: "Design Document",
				content: true,
				inject_downstream: true,
				verify: [
					{ name: "Design review", type: "llm-review", role: "architect", prompt: DESIGN_REVIEW_PROMPT },
					{ name: "Gap analysis", type: "llm-review", role: "spec-auditor", prompt: GAP_ANALYSIS_DESIGN_PROMPT },
				],
			},
			{
				id: "implementation",
				name: "Implementation",
				description: RALPH_LOOP_DESCRIPTION,
				depends_on: ["design-doc"],
				verify: [
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600 },
					{ name: "Type check passes", type: "command", phase: 1, component: c, command: "check" },
					{ name: "Unit tests", type: "command", phase: 1, timeout: 900, component: c, command: "unit" },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Gap analysis", type: "llm-review", role: "spec-auditor", phase: 2, prompt: GAP_ANALYSIS_IMPL_PROMPT },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
					{ name: "Security review", type: "llm-review", role: "security-reviewer", phase: 2, prompt: SECURITY_REVIEW_PROMPT },
					{
						name: "QA testing",
						type: "agent-qa",
						role: "qa-tester",
						component: c,
						phase: 3,
						optional: true,
						label: "Enable QA Testing",
						description: "Spawn a QA agent that builds, starts the server, and drives a real browser through scenarios.",
						prompt: "Stand up the ephemeral testbed (component config.qa_start_command), plan 3-5 scenarios, drive the browser, submit `verification_result`.",
					},
				],
			},
			{
				id: "documentation",
				name: "Documentation",
				depends_on: ["implementation"],
				verify: [
					{ name: "Documentation coverage", type: "llm-review", prompt: DOC_PROMPT },
				],
			},
			readyToMergeGate(),
		],
	};

	const bugFix: SeededWorkflow = {
		id: "bug-fix",
		name: "Bug Fix",
		description: "Fix a reported bug with TDD verification.",
		gates: [
			{
				id: "issue-analysis",
				name: "Issue Analysis",
				content: true,
				inject_downstream: true,
				verify: [
					{
						name: "Analysis quality",
						type: "llm-review",
						prompt: `Review the issue analysis for completeness. Check:
1. Reproduction steps are specific enough to follow mechanically
2. Root cause references actual source files and lines
3. Analysis distinguishes symptoms from underlying cause
4. **Test plan** — the analysis must describe what test will verify the fix.`,
					},
					{ name: "Gap analysis", type: "llm-review", role: "spec-auditor", prompt: GAP_ANALYSIS_DESIGN_PROMPT },
				],
			},
			{
				id: "reproducing-test",
				name: "Reproducing Test",
				depends_on: ["issue-analysis"],
				metadata: { test_command: "string", error_pattern: "string" },
				verify: [
					{ name: "Test fails (bug exists)", type: "command", run: "{{agent.test_command}}", expect: "failure" },
				],
			},
			{
				id: "implementation",
				name: "Implementation",
				description: RALPH_LOOP_DESCRIPTION,
				depends_on: ["reproducing-test"],
				verify: [
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600 },
					{ name: "Type check", type: "command", phase: 1, component: c, command: "check" },
					{ name: "Repro test passes (bug fixed)", type: "command", phase: 1, run: "{{reproducing-test.meta.test_command}}", expect: "success" },
					{ name: "Unit tests", type: "command", phase: 1, timeout: 900, component: c, command: "unit" },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
					{ name: "Security review", type: "llm-review", role: "security-reviewer", phase: 2, prompt: SECURITY_REVIEW_PROMPT },
				],
			},
			{
				id: "documentation",
				name: "Documentation",
				depends_on: ["implementation"],
				verify: [
					{ name: "Documentation coverage", type: "llm-review", prompt: DOC_PROMPT },
				],
			},
			readyToMergeGate(),
		],
	};

	const quickFix: SeededWorkflow = {
		id: "quick-fix",
		name: "Quick Fix",
		description: "Fast workflow for small changes — skip design, go straight to implementation and merge.",
		gates: [
			{
				id: "implementation",
				name: "Implementation",
				description: "Ralph loop (minimal): build, test, review.",
				verify: [
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600 },
					{ name: "Type check passes", type: "command", phase: 1, component: c, command: "check" },
					{ name: "Unit tests", type: "command", phase: 1, timeout: 900, component: c, command: "unit" },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
				],
			},
			// quick-fix has no documentation gate — wire ready-to-merge directly off implementation.
			{
				id: "ready-to-merge",
				name: "Ready to Merge",
				depends_on: ["implementation"],
				verify: readyToMergeGate().verify,
			},
		],
	};

	// ── parent workflow (nested goals — docs/design/nested-goals.md §6 + §14.4) ──
	//
	// Orchestrates a goal that decomposes into child subgoals. The
	// `goal-plan` gate is manual (human-only signal) and triggers a
	// server-side freeze hook that stamps `metadata.frozen="true"` onto the
	// goal's snapshotted `execution` gate. Subsequent plan mutations are
	// then subject to the goal's divergence policy and the plan-mutation
	// classifier.
	//
	// `execution.verify[]` starts EMPTY — it's populated by the team-lead
	// via `goal_plan_propose` calls before the user signals `goal-plan`.
	const parentRtm = readyToMergeGate();
	const parent: SeededWorkflow = {
		id: "parent",
		name: "Parent Goal",
		description: [
			"Orchestrates a goal that decomposes into child subgoals. The team-lead",
			"drafts a charter (user-visible outcome + acceptance criteria), proposes",
			"a DAG of child goals at \"plan-review\", and waits for the user to",
			"approve the plan via the `goal-plan` gate. Once approved, the execution",
			"gate's verify[] freezes; the verification harness then spawns the planned",
			"children in parallel up to maxConcurrentChildren, each branching off this",
			"goal's branch and merging back when their own `ready-to-merge` gate passes.",
			"The parent's `ready-to-merge` raises the single PR to master once all",
			"children have merged.",
		].join(" "),
		gates: [
			{
				id: "charter",
				name: "Charter",
				content: true,
				inject_downstream: true,
				description: "Define the user-visible outcome in plain English, list 3-7 acceptance criteria that are independently verifiable, and identify the natural decomposition into child goals. The plan-review gate will read this charter as upstream context — be explicit about scope so the reviewer can flag missing coverage.",
				verify: [
					{ name: "Charter review", type: "llm-review", role: "architect", prompt: CHARTER_PROMPT },
				],
			},
			{
				id: "plan-review",
				name: "Plan Review",
				depends_on: ["charter"],
				content: true,
				inject_downstream: true,
				description: "Submit the proposed plan as a list of `subgoal` verify steps on the execution gate (call `goal_plan_propose`). LLM reviewers check: every node has a non-empty title and spec; phase numbers form a valid layered DAG; every charter acceptance criterion is assigned to at least one child; workflow ids resolve. The review is advisory — the user's `goal-plan` signal is the authoritative approval.",
				verify: [
					{ name: "DAG correctness", type: "llm-review", role: "architect", prompt: PLAN_REVIEW_DAG_PROMPT },
					{ name: "Spec completeness", type: "llm-review", role: "spec-auditor", phase: 1, prompt: PLAN_REVIEW_COMPLETENESS_PROMPT },
				],
			},
			{
				id: "goal-plan",
				name: "Plan Approval",
				depends_on: ["plan-review"],
				manual: true,
				description: "Manual gate. Signalling this gate freezes the execution gate's verify[] — post-freeze plan mutations are subject to the goal's divergence policy and the plan-mutation classifier. The user signals this gate from the dashboard's Plan tab once they're satisfied with the proposed DAG.",
			},
			{
				id: "execution",
				name: "Execution",
				depends_on: ["goal-plan"],
				description: "The plan runs here. Each `subgoal` verify step spawns a child goal at the appropriate phase, branched off this goal's branch. Phase parallelism is bounded by `maxConcurrentChildren`. A child step passes when its `ready-to-merge` gate passes AND the local merge into this goal's branch succeeds without conflict. Merge conflicts surface back to the team-lead, who escalates to the user.",
				// verify[] is empty at creation; populated by `goal_plan_propose`
				// calls and frozen once goal-plan is signalled. Each entry is a
				// `subgoal` step. Multiple entries with the same `phase` run in
				// parallel, bounded by goal.maxConcurrentChildren.
				verify: [],
			},
			{
				id: "integration",
				name: "Integration",
				depends_on: ["execution"],
				description: "Run typecheck/build/tests on this goal's branch after all children have merged. Catches integration issues that per-child verification couldn't see.",
				verify: [
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600 },
					{ name: "Type check", type: "command", phase: 1, component: c, command: "check" },
					{ name: "Unit tests", type: "command", phase: 1, component: c, command: "unit" },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
				],
			},
			// readyToMergeGate() helper hardcodes depends_on: ["documentation"];
			// parent has no documentation gate — patch dependencies + description.
			{
				...parentRtm,
				depends_on: ["integration"],
				description: "Top-level goals raise a PR to master from this branch. Child goals (mergeTarget == 'parent') short-circuit this gate — the parent's harness performs the local merge instead. Either way, this gate signals the goal is done.",
			},
		],
	};

	return {
		general,
		feature,
		"bug-fix": bugFix,
		"quick-fix": quickFix,
		parent,
	};
}
