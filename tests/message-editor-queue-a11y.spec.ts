/**
 * A11y — composer queue pill "steered" state must be exposed through the
 * accessible name, not just the amber-vs-muted background color.
 *
 * Source: PR #246 judgment inventory, "Color-only signaling" item 12 —
 * "Steered vs normal queue pills (amber vs muted) in the composer." The
 * orchestrator ruling for this item: append "(steered)" to the steered
 * pill's accessible name (role="group" + aria-label), zero visible pixel
 * changes. Bundles the REAL <message-editor> component (not a replica) so
 * this pins production `src/ui/components/MessageEditor.ts` rendering —
 * see `tests/message-editor-queue.spec.ts` for the vanilla-DOM replica used
 * for the broader queue-interaction test suite.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/message-editor-queue-a11y.html");
const BUNDLE = path.resolve("tests/fixtures/message-editor-queue-a11y-bundle.js");
const ENTRY = path.resolve("tests/fixtures/message-editor-queue-a11y-entry.ts");
const SRC = path.resolve("src/ui/components/MessageEditor.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, SRC] });
});

const PAGE = `file://${FIXTURE}`;
async function ready(page: import("@playwright/test").Page) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("Composer queue pill a11y — steered state (judgment item 12)", () => {
	test("steered pill exposes '(steered)' via role=group aria-label; normal pill does not", async ({ page }) => {
		await ready(page);
		const el = await page.evaluate(async () => {
			const w = window as any;
			const container = document.getElementById("container")!;
			const editor = w.__mountEditor(container);
			w.__setQueue(editor, [
				{ id: "q1", text: "normal queued message", isSteered: false, createdAt: 1000 },
				{ id: "q2", text: "steered message", isSteered: true, createdAt: 2000 },
			]);
			await editor.updateComplete;
			return true;
		});
		expect(el).toBe(true);

		const normalPill = page.locator('.queue-pill[data-steered="false"]');
		const steeredPill = page.locator('.queue-pill[data-steered="true"]');
		await expect(normalPill).toHaveCount(1);
		await expect(steeredPill).toHaveCount(1);

		// Normal pill: no group role / aria-label override — its accessible
		// name (if any) comes from its interactive children (Steer/Edit/Remove
		// buttons), unaffected by this fix.
		await expect(normalPill).not.toHaveAttribute("role", "group");
		await expect(normalPill).not.toHaveAttribute("aria-label");

		// Steered pill: color (amber background) is no longer the only signal —
		// the accessible name now says so explicitly.
		await expect(steeredPill).toHaveAttribute("role", "group");
		await expect(steeredPill).toHaveAttribute("aria-label", "steered message (steered)");

		// Zero visible-pixel regression: the visible "Sent" badge is untouched.
		await expect(steeredPill.locator(".sent-indicator")).toContainText("Sent");
	});
});
