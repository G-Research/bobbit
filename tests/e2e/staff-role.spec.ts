import { test, expect } from "./in-process-harness.js";
import { defaultProject, apiFetch } from "./e2e-setup.js";

/**
 * E2E tests for staff ↔ role association (server backend, Unit A).
 *
 * Covers:
 *   - POST /api/staff with a valid roleId persists it.
 *   - PUT /api/staff/:id changes the roleId, and clears it via roleId: null.
 *   - Unknown roleId → 404 on both POST and PUT.
 *
 * Role-prompt injection itself is unit-tested in tests/role-prompt.test.ts;
 * here we pin the REST surface (persistence + validation).
 */

const ROLE_NAME = "staff-role-test-role";

async function createTestRole(): Promise<void> {
	await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({
			name: ROLE_NAME,
			label: "Staff Role Test",
			promptTemplate: "You are a staff role test agent.",
			accessory: "glasses",
		}),
	}).catch(() => {});
}

async function createStaffBody(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
	const project = await defaultProject();
	return {
		name: "Role Staff",
		systemPrompt: "You are a role staff agent.",
		cwd: project.rootPath,
		projectId: project.id,
		...extra,
	};
}

test.describe("Staff role association — REST API", () => {
	const cleanupStaffIds: string[] = [];
	const cleanupSessionIds: string[] = [];

	test.beforeAll(async () => {
		await createTestRole();
	});

	test.afterAll(async () => {
		await Promise.all(cleanupSessionIds.map((id) => apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {})));
		await Promise.all(cleanupStaffIds.map((id) => apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {})));
		await apiFetch(`/api/roles/${ROLE_NAME}`, { method: "DELETE" }).catch(() => {});
	});

	test("POST /api/staff with a valid roleId persists it", async () => {
		const res = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify(await createStaffBody({ roleId: ROLE_NAME })),
		});
		expect(res.status).toBe(201);
		const staff = await res.json();
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		expect(staff.roleId).toBe(ROLE_NAME);

		// Round-trip via GET to confirm persistence.
		const getRes = await apiFetch(`/api/staff/${staff.id}`, {});
		const fetched = await getRes.json();
		expect(fetched.roleId).toBe(ROLE_NAME);
	});

	test("POST /api/staff with an unknown roleId returns 404", async () => {
		const res = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify(await createStaffBody({ roleId: "no-such-role-xyz" })),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("Role not found");
	});

	test("POST /api/staff without a roleId succeeds (role optional)", async () => {
		const res = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify(await createStaffBody({})),
		});
		expect(res.status).toBe(201);
		const staff = await res.json();
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);
		expect(staff.roleId == null).toBe(true);
	});

	test("PUT /api/staff/:id sets, changes, and clears roleId", async () => {
		// Start with no role.
		const createRes = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify(await createStaffBody({})),
		});
		expect(createRes.status).toBe(201);
		const staff = await createRes.json();
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		// Set the role.
		const setRes = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ roleId: ROLE_NAME }),
		});
		expect(setRes.ok).toBe(true);
		const afterSet = await setRes.json();
		expect(afterSet.roleId).toBe(ROLE_NAME);

		// Clear the role with roleId: null.
		const clearRes = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ roleId: null }),
		});
		expect(clearRes.ok).toBe(true);
		const afterClear = await clearRes.json();
		expect(afterClear.roleId == null).toBe(true);

		// Confirm persistence of the cleared state.
		const getRes = await apiFetch(`/api/staff/${staff.id}`, {});
		const fetched = await getRes.json();
		expect(fetched.roleId == null).toBe(true);
	});

	test("PUT /api/staff/:id with an unknown roleId returns 404", async () => {
		const createRes = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify(await createStaffBody({})),
		});
		expect(createRes.status).toBe(201);
		const staff = await createRes.json();
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		const res = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ roleId: "no-such-role-xyz" }),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("Role not found");
	});
});
