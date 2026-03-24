import { test, expect } from "@playwright/test";
import { readE2EToken, BASE, nonGitCwd } from "./e2e-setup.js";
let token: string;

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(opts?.headers || {}),
		},
	});
}

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
	test("GET /api/workflows returns seeded bug-fix workflow", async () => {
		const resp = await apiFetch("/api/workflows");
		expect(resp.status).toBe(200);
		const { workflows } = await resp.json();
		expect(Array.isArray(workflows)).toBe(true);
		const bugFix = workflows.find((w: any) => w.id === "bug-fix");
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
		expect(deleteResp.status).toBe(204);

		// Verify gone
		const gone = await apiFetch(`/api/workflows/${id}`);
		expect(gone.status).toBe(404);
	});

	test("POST validates DAG — circular deps", async () => {
		const id = "e2e-circular-" + Date.now();
		const resp = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				id,
				name: "Circular",
				description: "",
				gates: [
					{ id: "a", name: "Gate A", dependsOn: ["b"], verify: [] },
					{ id: "b", name: "Gate B", dependsOn: ["a"], verify: [] },
				],
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("Circular dependency");
		// Cleanup in case it was created
		await apiFetch(`/api/workflows/${id}`, { method: "DELETE" }).catch(() => {});
	});

	test("POST validates DAG — duplicate IDs", async () => {
		const resp = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				id: "e2e-dupid-" + Date.now(),
				name: "DupIDs",
				description: "",
				gates: [
					{ id: "same", name: "Gate A", dependsOn: [], verify: [] },
					{ id: "same", name: "Gate B", dependsOn: [], verify: [] },
				],
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("Duplicate gate ID");
	});

	test("POST validates DAG — unknown dependsOn", async () => {
		const resp = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				id: "e2e-unknowndep-" + Date.now(),
				name: "UnknownDep",
				description: "",
				gates: [
					{ id: "a", name: "Gate A", dependsOn: ["nonexistent"], verify: [] },
				],
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("unknown");
	});

	test("POST validates — empty gates", async () => {
		const resp = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				id: "e2e-empty-" + Date.now(),
				name: "Empty",
				description: "",
				gates: [],
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("at least one gate");
	});

	test("POST validates — missing name", async () => {
		const resp = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				id: "e2e-noname-" + Date.now(),
				description: "",
				gates: [
					{ id: "a", name: "A", depends_on: [] },
				],
			}),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("name");
	});

	test("POST validates — duplicate workflow ID", async () => {
		const id = "e2e-dup-wf-" + Date.now();
		// Create first
		const r1 = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify(minimalWorkflow(id)),
		});
		expect(r1.status).toBe(201);

		// Try to create again with same ID
		const r2 = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify(minimalWorkflow(id)),
		});
		expect(r2.status).toBe(400);
		const body = await r2.json();
		expect(body.error).toContain("already exists");

		// Cleanup
		await apiFetch(`/api/workflows/${id}`, { method: "DELETE" });
	});

	test("Clone creates independent copy", async () => {
		const resp = await apiFetch("/api/workflows/bug-fix/clone", {
			method: "POST",
		});
		expect(resp.status).toBe(201);
		const cloned = await resp.json();
		expect(cloned.id).not.toBe("bug-fix");
		expect(cloned.id).toContain("bug-fix-clone-");
		expect(cloned.gates.length).toBeGreaterThan(0);
		expect(cloned.name).toBe("Bug Fix");

		// Cleanup — delete the clone
		await apiFetch(`/api/workflows/${cloned.id}`, { method: "DELETE" });
	});

	test("DELETE blocked when workflow in-use by active goal", async () => {
		// Create a test workflow
		const wfId = "e2e-delete-block-" + Date.now();
		const createWfResp = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify(minimalWorkflow(wfId)),
		});
		expect(createWfResp.status).toBe(201);

		// Create a goal with this workflowId
		const createGoalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "E2E delete-block test goal",
				cwd: nonGitCwd(),
				workflowId: wfId,
				team: false,
				worktree: false,
			}),
		});
		expect(createGoalResp.status).toBe(201);
		const goal = await createGoalResp.json();

		// Try to delete the workflow — should be blocked
		const deleteResp = await apiFetch(`/api/workflows/${wfId}`, {
			method: "DELETE",
		});
		expect(deleteResp.status).toBe(409);
		const body = await deleteResp.json();
		expect(body.error).toContain("in use");

		// Clean up: complete the goal and then delete the workflow
		await apiFetch(`/api/goals/${goal.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "complete" }),
		});
		const deleteResp2 = await apiFetch(`/api/workflows/${wfId}`, {
			method: "DELETE",
		});
		expect(deleteResp2.status).toBe(204);
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

	test("DELETE /api/workflows/:id returns 404 for unknown", async () => {
		const resp = await apiFetch("/api/workflows/nonexistent-workflow-id", {
			method: "DELETE",
		});
		expect(resp.status).toBe(404);
	});
});
