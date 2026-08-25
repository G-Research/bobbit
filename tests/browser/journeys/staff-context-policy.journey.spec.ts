import type { Page } from "@playwright/test";
import {
	apiFetch,
	defaultProject,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForSessionStatus,
} from "../../../tests2/browser/_helpers/journey-fixture.js";

type ContextPolicy = "compact" | "preserve" | "clear";

type StaffRecord = {
	id: string;
	name: string;
	currentSessionId?: string | null;
	contextPolicy?: ContextPolicy;
};

async function responseText(response: Response): Promise<string> {
	return await response.clone().text().catch(() => "<unreadable body>");
}

async function readStaff(staffId: string): Promise<StaffRecord> {
	const response = await apiFetch(`/api/staff/${staffId}`);
	expect(response.status, `read staff failed: ${await responseText(response)}`).toBe(200);
	return await response.json() as StaffRecord;
}

function policyGroup(page: Page) {
	return page.getByRole("group", { name: "Context Policy" });
}

function policyRadio(page: Page, policy: ContextPolicy) {
	const names: Record<ContextPolicy, RegExp> = {
		compact: /^Compact\s*\(default\)$/,
		preserve: /^Preserve$/,
		clear: /^Clear$/,
	};
	return policyGroup(page).getByRole("radio", { name: names[policy] });
}

async function expectPolicy(page: Page, policy: ContextPolicy): Promise<void> {
	await expect(policyRadio(page, policy)).toBeChecked();
	for (const other of (["compact", "preserve", "clear"] as ContextPolicy[]).filter((value) => value !== policy)) {
		await expect(policyRadio(page, other)).not.toBeChecked();
	}
}

async function savePolicy(page: Page, staffId: string, policy: ContextPolicy): Promise<StaffRecord> {
	await policyRadio(page, policy).check();
	await expectPolicy(page, policy);

	const update = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return response.request().method() === "PUT" && url.pathname === `/api/staff/${staffId}`;
	});
	await page.getByRole("button", { name: "Save Changes" }).click();
	const response = await update;
	const responseBody = await response.text().catch(() => "<unreadable body>");
	expect(response.status(), `save ${policy} failed: ${responseBody}`).toBe(200);
	expect((response.request().postDataJSON() as Record<string, unknown>).contextPolicy).toBe(policy);
	const updated = JSON.parse(responseBody) as StaffRecord;
	expect(updated.id).toBe(staffId);
	expect(updated.contextPolicy).toBe(policy);
	return updated;
}

async function reloadAndExpectPolicy(page: Page, staffName: string, policy: ContextPolicy): Promise<void> {
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: staffName })).toBeVisible({ timeout: 15_000 });
	await expectPolicy(page, policy);
}

