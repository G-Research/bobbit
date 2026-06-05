/**
 * Browser E2E coverage for the staff *proposal* panel's role selector and the
 * Create-Staff in-flight / double-submit guard (proposal-panels.ts).
 *
 * Issue 1 — the staff proposal panel must expose a role <select> that reflects
 *   the proposed role, is user-editable, and persists the chosen role as
 *   `roleId` on the created staff. A "No role" selection creates with no role.
 * Issue 2 — clicking "Create Staff" must immediately disable the button and
 *   show a "Creating…" label; on failure the panel + assistant session stay
 *   open, the error modal is shown, and the button re-enables for retry.
 *
 * The staff proposal is driven by the mock agent via the `STAFF_PROPOSAL_ROLE`
 * trigger (mock-agent-core.mjs), which proposes a staff with `role: "coder"`.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import type { Page } from "@playwright/test";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

// Built-in roles (defaults/roles/*.yaml) — same ones used by staff-role.spec.ts.
const PROPOSED_ROLE = "coder";
const CHANGED_ROLE = "architect";

interface UiProject {
	id: string;
	name: string;
	rootPath: string;
}

interface StaffRecord {
	id: string;
	name: string;
	currentSessionId?: string | null;
	roleId?: string | null;
}

async function waitForActiveProject(page: Page): Promise<UiProject> {
	await page.waitForFunction(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const project = state?.projects?.find((p: any) => p.id === state?.activeProjectId);
		return !!project?.id && !!project?.rootPath;
	}, null, { timeout: 15_000 });
	return await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state.projects.find((p: any) => p.id === state.activeProjectId);
	}) as UiProject;
}

async function waitForStaffProposal(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const fields = state?.activeProposals?.staff?.fields;
		return fields && typeof fields === "object" && fields.name === "parity-staff";
	}, null, { timeout: 15_000 });
}

async function openStaffProposalPanel(page: Page) {
	const panel = page.locator('[data-panel="staff-proposal"]').first();
	if (!(await panel.isVisible().catch(() => false))) {
		const tab = page.locator('.goal-tab-pill[title="Staff"]').first();
		if (await tab.isVisible().catch(() => false)) {
			await tab.click();
		} else {
			const openButton = page.locator('[data-testid="proposal-open-button"]').last();
			await expect(openButton).toBeVisible({ timeout: 15_000 });
			await openButton.click();
		}
	}
	await expect(panel).toBeVisible({ timeout: 10_000 });
	return panel;
}

/** Force a unique name into the proposal panel so created staff don't collide. */
async function setStaffName(page: Page, name: string): Promise<void> {
	await page.evaluate((n) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		state.staffPreviewName = n;
		state.staffPreviewNameEdited = true;
		(window as any).__bobbitRenderApp?.();
	}, name);
}

async function findStaffByName(name: string): Promise<StaffRecord | undefined> {
	const res = await apiFetch("/api/staff");
	expect(res.ok).toBe(true);
	const body = await res.json();
	const list: StaffRecord[] = Array.isArray(body) ? body : (body.staff ?? body.agents ?? []);
	return list.find((s) => s.name === name);
}

