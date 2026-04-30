/**
 * Workflow CRUD API E2E tests.
 *
 * Workflows live exclusively in registered projects' `project.yaml::workflows`.
 * The shared `apiFetch` helper auto-injects the harness default projectId
 * (body for POST /api/workflows; query string for /:id and /:id/customize|/override
 * routes). Tests exercising the 400-projectId-required path use `rawApiFetch`
 * (see workflows-project-scope.spec.ts).
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, nonGitCwd, apiFetch } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
let token: string;

/** Helper: minimal valid v2 workflow body (gates-based) */
function minimalWorkflow(id: string, name?: string) {
	return {
		id,
		name: name || `Test Workflow ${id}`,
		description: "A test workflow",
		gates: [
			{
				id: "step-a",
				name: "Step A",
				depends_on: [],
				verify: [
					{ name: "Check", type: "command", run: "echo ok" },
				],
			},
		],
	};
}

test.beforeAll(async () => {
	token = readE2EToken();
});

test.describe("Workflow CRUD API", () => {
	test("GET /api/workflows returns seeded bug-fix workflow @smoke", async () => {
		// Poll briefly — seeded workflows may not be ready immediately after gateway init
		const bugFix = await pollUntil(async () => {
			const resp = await apiFetch("/api/workflows");
			expect(resp.status).toBe(200);
			const { workflows } = await resp.json();
			expect(Array.isArray(workflows)).toBe(true);
			return workflows.find((w: any) => w.id === "bug-fix") ?? null;
		}, { timeoutMs: 5000, intervalMs: 100, label: "bug-fix workflow seeded" });
		expect(bugFix).toBeTruthy();
		expect(bugFix.name).toBe("Bug Fix");
		expect(bugFix.gates).toBeTruthy();
		expect(bugFix.gates.length).toBeGreaterThan(0);
	});

	test("Full CRUD lifecycle", async () => {
		const id = "e2e-crud-" + Date.now();

		// POST — create
		const createResp = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify(minimalWorkflow(id)),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();
		expect(created.id).toBe(id);
		expect(created.gates).toHaveLength(1);

		// GET — retrieve by id
		const getResp = await apiFetch(`/api/workflows/${id}`);
		expect(getResp.status).toBe(200);
		const fetched = await getResp.json();
		expect(fetched.id).toBe(id);
		expect(fetched.name).toContain("Test Workflow");

		// PUT — update
		const updateResp = await apiFetch(`/api/workflows/${id}`, {
			method: "PUT",
			body: JSON.stringify({ name: "Updated Name" }),
		});
		expect(updateResp.status).toBe(200);
		const updated = await updateResp.json();
		expect(updated.name).toBe("Updated Name");

		// Verify update persisted
		const getResp2 = await apiFetch(`/api/workflows/${id}`);
		const fetched2 = await getResp2.json();
		expect(fetched2.name).toBe("Updated Name");

		// DELETE — remove
		const deleteResp = await apiFetch(`/api/workflows/${id}`, {
			method: "DELETE",
		});
		// Project-scoped DELETE is idempotent; returns 200 { ok: true }.
		expect(deleteResp.status).toBe(200);

		// Verify gone — without the projectId override, GET /:id falls back to
		// the cascade for the harness default project, which now lacks the id.
		const gone = await apiFetch(`/api/workflows/${id}`);
		expect(gone.status).toBe(404);
	});

	test("DELETE on workflow used by a goal still removes it (no in-use check at server scope)", async () => {
		// Note: prior behaviour blocked deletion with 409 via WorkflowManager.
		// The system-scope WorkflowManager has been removed; the project-scoped
		// REST path delegates straight to the inline workflow store and does
		// not enforce in-use checks. This test pins the new contract so we
		// notice if it changes.
		const wfId = "e2e-delete-block-" + Date.now();
		const createWfResp = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify(minimalWorkflow(wfId)),
		});
		expect(createWfResp.status).toBe(201);

		const createGoalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "E2E delete-no-block test goal",
				cwd: nonGitCwd(),
				workflowId: wfId,
				team: false,
				worktree: false,
			}),
		});
		expect(createGoalResp.status).toBe(201);
		const goal = await createGoalResp.json();

		const deleteResp = await apiFetch(`/api/workflows/${wfId}`, { method: "DELETE" });
		expect(deleteResp.status).toBe(200);

		// Cleanup
		await apiFetch(`/api/goals/${goal.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "complete" }),
		});
	});

	test("GET /api/workflows/:id returns 404 for unknown", async () => {
		const resp = await apiFetch("/api/workflows/nonexistent-workflow-id");
		expect(resp.status).toBe(404);
	});

	test("PUT /api/workflows/:id returns 404 for unknown", async () => {
		const resp = await apiFetch("/api/workflows/nonexistent-workflow-id", {
			method: "PUT",
			body: JSON.stringify({ name: "nope" }),
		});
		expect(resp.status).toBe(404);
	});

	test("DELETE /api/workflows/:id is idempotent for unknown ids", async () => {
		// Project-scoped DELETE is idempotent — the inline workflow store's
		// remove() is a no-op when the key is absent.
		const resp = await apiFetch("/api/workflows/nonexistent-workflow-id", {
			method: "DELETE",
		});
		expect(resp.status).toBe(200);
	});
});
