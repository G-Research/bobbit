/**
 * Workflows are project-scoped — API E2E tests.
 *
 * Pins the contract from "Remove system-level workflows":
 *   - GET /api/workflows (no projectId)               → 200 { workflows: [] }
 *   - POST /api/workflows (no projectId in body)      → 400 projectId required
 *   - POST /:id/customize (no projectId in query)     → 400
 *   - DELETE /:id/override (no projectId in query)    → 400
 *   - PUT /:id (no projectId in query)                → 400
 *   - DELETE /:id (no projectId in query)             → 400
 *   - GET /:id (no projectId in query)                → 404
 *   - GET /api/workflows?projectId=<id>               → only that project's workflows
 *
 * Uses `rawApiFetch` to bypass the harness's auto-projectId-injection so
 * we hit the bare server contract.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, rawApiFetch } from "./e2e-setup.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createProjectDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-wf-scope-"));
	mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

async function registerProject(name: string, rootPath: string) {
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath, __e2e_seed_skip__: true }),
	});
	expect(res.status).toBe(201);
	return res.json();
}

async function deleteProject(id: string) {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

function minimalWorkflow(id: string) {
	return {
		id,
		name: `Project-scope ${id}`,
		description: "scope test",
		gates: [{
			id: "step-a",
			name: "Step A",
			depends_on: [],
			verify: [{ name: "Check", type: "command", run: "echo ok" }],
		}],
	};
}

test.describe("Workflows are project-scoped only", () => {

	test("GET /api/workflows without projectId returns empty list", async () => {
		const resp = await rawApiFetch("/api/workflows");
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body).toEqual({ workflows: [] });
	});

	test("POST /api/workflows without projectId returns 400", async () => {
		const resp = await rawApiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify(minimalWorkflow("e2e-scope-no-pid-" + Date.now())),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toBe("projectId required");
	});

	test("mutation routes without projectId all 400", async () => {
		const id = "e2e-scope-route-" + Date.now();

		const customize = await rawApiFetch(`/api/workflows/${id}/customize`, { method: "POST" });
		expect(customize.status).toBe(400);
		expect((await customize.json()).error).toBe("projectId required");

		const override = await rawApiFetch(`/api/workflows/${id}/override`, { method: "DELETE" });
		expect(override.status).toBe(400);
		expect((await override.json()).error).toBe("projectId required");

		const put = await rawApiFetch(`/api/workflows/${id}`, {
			method: "PUT",
			body: JSON.stringify({ name: "ignored" }),
		});
		expect(put.status).toBe(400);
		expect((await put.json()).error).toBe("projectId required");

		const del = await rawApiFetch(`/api/workflows/${id}`, { method: "DELETE" });
		expect(del.status).toBe(400);
		expect((await del.json()).error).toBe("projectId required");
	});

	test("GET /api/workflows/:id without projectId returns 404", async () => {
		// Even with a workflow id that does exist in some project, a bare GET
		// without projectId must 404 (no system scope).
		const resp = await rawApiFetch("/api/workflows/general");
		expect(resp.status).toBe(404);
	});

	test("GET /api/workflows?projectId=<id> returns only that project's workflows", async () => {
		const tmpDirA = createProjectDir();
		const tmpDirB = createProjectDir();
		const projA = await registerProject("wf-scope-A-" + Date.now(), tmpDirA);
		const projB = await registerProject("wf-scope-B-" + Date.now(), tmpDirB);

		try {
			const onlyInA = "wf-scope-only-a-" + Date.now();
			const onlyInB = "wf-scope-only-b-" + Date.now();

			// Add `onlyInA` to project A only.
			const cA = await rawApiFetch("/api/workflows", {
				method: "POST",
				body: JSON.stringify({ ...minimalWorkflow(onlyInA), projectId: projA.id }),
			});
			expect(cA.status).toBe(201);

			// Add `onlyInB` to project B only.
			const cB = await rawApiFetch("/api/workflows", {
				method: "POST",
				body: JSON.stringify({ ...minimalWorkflow(onlyInB), projectId: projB.id }),
			});
			expect(cB.status).toBe(201);

			// GET A → contains onlyInA, not onlyInB.
			const listA = await rawApiFetch(`/api/workflows?projectId=${encodeURIComponent(projA.id)}`);
			expect(listA.status).toBe(200);
			const idsA = ((await listA.json()).workflows as Array<{ id: string }>).map(w => w.id);
			expect(idsA).toContain(onlyInA);
			expect(idsA).not.toContain(onlyInB);

			// GET B → contains onlyInB, not onlyInA.
			const listB = await rawApiFetch(`/api/workflows?projectId=${encodeURIComponent(projB.id)}`);
			expect(listB.status).toBe(200);
			const idsB = ((await listB.json()).workflows as Array<{ id: string }>).map(w => w.id);
			expect(idsB).toContain(onlyInB);
			expect(idsB).not.toContain(onlyInA);

			// And bare GET still empty.
			const bareList = await rawApiFetch("/api/workflows");
			expect(bareList.status).toBe(200);
			const bareIds = ((await bareList.json()).workflows as Array<{ id: string }>).map(w => w.id);
			expect(bareIds).not.toContain(onlyInA);
			expect(bareIds).not.toContain(onlyInB);
		} finally {
			await deleteProject(projA.id);
			await deleteProject(projB.id);
			rmSync(tmpDirA, { recursive: true, force: true });
			rmSync(tmpDirB, { recursive: true, force: true });
		}
	});
});