async function cleanupStaff(name: string): Promise<void> {
	const staff = await findStaffByName(name);
	if (!staff?.id) return;
	if (staff.currentSessionId) {
		await apiFetch(`/api/sessions/${staff.currentSessionId}`, { method: "DELETE" }).catch(() => {});
	}
	await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Staff proposal panel — role selector + create guard", () => {
	test.describe.configure({ timeout: 90_000 });

	test("role selector reflects the proposed role, is changeable, and persists as roleId", async ({ page }) => {
		const staffName = `proposal-role-${Date.now().toString(36)}`;
		try {
			await openApp(page);
			await createSessionViaUI(page);
			await waitForActiveProject(page);

			await sendMessage(page, "STAFF_PROPOSAL_ROLE");
			await waitForStaffProposal(page);
			const panel = await openStaffProposalPanel(page);

			// Role <select> appears and reflects the proposed role.
			const select = panel.locator('[data-testid="staff-proposal-role-select"]');
			await expect(select).toBeVisible({ timeout: 10_000 });
			await expect(select).toHaveValue(PROPOSED_ROLE);

			// User can change the selection.
			await select.selectOption(CHANGED_ROLE);
			await expect(select).toHaveValue(CHANGED_ROLE);

			await setStaffName(page, staffName);

			const createButton = panel.locator('[data-testid="proposal-primary-submit"] button');
			await expect(createButton).toBeEnabled({ timeout: 5_000 });
			await createButton.click();

			// On success the proposal is cleared.
			await page.waitForFunction(() => {
				const state = (window as any).bobbitState ?? (window as any).__bobbitState;
				return state?.activeProposals?.staff == null;
			}, null, { timeout: 20_000 });

			// The chosen role persisted as roleId on the created staff.
			await expect.poll(async () => (await findStaffByName(staffName))?.roleId, { timeout: 10_000 })
				.toBe(CHANGED_ROLE);
		} finally {
			await cleanupStaff(staffName);
		}
	});

	test("selecting \"No role\" creates a staff with no role", async ({ page }) => {
		const staffName = `proposal-norole-${Date.now().toString(36)}`;
		try {
			await openApp(page);
			await createSessionViaUI(page);
			await waitForActiveProject(page);

			await sendMessage(page, "STAFF_PROPOSAL_ROLE");
			await waitForStaffProposal(page);
			const panel = await openStaffProposalPanel(page);

			const select = panel.locator('[data-testid="staff-proposal-role-select"]');
			await expect(select).toHaveValue(PROPOSED_ROLE, { timeout: 10_000 });

			// Clear the role.
			await select.selectOption("");
			await expect(select).toHaveValue("");

			await setStaffName(page, staffName);

			const createButton = panel.locator('[data-testid="proposal-primary-submit"] button');
			await expect(createButton).toBeEnabled({ timeout: 5_000 });
			await createButton.click();

			await page.waitForFunction(() => {
				const state = (window as any).bobbitState ?? (window as any).__bobbitState;
				return state?.activeProposals?.staff == null;
			}, null, { timeout: 20_000 });

			const saved = await findStaffByName(staffName);
			expect(saved, "staff should have been created").toBeTruthy();
			expect(saved?.roleId ?? null, "no role should persist as null").toBeNull();
		} finally {
			await cleanupStaff(staffName);
		}
	});

	test("Create Staff shows Creating…/disabled in flight, and on failure keeps the panel open + re-enables", async ({ page }) => {
		const staffName = `proposal-fail-${Date.now().toString(36)}`;
		// Intercept the create call: hold it open until the test has observed the
		// in-flight state (event-driven gate, no wall-clock sleep), then fail with
		// 404 to simulate a rejected create.
		let releaseCreate: () => void = () => {};
		const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
		await page.route("**/api/staff", async (route) => {
			if (route.request().method() !== "POST") {
				await route.continue();
				return;
			}
			await createGate;
			await route.fulfill({
				status: 404,
				contentType: "application/json",
				body: JSON.stringify({ error: "role not found" }),
			});
		});

		try {
			await openApp(page);
			await createSessionViaUI(page);
			await waitForActiveProject(page);

			await sendMessage(page, "STAFF_PROPOSAL_ROLE");
			await waitForStaffProposal(page);
			const panel = await openStaffProposalPanel(page);

			await setStaffName(page, staffName);

			const createButton = panel.locator('[data-testid="proposal-primary-submit"] button');
			await expect(createButton).toBeEnabled({ timeout: 5_000 });
			await createButton.click();

			// In-flight: button disabled + "Creating…" label.
			await expect(panel.locator('[data-testid="staff-creating-label"]')).toBeVisible({ timeout: 5_000 });
			await expect(createButton).toBeDisabled();

			// Let the create call complete (with the simulated 404).
			releaseCreate();

			// On failure: error modal shown, panel stays open, button re-enables.
			await expect(page.getByText("Failed to create staff agent")).toBeVisible({ timeout: 10_000 });
			await expect(panel).toBeVisible();
			await page.waitForFunction(() => {
				const state = (window as any).bobbitState ?? (window as any).__bobbitState;
				return state?.activeProposals?.staff != null;
			}, null, { timeout: 5_000 });
			await expect(createButton).toBeEnabled({ timeout: 5_000 });
			await expect(panel.locator('[data-testid="staff-creating-label"]')).toHaveCount(0);
		} finally {
			await page.unroute("**/api/staff").catch(() => {});
			await cleanupStaff(staffName);
		}
	});
});
