import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProject } from "./e2e-setup.js";

const CREATE_ACCESSORY = "wizard-hat";
const STALE_SESSION_ACCESSORY = "bandana";
const PERSISTED_ACCESSORY = "crown";

type StaffRecord = {
	id: string;
	projectId?: string;
	currentSessionId?: string;
	accessory?: string;
};

async function createStaffWithAccessory(): Promise<StaffRecord> {
	const project = await defaultProject();
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name: `Accessory Persistence ${Date.now()}`,
			description: "Reproduces staff accessory persistence loss.",
			systemPrompt: "Keep the selected accessory across staff session recreation.",
			cwd: project.rootPath,
			projectId: project.id,
			worktree: false,
			accessory: CREATE_ACCESSORY,
		}),
	});
	expect(res.status, `staff create failed: ${await res.clone().text().catch(() => "")}`).toBe(201);
	return await res.json();
}

async function readJson(path: string): Promise<any> {
	const res = await apiFetch(path);
	expect(res.ok, `${path} should return JSON: ${res.status} ${await res.clone().text().catch(() => "")}`).toBeTruthy();
	return await res.json();
}

function persistedStaffRecord(staffJsonPath: string, staffId: string): Record<string, unknown> | undefined {
	const raw = readFileSync(staffJsonPath, "utf-8");
	const records = JSON.parse(raw) as Array<Record<string, unknown>>;
	return records.find((record) => record.id === staffId);
}

function projectContext(gateway: any, projectId: string): any {
	const pcm = gateway.sessionManager.getProjectContextManager?.() ?? gateway.projectContextManager;
	const ctx = pcm?.getOrCreate(projectId);
	if (!ctx) throw new Error(`missing project context for ${projectId}`);
	return { pcm, ctx };
}

test.describe("Staff accessory persistence", () => {
	test("persists staff accessory via staff API and applies it to recreated staff sessions", async ({ gateway }) => {
		let staff: StaffRecord | undefined;
		let initialSessionId: string | undefined;
		let recreatedSessionId: string | undefined;

		try {
			staff = await createStaffWithAccessory();
			initialSessionId = staff.currentSessionId;
			expect(initialSessionId, "staff create should materialize a permanent session").toBeTruthy();
			expect(staff.projectId, "staff create should return the selected projectId").toBeTruthy();

			expect.soft(
				staff.accessory,
				"STAFF_ACCESSORY_PERSISTENCE_CREATE_RESPONSE: accessory should be persisted and returned on POST /api/staff",
			).toBe(CREATE_ACCESSORY);

			const createdSession = await readJson(`/api/sessions/${initialSessionId}`);
			expect.soft(
				createdSession.accessory,
				"STAFF_ACCESSORY_PERSISTENCE_CREATE_SESSION: accessory should be applied to the staff permanent session created by POST /api/staff",
			).toBe(CREATE_ACCESSORY);

			// Mimic today's buggy UI path: the accessory can exist only on the current session.
			const sessionPatch = await apiFetch(`/api/sessions/${initialSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ accessory: STALE_SESSION_ACCESSORY }),
			});
			expect(sessionPatch.ok, `session accessory patch failed: ${await sessionPatch.clone().text().catch(() => "")}`).toBeTruthy();

			const updateRes = await apiFetch(`/api/staff/${staff.id}`, {
				method: "PUT",
				body: JSON.stringify({ accessory: PERSISTED_ACCESSORY }),
			});
			expect(updateRes.ok, `staff accessory update failed: ${await updateRes.clone().text().catch(() => "")}`).toBeTruthy();
			const updated = await updateRes.json();
			expect.soft(
				updated.accessory,
				"STAFF_ACCESSORY_PERSISTENCE_PUT_RESPONSE: accessory should be persisted and returned on PUT /api/staff/:id",
			).toBe(PERSISTED_ACCESSORY);

			const fetched = await readJson(`/api/staff/${staff.id}`);
			expect.soft(
				fetched.accessory,
				"STAFF_ACCESSORY_PERSISTENCE_GET_RESPONSE: accessory should round-trip through GET /api/staff/:id",
			).toBe(PERSISTED_ACCESSORY);

			const listed = await readJson("/api/staff");
			const listedStaff = (listed.staff as StaffRecord[]).find((entry) => entry.id === staff!.id);
			expect(listedStaff, "created staff should appear in GET /api/staff").toBeTruthy();
			expect.soft(
				listedStaff?.accessory,
				"STAFF_ACCESSORY_PERSISTENCE_LIST_RESPONSE: accessory should be included in GET /api/staff list entries",
			).toBe(PERSISTED_ACCESSORY);

			const project = await defaultProject();
			const staffJsonPath = join(project.rootPath, ".bobbit", "state", "staff.json");
			const persisted = persistedStaffRecord(staffJsonPath, staff.id);
			expect(persisted, "staff record must be written to staff.json").toBeTruthy();
			expect.soft(
				persisted?.accessory,
				"STAFF_ACCESSORY_PERSISTENCE_STAFF_JSON: accessory should be written to staff.json as first-class staff data",
			).toBe(PERSISTED_ACCESSORY);

			const mirroredSession = await readJson(`/api/sessions/${initialSessionId}`);
			expect.soft(
				mirroredSession.accessory,
				"STAFF_ACCESSORY_PERSISTENCE_SESSION_MIRROR: PUT /api/staff/:id should mirror accessory onto the current staff session",
			).toBe(PERSISTED_ACCESSORY);

			const { pcm, ctx } = projectContext(gateway, staff.projectId!);
			ctx.staffStore.update(staff.id, { currentSessionId: null });

			const { StaffManager } = await import("../../dist/server/agent/staff-manager.js");
			const staffManager = new StaffManager(pcm);
			recreatedSessionId = await staffManager.ensureSessionForStaff(staff.id, gateway.sessionManager);
			expect(recreatedSessionId, "ensureSessionForStaff should recreate a permanent session when currentSessionId is missing").toBeTruthy();
			expect(recreatedSessionId, "session recreation should create a replacement permanent session").not.toBe(initialSessionId);

			const recreatedSession = await readJson(`/api/sessions/${recreatedSessionId}`);
			expect.soft(
				recreatedSession.accessory,
				"STAFF_ACCESSORY_PERSISTENCE_RECREATED_SESSION: recreated staff session should inherit persisted staff accessory",
			).toBe(PERSISTED_ACCESSORY);
		} finally {
			if (staff?.id) {
				await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => {});
			}
			for (const sessionId of [recreatedSessionId, initialSessionId].filter(Boolean) as string[]) {
				await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			}
		}
	});
});
