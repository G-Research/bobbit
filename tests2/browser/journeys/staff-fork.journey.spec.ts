import type { Locator, Page } from "@playwright/test";
import {
	apiFetch,
	defaultProject,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForAgentResponse,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

type StaffRecord = {
	id: string;
	name: string;
	currentSessionId?: string;
	projectId?: string;
	state?: string;
};

type InboxEntry = {
	id: string;
	title: string;
	state: string;
};

async function responseText(response: Response): Promise<string> {
	return response.clone().text().catch(() => "<unreadable body>");
}

async function createStaff(project: { id: string; rootPath: string }, name: string): Promise<StaffRecord> {
	const response = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name,
			description: "Browser journey source for an independent staff fork.",
			systemPrompt: "Reply briefly while preserving staff-fork history.",
			cwd: project.rootPath,
			projectId: project.id,
			worktree: false,
			sandboxed: false,
		}),
	});
	expect(response.status, `create staff failed: ${await responseText(response)}`).toBe(201);
	return await response.json() as StaffRecord;
}

async function listStaff(): Promise<StaffRecord[]> {
	const response = await apiFetch("/api/staff");
	expect(response.status, `list staff failed: ${await responseText(response)}`).toBe(200);
	const body = await response.json() as StaffRecord[] | { staff?: StaffRecord[] };
	return Array.isArray(body) ? body : (body.staff ?? []);
}

async function readStaff(staffId: string): Promise<StaffRecord | undefined> {
	return (await listStaff()).find((staff) => staff.id === staffId);
}

