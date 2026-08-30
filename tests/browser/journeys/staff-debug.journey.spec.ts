/**
 * Journey: Staff + Debug Tools — v2 browser smoke
 * Covers: journey-staff, journey-debug-tools
 * Consolidated from: staff-inbox, debug-panel, api-error-modal, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch, defaultProject } from "../../../tests2/browser/_helpers/journey-fixture.js";

const PONYTAIL_ID = "ponytail";
const PONYTAIL_LABEL = "Ponytail";

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
	const response = await apiFetch(path);
	expect(response.ok, `${path} should succeed: ${response.status} ${await response.clone().text().catch(() => "")}`).toBe(true);
	return await response.json() as T;
}

function ponytailButton(page: import("@playwright/test").Page) {
	return page.locator(`button[title="${PONYTAIL_LABEL}"]`).filter({ hasText: PONYTAIL_LABEL }).first();
}

function staffAccessorySelect(page: import("@playwright/test").Page) {
	return page.getByTestId("staff-accessory-select");
}

async function expectPonytailSelected(page: import("@playwright/test").Page): Promise<void> {
	await expect(staffAccessorySelect(page)).toBeVisible({ timeout: 10_000 });
	await expect(staffAccessorySelect(page)).toHaveAttribute("data-value", PONYTAIL_ID);
	await expect(staffAccessorySelect(page).locator("img")).toHaveCount(2);
}

test.describe("Journey: Staff", () => {
	test("settings staff section navigable", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test("sidebar remains stable during staff route", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("staff page renders with 'Staff Agents' heading", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/staff");
		// The staff page always renders the "Staff Agents" h1 heading.
		await expect(page.locator("h1").filter({ hasText: "Staff Agents" })).toBeVisible({ timeout: 15_000 });
	});

	test("staff page shows empty-state or table when there are no staff agents", async ({ page }) => {
		await openApp(page);
		const staffListResponse = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return response.request().method() === "GET" && url.pathname === "/api/staff";
		});
		await navigateToHash(page, "#/staff");
		const response = await staffListResponse;
		const responseText = await response.text();
		expect(response.ok(), `staff list failed: ${response.status()} ${responseText}`).toBe(true);
		const payload = JSON.parse(responseText) as StaffRecord[] | { staff?: StaffRecord[] };
		const staffAgents = Array.isArray(payload) ? payload : (payload.staff ?? []);

		await expect(page.locator("h1").filter({ hasText: "Staff Agents" })).toBeVisible({ timeout: 15_000 });
		const emptyState = page.getByText("No staff agents yet");
		const staffTable = page.locator("table");
		if (staffAgents.length === 0) {
			await expect(emptyState).toBeVisible({ timeout: 20_000 });
			await expect(staffTable).toHaveCount(0);
		} else {
			await expect(staffTable).toBeVisible({ timeout: 20_000 });
			await expect(staffTable.locator("tbody tr")).toHaveCount(staffAgents.length);
			await expect(emptyState).toHaveCount(0);
		}
	});
});

test.describe("Journey: Debug Tools", () => {
	test("app shell loads correctly for debug scenario", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("app title is set", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	test("settings general page renders Appearance section", async ({ page }) => {
		// The general settings tab contains the Appearance heading and the
		// debug-mode-toggle area (visible in dev-harness mode only).
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		// The Settings h1 must appear.
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 15_000 });
		// The Appearance section heading must be present.
		await expect(page.getByTestId("general-appearance-heading")).toBeVisible({ timeout: 20_000 });
	});

	test("send message → mock agent response appears (tool renderer output path)", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("debug test");
			await editor.press("Enter");
			// The mock agent responds with "OK" — proves the message renderer renders agent output
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});

// Ported from staff-sub-section.spec.ts and extended to cover the staff row's
// canonical session actions across desktop, reload, keyboard, and mobile paths.
test.describe("Journey: Staff Sidebar Actions", () => {
	test("staff row actions match sessions across desktop, reload, keyboard, and mobile", async ({ page }) => {
		test.setTimeout(90_000);
		const project = await defaultProject();
		let staff: StaffRecord | undefined;
		try {
			const resp = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({
					name: `v2-staff-${Date.now()}`,
					systemPrompt: "You are a sidebar test bot.",
					cwd: project.rootPath, projectId: project.id,
				}),
			});
			expect(resp.status).toBe(201);
			staff = await resp.json() as StaffRecord;
			expect(staff.currentSessionId).toBeTruthy();
			await waitForSessionStatus(staff.currentSessionId!, "idle");

			await page.setViewportSize({ width: 1280, height: 900 });
			await openApp(page);
			const header = page.locator(`[data-testid='sidebar-staff-header'][data-nav-id="staff-header:${project.id}"]`).first();
			await expect(header).toBeVisible({ timeout: 20_000 });
			const row = page.locator(`[data-nav-id="session:${staff.currentSessionId}"]`).filter({ hasText: staff.name }).first();
			const trigger = row.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-id="${staff.currentSessionId}"]`).first();
			await expect(row).toBeVisible({ timeout: 20_000 });
			await row.hover();
			await expect(row.locator('[data-session-action-id="modify"][data-sidebar-action-quick="true"]')).toBeVisible();
			await expect(row.locator('[data-session-action-id="terminate"][data-sidebar-action-quick="true"]')).toBeVisible();
			await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
			await trigger.focus();
			await trigger.press("ArrowDown");
			const menu = page.locator("sidebar-actions-popover [role='menu']");
			await expect(menu).toBeVisible({ timeout: 5_000 });
			await expect(trigger).toHaveAttribute("aria-expanded", "true");
			for (const actionId of ["modify", "terminate", "refresh-agent", "fork", "copy-link", "view-system-prompt", "open-new-window"]) {
				await expect(page.locator(`sidebar-actions-popover [role="menuitem"][data-session-action-id="${actionId}"]`).first()).toBeVisible();
			}
			await expect(page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="modify"]').first()).toContainText("Edit staff");
			await page.keyboard.press("Escape");
			await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
			await expect(trigger).toBeFocused();

			await trigger.press("Enter");
			await page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="modify"]').first().click();
			await expect(page).toHaveURL(new RegExp(`#/staff/${staff.id}$`));
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });

			await page.setViewportSize({ width: 390, height: 820 });
			await navigateToHash(page, "#/");
			const mobileRow = page.locator(`[data-nav-id="session:${staff.currentSessionId}"]`).filter({ hasText: staff.name }).first();
			const mobileTrigger = mobileRow.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-id="${staff.currentSessionId}"]`).first();
			await expect(mobileRow).toBeVisible({ timeout: 15_000 });
			await expect(mobileRow.locator('[data-session-action-id="modify"][data-sidebar-action-quick="true"]')).toBeVisible();
			await expect(mobileRow.locator('[data-session-action-id="terminate"][data-sidebar-action-quick="true"]')).toBeVisible();
			const startingHash = await page.evaluate(() => window.location.hash);
			await mobileTrigger.click();
			await expect(menu).toBeVisible({ timeout: 5_000 });
			await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(startingHash);
			await page.keyboard.press("Escape");
			await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
		} finally {
			if (staff?.id) await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => {});
			if (staff?.currentSessionId) await deleteSession(staff.currentSessionId).catch(() => {});
		}
	});
});

// Ported from staff-role.spec.ts (audit: staff-debug GAP): the staff edit page
// exposes the role select and renders the staff identity beside the name field.
test.describe("Journey: Staff Role Select", () => {
	test("staff edit page exposes the role select and avatar beside the name", async ({ page }) => {
		const project = await defaultProject();
		let staffId = "";
		let currentSessionId = "";
		try {
			const resp = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({ name: `v2-staffrole-${Date.now()}`, systemPrompt: "role test bot", cwd: project.rootPath, projectId: project.id }),
			});
			expect(resp.status).toBe(201);
			const createdStaff = await resp.json() as { id: string; currentSessionId?: string };
			staffId = createdStaff.id;
			currentSessionId = createdStaff.currentSessionId || "";
			expect(currentSessionId).not.toBe("");
			const sessionResponse = await apiFetch(`/api/sessions/${currentSessionId}`);
			expect(sessionResponse.status).toBe(200);
			const runtimeCwd = (await sessionResponse.json() as { cwd: string }).cwd;
			await openApp(page);
			await navigateToHash(page, `#/staff/${staffId}`);
			await expect(page.locator('[data-testid="staff-role-select"]').first()).toBeVisible({ timeout: 15_000 });

			const headerActions = page.getByTestId("staff-edit-header-actions");
			await expect(headerActions.getByRole("button", { name: "Cancel" })).toBeVisible();
			await expect(headerActions.getByRole("button", { name: "Save Changes" })).toBeVisible();
			await expect(page.getByRole("button", { name: "Save Changes" })).toHaveCount(1);
			await expect(page.getByRole("button", { name: "Wake Now" })).toHaveCount(0);
			await expect(page.getByRole("button", { name: "View Session" })).toHaveCount(0);

			for (const picker of [
				{ testId: "staff-role-select", listName: "Role options" },
				{ testId: "staff-accessory-select", listName: "Accessory options" },
				{ testId: "staff-color-select", listName: "Colour options" },
			]) {
				const trigger = page.getByTestId(picker.testId);
				await trigger.focus();
				await page.keyboard.press("ArrowDown");
				const listbox = page.getByRole("listbox", { name: picker.listName });
				await expect(listbox).toBeVisible();
				await expect(listbox.locator('[role="option"]:focus')).toHaveCount(1);
				await page.keyboard.press("End");
				await expect(listbox.getByRole("option").last()).toBeFocused();
				await page.keyboard.press("Home");
				await expect(listbox.getByRole("option").first()).toBeFocused();
				await page.keyboard.press("Escape");
				await expect(listbox).toHaveCount(0);
				await expect(trigger).toBeFocused();
			}

			const tabs = page.getByTestId("staff-edit-tabs");
			const promptTab = tabs.getByRole("button", { name: "Prompt" });
			const triggersTab = tabs.getByRole("button", { name: "Triggers" });
			await expect(promptTab).toHaveAttribute("aria-pressed", "true");
			await expect(page.getByTestId("staff-prompt-tab-panel")).toBeVisible();
			await expect(page.getByTestId("staff-triggers-tab-panel")).toHaveCount(0);
			await triggersTab.click();
			await expect(triggersTab).toHaveAttribute("aria-pressed", "true");
			await expect(page.getByTestId("staff-triggers-tab-panel")).toBeVisible();
			await expect(page.getByTestId("staff-prompt-tab-panel")).toHaveCount(0);
			await promptTab.click();

			const avatar = page.locator('[data-testid="staff-edit-avatar"]');
			const avatarSprite = page.getByTestId("staff-edit-avatar-sprite");
			const avatarCanvas = avatar.locator("canvas");
			const nameField = page.locator('[data-testid="staff-edit-name-field"]');
			const cwdField = page.locator('[data-testid="staff-edit-cwd-field"]');
			const sandboxField = page.getByTestId("staff-edit-sandbox-field");
			const descriptionField = page.getByTestId("staff-edit-description-field");
			const identitySelects = page.getByTestId("staff-identity-selects");
			await expect(avatar).toBeVisible();
			await expect(avatarSprite).toHaveCSS("left", "44px");
			await expect(avatarSprite.locator(":scope > div > div")).toHaveCSS("overflow", "visible");
			await expect(avatarCanvas).toBeVisible();
			const [avatarBox, avatarSpriteBox, canvasBox, nameBox, cwdBox, sandboxBox, nameLabelBox, nameInputBox, cwdLabelBox, cwdInputBox] = await Promise.all([
				avatar.boundingBox(),
				avatarSprite.boundingBox(),
				avatarCanvas.boundingBox(),
				nameField.boundingBox(),
				cwdField.boundingBox(),
				sandboxField.boundingBox(),
				nameField.locator("label").boundingBox(),
				nameField.locator("input").boundingBox(),
				cwdField.locator("label").boundingBox(),
				cwdField.locator("input").boundingBox(),
			]);
			expect(avatarBox).not.toBeNull();
			expect(avatarSpriteBox).not.toBeNull();
			expect(canvasBox).not.toBeNull();
			expect(nameBox).not.toBeNull();
			expect(cwdBox).not.toBeNull();
			expect(sandboxBox).not.toBeNull();
			expect(nameLabelBox).not.toBeNull();
			expect(nameInputBox).not.toBeNull();
			expect(cwdLabelBox).not.toBeNull();
			expect(cwdInputBox).not.toBeNull();
			expect(avatarBox!.width).toBeCloseTo(124, 0);
			expect(avatarBox!.height).toBeCloseTo(124, 0);
			expect(avatarSpriteBox!.width).toBeCloseTo(76, 0);
			expect(avatarSpriteBox!.height).toBeCloseTo(76, 0);
			expect(avatarSpriteBox!.x + avatarSpriteBox!.width / 2).toBeCloseTo(avatarBox!.x + avatarBox!.width / 2 + 44, 0);
			expect(avatarSpriteBox!.y + avatarSpriteBox!.height / 2).toBeCloseTo(avatarBox!.y + avatarBox!.height / 2, 0);
			expect(canvasBox!.x + canvasBox!.width).toBeLessThanOrEqual(nameBox!.x);
			expect(Math.abs(nameLabelBox!.y + nameLabelBox!.height / 2 - (nameInputBox!.y + nameInputBox!.height / 2))).toBeLessThanOrEqual(1);
			expect(Math.abs(cwdLabelBox!.y + cwdLabelBox!.height / 2 - (cwdInputBox!.y + cwdInputBox!.height / 2))).toBeLessThanOrEqual(1);
			expect(cwdBox!.y).toBeGreaterThan(nameBox!.y + nameBox!.height);
			expect(sandboxBox!.y).toBeGreaterThan(cwdBox!.y + cwdBox!.height);
			expect(cwdInputBox!.x).toBeCloseTo(nameInputBox!.x, 0);
			await expect(nameField.locator("label")).toHaveCSS("text-align", "right");
			await expect(cwdField.locator("label")).toHaveCSS("text-align", "right");
			await expect(sandboxField.locator("label")).toHaveCSS("text-align", "right");
			await expect(sandboxField.locator("div")).toHaveText("Disabled");
			await expect(cwdField.locator("input")).toHaveAttribute("readonly", "");
			await expect(cwdField.locator("input")).toHaveValue(runtimeCwd);
			const [descriptionBox, identityBox, roleBox, accessoryBox, colorBox] = await Promise.all([
				descriptionField.boundingBox(),
				identitySelects.boundingBox(),
				page.getByTestId("staff-role-select").boundingBox(),
				page.getByTestId("staff-accessory-select").boundingBox(),
				page.getByTestId("staff-color-select").boundingBox(),
			]);
			expect(descriptionBox).not.toBeNull();
			expect(identityBox).not.toBeNull();
			expect(roleBox).not.toBeNull();
			expect(accessoryBox).not.toBeNull();
			expect(colorBox).not.toBeNull();
			expect(identityBox!.y).toBeGreaterThanOrEqual(descriptionBox!.y + descriptionBox!.height);
			expect(accessoryBox!.y).toBeCloseTo(roleBox!.y, 0);
			expect(colorBox!.y).toBeCloseTo(roleBox!.y, 0);
			const [accessoryPreviewBox, colorPreviewBox] = await Promise.all([
				page.getByTestId("staff-accessory-select").getByTestId("staff-picker-sprite").boundingBox(),
				page.getByTestId("staff-color-select").getByTestId("staff-picker-sprite").boundingBox(),
			]);
			expect(accessoryPreviewBox).not.toBeNull();
			expect(colorPreviewBox).not.toBeNull();
			expect(colorPreviewBox!.width).toBeCloseTo(accessoryPreviewBox!.width, 0);
			expect(colorPreviewBox!.height).toBeCloseTo(accessoryPreviewBox!.height, 0);
			await expect(page.getByTestId("staff-color-select")).not.toContainText(/Colour \d+/);

			await page.setViewportSize({ width: 360, height: 640 });
			const saveBox = await headerActions.getByRole("button", { name: "Save Changes" }).boundingBox();
			expect(saveBox).not.toBeNull();
			expect(saveBox!.x).toBeGreaterThanOrEqual(0);
			expect(saveBox!.x + saveBox!.width).toBeLessThanOrEqual(360);
		} finally {
			if (staffId) await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});

// Browser-level coverage for the ponytail's user-facing happy path: picker
// visibility, persistence into the linked session/sidebar, real CSS rendering
// and animation, reload, and cleanup.
test.describe("Journey: Ponytail Accessory", () => {
	test("ponytail renders, animates, persists across reload, and cleans up", async ({ page }) => {
		const project = await defaultProject();
		const sessionsToDelete = new Set<string>();
		let staff: StaffRecord | undefined;

		try {
			const createResponse = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({
					name: `PonytailStaff${Date.now().toString(36)}`,
					description: "Browser journey for the ponytail accessory.",
					systemPrompt: "Keep the selected ponytail accessory persisted.",
					cwd: project.rootPath,
					projectId: project.id,
					worktree: false,
					sandboxed: false,
				}),
			});
			expect(createResponse.status, `staff create failed: ${await createResponse.clone().text().catch(() => "")}`).toBe(201);
			staff = await createResponse.json() as StaffRecord;
			expect(staff.currentSessionId, "staff creation should materialize a permanent session").toBeTruthy();
			if (staff.currentSessionId) sessionsToDelete.add(staff.currentSessionId);

			await openApp(page);
			await navigateToHash(page, `#/staff/${staff.id}`);
			await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });

			const identitySelects = page.getByTestId("staff-identity-selects");
			const roleSelect = page.getByTestId("staff-role-select");
			const accessorySelect = staffAccessorySelect(page);
			await expect(identitySelects).toBeVisible({ timeout: 10_000 });
			await expect(accessorySelect).toBeVisible();
			const [roleBox, accessoryBox] = await Promise.all([roleSelect.boundingBox(), accessorySelect.boundingBox()]);
			expect(roleBox).not.toBeNull();
			expect(accessoryBox).not.toBeNull();
			expect(accessoryBox!.y).toBeCloseTo(roleBox!.y, 0);
			await accessorySelect.click();
			const option = page.getByRole("option", { name: PONYTAIL_LABEL, exact: true });
			await expect(option).toBeVisible();
			await expect(option.locator("img")).toHaveCount(2);
			const nudgedSprite = option.getByTestId("staff-picker-sprite").locator(":scope > span");
			await expect(nudgedSprite).toHaveCSS("left", "2px");
			await expect(nudgedSprite).toHaveCSS("top", "1px");
			await option.click();
			await expectPonytailSelected(page);

			const saveButton = page.getByRole("button", { name: "Save Changes" });
			await expect(saveButton).toBeEnabled({ timeout: 5_000 });
			const staffUpdate = page.waitForResponse((response) =>
				response.request().method() === "PUT" && response.url().includes(`/api/staff/${staff!.id}`),
			);
			await saveButton.click();
			const updateResponse = await staffUpdate;
			expect(updateResponse.ok(), `staff update failed: ${updateResponse.status()} ${await updateResponse.text().catch(() => "")}`).toBe(true);
			expect((updateResponse.request().postDataJSON() as Record<string, unknown>).accessory).toBe(PONYTAIL_ID);

			const updatedStaff = await readJson<StaffRecord>(`/api/staff/${staff.id}`);
			expect(updatedStaff.accessory).toBe(PONYTAIL_ID);
			if (updatedStaff.currentSessionId) sessionsToDelete.add(updatedStaff.currentSessionId);
			const sessionId = updatedStaff.currentSessionId || staff.currentSessionId;
			expect(sessionId).toBeTruthy();
			const updatedSession = await readJson<SessionRecord>(`/api/sessions/${sessionId}`);
			expect(updatedSession.accessory, "linked staff session should mirror the ponytail").toBe(PONYTAIL_ID);

			const sidebarRow = page
				.locator('[data-testid="sidebar-expanded"] [data-nav-id^="session:"]')
				.filter({ hasText: staff.name })
				.first();
			await expect(sidebarRow).toBeVisible({ timeout: 15_000 });
			await expect.poll(
				async () => await sidebarRow.locator("img").count(),
				{ timeout: 10_000, message: "sidebar staff avatar should render the ponytail image layer" },
			).toBeGreaterThan(1);

			// The role manager uses the actual CSS overlay path rather than the
			// sidebar's static image renderer, so this proves browser visibility
			// and the sleeping-idle animation with the shipped stylesheet.
			await navigateToHash(page, "#/roles/general");
			await expect(page.locator('[data-testid="role-editor"]').first()).toBeVisible({ timeout: 15_000 });
			const rolePreviewOverlay = ponytailButton(page).locator(".bobbit-blob__ponytail");
			await expect(rolePreviewOverlay).toBeVisible({ timeout: 10_000 });
			const overlayStyle = await rolePreviewOverlay.evaluate((element) => {
				const style = getComputedStyle(element);
				return { display: style.display, animationName: style.animationName, boxShadow: style.boxShadow };
			});
			expect(overlayStyle.display).toBe("block");
			expect(overlayStyle.animationName).toContain("blob-ponytail-idle-sleep-breathe");
			expect(overlayStyle.boxShadow).not.toBe("none");

			await navigateToHash(page, `#/staff/${staff.id}`);
			await page.reload();
			await navigateToHash(page, `#/staff/${staff.id}`);
			await expect(page.getByRole("heading", { name: staff.name })).toBeVisible({ timeout: 15_000 });
			await expectPonytailSelected(page);
		} finally {
			if (staff?.id) await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => {});
			for (const sessionId of sessionsToDelete) {
				await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			}
		}
	});
});
