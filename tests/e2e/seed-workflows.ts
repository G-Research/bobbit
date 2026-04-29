/**
 * Test workflow seed helpers.
 *
 * Builtin workflow YAMLs (`defaults/workflows/*.yaml`) were removed in
 * follow-up A of the multi-repo & components goal. Workflows now live
 * inline in `project.yaml::workflows`. Tests that need workflows must
 * inject them into the project they target.
 *
 * These helpers produce inline workflow blocks that match the shape of
 * the deleted YAMLs (gate IDs, gate names, step names, dependency graph)
 * so existing E2E assertions keep passing without per-test rewrites.
 *
 * Step shape uses the post-multi-repo grammar:
 *   - `{ component, command }` for component-linked named commands
 *   - `{ run }` for free-form shell strings
 *   - no `{{project.X}}` tokens (validator rejects them)
 *
 * Verification command bodies are stubbed to `echo ok` so steps complete
 * instantly. llm-review steps run through the harness skip path
 * (BOBBIT_LLM_REVIEW_SKIP=1) so their `prompt:` text is never invoked.
 */

export interface TestComponent {
	name: string;
	repo: string;
	commands?: Record<string, string>;
}

export interface TestWorkflowsBlock {
	[id: string]: Record<string, unknown>;
}

/** Default no-op component used by most E2E tests (fast, command-only). */
export const TEST_DEFAULT_COMPONENT: TestComponent = {
	name: "test",
	repo: ".",
	commands: {
		build: "echo ok",
		check: "echo ok",
		unit: "echo ok",
		e2e: "echo ok",
	},
};

/**
 * Inline workflow block covering the IDs the E2E suite references:
 *   general, feature, bug-fix, quick-fix, test-fast.
 *
 * Gate names mirror the original `defaults/workflows/*.yaml` shapes
 * ("Design Document", "Implementation", "Documentation", "Ready to
 * Merge", "Issue Analysis", "Reproducing Test") so tests asserting on
 * gate name / count keep passing.
 */
export function testWorkflows(): TestWorkflowsBlock {
	const reviewStep = (name: string): Record<string, unknown> => ({
		name, type: "llm-review",
		prompt: "Review (skipped under BOBBIT_LLM_REVIEW_SKIP).",
	});
	const readyToMergeGate = (deps = ["documentation"]): Record<string, unknown> => ({
		id: "ready-to-merge", name: "Ready to Merge", depends_on: deps,
		verify: [
			{ name: "Branch pushed to remote", type: "command", run: "echo ok" },
			{ name: "Master merged into branch", type: "command", run: "echo ok" },
			{ name: "PR raised", type: "command", run: "echo ok" },
		],
	});
	const documentationGate = (deps = ["implementation"]): Record<string, unknown> => ({
		id: "documentation", name: "Documentation", depends_on: deps,
		verify: [reviewStep("Documentation coverage")],
	});
	const implementationVerify = (): Record<string, unknown>[] => [
		{ name: "Build", type: "command", component: "test", command: "build", timeout: 600 },
		{ name: "Type check", type: "command", phase: 1, component: "test", command: "check" },
		{ name: "Unit tests", type: "command", phase: 1, component: "test", command: "unit" },
		{ name: "E2E tests", type: "command", phase: 1, component: "test", command: "e2e", timeout: 900 },
		reviewStep("Code quality review"),
		{
			name: "QA testing", type: "agent-qa", role: "qa-tester", phase: 3,
			optional: true, label: "Enable QA Testing",
			description: "Spawn a QA agent that builds the project, starts an ephemeral server, and drives a real browser through user scenarios to validate the fix end-to-end.",
			prompt: "QA test (skipped in tests).",
		},
	];
	return {
		"general": {
			id: "general",
			name: "General",
			description: "Lightweight workflow for general-purpose goals",
			gates: [
				{ id: "design-doc", name: "Design Document", content: true, inject_downstream: true,
					verify: [reviewStep("Design review"), reviewStep("Gap analysis")] },
				{ id: "implementation", name: "Implementation", depends_on: ["design-doc"],
					verify: implementationVerify() },
				documentationGate(),
				readyToMergeGate(),
			],
		},
		"feature": {
			id: "feature",
			name: "Feature",
			description: "Implement a new feature with design, implementation, and review",
			gates: [
				{ id: "design-doc", name: "Design Document", content: true, inject_downstream: true,
					verify: [reviewStep("Design review"), reviewStep("Gap analysis")] },
				{ id: "implementation", name: "Implementation", depends_on: ["design-doc"],
					verify: implementationVerify() },
				documentationGate(),
				readyToMergeGate(),
			],
		},
		"bug-fix": {
			id: "bug-fix",
			name: "Bug Fix",
			description: "Fix a reported bug with TDD verification",
			gates: [
				{ id: "issue-analysis", name: "Issue Analysis", content: true, inject_downstream: true,
					verify: [reviewStep("Analysis quality")] },
				{ id: "reproducing-test", name: "Reproducing Test", depends_on: ["issue-analysis"],
					metadata: { test_command: "string", error_pattern: "string" },
					verify: [
						// `expect: failure` makes the gate pass when the command exits non-zero.
						{ name: "Test fails (bug exists)", type: "command",
							run: "{{agent.test_command}}", expect: "failure" },
					] },
				{ id: "implementation", name: "Implementation", depends_on: ["reproducing-test"],
					verify: implementationVerify() },
				documentationGate(),
				readyToMergeGate(),
			],
		},
		"quick-fix": {
			id: "quick-fix",
			name: "Quick Fix",
			description: "Fast workflow for small changes",
			gates: [
				{ id: "implementation", name: "Implementation",
					verify: implementationVerify() },
				readyToMergeGate(["implementation"]),
			],
		},
		// `test-fast` is the canonical command-only fixture used by
		// gate-verification.test.ts and other contract tests.
		"test-fast": {
			id: "test-fast",
			name: "Test Fast",
			description: "Lightweight workflow for E2E testing with fast verification steps.",
			hidden: true,
			gates: [
				{ id: "design-doc", name: "Design Doc",
					verify: [{ name: "Content present", type: "command", run: "echo ok" }] },
				{ id: "implementation", name: "Implementation", depends_on: ["design-doc"],
					verify: [{ name: "Quick check", type: "command", run: "echo ok" }] },
				{ id: "ready-to-merge", name: "Ready to Merge", depends_on: ["implementation"],
					verify: [
						{ name: "Branch pushed", type: "command", run: "echo ok" },
						{ name: "Master merged", type: "command", run: "echo ok" },
						{ name: "PR raised", type: "command", run: "echo ok" },
					] },
			],
		},
	};
}