async function pauseStaff(staffId: string): Promise<void> {
	const response = await apiFetch(`/api/staff/${encodeURIComponent(staffId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "paused" }),
	});
	expect(response.status, `pause staff failed: ${await responseText(response)}`).toBe(200);
}

async function listInbox(staffId: string): Promise<InboxEntry[]> {
	const response = await apiFetch(`/api/staff/${encodeURIComponent(staffId)}/inbox`);
	expect(response.status, `list inbox failed for ${staffId}: ${await responseText(response)}`).toBe(200);
	return (await response.json() as { entries: InboxEntry[] }).entries;
}

async function addInboxEntry(staffId: string, title: string): Promise<InboxEntry> {
	const response = await apiFetch(`/api/staff/${encodeURIComponent(staffId)}/inbox`, {
		method: "POST",
		body: JSON.stringify({
			title,
			prompt: "Keep this source-only inbox entry isolated from its fork.",
			source: { type: "manual_api" },
		}),
	});
	expect(response.status, `add source inbox entry failed: ${await responseText(response)}`).toBe(201);
	return (await response.json() as { entry: InboxEntry }).entry;
}

function projectStaffSection(page: Page, projectId: string): Locator {
	return page
		.locator(`[data-testid="sidebar-staff-header"][data-nav-id="staff-header:${projectId}"]`)
		.first()
		.locator("..");
}

function staffRow(section: Locator, sessionId: string, name: string): Locator {
	return section
		.locator(`[data-nav-id="session:${sessionId}"]:not([data-session-id])`)
		.filter({ hasText: name })
		.first();
}

function regularSessionRows(page: Page, sessionId: string): Locator {
	return page.locator(`.sidebar-root [data-session-id="${sessionId}"]`);
}

async function ensureStaffSectionExpanded(page: Page, projectId: string, expectedRow: Locator): Promise<Locator> {
	const header = page.locator(`[data-testid="sidebar-staff-header"][data-nav-id="staff-header:${projectId}"]`).first();
	await expect(header).toBeVisible({ timeout: 20_000 });
	if (!(await expectedRow.isVisible().catch(() => false))) await header.click();
	await expect(expectedRow).toBeVisible({ timeout: 20_000 });
	return header.locator("..");
}

async function openStaffSessionMenu(row: Locator, sessionId: string): Promise<void> {
	await expect(row).toBeVisible({ timeout: 20_000 });
	await row.hover();
	const trigger = row
		.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`)
		.first();
	await expect(trigger).toBeVisible({ timeout: 5_000 });
	await trigger.click();
	await expect(row.page().locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
}

async function openInbox(page: Page): Promise<void> {
	if (!(await page.locator("inbox-panel").isVisible().catch(() => false))) {
		const reopen = page.getByTestId("staff-inbox-open");
		if (await reopen.isVisible().catch(() => false)) await reopen.click();
	}
	const tab = page.locator("[data-testid='inbox-tab-unified'], [data-testid='inbox-tab-pill']").first();
	if (await tab.isVisible().catch(() => false)) await tab.click();
	await expect(page.locator("inbox-panel")).toBeVisible({ timeout: 15_000 });
}

test.describe("Journey: Independent staff fork", () => {
	test("forks from Staff into an independent durable staff row and inbox", async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 900 });
		const project = await defaultProject();
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const sourceName = `StaffForkSource-${stamp}`;
		const historyMarker = `STAFF_FORK_HISTORY_${stamp}`;
		const sourceInboxTitle = `SOURCE_ONLY_INBOX_${stamp}`;
		const destinationInboxTitle = `DESTINATION_ONLY_INBOX_${stamp}`;
		let source: StaffRecord | undefined;
		let destination: StaffRecord | undefined;
		let forkSessionId = "";
		let destinationDeleted = false;

		try {
			source = await createStaff(project, sourceName);
			const sourceSessionId = source.currentSessionId ?? "";
			expect(sourceSessionId, "source staff should own a permanent session").not.toBe("");
			await waitForSessionStatus(sourceSessionId, "idle", 30_000);

			await openApp(page);
			await navigateToHash(page, `#/session/${sourceSessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			let section = projectStaffSection(page, project.id);
			const sourceRow = staffRow(section, sourceSessionId, sourceName);
			section = await ensureStaffSectionExpanded(page, project.id, sourceRow);
			await expect(regularSessionRows(page, sourceSessionId), "source permanent session belongs only under Staff").toHaveCount(0);

			await sendMessage(page, historyMarker);
			await expect(page.locator("user-message").filter({ hasText: historyMarker })).toBeVisible({ timeout: 20_000 });
			await waitForAgentResponse(page, { timeout: 20_000 });
			await waitForSessionStatus(sourceSessionId, "idle", 20_000);

			// Pausing keeps both inbox snapshots deterministic: pending manual work is
			// visible but cannot be consumed by the background nudger during the journey.
			await pauseStaff(source.id);
			const sourceEntry = await addInboxEntry(source.id, sourceInboxTitle);
			expect(sourceEntry.state).toBe("pending");
			expect(await listInbox(source.id)).toEqual([expect.objectContaining({ id: sourceEntry.id, title: sourceInboxTitle, state: "pending" })]);

			// Fork through the real Staff-row action and explicitly choose borrowed
			// worktree mode via the existing New worktree toggle.
			await openStaffSessionMenu(sourceRow, sourceSessionId);
			const toggle = page
				.locator('sidebar-actions-popover [role="menuitemcheckbox"][data-sidebar-action-id="fork"]')
				.first();
			await expect(toggle).toHaveAttribute("aria-checked", "true");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-checked", "false");

			const forkResponsePromise = page.waitForResponse(
				(response) => response.url().includes(`/api/sessions/${sourceSessionId}/fork`)
					&& response.request().method() === "POST",
				{ timeout: 60_000 },
			);
			await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="fork"]').first().click();
			const forkResponse = await forkResponsePromise;
			const forkBody = await forkResponse.json() as { id?: string };
			expect(forkResponse.status(), JSON.stringify(forkBody)).toBe(201);
			expect(forkResponse.request().postDataJSON()).toMatchObject({ newWorktree: false });
			forkSessionId = forkBody.id ?? "";
			expect(forkSessionId).not.toBe("");
			expect(forkSessionId).not.toBe(sourceSessionId);
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 30_000 }).toBe(`#/session/${forkSessionId}`);

			await expect.poll(async () => {
				destination = (await listStaff()).find((staff) => staff.currentSessionId === forkSessionId);
				return destination?.id ?? "";
			}, {
				message: "fork publication should create a distinct staff record owning the destination session",
				timeout: 20_000,
			}).not.toBe("");
			expect(destination!.id).not.toBe(source.id);
			expect(destination!.name).toBe(`Fork: ${sourceName}`);
			expect(destination!.projectId).toBe(project.id);

			// The normal lifecycle push must place the fork under the same project's
			// Staff section immediately, never as an ordinary Sessions row.
			const destinationRow = staffRow(section, forkSessionId, destination!.name);
			await expect(destinationRow).toBeVisible({ timeout: 20_000 });
			await expect(sourceRow, "fork publication must leave the source Staff row intact").toBeVisible();
			await expect(regularSessionRows(page, forkSessionId), "destination permanent session must not appear under Sessions").toHaveCount(0);
			await expect(page.locator("user-message").filter({ hasText: historyMarker }), "fork should show cloned source history").toBeVisible({ timeout: 30_000 });

			// The destination starts empty and the source queue is neither copied nor
			// exposed. Adding work through the destination UI must target its fresh ID.
			expect(await listInbox(destination!.id)).toEqual([]);
			expect(await listInbox(source.id)).toEqual([expect.objectContaining({ id: sourceEntry.id, title: sourceInboxTitle })]);
			await openInbox(page);
			await expect(page.getByText("No inbox entries yet")).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText(sourceInboxTitle)).toHaveCount(0);
			await page.locator("button.inbox-add-btn").click();
			await page.locator("input.add-to-inbox-title").fill(destinationInboxTitle);
			await page.locator("textarea.add-to-inbox-prompt").fill("This work belongs only to the forked staff member.");
			const addResponsePromise = page.waitForResponse((response) => {
				const url = new URL(response.url());
				return response.request().method() === "POST"
					&& url.pathname.endsWith(`/api/staff/${encodeURIComponent(destination!.id)}/inbox`);
			});
			await page.locator("button.add-to-inbox-submit").click();
			const addResponse = await addResponsePromise;
			expect(addResponse.status()).toBe(201);
			await expect(page.locator('inbox-entry-row[data-state="pending"]').filter({ hasText: destinationInboxTitle })).toBeVisible({ timeout: 15_000 });
			expect((await listInbox(source.id)).map((entry) => entry.title)).toEqual([sourceInboxTitle]);
			expect((await listInbox(destination!.id)).map((entry) => entry.title)).toEqual([destinationInboxTitle]);

			// Reload proves the ID-based Staff placement, transcript and independent
			// destination inbox all survive client rehydration.
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 20_000 }).toBe(`#/session/${forkSessionId}`);
			section = projectStaffSection(page, project.id);
			const destinationAfterReload = staffRow(section, forkSessionId, destination!.name);
			await ensureStaffSectionExpanded(page, project.id, destinationAfterReload);
			await expect(staffRow(section, sourceSessionId, sourceName)).toBeVisible();
			await expect(regularSessionRows(page, forkSessionId)).toHaveCount(0);
			await expect(page.locator("user-message").filter({ hasText: historyMarker })).toBeVisible({ timeout: 30_000 });
			await openInbox(page);
			await expect(page.locator("inbox-entry-row").filter({ hasText: destinationInboxTitle })).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(sourceInboxTitle)).toHaveCount(0);

			// Destination-first cleanup removes only destination state. The source
			// staff/session/inbox must remain usable and represented in the sidebar.
			const deleteDestination = await apiFetch(`/api/staff/${encodeURIComponent(destination!.id)}`, { method: "DELETE" });
			expect(deleteDestination.status, `delete destination failed: ${await responseText(deleteDestination)}`).toBe(200);
			destinationDeleted = true;
			await expect(destinationAfterReload).toHaveCount(0, { timeout: 20_000 });
			await expect(staffRow(section, sourceSessionId, sourceName)).toBeVisible();
			await expect(regularSessionRows(page, forkSessionId)).toHaveCount(0);
			expect((await readStaff(source.id))?.currentSessionId).toBe(sourceSessionId);
			const sourceSessionResponse = await apiFetch(`/api/sessions/${encodeURIComponent(sourceSessionId)}`);
			expect(sourceSessionResponse.status, "destination cleanup must preserve the source permanent session").toBe(200);
			expect((await listInbox(source.id)).map((entry) => entry.title)).toEqual([sourceInboxTitle]);
		} finally {
			if (destination?.id && !destinationDeleted) {
				await apiFetch(`/api/staff/${encodeURIComponent(destination.id)}`, { method: "DELETE" }).catch(() => {});
			}
			if (forkSessionId) await deleteSession(forkSessionId).catch(() => {});
			if (source?.id) await apiFetch(`/api/staff/${encodeURIComponent(source.id)}`, { method: "DELETE" }).catch(() => {});
			if (source?.currentSessionId) await deleteSession(source.currentSessionId).catch(() => {});
		}
	});
});
