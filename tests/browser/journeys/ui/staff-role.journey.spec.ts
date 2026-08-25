import { test, expect } from "../../_helpers/gateway-harness.js";
import { apiFetch, defaultProject } from "../../_helpers/e2e-setup.js";
import { openApp, navigateToHash } from "../../../support/harnesses/browser/legacy-ui/ui-helpers.js";

// Built-in roles + their accessories (defaults/roles/*.yaml).
const ROLE_A = "architect";
const ROLE_A_ACCESSORY = "set-square";
const ROLE_A_ACCESSORY_LABEL = "Set Square";
const ROLE_B = "coder";

// An accessory distinct from any role's default, used to prove manual override.
const MANUAL_ACCESSORY = "wizard-hat";
const MANUAL_ACCESSORY_LABEL = "Wizard Hat";

type StaffRecord = {
	id: string;
	name: string;
	currentSessionId?: string | null;
	accessory?: string;
	roleId?: string;
};

async function readJson<T>(path: string): Promise<T> {
	const res = await apiFetch(path);
	expect(res.ok, `${path} should succeed: ${res.status} ${await res.clone().text().catch(() => "")}`).toBe(true);
	return await res.json() as T;
}

function roleSelect(page: import("@playwright/test").Page) {
	return page.getByTestId("staff-role-select");
}

async function selectRole(page: import("@playwright/test").Page, value: string, label: string): Promise<void> {
	await roleSelect(page).click();
	const options = page.getByRole("listbox", { name: "Role options" });
	await expect(options).toBeVisible();
	const option = value
		? options.locator(`[role="option"][data-value="${value}"]`)
		: options.getByRole("option", { name: "No role", exact: true });
	await option.click();
	await expect(roleSelect(page)).toContainText(label);
}

function accessorySelect(page: import("@playwright/test").Page) {
	return page.getByTestId("staff-accessory-select");
}

async function selectAccessory(page: import("@playwright/test").Page, value: string, label: string): Promise<void> {
	await accessorySelect(page).click();
	const options = page.getByRole("listbox", { name: "Accessory options" });
	await expect(options).toBeVisible();
	await options.locator(`[role="option"][data-value="${value}"]`).click();
	await expectAccessorySelected(page, value, label);
}

async function expectAccessorySelected(page: import("@playwright/test").Page, value: string, label: string): Promise<void> {
	await expect(accessorySelect(page)).toBeVisible({ timeout: 10_000 });
	await expect(accessorySelect(page)).toHaveAttribute("data-value", value);
	await expect(accessorySelect(page)).toContainText(label);
}

