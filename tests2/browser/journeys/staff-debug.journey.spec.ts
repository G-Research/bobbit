/**
 * Journey: Staff + Debug Tools — v2 browser smoke
 * Covers: journey-staff, journey-debug-tools
 * Consolidated from: staff-inbox, debug-panel, api-error-modal, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch, defaultProject } from "../_helpers/journey-fixture.js";

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

async function expectPonytailSelected(page: import("@playwright/test").Page): Promise<void> {
	await expect(ponytailButton(page)).toBeVisible({ timeout: 10_000 });
	await expect.poll(
		async () => await ponytailButton(page).evaluate((element) => element.className.toString()),
		{ timeout: 10_000, message: "ponytail should remain selected in the staff accessory picker" },
	).toContain("ring-2");
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
		await navigateToHash(page, "#/staff");
		await expect(page.locator("h1").filter({ hasText: "Staff Agents" })).toBeVisible({ timeout: 15_000 });

		// Either the empty-state message or a staff table must be present.
		const emptyState = page.getByText("No staff agents yet");
		const staffTable = page.locator("table");
		// Use or() to accept either state — whichever renders first.
		await expect(emptyState.or(staffTable).first()).toBeVisible({ timeout: 20_000 });
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
// exposes the role select.
test.describe("Journey: Staff Role Select", () => {
	test("staff edit page exposes the role select", async ({ page }) => {
		const project = await defaultProject();
		let staffId = "";
		try {
			const resp = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({ name: `v2-staffrole-${Date.now()}`, systemPrompt: "role test bot", cwd: project.rootPath, projectId: project.id }),
			});
			expect(resp.status).toBe(201);
			staffId = (await resp.json()).id;
			await openApp(page);
			await navigateToHash(page, `#/staff/${staffId}`);
			await expect(page.locator('[data-testid="staff-role-select"]').first()).toBeVisible({ timeout: 15_000 });
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

			const option = ponytailButton(page);
			await expect(option).toBeVisible({ timeout: 10_000 });
			await expect.poll(
				async () => await option.locator("img").count(),
				{ timeout: 10_000, message: "ponytail picker preview should include its accessory image layer" },
			).toBeGreaterThan(1);
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