/**
 * Convenience: registers `testWorkflows()` into the named project via
 * `PUT /api/projects/:id/config` and ALSO writes them into the
 * server-level project.yaml so cascade-API tests that query without a
 * projectId see them. Use after the harness has registered the default
 * project. Returns the response body.
 */
export async function seedTestWorkflows(opts: {
	baseURL: string;
	token: string;
	projectId: string;
	component?: TestComponent;
	/** When set, also write workflows to <serverConfigDir>/project.yaml. */
	serverConfigDir?: string;
}): Promise<{ status: number; body: unknown }> {
	const component = opts.component ?? TEST_DEFAULT_COMPONENT;
	const res = await fetch(`${opts.baseURL}/api/projects/${opts.projectId}/config`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.token}`,
		},
		body: JSON.stringify({
			components: [component],
			workflows: testWorkflows(),
		}),
	});
	const text = await res.text();
	let body: unknown = null;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }

	// Also seed the server-level workflow store. The standalone server
	// `WorkflowStore` reads from `<bobbitDir>/config/project.yaml` (via
	// `bobbitConfigDir()` in the server boot block). The default project's
	// configDir is `<rootPath>/.bobbit/config/`, which is a *different*
	// path. Cascade-API tests that hit /api/workflows without a projectId
	// resolve through the server-level store, so we have to write there
	// too. Done by spawning a tiny dynamic-import block so this helper
	// stays node:fs-free for browser-side callers.
	if (opts.serverConfigDir) {
		try {
			const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
			const { join } = await import("node:path");
			const yaml = await import("yaml");
			mkdirSync(opts.serverConfigDir, { recursive: true });
			const yamlPath = join(opts.serverConfigDir, "project.yaml");
			let existing: Record<string, unknown> = {};
			if (existsSync(yamlPath)) {
				try {
					const parsed = yaml.parse(readFileSync(yamlPath, "utf-8"));
					if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
				} catch { /* corrupt, replace */ }
			}
			existing.components = [component];
			existing.workflows = testWorkflows();
			writeFileSync(yamlPath, yaml.stringify(existing));
		} catch { /* best-effort */ }
	}

	return { status: res.status, body };
}
