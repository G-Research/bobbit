import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, defaultProject, apiFetch } from "./e2e-setup.js";

/**
 * End-to-end tests for the Staff Agents feature (persistent session model).
 *
 * Each staff agent has a single permanent session created at staff creation time.
 * Wake cycles enqueue prompts on the existing session instead of creating new ones.
 *
 * Run with:
 *   npm run build:server && npx playwright test tests/e2e/staff.spec.ts --config playwright-e2e.config.ts
 */

function GW_URL() { return base(); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiCreateStaff(
	_token: string,
	data: {
		name: string;
		description?: string;
		systemPrompt: string;
		cwd?: string;
		projectId?: string;
		sandboxed?: boolean;
		triggers?: Array<{ type: string; config: Record<string, unknown>; enabled: boolean; prompt?: string }>;
	},
): Promise<any> {
	const body: Record<string, unknown> = { ...data };
	if (!body.cwd && !body.projectId) {
		const project = await defaultProject();
		body.cwd = project.rootPath;
		body.projectId = project.id;
	}
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	return res.json();
}

async function apiDeleteStaff(_token: string, id: string): Promise<void> {
	await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
}

async function apiDeleteSession(_token: string, id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Staff Agents — REST API", () => {
	let token: string;
	const cleanupStaffIds: string[] = [];
	const cleanupSessionIds: string[] = [];
	/** Shared staff agent created once for read-only and update tests. */
	let sharedStaff: any;

	test.beforeAll(async () => {
		token = readE2EToken();
		// Pre-create a shared staff agent used by list, get-by-id, update, wake, and paused tests
		sharedStaff = await apiCreateStaff(token, {
			name: "Shared Test Agent",
			description: "Shared for multiple tests",
			systemPrompt: "You are a shared test agent.",
		});
		cleanupStaffIds.push(sharedStaff.id);
		if (sharedStaff.currentSessionId) cleanupSessionIds.push(sharedStaff.currentSessionId);
	});

	test.afterAll(async () => {
		await Promise.all(cleanupSessionIds.map((id) => apiDeleteSession(token, id)));
		await Promise.all(cleanupStaffIds.map((id) => apiDeleteStaff(token, id)));
	});

	test("POST /api/staff creates a staff agent with defaults and a permanent session", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Test Warden",
			description: "A test staff agent",
			systemPrompt: "You are a test warden.",
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		expect(staff.id).toBeTruthy();
		expect(staff.name).toBe("Test Warden");
		expect(staff.description).toBe("A test staff agent");
		expect(staff.systemPrompt).toBe("You are a test warden.");
		expect(staff.state).toBe("active");
		expect(staff.triggers).toEqual([]);
		expect(staff.memory).toBe("");
		expect(staff.createdAt).toBeGreaterThan(0);
		expect(staff.updatedAt).toBeGreaterThan(0);

		// Persistent session model: session is created with the staff agent
		expect(staff.currentSessionId).toBeTruthy();

		// Verify the session exists and is linked to the staff agent
		const sessionRes = await apiFetch(`/api/sessions/${staff.currentSessionId}`, {
		});
		expect(sessionRes.ok).toBe(true);
		const session = await sessionRes.json();
		expect(session.staffId).toBe(staff.id);
	});

	test("POST /api/staff with missing name returns 400", async () => {
		const res = await apiFetch(`/api/staff`, {
			method: "POST",
			body: JSON.stringify({ systemPrompt: "test" }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/staff with missing systemPrompt returns 400", async () => {
		const res = await apiFetch(`/api/staff`, {
			method: "POST",
			body: JSON.stringify({ name: "No Prompt" }),
		});
		expect(res.status).toBe(400);
	});

	test("GET /api/staff lists created staff agents", async () => {
		const res = await apiFetch(`/api/staff`, {
		});
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(Array.isArray(data.staff)).toBe(true);
		const found = data.staff.find((s: any) => s.id === sharedStaff.id);
		expect(found).toBeTruthy();
		expect(found.name).toBe("Shared Test Agent");
	});

	test("GET /api/staff/:id returns a single staff agent", async () => {
		const res = await apiFetch(`/api/staff/${sharedStaff.id}`, {
		});
		expect(res.ok).toBe(true);
		const staff = await res.json();
		expect(staff.id).toBe(sharedStaff.id);
		expect(staff.name).toBe("Shared Test Agent");
		expect(staff.description).toBe("Shared for multiple tests");
		expect(staff.cwd).toBe((await defaultProject()).rootPath);
	});

	test("PUT /api/staff/:id updates fields", async () => {
		const res = await apiFetch(`/api/staff/${sharedStaff.id}`, {
			method: "PUT",
			body: JSON.stringify({ description: "Updated desc" }),
		});
		expect(res.ok).toBe(true);
		const updated = await res.json();
		expect(updated.description).toBe("Updated desc");
		// Name should remain unchanged
		expect(updated.name).toBe("Shared Test Agent");
		// Restore original description for other tests
		await apiFetch(`/api/staff/${sharedStaff.id}`, {
			method: "PUT",
			body: JSON.stringify({ description: "Shared for multiple tests" }),
		});
	});

	test("DELETE /api/staff/:id removes the staff agent and its session", async () => {
		const created = await apiCreateStaff(token, {
			name: "Deletable Agent",
			systemPrompt: "To be deleted.",
		});
		const sessionId = created.currentSessionId;
		expect(sessionId).toBeTruthy();

		const delRes = await apiFetch(`/api/staff/${created.id}`, {
			method: "DELETE",
		});
		expect(delRes.ok).toBe(true);

		// Verify staff is gone
		const getRes = await apiFetch(`/api/staff/${created.id}`, {
		});
		expect(getRes.status).toBe(404);

		// Session is archived (not deleted) — verify it still exists but is archived
		const sessionRes = await apiFetch(`/api/sessions/${sessionId}`, {
		});
		expect(sessionRes.status).toBe(200);
		const sessionBody = await sessionRes.json();
		expect(sessionBody.archived).toBe(true);
	});

	test("POST /api/staff with triggers auto-generates trigger IDs", async () => {
		const staff = await apiCreateStaff(token, {
			name: "Triggered Agent",
			systemPrompt: "You have triggers.",
			triggers: [
				{ type: "schedule", config: { cron: "0 9 * * *" }, enabled: true, prompt: "Good morning" },
				{ type: "manual", config: {}, enabled: true },
				{ type: "git", config: { branch: "master", event: "push" }, enabled: false },
			],
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		expect(staff.triggers).toHaveLength(3);

		// Each trigger should have an auto-generated ID
		for (const trigger of staff.triggers) {
			expect(trigger.id).toBeTruthy();
			expect(typeof trigger.id).toBe("string");
			expect(trigger.id.length).toBeGreaterThan(0);
		}

		// Verify trigger fields
		const scheduleTrigger = staff.triggers.find((t: any) => t.type === "schedule");
		expect(scheduleTrigger).toBeTruthy();
		expect(scheduleTrigger.config.cron).toBe("0 9 * * *");
		expect(scheduleTrigger.enabled).toBe(true);
		expect(scheduleTrigger.prompt).toBe("Good morning");

		const manualTrigger = staff.triggers.find((t: any) => t.type === "manual");
		expect(manualTrigger).toBeTruthy();
		expect(manualTrigger.enabled).toBe(true);

		const gitTrigger = staff.triggers.find((t: any) => t.type === "git");
		expect(gitTrigger).toBeTruthy();
		expect(gitTrigger.config.branch).toBe("master");
		expect(gitTrigger.enabled).toBe(false);
	});

	// NOTE: `POST /api/staff/:id/wake` was removed by the staff-inbox migration
	// (docs/design/staff-inbox.md §7.2). The equivalent surface is
	// `POST /api/staff/:id/inbox` — covered by `tests/e2e/inbox-api.spec.ts`.

	test("GET /api/staff/:id/sessions returns 410 (deprecated)", async () => {
		const histRes = await apiFetch(`/api/staff/${sharedStaff.id}/sessions`, {
		});
		expect(histRes.status).toBe(410);
	});

	test("Staff assistant session can be created via assistantType", async () => {
		const res = await apiFetch(`/api/sessions`, {
			method: "POST",
			body: JSON.stringify({ assistantType: "staff" }),
		});
		expect(res.status).toBe(201);
		const session = await res.json();
		cleanupSessionIds.push(session.id);

		expect(session.assistantType).toBe("staff");

		// Verify via GET
		const getRes = await apiFetch(`/api/sessions/${session.id}`, {
		});
		expect(getRes.ok).toBe(true);
		const detail = await getRes.json();
		expect(detail.assistantType).toBe("staff");
	});

	test("Nonexistent staff returns 404/410 for all endpoints", async () => {
		const getRes = await apiFetch(`/api/staff/nonexistent-id-12345`, {
		});
		expect(getRes.status).toBe(404);

		const putRes = await apiFetch(`/api/staff/nonexistent-id-12345`, {
			method: "PUT",
			body: JSON.stringify({ description: "nope" }),
		});
		expect(putRes.status).toBe(404);

		const delRes = await apiFetch(`/api/staff/nonexistent-id-12345`, {
			method: "DELETE",
		});
		expect(delRes.status).toBe(404);

		// Wake endpoint is gone (staff-inbox migration). Use inbox POST for the 404 check.
		const wakeRes = await apiFetch(`/api/staff/nonexistent-id-12345/inbox`, {
			method: "POST",
			body: JSON.stringify({ title: "test", prompt: "hello" }),
		});
		expect(wakeRes.status).toBe(404);

		// The sessions endpoint is fully deprecated — returns 410 regardless of staff ID
		const sessionsRes = await apiFetch(`/api/staff/nonexistent-id-12345/sessions`, {
		});
		expect(sessionsRes.status).toBe(410);
	});

	// Removed: "Paused staff agent cannot be woken" — the wake endpoint is gone
	// and inbox enqueueing intentionally does NOT check `state` (entries
	// accumulate for paused staff and are delivered only when the staff
	// reactivates). See docs/design/staff-inbox.md §2.1.

	// ----- Pinned tests for fix-staff-sandbox-model design contract -----
	//
	// `sandboxed` is a persisted boolean on PersistedStaff: chosen at creation,
	// stored on the record, immutable for the staff's lifetime. The project's
	// sandbox config is NEVER consulted in the staff path. Replaces the earlier
	// (broken) behaviour that synthesised the field from project config in GET.

	test("GET /api/staff/:id returns the persisted sandboxed boolean (default false)", async () => {
		// sharedStaff was created without an explicit `sandboxed` field —
		// the default must be `false`.
		const res = await apiFetch(`/api/staff/${sharedStaff.id}`, {});
		expect(res.ok).toBe(true);
		const staff = await res.json();
		expect(typeof staff.sandboxed).toBe("boolean");
		expect(staff.sandboxed).toBe(false);
	});

	test("GET /api/staff list returns sandboxed as a boolean on every item", async () => {
		const res = await apiFetch(`/api/staff`, {});
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(Array.isArray(data.staff)).toBe(true);
		for (const s of data.staff) {
			expect(typeof s.sandboxed).toBe("boolean");
		}
	});

	test("POST /api/staff omitting sandboxed → GET returns false", async () => {
		const staff = await apiCreateStaff(token, {
			name: "NoSandboxField Bot",
			systemPrompt: "x",
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		expect(staff.sandboxed).toBe(false);

		// Round-trip via GET to confirm the API surface agrees.
		const res = await apiFetch(`/api/staff/${staff.id}`, {});
		const fetched = await res.json();
		expect(fetched.sandboxed).toBe(false);
	});

	test("POST /api/staff with sandboxed: false explicitly → GET returns false", async () => {
		const project = await defaultProject();
		const res = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: "ExplicitFalseSandbox Bot",
				systemPrompt: "x",
				cwd: project.rootPath,
				projectId: project.id,
				sandboxed: false,
			}),
		});
		expect(res.status).toBe(201);
		const staff = await res.json();
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		expect(staff.sandboxed).toBe(false);

		const getRes = await apiFetch(`/api/staff/${staff.id}`, {});
		const fetched = await getRes.json();
		expect(fetched.sandboxed).toBe(false);
	});

	test("sandboxed is persisted to staff.json on disk (survives reload)", async ({ gateway }) => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");

		const staff = await apiCreateStaff(token, {
			name: "PersistedSandbox Bot",
			systemPrompt: "x",
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		// staff.json lives under <project-rootPath>/.bobbit/state/staff.json.
		// The in-process harness registers the default project at `bobbitDir`.
		const staffJsonPath = join(gateway.bobbitDir, ".bobbit", "state", "staff.json");
		const raw = readFileSync(staffJsonPath, "utf-8");
		const persisted = JSON.parse(raw) as Array<Record<string, unknown>>;
		const record = persisted.find((s) => s.id === staff.id);
		expect(record, "staff record must be written to staff.json").toBeTruthy();
		expect(record!.sandboxed, "sandboxed must be persisted as a real boolean (not derived at GET time)").toBe(false);

		// Simulate "server restart" at the data-model level by reloading the
		// store from disk. The full in-process harness has no reboot path, but
		// proving the JSON contains the field is equivalent: a fresh StaffStore
		// constructed against the same dir would read it back (see
		// tests/staff-sandboxed-persistence.test.ts for that pinning).
	});

	test("PUT /api/staff/:id { sandboxed: true } silently drops the field (immutable after creation)", async () => {
		const staff = await apiCreateStaff(token, {
			name: "ImmutableSandbox Bot",
			systemPrompt: "x",
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		expect(staff.sandboxed).toBe(false);

		// Attempt to flip sandboxed via PUT. The server's allow-list does NOT
		// forward `body.sandboxed` to staffManager.updateStaff — the field is
		// silently dropped (no 400, no error).
		const putRes = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ sandboxed: true, description: "updated" }),
		});
		expect(putRes.ok).toBe(true);

		// GET must still return the original value.
		const getRes = await apiFetch(`/api/staff/${staff.id}`, {});
		const fetched = await getRes.json();
		expect(fetched.sandboxed).toBe(false);
		// Sanity: other fields in the same PUT still take effect, proving the
		// allow-list isn't blanket-rejecting the request.
		expect(fetched.description).toBe("updated");
	});

	test("PUT /api/staff/:id { sandboxed: false } silently drops the field too (no PUT path for the value)", async () => {
		// Same shape as the truthy attempt above — the API has no PUT path for
		// the field at all, so passing the existing value is also a no-op.
		const staff = await apiCreateStaff(token, {
			name: "NoPutPath Bot",
			systemPrompt: "x",
		});
		cleanupStaffIds.push(staff.id);
		if (staff.currentSessionId) cleanupSessionIds.push(staff.currentSessionId);

		const putRes = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ sandboxed: false }),
		});
		expect(putRes.ok).toBe(true);

		const getRes = await apiFetch(`/api/staff/${staff.id}`, {});
		const fetched = await getRes.json();
		expect(fetched.sandboxed).toBe(false);
	});

	// Removed: "POST /api/staff/:id/wake refreshes worktree from primary branch"
	// — worktree refresh now lives inside `StaffManager.ensureSessionForStaff`,
	// which is invoked by the InboxNudger when it decides to deliver a digest.
	// It is no longer synchronously triggered by a REST call, so the timing
	// assertions don't fit the new architecture. Refresh behaviour itself is
	// preserved (moved verbatim into the helper).
});
