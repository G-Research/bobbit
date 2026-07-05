import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

// UX-01 (Fable audit): pressing Escape to dismiss a confirm/error dialog must
// dismiss ONLY the dialog, not also abort the streaming agent turn.
// AgentInterface._handleGlobalEscape (src/ui/components/AgentInterface.ts)
// is a document-level, capture-phase Escape handler that aborts the
// streaming session unless it finds a `[role="dialog"]` / `[aria-modal="true"]`
// element in the DOM. Mini-lit's Dialog renders neither, so every
// src/app/dialogs.ts helper tags its own container via createDialogContainer().
// This spec exercises the real DOM guard end-to-end: a live <agent-interface>
// with isStreaming=true, and a real confirmAction() dialog on top of it.

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/agent-interface-dialog-escape-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "agent-interface-dialog-escape-bundle.js");
const AGENT_INTERFACE_SRC = path.resolve("src/ui/components/AgentInterface.ts");
const DIALOGS_SRC = path.resolve("src/app/dialogs.ts");

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, AGENT_INTERFACE_SRC, DIALOGS_SRC],
	});
});

async function loadFixture(page: Page, options?: { isStreaming?: boolean }): Promise<string[]> {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__agentInterfaceDialogEscapeReady === true, null, { timeout: 10_000 });
	await page.evaluate((opts) => (window as any).__mountAgentInterfaceDialogEscapeFixture(opts ?? {}), options ?? {});
	await page.waitForSelector("agent-interface message-list", { timeout: 10_000 });
	// MessageEditor auto-focuses its own textarea on mount, and its *local*
	// keydown handler independently aborts on Escape whenever it has focus
	// (src/ui/components/MessageEditor.ts:625) — regardless of any open
	// dialog. That's a separate code path from AgentInterface's document-level
	// `_handleGlobalEscape` guard under test here (see finding UX-01's own
	// scoping: "+ focus not in a textarea"). Blur it so Escape exercises the
	// guard this fix targets, matching the realistic repro (a dialog opened
	// from a button click, which itself moves focus off the composer).
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	return errors;
}

test.describe("UX-01: Escape on an unrelated dialog does not abort a streaming agent", () => {
	test("confirmAction dialog is tagged role=dialog / aria-modal=true", async ({ page }) => {
		await loadFixture(page, { isStreaming: true });
		await page.evaluate(() => (window as any).__openConfirmDialog());

		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toHaveCount(1);
		await expect(dialog).toHaveAttribute("aria-modal", "true");
	});

	test("Escape closes the confirm dialog and does NOT abort the streaming session", async ({ page }) => {
		const errors = await loadFixture(page, { isStreaming: true });
		await page.evaluate(() => (window as any).__openConfirmDialog());
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);

		await page.keyboard.press("Escape");

		// Dialog is gone...
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		// ...resolved as cancelled (confirmAction's own Escape handler ran)...
		await expect.poll(() => page.evaluate(() => (window as any).__getConfirmResult())).toEqual({ settled: true, value: false });
		// ...and critically, the streaming agent was NOT aborted.
		expect(await page.evaluate(() => (window as any).__getAbortCallCount())).toBe(0);

		expect(errors.filter((line) => !/favicon|ResizeObserver loop/i.test(line))).toEqual([]);
	});

	test("control: Escape with no dialog open DOES abort the streaming session (guard is not overbroad)", async ({ page }) => {
		await loadFixture(page, { isStreaming: true });
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);

		await page.keyboard.press("Escape");

		expect(await page.evaluate(() => (window as any).__getAbortCallCount())).toBe(1);
	});
});

