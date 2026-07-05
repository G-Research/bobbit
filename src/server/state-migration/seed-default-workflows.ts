/**
 * Canonical inline-workflow definitions for the built-in workflow IDs:
 * `general`, `feature`, `bug-fix`, `quick-fix`, `solo-fast`.
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
	/** See `VerifyStep.cacheInputGlobs` in `workflow-store.ts` — VER-01 content-keyed gate cache. */
	cacheInputGlobs?: string[];
	/** See `VerifyStep.docGate` in `workflow-store.ts` — VER-06 doc-gate diff filter marker. */
	docGate?: boolean;
	subgoal?: {
		planId: string;
		title: string;
		spec: string;
		workflowId?: string;
		suggestedRole?: string;
	};
	[key: string]: unknown;
}

export interface SeededGate {
	id: string;
	name: string;
	description?: string;
	depends_on?: string[];
	content?: boolean;
	inject_downstream?: boolean;
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

/**
 * F4/VER-01 default-workflow activation (docs/design/gate-step-cache.md).
 *
 * This template seeds workflows for *arbitrary* managed projects (any
 * language/layout — `Component.commands` are opaque shell strings), so it
 * cannot assume a source-tree convention like this repo's own dogfooded
 * `.bobbit/config/project.yaml` does (`src/**`, `tsconfig*.json`, etc. —
 * see `tests/gate-cache-globs-adoption.test.ts`). Declaring those
 * Bobbit-specific globs here would be UNDER-broad for any other project's
 * layout — a change to that project's real source (e.g. `main.py`,
 * `pkg/foo.go`) would silently miss the glob and let `BOBBIT_GATE_CACHE=content`
 * reuse a stale pass, which the design doc calls out as never acceptable.
 *
 * `["**"]` is the one glob that's sound for every layout: paths reported by
 * `gitListTrackedPaths`/`gitDiffIsClean` (verification-harness.ts) are
 * already scoped to the step's resolved `cwd` (`componentRoot()` —
 * `<repo>/<relativePath>` for that component, collapsing to the whole repo
 * for single-repo/single-component projects). `["**"]` matches every
 * tracked path under that cwd, so a step is only reused when literally
 * nothing in its own component changed — an unconditionally sufficient
 * (maximally conservative, never under-broad) precondition regardless of
 * what language or file layout the component uses. It's a no-op for
 * single-component projects (their cwd is the whole repo, and a Ralph-loop
 * iteration always changes something), but a real win for multi-component
 * projects (`buildAllComponentsWorkflow` / `docs/design/multi-repo-components.md`):
 * a fix scoped to one component no longer busts a sibling component's
 * cached Build/Type check/Unit tests results.
 */
export const COMPONENT_SCOPED_CACHE_GLOBS = ["**"];

/** Standard "Ready to Merge" verification gate — identical across all four flows. */
export function readyToMergeGate(): SeededGate {
	return {
		id: "ready-to-merge",
		name: "Ready to Merge",
		depends_on: ["documentation"],
		verify: [
			{ name: "Branch pushed to remote", type: "command", run: "git push origin {{branch}}:refs/heads/{{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." },
			{ name: "Base ref merged into branch", type: "command", run: "git fetch origin {{baseBranch}} && git merge-base --is-ancestor origin/{{baseBranch}} {{branch}}" },
			{ name: "PR raised", type: "command", run: "gh pr list --head {{branch}} --base {{baseBranch}} --state open --json url -q \".[0].url\" | grep -q ." },
		],
	};
}

export const DOC_PROMPT = `Review documentation for the changes on branch {{branch}} vs origin/{{baseBranch}}.

Run \`git diff origin/{{baseBranch}}...{{branch}} -- . ':!package-lock.json'\` to see all changes.
Read the key documentation files: AGENTS.md, README.md, and files in docs/.

The goal spec is:
{{goal_spec}}

**Documentation location rules:**
- Detailed feature behavior, architecture explanations, workflows, and durable reference material should usually live in \`docs/*.md\`.
- \`README.md\` should cover entrypoints, setup, and concise high-level project orientation.
- \`AGENTS.md\` should only change when agent-operational guidance changed: repo navigation, architecture launchpad notes, common task recipes, debugging index entries, verification flow, or other instructions an agent needs in many sessions.
- Do NOT require an \`AGENTS.md\` update for routine product or feature documentation when \`docs/\` or \`README.md\` is the better home.

**Check 1 — Every feature is documented:**
- Every new user-facing feature, API endpoint, config option, or behavioral change introduced in this branch must be documented somewhere.
- If a feature is only described in code comments, that is NOT sufficient — it must appear in a .md file.
- List any undocumented features.
- Also flag documentation placed in the wrong home when that placement creates pressure to grow \`AGENTS.md\` unnecessarily.

**Check 2 — Existing documentation is updated:**
- If the changes modify behavior that is already documented, the documentation must be updated to reflect the new behavior.
- Check for stale references: old API signatures, removed config options, renamed files, changed defaults, altered workflows.
- List any stale documentation that was not updated.

**Check 3 — Documentation placement is appropriate:**
- Prefer \`docs/\` for detailed explanations.
- Prefer \`README.md\` for top-level orientation.
- Only require \`AGENTS.md\` changes for agent-facing operational guidance.
- Flag branches that add routine feature detail to \`AGENTS.md\` instead of the better destination.

**Check 4 — AGENTS.md edit discipline (only if this branch modifies AGENTS.md):**
AGENTS.md is loaded into every agent turn — its size is a direct per-turn token cost on every session. FAIL this check if the diff:
- Adds a Recipe or Debugging entry that spans more than one line. Multi-sentence prose, inlined schemas, code blocks, and step-by-step walkthroughs all belong in \`docs/\`, not AGENTS.md.
- Adds a new entry where extending or replacing an existing entry on the same topic would have worked (net adds drive bloat).
- Adds both a Recipe and a Debugging entry for the same fix (pick one).
- Adds a categorical subsection past ~12 entries without splitting it.
If the diff fixes any of the above (e.g. it shortens long entries, dedupes recipe↔debug pairs, splits a large subsection), say so and PASS.

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

Run \`git diff origin/{{baseBranch}}...{{branch}} -- . ':!package-lock.json'\` to see the implementation diff.
Read the design document content from upstream gates.

Identify:
1. Features described in the goal/design but not implemented
2. Acceptance criteria not met by the code changes
3. Implemented behavior that contradicts the specification

IMPORTANT: Ignore documentation gaps. This gap analysis runs during the implementation phase, BEFORE the documentation gate. Do NOT flag missing or outdated documentation, README updates, design-doc updates, code comments, or other docs-only artifacts as gaps — those are addressed by the dedicated documentation gate later in the workflow. Focus exclusively on code/behavior gaps relative to the spec and design.`;

export const CODE_REVIEW_PROMPT = `Review the code changes on branch {{branch}} vs origin/{{baseBranch}} for quality.

Start with \`git diff --stat origin/{{baseBranch}}...{{branch}} -- . ':!package-lock.json'\` to see which files changed.
Then use \`git diff origin/{{baseBranch}}...{{branch}} -M -- . ':!package-lock.json'\` (with rename detection) to see actual content changes.
For large diffs, review files individually with \`read\` rather than dumping the entire diff into context.

Check:
1. Correctness — logic errors, off-by-one, race conditions
2. Error handling — missing try/catch, unhandled promise rejections
3. Edge cases — null/undefined, empty arrays, boundary values
4. Code style — consistent naming, no dead code, clear intent
5. Test coverage — are new behaviors tested?`;

export const BUG_HUNT_PROMPT = `Review the implementation on branch {{branch}} vs origin/{{baseBranch}} for actionable bugs.

Focus on correctness, edge cases, error paths, cross-system interactions, concurrency/lifecycle, and dangerous behavior. Fail only for critical/high actionable bugs.

For every finding, include file:line, reproduction conditions, consequence, and why it is a bug.`;

/**
 * `solo-fast` workflow's single consolidated review — merges the code-quality
 * and bug-hunt lenses (normally two separate reviewer sessions, see
 * CODE_REVIEW_PROMPT / BUG_HUNT_PROMPT above) into one pass, for low-risk
 * changes where a single competent reviewer is enough. See VER-05/W3.3.
 */
export const SOLO_FAST_REVIEW_PROMPT = `Review the code changes on branch {{branch}} vs origin/{{baseBranch}}. This is the ONLY review this change gets before merge — cover both quality and correctness in one pass.

Start with \`git diff --stat origin/{{baseBranch}}...{{branch}} -- . ':!package-lock.json'\` to see which files changed.
Then use \`git diff origin/{{baseBranch}}...{{branch}} -M -- . ':!package-lock.json'\` (with rename detection) to see actual content changes.
For large diffs, review files individually with \`read\` rather than dumping the entire diff into context.

Check:
1. Correctness — logic errors, off-by-one, race conditions, edge cases (null/undefined, empty arrays, boundary values)
2. Actionable bugs — error paths, cross-system interactions, concurrency/lifecycle, dangerous behavior. Fail only for critical/high actionable bugs.
3. Error handling — missing try/catch, unhandled promise rejections
4. Code style — consistent naming, no dead code, clear intent
5. Test coverage — are new behaviors tested?

For every bug finding, include file:line, reproduction conditions, consequence, and why it is a bug.`;

export const SECURITY_REVIEW_PROMPT = `Security review of changes on branch {{branch}} vs origin/{{baseBranch}}.

Run \`git diff origin/{{baseBranch}}...{{branch}} -- . ':!package-lock.json'\` to see changes.

Check:
1. Injection risks — command injection, path traversal, template injection
2. Auth/authz — are new endpoints properly authenticated?
3. Data validation — are inputs validated and sanitized?
4. Secrets handling — no hardcoded secrets, tokens, or credentials
5. Dependency risks — any new dependencies with known vulnerabilities?`;

// ── Phase 3 nested goals — `parent` meta-workflow prompts ──────────────
//
// The team-lead system prompt does the heavy lifting; these gate-level
// reviews are intentionally concise (3-6 sentences each).

/** Charter LLM-review prompt — does the goal have a clear, well-bounded charter? */
export const CHARTER_REVIEW_PROMPT = `Review the goal charter for clarity and scope.

Verify:
1. The problem statement is concrete (not "improve X" — what specifically must change?).
2. Acceptance criteria are listed (a "## Acceptance criteria" section is the convention) and each criterion is independently testable.
3. The scope boundary is explicit — what is in vs out of this goal.

Pass if the charter is good enough to plan against. Fail with concrete missing pieces if not.`;

/** Plan structural sanity prompt — does the proposed plan make architectural sense? */
export const PLAN_STRUCTURAL_PROMPT = `Review the structural sanity of the proposed plan.

Verify:
1. Subgoals decompose the parent into independently mergeable units (each merges into the parent's branch on its own).
2. Phase ordering / dependencies are sensible — work that depends on other work is in a later phase.
3. No subgoal duplicates another's scope or contradicts the parent charter.
4. Each subgoal has a clear title, spec, and (if relevant) suggested role.

Pass if the plan is coherent. Fail with concrete restructuring suggestions if not.`;

/** Acceptance-criteria coverage prompt — does the plan cover every criterion? */
export const CRITERIA_COVERAGE_PROMPT = `Verify the proposed plan covers every acceptance criterion in the parent goal's spec.

The criteria-coverage check is a whitespace-normalised, case-insensitive substring match against the union of {parent spec, subgoal step specs}. Hashes do not work — they fail when wording paraphrases. Subgoal specs MUST quote the criteria they cover verbatim (a "## Covers" heading is the convention).

Verify:
1. Every "## Acceptance criteria" bullet from the parent spec appears verbatim somewhere in the plan (parent or any subgoal spec).
2. Each subgoal that targets a criterion makes that link explicit.

Pass if every criterion is verbatim-covered. Fail with the list of uncovered criteria if not.`;

/** Integration LLM-review prompt — once children have merged, does the integrated whole make sense? */
export const INTEGRATION_PROMPT = `Review the cross-component integration after all subgoals have merged.

Run \`git diff origin/{{baseBranch}}...HEAD\` to see the cumulative result on the parent branch.

Verify:
1. Subgoal merges play together — no accidental regressions where one subgoal silently broke another.
2. End-to-end functionality reflects what the parent charter promised (each acceptance criterion now demonstrable on the merged tree).
3. No leftover scaffolding, duplicate definitions, or contradictory configs from the merges.

Pass if the integrated tree is coherent. Fail with concrete issues if not.`;

/**
 * Build the `parent` meta-workflow.
 *
 * Phase 3 of nested goals — see SUBGOALS-SPEC §2 / §5 and
 * docs/_phase-3-notes.md. The execution gate's verify[] starts EMPTY; the
 * team-lead populates it via `goal_plan_propose` with `subgoal`-typed
 * verify-steps (see `SeededVerifyStep.type === "subgoal"`), and the
 * goal-plan signal freezes the array (mutation classifier kicks in for
 * further changes). Each subgoal step's `subgoal` payload (`planId`,
 * `title`, `spec`, optional `workflowId` / `suggestedRole`) is consumed
 * by the verification harness's `runSubgoalStep`, which spawns/resolves
 * a child goal and waits for its `ready-to-merge` to pass.
 *
 * Gate sequence: charter → plan-review → goal-plan → execution → integration → ready-to-merge.
 *
 * Reuses `readyToMergeGate()` so behaviour matches every other workflow.
 */
export function buildParentWorkflow(): SeededWorkflow {
	return {
		id: "parent",
		name: "Parent",
		description: "A meta-workflow whose execution gate spawns and merges child goals (subgoals).",
		gates: [
			{
				id: "charter",
				name: "Charter",
				content: true,
				inject_downstream: true,
				verify: [
					{ name: "Charter review", type: "llm-review", role: "architect", prompt: CHARTER_REVIEW_PROMPT },
				],
			},
			{
				id: "plan-review",
				name: "Plan Review",
				depends_on: ["charter"],
				content: true,
				inject_downstream: true,
				verify: [
					{ name: "Plan structural sanity", type: "llm-review", role: "architect", prompt: PLAN_STRUCTURAL_PROMPT },
					{ name: "Acceptance criteria coverage", type: "llm-review", role: "spec-auditor", prompt: CRITERIA_COVERAGE_PROMPT },
				],
			},
			{
				id: "goal-plan",
				name: "Goal Plan",
				depends_on: ["plan-review"],
				// Manual gate — signaled by the team-lead to FREEZE execution.verify[].
				// content:false because the plan lives on execution.verify[], not as
				// gate content.
				manual: true,
				content: false,
			},
			{
				id: "execution",
				name: "Execution",
				depends_on: ["goal-plan"],
				description: RALPH_LOOP_DESCRIPTION,
				// Populated by the team-lead via propose-and-edit on the parent goal's
				// workflow snapshot. Each step has type: "subgoal" and runs through
				// `runSubgoalStep` in the verification harness.
				verify: [],
			},
			{
				id: "integration",
				name: "Integration",
				depends_on: ["execution"],
				verify: [
					{ name: "Cross-component integration", type: "llm-review", role: "architect", prompt: INTEGRATION_PROMPT },
				],
			},
			{ ...readyToMergeGate(), depends_on: ["integration"] },
		],
	};
}

/** Build the canonical workflows targeting `componentName` (typically the project name). */
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
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600, cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Type check passes", type: "command", phase: 1, component: c, command: "check", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Unit tests", type: "command", phase: 1, component: c, command: "unit", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Gap analysis", type: "llm-review", role: "spec-auditor", phase: 2, prompt: GAP_ANALYSIS_IMPL_PROMPT },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
					{ name: "Bug hunt", type: "llm-review", role: "bug-hunter", phase: 2, prompt: BUG_HUNT_PROMPT },
				],
			},
			{
				id: "documentation",
				name: "Documentation",
				depends_on: ["implementation"],
				verify: [
					{ name: "Documentation coverage", type: "llm-review", docGate: true, prompt: DOC_PROMPT },
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
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600, cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Type check passes", type: "command", phase: 1, component: c, command: "check", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Unit tests", type: "command", phase: 1, component: c, command: "unit", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Gap analysis", type: "llm-review", role: "spec-auditor", phase: 2, prompt: GAP_ANALYSIS_IMPL_PROMPT },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
					{ name: "Bug hunt", type: "llm-review", role: "bug-hunter", phase: 2, prompt: BUG_HUNT_PROMPT },
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
					{ name: "Documentation coverage", type: "llm-review", docGate: true, prompt: DOC_PROMPT },
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
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600, cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Type check", type: "command", phase: 1, component: c, command: "check", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Repro test passes (bug fixed)", type: "command", phase: 1, run: "{{reproducing-test.meta.test_command}}", expect: "success" },
					{ name: "Unit tests", type: "command", phase: 1, component: c, command: "unit", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
					{ name: "Bug hunt", type: "llm-review", role: "bug-hunter", phase: 2, prompt: BUG_HUNT_PROMPT },
					{ name: "Security review", type: "llm-review", role: "security-reviewer", phase: 2, prompt: SECURITY_REVIEW_PROMPT },
				],
			},
			{
				id: "documentation",
				name: "Documentation",
				depends_on: ["implementation"],
				verify: [
					{ name: "Documentation coverage", type: "llm-review", docGate: true, prompt: DOC_PROMPT },
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
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600, cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Type check passes", type: "command", phase: 1, component: c, command: "check", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Unit tests", type: "command", phase: 1, component: c, command: "unit", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "E2E tests", type: "command", phase: 1, timeout: 900, component: c, command: "e2e" },
					{ name: "Code quality review", type: "llm-review", role: "code-reviewer", phase: 2, prompt: CODE_REVIEW_PROMPT },
					{ name: "Bug hunt", type: "llm-review", role: "bug-hunter", phase: 2, prompt: BUG_HUNT_PROMPT },
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

	// VER-05/W3.3 — deterministic, workflow-level fast path (not an LLM risk
	// judgment): opt-in per goal, selected the same way any other workflow is.
	// Deliberately narrower than quick-fix: no e2e (900s) and one consolidated
	// review instead of a 2-reviewer fan-out. Nothing changes for existing
	// workflows/goals unless a goal explicitly picks "solo-fast".
	//
	// Automatic risk-based selection of this path (classifying a diff as
	// low-risk and routing it here without the user asking) is explicitly out
	// of scope. The observe-only evidence-gatherer for that eventual decision
	// landed as CLF-W5 (gate-risk-classifier.ts, `(gate-verify, risk)`) — it
	// proposes a low/medium/high label from changed-file shape, but nothing
	// reads that label back to select a workflow yet. This workflow only
	// makes the fast path *available*; nothing auto-selects it.
	//
	// The "unit" step below still runs the full suite. TEST-01 landed
	// explicit-path filtering (`npm run test:unit -- <paths>`) but there is no
	// automatic diff→affected-files computation yet — CLF-W5 computes path
	// CLASSES (server/ui/tests/docs) for its own risk label, not an
	// affected-file list, so wiring the unit step to auto-derive "affected"
	// files from the branch diff remains a separate, unbuilt piece of that
	// same future diff-risk-model territory, not something this wave's
	// classifier already does.
	const soloFast: SeededWorkflow = {
		id: "solo-fast",
		name: "Solo Fast",
		description: "Deterministic fast path for low-risk, single-agent changes — skip design/docs gates, drop e2e, and replace the reviewer fan-out with one consolidated review. Opt-in: select this workflow explicitly per goal.",
		gates: [
			{
				id: "implementation",
				name: "Implementation",
				description: "Solo-fast Ralph loop (minimal): build, typecheck, unit, one consolidated review.",
				verify: [
					{ name: "Build", type: "command", component: c, command: "build", timeout: 600, cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Type check passes", type: "command", phase: 1, component: c, command: "check", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Unit tests", type: "command", phase: 1, component: c, command: "unit", cacheInputGlobs: COMPONENT_SCOPED_CACHE_GLOBS },
					{ name: "Solo review", type: "llm-review", role: "reviewer", phase: 2, prompt: SOLO_FAST_REVIEW_PROMPT },
				],
			},
			// No documentation gate (mirrors quick-fix) — wire ready-to-merge directly off implementation.
			{
				id: "ready-to-merge",
				name: "Ready to Merge",
				depends_on: ["implementation"],
				verify: readyToMergeGate().verify,
			},
		],
	};

	return {
		general,
		feature,
		"bug-fix": bugFix,
		"quick-fix": quickFix,
		"solo-fast": soloFast,
		parent: buildParentWorkflow(),
	};
}
