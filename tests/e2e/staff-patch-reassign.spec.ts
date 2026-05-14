/**
 * PATCH /api/staff/:id re-homes a staff record to a different project.
 *
 * Pins the surface-staff-in-sessions design §6 contract:
 *  - PATCH without projectId → 400
 *  - PATCH to an unknown projectId → 404
 *  - PATCH to a real projectId → 200, record returned with new projectId
 *  - GET /api/staff scoped to the new projectId now contains the record
 *  - GET /api/staff/orphaned returns staff with system / missing projectId
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, gitCwd, readE2EToken } from "./e2e-setup.js";

test.describe("PATCH /api/staff/:id — re-home to project", () => {
	let token: string;
	const cleanupStaffIds: string[] = [];

	test.beforeAll(() => {
		token = readE2EToken();
		void token;
	});

	test.afterAll(async () => {
		for (const id of cleanupStaffIds) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("re-assigns staff between projects", async () => {
		// Need two projects. Register a second one alongside the harness default.
		const projects = (await (await apiFetch("/api/projects")).json()) as Array<{ id: string; rootPath: string; name: string }>;
		expect(projects.length).toBeGreaterThanOrEqual(1);
		const projA = projects[0];

		// Register a second project rooted at a fresh dir.
		const projBRoot = gitCwd() + "-projB-" + Date.now();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(projBRoot, { recursive: true });
		const projBResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `patch-target-${Date.now()}`, rootPath: projBRoot }),
		});
		expect(projBResp.ok).toBeTruthy();
		const projB = await projBResp.json();

		// Staff creation needs a real git repo for worktree setup, so use gitCwd()
		// for the cwd. projectId still pins ownership.
		const createResp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `patch-staff-${Date.now()}`,
				systemPrompt: "y",
				cwd: gitCwd(),
				projectId: projA.id,
			}),
		});
		expect(createResp.status).toBe(201);
		const staff = await createResp.json();
		cleanupStaffIds.push(staff.id);
		expect(staff.projectId).toBe(projA.id);

		// PATCH without projectId — 400
		const missingResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PATCH",
			body: JSON.stringify({}),
		});
		expect(missingResp.status).toBe(400);

		// PATCH with unknown projectId — 404
		const badResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PATCH",
			body: JSON.stringify({ projectId: "no-such-project-id" }),
		});
		expect(badResp.status).toBe(404);

		// PATCH to projB — 200
		const okResp = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PATCH",
			body: JSON.stringify({ projectId: projB.id }),
		});
		expect(okResp.status).toBe(200);
		const moved = await okResp.json();
		expect(moved.projectId).toBe(projB.id);

		// GET scoped to projB now contains the record
		const listB = await (await apiFetch(`/api/staff?projectId=${encodeURIComponent(projB.id)}`)).json();
		expect((listB.staff as any[]).some((s) => s.id === staff.id)).toBe(true);

		// And no longer under projA
		const listA = await (await apiFetch(`/api/staff?projectId=${encodeURIComponent(projA.id)}`)).json();
		expect((listA.staff as any[]).some((s) => s.id === staff.id)).toBe(false);
	});

	test("GET /api/staff/orphaned endpoint exists and returns an array", async () => {
		const resp = await apiFetch("/api/staff/orphaned");
		expect(resp.ok).toBeTruthy();
		const body = await resp.json();
		expect(Array.isArray(body.staff)).toBe(true);
	});
});
