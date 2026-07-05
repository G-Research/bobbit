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

async function loadFixture(page: Page, options?: { isStreaming?: boolean; keepComposerFocus?: boolean }): Promise<string[]> {
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
	//
	// W2.16 (Fable audit): the composer's own local handler had NO equivalent
	// guard for this case — see the "composer focused" describe block below,
	// which deliberately passes `keepComposerFocus: true` to leave focus in
	// the textarea and exercise that path instead.
	if (!options?.keepComposerFocus) {
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	}
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

// W2.16 (Fable audit, follow-up to UX-01 / PR #15): MessageEditor
// (src/ui/components/MessageEditor.ts) binds its own LOCAL keydown handler
// directly on the textarea (`@keydown=${this.handleKeyDown}`), which aborts
// the streaming session on Escape whenever the composer has focus — a
// separate code path from AgentInterface's document-level, capture-phase
// `_handleGlobalEscape`. That global handler already bails when a dialog is
// open, but it ALSO bails whenever focus is in a TEXTAREA/INPUT (so it
// doesn't double-fire against MessageEditor's own abort) — which means when a
// dialog is open *and* the composer still has focus (the realistic case: the
// dialog itself doesn't steal focus), neither handler stops MessageEditor
// from aborting. This block reproduces that with the composer left focused.
test.describe("W2.16: Escape on a dialog does not abort when the composer still has focus", () => {
	test("RED (pre-fix) / GREEN (post-fix): dialog closes and streaming is NOT aborted", async ({ page }) => {
		const errors = await loadFixture(page, { isStreaming: true, keepComposerFocus: true });

		// Sanity: the composer textarea genuinely has focus, matching the
		// realistic repro (confirmAction, on this base, does not move focus
		// into the dialog on open).
		await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.tagName)).toBe("TEXTAREA");

		await page.evaluate(() => (window as any).__openConfirmDialog());
		await expect(page.locator('[role="dialog"]')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.tagName)).toBe("TEXTAREA");

		await page.keyboard.press("Escape");

		// Dialog is gone, resolved as cancelled...
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => (window as any).__getConfirmResult())).toEqual({ settled: true, value: false });
		// ...and critically, the streaming agent was NOT aborted by the
		// composer's own local Escape handler.
		expect(await page.evaluate(() => (window as any).__getAbortCallCount())).toBe(0);

		expect(errors.filter((line) => !/favicon|ResizeObserver loop/i.test(line))).toEqual([]);
	});

	test("control: Escape with composer focused and no dialog open DOES abort (guard is not overbroad)", async ({ page }) => {
		await loadFixture(page, { isStreaming: true, keepComposerFocus: true });
		await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.tagName)).toBe("TEXTAREA");
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);

		await page.keyboard.press("Escape");

		expect(await page.evaluate(() => (window as any).__getAbortCallCount())).toBe(1);
	});
});
