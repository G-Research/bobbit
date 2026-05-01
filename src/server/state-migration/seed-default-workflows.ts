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

export interface SeededVerifyStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa";
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
	[key: string]: unknown;
}

export interface SeededGate {
	id: string;
	name: string;
	description?: string;
	depends_on?: string[];
	content?: boolean;
	inject_downstream?: boolean;
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

	return {
		general,
		feature,
		"bug-fix": bugFix,
		"quick-fix": quickFix,
	};
}