test.describe("Journey: Staff Context Policy", () => {
	test("Compact, Preserve, and Clear are accessible, durable, identity-preserving, and responsive", async ({ page }) => {
		test.setTimeout(90_000);
		const project = await defaultProject();
		const marker = `CONTEXT_POLICY_UNSAVED_HISTORY_${Date.now()}`;
		let staffId = "";
		let sessionId = "";

		try {
			const createResponse = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({
					name: `ContextPolicyStaff${Date.now().toString(36)}`,
					description: "Browser journey for all staff context policies.",
					systemPrompt: "Keep staff context-policy configuration stable.",
					cwd: project.rootPath,
					projectId: project.id,
					worktree: false,
					sandboxed: false,
				}),
			});
			expect(createResponse.status, `create staff failed: ${await responseText(createResponse)}`).toBe(201);
			const created = await createResponse.json() as StaffRecord;
			staffId = created.id;
			sessionId = created.currentSessionId ?? "";
			expect(sessionId, "staff creation should retain a permanent Bobbit session").not.toBe("");
			await waitForSessionStatus(sessionId, "idle");

			const initial = await readStaff(staffId);
			expect(initial.id).toBe(staffId);
			expect(initial.currentSessionId).toBe(sessionId);
			expect(initial.contextPolicy).toBe("compact");

			// Give the permanent session visible history so an unsaved Clear selection
			// can prove that form interaction alone does not run the clear transaction.
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await sendMessage(page, marker);
			await expect(page.locator("user-message").filter({ hasText: marker })).toHaveCount(1, { timeout: 20_000 });
			await waitForSessionStatus(sessionId, "idle", 20_000);
			await expect(page.getByTestId("context-clear-card")).toHaveCount(0);

			await navigateToHash(page, `#/staff/${staffId}`);
			await expect(page.getByRole("heading", { name: created.name })).toBeVisible({ timeout: 15_000 });
			const group = policyGroup(page);
			await expect(group).toBeVisible();
			await expect(group.getByRole("radio")).toHaveCount(3);
			await expectPolicy(page, "compact");

			const preserved = await savePolicy(page, staffId, "preserve");
			expect(preserved.currentSessionId).toBe(sessionId);
			const preserveGet = await readStaff(staffId);
			expect(preserveGet.contextPolicy).toBe("preserve");
			expect(preserveGet.currentSessionId).toBe(sessionId);
			await reloadAndExpectPolicy(page, created.name, "preserve");

			// Selecting Clear only edits local form state. Until Save, the API remains
			// Preserve and the linked session keeps its model-facing history/boundaries.
			await policyRadio(page, "clear").check();
			await expectPolicy(page, "clear");
			const beforeSave = await readStaff(staffId);
			expect(beforeSave.contextPolicy).toBe("preserve");
			expect(beforeSave.currentSessionId).toBe(sessionId);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("user-message").filter({ hasText: marker })).toHaveCount(1, { timeout: 20_000 });
			await expect(page.getByTestId("context-clear-card")).toHaveCount(0);

			await navigateToHash(page, `#/staff/${staffId}`);
			await expect(page.getByRole("heading", { name: created.name })).toBeVisible({ timeout: 15_000 });
			await expectPolicy(page, "preserve");
			const cleared = await savePolicy(page, staffId, "clear");
			expect(cleared.currentSessionId).toBe(sessionId);
			const clearGet = await readStaff(staffId);
			expect(clearGet.id).toBe(staffId);
			expect(clearGet.currentSessionId).toBe(sessionId);
			expect(clearGet.contextPolicy).toBe("clear");
			const sessionResponse = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessionResponse.status, `read linked session failed: ${await responseText(sessionResponse)}`).toBe(200);
			const linkedSession = await sessionResponse.json() as { id: string; staffId?: string };
			expect(linkedSession).toEqual(expect.objectContaining({ id: sessionId, staffId }));
			await reloadAndExpectPolicy(page, created.name, "clear");

			const compacted = await savePolicy(page, staffId, "compact");
			expect(compacted.currentSessionId).toBe(sessionId);
			const compactGet = await readStaff(staffId);
			expect(compactGet.contextPolicy).toBe("compact");
			expect(compactGet.currentSessionId).toBe(sessionId);
			await reloadAndExpectPolicy(page, created.name, "compact");

			await page.setViewportSize({ width: 360, height: 720 });
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(group).toBeVisible({ timeout: 15_000 });
			const responsive = await group.evaluate((element) => {
				const radios = Array.from(element.querySelectorAll('input[type="radio"]'));
				let common = radios[0]?.parentElement ?? null;
				while (common && !radios.every((radio) => common!.contains(radio))) common = common.parentElement;
				const rect = element.getBoundingClientRect();
				return {
					flexWrap: common ? getComputedStyle(common).flexWrap : "missing",
					viewportWidth: window.innerWidth,
					documentWidth: document.documentElement.scrollWidth,
					left: rect.left,
					right: rect.right,
				};
			});
			expect(responsive.flexWrap).toBe("wrap");
			expect(responsive.documentWidth).toBeLessThanOrEqual(responsive.viewportWidth + 1);
			expect(responsive.left).toBeGreaterThanOrEqual(-1);
			expect(responsive.right).toBeLessThanOrEqual(responsive.viewportWidth + 1);
			await expectPolicy(page, "compact");
		} finally {
			if (staffId) await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" }).catch(() => {});
			if (sessionId) await deleteSession(sessionId).catch(() => {});
		}
	});
});
