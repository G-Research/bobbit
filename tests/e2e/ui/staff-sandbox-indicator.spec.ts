/**
 * Browser E2E for the fix-staff-sandbox-model design:
 *
 *   1. The staff edit page's Sandbox row reflects the persisted boolean
 *      verbatim ("Enabled" / "Disabled") — no whale badge, no "Inherited
 *      from project settings" caption. This is the user-visible artefact
 *      of the bug: the page must not lie about the staff's actual sandbox
 *      mode.
 *
 *   2. The value survives a reload (proves the GET endpoint returns the
 *      persisted value, not something synthesised at render time).
 *
 *   3. The sandbox checkbox in the staff assistant create flow is rendered
 *      regardless of the project's sandbox-configured state (AC #6: the
 *      previous `state.sandboxStatus?.configured` wrapper that hid it has
 *      been removed). The toggle-on case (`Enabled`) cannot be exercised
 *      end-to-end here because saving a `sandboxed: true` staff requires
 *      Docker — covered at the data-model layer by
 *      tests/staff-sandboxed-persistence.test.ts and at the API layer by
 *      tests/e2e/staff.spec.ts.
 *
 * Pattern mirrors tests/e2e/ui/settings.spec.ts for navigation + reload.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, gitCwd, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Staff sandbox indicator", () => {
	const cleanup: string[] = [];

	test.afterAll(async () => {
		for (const id of cleanup) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("edit page shows 'Disabled' for a staff created with sandboxed: false", async ({ page }) => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();

		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `SandboxOff${Date.now()}`,
				systemPrompt: "Indicator test.",
				cwd: gitCwd(),
				projectId: pid,
				sandboxed: false,
			}),
		});
		expect(resp.status).toBe(201);
		const staff = await resp.json();
		cleanup.push(staff.id);

		// Confirm the API agreed: the value round-trips verbatim.
		expect(staff.sandboxed).toBe(false);

		await openApp(page);
		await navigateToHash(page, `#/staff/${staff.id}`);

		// The Sandbox row is a label + value pair. Both must be visible.
		const sandboxLabel = page.locator("label").filter({ hasText: /^Sandbox$/ }).first();
		await expect(sandboxLabel).toBeVisible({ timeout: 10_000 });

		// Value sits in the sibling div immediately after the label — scope
		// the assertion to that container so we don't accidentally match the
		// word "Disabled" anywhere else on the page.
		const indicator = sandboxLabel.locator("xpath=following-sibling::div[1]");
		await expect(indicator).toBeVisible({ timeout: 5_000 });
		await expect(indicator).toHaveText(/^\s*Disabled\s*$/);

		// The "Inherited from project settings" caption that used to live
		// here (and lied about where the value came from) must NOT reappear.
		await expect(page.getByText("Inherited from project settings")).toHaveCount(0);
	});

	test("edit page indicator survives a reload (persisted, not derived)", async ({ page }) => {
		const pid = await defaultProjectId();
		expect(pid).toBeTruthy();

		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `SandboxReload${Date.now()}`,
				systemPrompt: "Reload test.",
				cwd: gitCwd(),
				projectId: pid,
				sandboxed: false,
			}),
		});
		expect(resp.status).toBe(201);
		const staff = await resp.json();
		cleanup.push(staff.id);

		await openApp(page);
		await navigateToHash(page, `#/staff/${staff.id}`);

		const sandboxLabel = page.locator("label").filter({ hasText: /^Sandbox$/ }).first();
		await expect(sandboxLabel).toBeVisible({ timeout: 10_000 });
		const indicator = sandboxLabel.locator("xpath=following-sibling::div[1]");
		await expect(indicator).toHaveText(/^\s*Disabled\s*$/);

		// Reload — the value must come from the GET endpoint, which reads
		// the persisted boolean.
		await page.reload();
		await navigateToHash(page, `#/staff/${staff.id}`);
		const sandboxLabelAfter = page.locator("label").filter({ hasText: /^Sandbox$/ }).first();
		await expect(sandboxLabelAfter).toBeVisible({ timeout: 10_000 });
		const indicatorAfter = sandboxLabelAfter.locator("xpath=following-sibling::div[1]");
		await expect(indicatorAfter).toHaveText(/^\s*Disabled\s*$/);

		// Sanity: the API returns the persisted value, not a project-derived one.
		const apiCheck = await (await apiFetch(`/api/staff/${staff.id}`)).json();
		expect(apiCheck.sandboxed).toBe(false);
	});

	test("staff assistant: sandbox checkbox is rendered (not hidden by sandboxStatus.configured gate)", async ({ page }) => {
		// AC #6: the previous wrapper `${state.sandboxStatus?.configured ? ...}`
		// that hid the checkbox when the project hadn't configured Docker has
		// been removed. The checkbox must always be present in the staff
		// assistant create flow, even in a test env with no Docker. The
		// existing disabled-state styling for the unavailable-image case
		// stays — we only assert the element is in the DOM, not enabled.
		await openApp(page);

		const newStaffBtn = page.locator("button[title^='New staff agent']").first();
		await expect(newStaffBtn).toBeVisible({ timeout: 10_000 });
		await newStaffBtn.evaluate((el) => (el as HTMLElement).click());

		// After the click the app navigates to the new staff-assistant
		// session. state.assistantType becomes "staff", the render router
		// invokes staffPreviewPanel(), which always renders the sandbox
		// checkbox. The unique copy "Sandbox (Docker)" appears ONLY inside
		// that panel.
		const sandboxLabel = page.getByText("Sandbox (Docker)").first();
		await expect(sandboxLabel).toBeVisible({ timeout: 15_000 });

		const panel = page.locator("[data-panel='staff-proposal']");
		await expect(panel).toBeVisible({ timeout: 5_000 });

		// The checkbox input itself must be attached to the DOM. It may
		// carry the `disabled` attribute (no Docker image available in the
		// harness), but it must NOT be missing — that's the AC #6 contract.
		const checkbox = panel.locator("input[type='checkbox'].toggle-switch").first();
		await expect(checkbox).toBeAttached({ timeout: 5_000 });
	});
});
