/**
 * Browser E2E: Roles model reshuffle — real gateway/browser coverage.
 *
 * Complements the file:// ui-fixture coverage (tests/ui-fixtures/*) by driving
 * the actual app against an in-process gateway:
 *   - Detail editor: Model is its own section, positioned between the Accessory
 *     section and the tab bar; the tab bar exposes only Prompt + Tool Access
 *     (the old `roles-tab-model` tab is gone).
 *   - Save-hang regression: editing a field and clicking Save returns the Save
 *     button from "Saving…" to an idle/disabled "Save" WITHOUT navigating away.
 *     Before the handleSave renderApp() fix this stuck on "Saving…" because
 *     setHashRoute() is a no-op when saving from the role's own edit page.
 *   - List rows expose the inline model control hooks (role-row-model-control
 *     + data-model-state) so CSS/E2E can target inherited vs override state.
 *
 * Uses a built-in role ("coder") so the spec does not depend on external model
 * availability — it never opens the model selector, only asserts layout,
 * tabs, list hooks, and the save lifecycle.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const ROLE = "coder";

test.describe("Roles model reshuffle", () => {
	test("detail editor: Model section between Accessory and tabs; only Prompt + Tool Access tabs @smoke", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/roles/${ROLE}`);

		// Editor for the requested role is mounted.
		const editor = page.locator(`[data-testid="role-editor"][data-role-name="${ROLE}"]`);
		await expect(editor).toBeVisible({ timeout: 15_000 });

		// Model section is present and visible.
		const modelSection = editor.locator('[data-testid="roles-model-section"]');
		await expect(modelSection).toBeVisible();

		// There is no Model tab anymore — only Prompt + Tool Access.
		await expect(editor.locator('[data-testid="roles-tab-model"]')).toHaveCount(0);
		const tabs = editor.locator(".roles-tab-bar .roles-tab");
		await expect(tabs).toHaveCount(2);
		await expect(tabs.nth(0)).toHaveText(/Prompt/);
		await expect(tabs.nth(1)).toHaveText(/Tool Access/);
		await expect(
			editor.locator(".roles-tab-bar .roles-tab").filter({ hasText: /^Model$/ }),
		).toHaveCount(0);

		// Section order: Accessory section, then Model section, then tab bar.
		const order = await editor.evaluate((root) => {
			const main = root.querySelector(".roles-edit-main") ?? root;
			const nodes = Array.from(main.children) as HTMLElement[];
			const indexOf = (pred: (el: HTMLElement) => boolean) =>
				nodes.findIndex(pred);
			const accessoryIdx = indexOf((el) =>
				el.classList.contains("roles-edit-section") &&
				/Accessory/.test(el.querySelector(".roles-section-title")?.textContent ?? ""));
			const modelIdx = indexOf((el) => el.getAttribute("data-testid") === "roles-model-section");
			const tabBarIdx = indexOf((el) => el.classList.contains("roles-tab-bar"));
			return { accessoryIdx, modelIdx, tabBarIdx };
		});
		expect(order.accessoryIdx, "Accessory section present").toBeGreaterThanOrEqual(0);
		expect(order.modelIdx, "Model section present").toBeGreaterThanOrEqual(0);
		expect(order.tabBarIdx, "tab bar present").toBeGreaterThanOrEqual(0);
		expect(order.accessoryIdx).toBeLessThan(order.modelIdx);
		expect(order.modelIdx).toBeLessThan(order.tabBarIdx);
	});

	test("save-hang regression: Save returns from Saving… to idle without navigation", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, `#/roles/${ROLE}`);

		const editor = page.locator(`[data-testid="role-editor"][data-role-name="${ROLE}"]`);
		await expect(editor).toBeVisible({ timeout: 15_000 });

		const hashBefore = await page.evaluate(() => window.location.hash);

		const saveBtn = page.locator('[data-testid="role-save-btn"] button');
		// Initially no changes ⇒ Save is disabled. (Button text is padded with
		// whitespace by the layout, so match tolerantly and assert it is NOT "Saving…".)
		await expect(saveBtn).toBeDisabled();
		await expect(saveBtn).toHaveText(/^\s*Save\s*$/);

		// Make a change to enable Save. The Label input drives the editor draft.
		const labelInput = editor.locator('input[placeholder="e.g. Documentation Writer"]').first();
		await expect(labelInput).toBeVisible();
		const original = await labelInput.inputValue();
		const mutated = `${original} `; // trailing space — a real, reversible change
		await labelInput.fill(mutated);

		// Change enables Save.
		await expect(saveBtn).toBeEnabled({ timeout: 5_000 });

		await saveBtn.click();

		// The crux: the button must settle back to an idle/disabled "Save" —
		// NOT stay stuck on "Saving…". Poll the rendered label + disabled state.
		await expect(saveBtn).toHaveText(/^\s*Save\s*$/, { timeout: 10_000 });
		await expect(saveBtn).not.toContainText("Saving");
		await expect(saveBtn).toBeDisabled();

		// And we must still be on the same edit route (no navigation occurred).
		const hashAfter = await page.evaluate(() => window.location.hash);
		expect(hashAfter).toBe(hashBefore);
		await expect(editor).toBeVisible();

		// Restore the label so the role config is left clean for any later test.
		await labelInput.fill(original);
		await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
		await saveBtn.click();
		await expect(saveBtn).toBeDisabled({ timeout: 10_000 });
	});

	test("list rows expose inline model-control hooks (role-row-model-control + data-model-state)", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/roles");

		// Wait for the roles list to render at least one inline model control.
		const controls = page.locator('[data-testid="role-row-model-control"]');
		await expect(controls.first()).toBeVisible({ timeout: 15_000 });
		const count = await controls.count();
		expect(count).toBeGreaterThan(0);

		// Every control carries a deterministic state hook. The polished list adds
		// thinking-only and read-only (pack) states alongside inherited/override.
		const states = await controls.evaluateAll((els) =>
			els.map((el) => el.getAttribute("data-model-state")));
		expect(states.length).toBe(count);
		for (const s of states) {
			expect(["inherited", "override", "thinking-override", "partial-override", "readonly"]).toContain(s);
		}
	});

	test("list rows: inline model control is compact and its chevrons do not overflow", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/roles");

		const control = page.locator('[data-testid="role-row-model-control"]').first();
		await expect(control).toBeVisible({ timeout: 15_000 });

		const geom = await control.evaluate((root) => {
			const cb = root.getBoundingClientRect();
			const within = (el: Element | null, parent: DOMRect, tol = 1) => {
				if (!el) return true;
				const r = el.getBoundingClientRect();
				return (
					r.left >= parent.left - tol && r.right <= parent.right + tol &&
					r.top >= parent.top - tol && r.bottom <= parent.bottom + tol
				);
			};
			// 1) Every sub-control (buttons, selects, chevrons) stays within the
			//    control's own bounds — nothing spills out of the row cell.
			const subControls = Array.from(root.querySelectorAll('button, select, [role="combobox"], svg'));
			const allContained = subControls.every((el) => within(el, cb));

			// 2) Each select/combobox chevron stays within ITS OWN control bounds
			//    (the "arrows must not overflow their option/control" requirement).
			const selects = Array.from(root.querySelectorAll('[role="combobox"], select'));
			let chevronContained = true;
			for (const sel of selects) {
				const selRect = sel.getBoundingClientRect();
				for (const svg of Array.from(sel.querySelectorAll('svg'))) {
					if (!within(svg, selRect, 1)) chevronContained = false;
				}
			}
			return { allContained, chevronContained, height: cb.height };
		});

		expect(geom.allContained, "all sub-controls/chevrons contained within the control").toBe(true);
		expect(geom.chevronContained, "select chevrons stay within their own control bounds").toBe(true);
		// Compact: at most a small two-line control, not a sprawling block.
		expect(geom.height, "inline control stays compact").toBeLessThanOrEqual(140);
	});

	test("list rows remain usable at a narrow viewport (edit/delete reachable)", async ({ page }) => {
		await page.setViewportSize({ width: 380, height: 800 });
		await openApp(page);
		await navigateToHash(page, "#/roles");

		const row = page.locator(".role-row").first();
		await expect(row).toBeVisible({ timeout: 15_000 });

		const editBtn = row.locator(".role-row-action-btn:not(.delete)").first();
		const deleteBtn = row.locator(".role-row-action-btn.delete").first();
		await expect(editBtn).toBeVisible();
		await expect(deleteBtn).toBeVisible();

		// Action buttons must not be clipped off the right edge of the viewport.
		const vw = page.viewportSize()!.width;
		for (const btn of [editBtn, deleteBtn]) {
			const box = await btn.boundingBox();
			expect(box, "action button has a layout box").not.toBeNull();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 1);
		}

		// The edit action still works at narrow width.
		await editBtn.click();
		await expect(page.locator('[data-testid="role-editor"]')).toBeVisible({ timeout: 10_000 });
	});
});
