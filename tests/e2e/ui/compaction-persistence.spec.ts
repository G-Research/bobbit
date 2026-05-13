/**
 * Browser E2E: compaction card survives navigate-away + reload.
 *
 * Drives a session whose compaction sidecar carries one persisted entry.
 * The server's `get_messages` pipeline splices the synthetic rich
 * `__compaction_summary` row into the snapshot; the renderer must show
 * the card whether the user lands cold or returns after navigating
 * away.
 *
 * See docs/design/persist-compaction-history.md \u00a76.3 and \u00a73.4.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, waitForSessionStatus, apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage } from "./ui-helpers.js";
import fs from "node:fs";
import path from "node:path";

async function seedSidecarFor(
	bobbitDir: string,
	sessionId: string,
	entry: {
		id: string;
		trigger?: "manual" | "auto" | "overflow";
		tokensBefore?: number;
		firstKeptEntryId?: string | null;
	},
): Promise<void> {
	const dir = path.join(bobbitDir, "state", "compaction-sidecar");
	fs.mkdirSync(dir, { recursive: true });
	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
	const file = path.join(dir, `${safe}.jsonl`);
	const startedAt = new Date(Date.now() - 1000).toISOString();
	const endedAt = new Date().toISOString();
	const line = JSON.stringify({
		schemaVersion: 1,
		id: entry.id,
		trigger: entry.trigger ?? "manual",
		tokensBefore: entry.tokensBefore ?? 50_000,
		tokensAfter: null,
		durationMs: 1000,
		startedAt,
		endedAt,
		success: true,
		firstKeptEntryId: entry.firstKeptEntryId ?? null,
	}) + "\n";
	fs.appendFileSync(file, line, "utf-8");
}

test.describe("Compaction card persistence", () => {
	test("card survives navigate-away to sibling session and back", async ({ page, gateway }) => {
		const sessionId = await createSession();
		const otherId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await waitForSessionStatus(otherId, "idle");

		// Seed a sidecar entry. The agent's own .jsonl is whatever the
		// mock has written; the sidecar splice is independent of jsonl
		// content for the card itself.
		await seedSidecarFor(gateway.bobbitDir, sessionId, {
			id: "c_persist_nav_1",
			trigger: "manual",
			tokensBefore: 50_000,
		});

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveCount(1, { timeout: 15_000 });
		await expect(card).toHaveAttribute("data-state", "complete");

		// Navigate to a sibling session and back.
		await navigateToHash(page, `#/session/${otherId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await expect(card).toHaveCount(1, { timeout: 15_000 });
		await expect(card).toHaveAttribute("data-state", "complete");
	});

	test("card survives full page reload", async ({ page, gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await seedSidecarFor(gateway.bobbitDir, sessionId, {
			id: "c_persist_reload_1",
			trigger: "auto",
			tokensBefore: 75_000,
		});

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveCount(1, { timeout: 15_000 });
		await expect(card).toHaveAttribute("data-state", "complete");

		// Full reload \u2014 sidecar must still anchor the card.
		await page.reload();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await expect(card).toHaveCount(1, { timeout: 20_000 });
		await expect(card).toHaveAttribute("data-state", "complete");
	});
});
