/**
 * E2E tests that reproduce the two setup wizard bugs.
 *
 * These tests FAIL on the current (unfixed) codebase, proving the bugs exist.
 * After the fix, they will PASS.
 *
 * Bug 1: No project config API — GET /api/project-config returns 404.
 * Bug 2: Workflow verification uses hardcoded commands instead of template variables.
 */
import { test, expect } from "./gateway-harness.js";
import { apiFetch, createGoal, deleteGoal, nonGitCwd } from "./e2e-setup.js";

// ---------------------------------------------------------------------------
// Bug 1: Project config API does not exist
// ---------------------------------------------------------------------------

test.describe("Bug 1: Project config API", () => {
	test("GET /api/project-config returns 200", async () => {
		const resp = await apiFetch("/api/project-config");
		expect(resp.status, "Expected GET /api/project-config to return 200 but got 404 — endpoint does not exist yet").toBe(200);
	});

	test("GET /api/project-config/defaults returns built-in defaults", async () => {
		const resp = await apiFetch("/api/project-config/defaults");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.typecheck_command).toBe("npm run check");
		expect(data.build_command).toBe("npm run build");
		expect(data.test_unit_command).toBe("npm run test:unit");
	});

	test("PUT /api/project-config accepts arbitrary keys", async () => {
		// Set a custom key
		const putResp = await apiFetch("/api/project-config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ my_custom_var: "hello world" }),
		});
		expect(putResp.status).toBe(200);

		// Verify it appears in GET
		const getResp = await apiFetch("/api/project-config");
		const data = await getResp.json();
		expect(data.my_custom_var).toBe("hello world");
		// Defaults still present
		expect(data.typecheck_command).toBe("npm run check");

		// Clean up: remove the custom key
		await apiFetch("/api/project-config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ my_custom_var: null }),
		});
		const cleanResp = await apiFetch("/api/project-config");
		const cleanData = await cleanResp.json();
		expect(cleanData.my_custom_var).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Bug 2: Workflow verification uses hardcoded commands
// ---------------------------------------------------------------------------

test.describe("Bug 2: Workflow verification uses template variables", () => {
	test("general workflow implementation gate uses {{project.typecheck_command}} not hardcoded npm run check", async () => {
		const goal = await createGoal({
			title: `Setup Bug Test ${Date.now()}`,
			cwd: nonGitCwd(),
			workflowId: "general",
		});
		try {
			// The goal object includes the full workflow with gates and verify steps
			const workflow = (goal as any).workflow;
			expect(workflow).toBeTruthy();

			const implGate = workflow.gates.find((g: any) => g.id === "implementation");
			expect(implGate).toBeTruthy();
			expect(implGate.verify).toBeTruthy();

			// Find the type-check verification step
			const typeCheckStep = implGate.verify.find(
				(v: any) => v.type === "command" && v.name?.toLowerCase().includes("type check"),
			);
			expect(typeCheckStep, "Expected a type-check verification step in implementation gate").toBeTruthy();

			// This assertion will FAIL on unfixed code because `run` is "npm run check"
			// After fix, it should be "{{project.typecheck_command}}"
			expect(typeCheckStep.run).toContain("{{project.typecheck_command}}");
		} finally {
			await deleteGoal(goal.id);
		}
	});

	test("general workflow implementation gate uses {{project.test_unit_command}} not hardcoded npm run test:unit", async () => {
		const goal = await createGoal({
			title: `Setup Bug Test Unit ${Date.now()}`,
			cwd: nonGitCwd(),
			workflowId: "general",
		});
		try {
			const workflow = (goal as any).workflow;
			const implGate = workflow.gates.find((g: any) => g.id === "implementation");
			const unitTestStep = implGate.verify.find(
				(v: any) => v.type === "command" && v.name?.toLowerCase().includes("unit test"),
			);
			expect(unitTestStep, "Expected a unit-test verification step in implementation gate").toBeTruthy();

			// This assertion will FAIL on unfixed code because `run` is "npm run test:unit"
			// After fix, it should be "{{project.test_unit_command}}"
			expect(unitTestStep.run).toContain("{{project.test_unit_command}}");
		} finally {
			await deleteGoal(goal.id);
		}
	});

	test("bug-fix workflow implementation gate uses {{project.typecheck_command}} not hardcoded npm run check", async () => {
		const goal = await createGoal({
			title: `Setup Bug Test BugFix ${Date.now()}`,
			cwd: nonGitCwd(),
			workflowId: "bug-fix",
		});
		try {
			const workflow = (goal as any).workflow;
			const implGate = workflow.gates.find((g: any) => g.id === "implementation");
			const typeCheckStep = implGate.verify.find(
				(v: any) => v.type === "command" && v.name?.toLowerCase().includes("type check"),
			);
			expect(typeCheckStep, "Expected a type-check verification step in bug-fix implementation gate").toBeTruthy();

			// This assertion will FAIL on unfixed code because `run` is "npm run check"
			expect(typeCheckStep.run).toContain("{{project.typecheck_command}}");
		} finally {
			await deleteGoal(goal.id);
		}
	});
});