test.describe("Staff role selection", () => {
	test("pick role pre-fills accessory, persists, is overridable, and clears", async ({ page }) => {
		const project = await defaultProject();
		const sessionsToDelete = new Set<string>();
		let staff: StaffRecord | undefined;

		try {
			const createRes = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({
					name: `StaffRole${Date.now().toString(36)}`,
					description: "Browser E2E staff role selection fixture.",
					systemPrompt: "Persist the selected role on the staff record.",
					cwd: project.rootPath,
					projectId: project.id,
					worktree: false,
					sandboxed: false,
				}),
			});
			expect(createRes.status, `staff create failed: ${await createRes.clone().text().catch(() => "")}`).toBe(201);
			staff = await createRes.json() as StaffRecord;
			if (staff.currentSessionId) sessionsToDelete.add(staff.currentSessionId);

			await openApp(page);
			await navigateToHash(page, `#/staff/${staff.id}`);
			await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });

			// Role picker starts with "No role".
			const select = roleSelect(page);
			await expect(select).toBeVisible({ timeout: 10_000 });
			await expect(select).toContainText("No role");

			// Pick a role → accessory pre-fills from the role's default.
			await selectRole(page, ROLE_A, "Architect");
			await expectAccessorySelected(page, ROLE_A_ACCESSORY, ROLE_A_ACCESSORY_LABEL);

			// Save → PUT carries roleId; persisted on the staff record.
			const saveButton = page.getByRole("button", { name: "Save Changes" });
			await expect(saveButton).toBeEnabled({ timeout: 5_000 });
			let putWait = page.waitForResponse((resp) =>
				resp.request().method() === "PUT" && resp.url().includes(`/api/staff/${staff!.id}`),
			);
			await saveButton.click();
			let resp = await putWait;
			expect(resp.ok(), `staff update failed: ${resp.status()}`).toBe(true);
			let payload = resp.request().postDataJSON() as Record<string, unknown>;
			expect.soft(payload.roleId, "STAFF_ROLE_PUT_PAYLOAD: save should send roleId").toBe(ROLE_A);
			expect.soft(payload.accessory, "STAFF_ROLE_PUT_ACCESSORY: save should send pre-filled accessory").toBe(ROLE_A_ACCESSORY);

			let saved = await readJson<StaffRecord>(`/api/staff/${staff.id}`);
			expect(saved.roleId, "STAFF_ROLE_API_PERSISTENCE: GET should return saved roleId").toBe(ROLE_A);
			expect(saved.accessory).toBe(ROLE_A_ACCESSORY);
			if (saved.currentSessionId) sessionsToDelete.add(saved.currentSessionId);

			// Reload → role persists in the picker.
			await page.reload();
			await navigateToHash(page, `#/staff/${staff.id}`);
			await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });
			await expect(roleSelect(page)).toContainText("Architect");
			await expectAccessorySelected(page, ROLE_A_ACCESSORY, ROLE_A_ACCESSORY_LABEL);

			// Accessory remains overridable after a role is in effect: a manual
			// pick must NOT be clobbered by subsequently changing the role.
			await selectAccessory(page, MANUAL_ACCESSORY, MANUAL_ACCESSORY_LABEL);
			await selectRole(page, ROLE_B, "Coder");
			// Manual accessory survives the role change.
			await expectAccessorySelected(page, MANUAL_ACCESSORY, MANUAL_ACCESSORY_LABEL);

			putWait = page.waitForResponse((resp2) =>
				resp2.request().method() === "PUT" && resp2.url().includes(`/api/staff/${staff!.id}`),
			);
			await page.getByRole("button", { name: "Save Changes" }).click();
			resp = await putWait;
			payload = resp.request().postDataJSON() as Record<string, unknown>;
			expect.soft(payload.roleId, "STAFF_ROLE_CHANGE: changed role should be sent").toBe(ROLE_B);
			expect.soft(payload.accessory, "STAFF_ROLE_MANUAL_OVERRIDE: manual accessory must survive role change").toBe(MANUAL_ACCESSORY);

			saved = await readJson<StaffRecord>(`/api/staff/${staff.id}`);
			expect(saved.roleId).toBe(ROLE_B);
			expect(saved.accessory).toBe(MANUAL_ACCESSORY);

			// Clear the role ("No role") → roleId cleared on the server.
			await selectRole(page, "", "No role");
			putWait = page.waitForResponse((resp2) =>
				resp2.request().method() === "PUT" && resp2.url().includes(`/api/staff/${staff!.id}`),
			);
			await page.getByRole("button", { name: "Save Changes" }).click();
			resp = await putWait;
			payload = resp.request().postDataJSON() as Record<string, unknown>;
			expect.soft(payload.roleId, "STAFF_ROLE_CLEAR: clearing role should send roleId=null").toBeNull();

			saved = await readJson<StaffRecord>(`/api/staff/${staff.id}`);
			expect(saved.roleId ?? null, "STAFF_ROLE_CLEAR_PERSISTENCE: cleared role should not persist").toBeNull();

			await page.reload();
			await navigateToHash(page, `#/staff/${staff.id}`);
			await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });
			await expect(roleSelect(page)).toContainText("No role");
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
