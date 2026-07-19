import type { Page } from "@playwright/test";
import { test, expect, apiFetch, defaultProject, openApp } from "../_helpers/journey-fixture.js";

type StaffRecord = {
	id: string;
	name: string;
	currentSessionId?: string;
	projectId?: string;
};

async function responseText(resp: Response): Promise<string> {
	return await resp.clone().text().catch(() => "<unreadable body>");
}

async function createStaff(project: { id: string; rootPath: string }, name: string): Promise<StaffRecord> {
	const resp = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name,
			description: "Browser no-refresh staff lifecycle regression fixture",
			systemPrompt: "You are a browser regression fixture staff agent.",
			cwd: project.rootPath,
			projectId: project.id,
		}),
	});
	expect(resp.status, `create staff failed: ${await responseText(resp)}`).toBe(201);
	return await resp.json() as StaffRecord;
}

async function fetchStaff(staffId: string): Promise<StaffRecord | null> {
	const resp = await apiFetch("/api/staff");
	expect(resp.status, `list staff failed: ${await responseText(resp)}`).toBe(200);
	const data = await resp.json() as StaffRecord[] | { staff?: StaffRecord[] };
	const list = Array.isArray(data) ? data : (data.staff ?? []);
	return list.find((staff) => staff.id === staffId) ?? null;
}

async function waitForStaffSession(staffId: string): Promise<StaffRecord> {
	let latest: StaffRecord | null = null;
	await expect.poll(async () => {
		latest = await fetchStaff(staffId);
		return latest?.currentSessionId ?? "";
	}, {
		message: "created staff record should be linked to its permanent session",
		timeout: 20_000,
	}).not.toBe("");
	return latest!;
}

function staffSidebarRow(page: Page, staff: StaffRecord) {
	return page
		.locator(`.sidebar-root [data-nav-id="session:${staff.currentSessionId}"]:not([data-session-id])`)
		.filter({ hasText: staff.name })
		.first();
}

function regularSessionRows(page: Page, sessionId: string) {
	return page.locator(`.sidebar-root [data-session-id="${sessionId}"]`);
}

async function openAppWithStaffPushReady(page: Page): Promise<void> {
	const pushReady = page
		.waitForEvent("websocket", (socket) => new URL(socket.url()).pathname === "/ws/viewer")
		.then((socket) => socket.waitForEvent("framereceived", ({ payload }) => {
			try {
				return JSON.parse(String(payload))?.type === "auth_ok";
			} catch {
				return false;
			}
		}));
	await openApp(page);
	await pushReady;
}

async function seedNoReloadMarker(page: Page): Promise<string> {
	const marker = `staff-lifecycle-${Date.now()}-${Math.random()}`;
	await page.evaluate((value) => { (window as any).__staffLifecycleNoRefreshMarker = value; }, marker);
	return marker;
}

async function expectNoPageReload(page: Page, marker: string): Promise<void> {
	await expect.poll(() => page.evaluate(() => (window as any).__staffLifecycleNoRefreshMarker ?? null), {
		message: "staff lifecycle push handling must update the sidebar without a full page reload",
		timeout: 5_000,
	}).toBe(marker);
}

async function assertCreateDeleteReflectsWithoutReload(page: Page, viewportLabel: string): Promise<void> {
	const project = await defaultProject();
	const staffName = `no-refresh-${viewportLabel}-${Date.now()}`;
	let staffId = "";
	let sessionId = "";

	await openAppWithStaffPushReady(page);
	await expect(page.locator(".sidebar-root").first()).toBeVisible({ timeout: 20_000 });
	// A fresh mobile project intentionally renders the empty-state splash until
	// its first session exists, so its nested Staff header is not a boot-readiness
	// signal. The authenticated viewer socket above is the actual push precondition.
	const marker = await seedNoReloadMarker(page);

	try {
		const created = await createStaff(project, staffName);
		staffId = created.id;
		const linked = await waitForStaffSession(staffId);
		sessionId = linked.currentSessionId!;

		await expect(
			staffSidebarRow(page, linked),
			`${viewportLabel}: externally created staff should appear in the Staff section without reloading`,
		).toBeVisible({ timeout: 20_000 });
		await expect(
			regularSessionRows(page, sessionId),
			`${viewportLabel}: permanent staff-agent session must not render as a regular Sessions row`,
		).toHaveCount(0);
		await expectNoPageReload(page, marker);

		const deleteResp = await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" });
		expect(deleteResp.status, `delete staff failed: ${await responseText(deleteResp)}`).toBe(200);
		staffId = "";

		await expect(
			staffSidebarRow(page, linked),
			`${viewportLabel}: externally deleted staff should disappear from the Staff section without reloading`,
		).toHaveCount(0, { timeout: 20_000 });
		await expect(
			regularSessionRows(page, sessionId),
			`${viewportLabel}: deleted staff permanent session should not reappear under regular Sessions`,
		).toHaveCount(0);
		await expectNoPageReload(page, marker);
	} finally {
		if (staffId) await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" }).catch(() => {});
	}
}

test.describe("Staff lifecycle sidebar push refresh", () => {
	test("desktop sidebar updates when staff is created and deleted via API without refresh", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await assertCreateDeleteReflectsWithoutReload(page, "desktop");
	});

	test("mobile sidebar updates when staff is created and deleted via API without refresh", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 820 });
		await assertCreateDeleteReflectsWithoutReload(page, "mobile");
	});
});
