import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProject } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const ACCESSORY_ID = "wizard-hat";
const ACCESSORY_LABEL = "Wizard Hat";

type StaffRecord = {
	id: string;
	name: string;
	currentSessionId?: string | null;
	accessory?: string;
};

type SessionRecord = {
	id: string;
	accessory?: string;
};

async function readJson<T>(path: string): Promise<T> {
	const res = await apiFetch(path);
	expect(res.ok, `${path} should succeed: ${res.status} ${await res.clone().text().catch(() => "")}`).toBe(true);
	return await res.json() as T;
}

function accessoryButton(page: import("@playwright/test").Page) {
	return page.locator(`button[title="${ACCESSORY_LABEL}"]`).filter({ hasText: ACCESSORY_LABEL }).first();
}

async function expectAccessoryPickerSelection(page: import("@playwright/test").Page): Promise<void> {
	await expect(accessoryButton(page)).toBeVisible({ timeout: 10_000 });
	await expect
		.poll(
			async () => await accessoryButton(page).evaluate((el) => el.className.toString()),
			{
				timeout: 10_000,
				message: "STAFF_ACCESSORY_BROWSER_PICKER_SELECTION: edit picker should show the saved accessory as selected",
			},
		)
		.toContain("ring-2");
}

async function expectSidebarAccessoryOverlay(page: import("@playwright/test").Page, staffName: string): Promise<void> {
	const row = page
		.locator('[data-testid="sidebar-expanded"]')
		.locator('[data-nav-id^="session:"]')
		.filter({ hasText: staffName })
		.first();
	await expect(row, "STAFF_ACCESSORY_BROWSER_SIDEBAR_ROW: staff row should be visible in the sidebar").toBeVisible({ timeout: 15_000 });
	await expect
		.poll(
			async () => await row.locator("img").count(),
			{
				timeout: 10_000,
				message: "STAFF_ACCESSORY_BROWSER_SIDEBAR_ICON: sidebar staff icon should render the accessory overlay layer",
			},
		)
		.toBeGreaterThan(1);
}

test.describe("Staff accessory persistence", () => {
	test("staff edit accessory picker persists to staff API, session metadata, sidebar, and reload", async ({ page }) => {
		const project = await defaultProject();
		const sessionsToDelete = new Set<string>();
		let staff: StaffRecord | undefined;

		try {
			const createRes = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({
					name: `StaffAccessory${Date.now().toString(36)}`,
					description: "Browser E2E staff accessory persistence fixture.",
					systemPrompt: "Keep the selected accessory persisted on the staff record.",
					cwd: project.rootPath,
					projectId: project.id,
					worktree: false,
					sandboxed: false,
				}),
			});
			expect(createRes.status, `staff create failed: ${await createRes.clone().text().catch(() => "")}`).toBe(201);
			staff = await createRes.json() as StaffRecord;
			expect(staff.currentSessionId, "staff create should materialize a current permanent session").toBeTruthy();
			if (staff.currentSessionId) sessionsToDelete.add(staff.currentSessionId);

			await openApp(page);
			await navigateToHash(page, `#/staff/${staff.id}`);
			await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });

			const option = accessoryButton(page);
			await expect(option).toBeVisible({ timeout: 10_000 });
			await option.click();
			await expectAccessoryPickerSelection(page);

			const saveButton = page.getByRole("button", { name: "Save Changes" });
			await expect(saveButton).toBeEnabled({ timeout: 5_000 });
			const staffUpdateResponse = page.waitForResponse((resp) =>
				resp.request().method() === "PUT" && resp.url().includes(`/api/staff/${staff!.id}`),
			);
			await saveButton.click();
			const updateResp = await staffUpdateResponse;
			expect(updateResp.ok(), `staff update failed: ${updateResp.status()} ${await updateResp.text().catch(() => "")}`).toBe(true);
			const updatePayload = updateResp.request().postDataJSON() as Record<string, unknown>;
			expect.soft(
				updatePayload.accessory,
				"STAFF_ACCESSORY_BROWSER_PUT_PAYLOAD: staff edit save should send accessory to PUT /api/staff/:id",
			).toBe(ACCESSORY_ID);

			const updatedStaff = await readJson<StaffRecord>(`/api/staff/${staff.id}`);
			expect(
				updatedStaff.accessory,
				"STAFF_ACCESSORY_BROWSER_API_PERSISTENCE: GET /api/staff/:id should return the saved accessory",
			).toBe(ACCESSORY_ID);
			if (updatedStaff.currentSessionId) sessionsToDelete.add(updatedStaff.currentSessionId);

			const sessionId = updatedStaff.currentSessionId || staff.currentSessionId;
			expect(sessionId, "saved staff should still have a current session for sidebar rendering").toBeTruthy();
			const updatedSession = await readJson<SessionRecord>(`/api/sessions/${sessionId}`);
			expect(
				updatedSession.accessory,
				"STAFF_ACCESSORY_BROWSER_SESSION_MIRROR: linked staff session should mirror the saved accessory",
			).toBe(ACCESSORY_ID);

			await expectSidebarAccessoryOverlay(page, staff.name);

			await page.reload();
			await navigateToHash(page, `#/staff/${staff.id}`);
			await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });
			await expectAccessoryPickerSelection(page);
		} finally {
			if (staff?.id) {
				await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => {});
			}
			for (const sessionId of sessionsToDelete) {
				await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			}
		}
	});
});