// UX-03 (Fable audit): a document-level Enter used to resolve confirmAction's
// promise as CONFIRMED regardless of the `destructive` flag and regardless of
// where focus was — no button was ever focused on open, so a stray Enter
// (mid-typing, or a screen-reader user who's landed nowhere in particular)
// could fire a destructive action with zero warning. The fix moves focus into
// the dialog on open (Cancel for destructive — the safe default — Confirm
// otherwise), drops the global Enter binding entirely, and adds a Tab focus
// trap. Native <button> Enter/Space activation then scopes "Enter confirms"
// to focus-within-dialog for free.
test.describe("UX-03: destructive confirmAction focuses Cancel and scopes Enter to focus-within-dialog", () => {
	test("destructive dialog moves focus to the Cancel button on open", async ({ page }) => {
		await loadFixture(page, { isStreaming: false });
		await page.evaluate(() => (window as any).__openConfirmDialog(true));
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);

		await expect.poll(() => page.evaluate(() => (window as any).__getActiveElementInfo()?.text)).toBe("Cancel");
	});

	test("non-destructive dialog moves focus to the Confirm button on open", async ({ page }) => {
		await loadFixture(page, { isStreaming: false });
		await page.evaluate(() => (window as any).__openConfirmDialog(false));
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);

		await expect.poll(() => page.evaluate(() => (window as any).__getActiveElementInfo()?.text)).toBe("Save");
	});

	test("Enter while focus is OUTSIDE the dialog does NOT confirm a destructive action", async ({ page }) => {
		await loadFixture(page, { isStreaming: false });
		await page.evaluate(() => (window as any).__openConfirmDialog(true));
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);
		// Wait for the dialog's own open-focus rAF to land on Cancel first, so
		// it can't race with (and steal back) the decoy focus set below.
		await expect.poll(() => page.evaluate(() => (window as any).__getActiveElementInfo()?.text)).toBe("Cancel");

		// Move focus to a decoy control entirely outside the dialog, then press
		// Enter. Under the old (buggy) behavior the document-level handler
		// confirmed regardless of focus location; under the fix, nothing is
		// bound globally, so an out-of-dialog Enter is a no-op for the dialog.
		await page.evaluate(() => (window as any).__focusDecoyButton());
		await expect.poll(() => page.evaluate(() => (window as any).__getActiveElementInfo()?.id)).toBe("ux03-decoy-outside-button");

		await page.keyboard.press("Enter");

		// Dialog is still open and unsettled — the stray Enter did nothing.
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);
		expect(await page.evaluate(() => (window as any).__getConfirmResult())).toEqual({ settled: false });
	});

	test("Enter on the focused Confirm button DOES confirm", async ({ page }) => {
		await loadFixture(page, { isStreaming: false });
		await page.evaluate(() => (window as any).__openConfirmDialog(true));
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => (window as any).__getActiveElementInfo()?.text)).toBe("Cancel");

		// Tab from the default-focused Cancel button onto Confirm, then Enter.
		await page.keyboard.press("Tab");
		await expect.poll(() => page.evaluate(() => (window as any).__getActiveElementInfo()?.text)).toBe("Discard");

		await page.keyboard.press("Enter");

		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		expect(await page.evaluate(() => (window as any).__getConfirmResult())).toEqual({ settled: true, value: true });
	});

	test("Enter on the focused Cancel button (the default) cancels — no accidental destructive confirm", async ({ page }) => {
		await loadFixture(page, { isStreaming: false });
		await page.evaluate(() => (window as any).__openConfirmDialog(true));
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => (window as any).__getActiveElementInfo()?.text)).toBe("Cancel");

		// This is the exact repro from the finding: press Enter without
		// clicking/tabbing anywhere. Previously this fired the destructive
		// action; now the safe default (Cancel) is what's focused.
		await page.keyboard.press("Enter");

		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		expect(await page.evaluate(() => (window as any).__getConfirmResult())).toEqual({ settled: true, value: false });
	});

	test("Tab focus trap keeps focus cycling within the dialog", async ({ page }) => {
		await loadFixture(page, { isStreaming: false });
		await page.evaluate(() => (window as any).__openConfirmDialog(true));
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => (window as any).__getActiveElementInfo()?.text)).toBe("Cancel");

		// Shift+Tab from the first focusable element wraps to the last, rather
		// than escaping the dialog into the page behind the backdrop.
		await page.keyboard.press("Shift+Tab");
		const wrapped = await page.evaluate(() => {
			const active = document.activeElement as HTMLElement | null;
			return active !== null && document.querySelector('[role="dialog"]')?.contains(active);
		});
		expect(wrapped).toBe(true);
	});
});
