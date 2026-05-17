/**
 * Renderer-level unit tests for the inbox tool renderers
 * (InboxListRenderer / InboxCompleteRenderer / InboxDismissRenderer).
 *
 * Pins:
 *   - inbox_list streaming, empty, success-with-entries, error
 *   - inbox_complete streaming, success (with summary), error
 *   - inbox_dismiss streaming, success (failed/cancelled outcome), error
 *
 * Pattern mirrors tests/ask-user-choices-renderer.spec.ts — file:// fixture +
 * esbuild-on-demand bundle keyed off mtimes.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/inbox-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/inbox-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/inbox-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/InboxToolRenderers.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(RENDERER_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

const SAMPLE_ENTRIES = [
	{
		id: "8af3b1c2-aaaa-bbbb-cccc-1234567890ab",
		staffId: "staff1",
		source: { type: "trigger", triggerId: "cron-1" },
		title: "Daily standup digest",
		prompt: "Summarize PRs and post to #standup.",
		state: "pending",
		createdAt: Date.now() - 2 * 60 * 1000, // 2m ago
	},
	{
		id: "3df9aa01-aaaa-bbbb-cccc-1234567890ab",
		staffId: "staff1",
		source: { type: "manual_ui", actorId: "user1" },
		title: "Investigate flaky test",
		prompt: "browser-eval.spec.ts is flaky.",
		state: "pending",
		createdAt: Date.now() - 28 * 60 * 1000,
	},
	{
		id: "19c8b773-aaaa-bbbb-cccc-1234567890ab",
		staffId: "staff1",
		source: { type: "manual_api", actorId: "github-webhook" },
		title: "Process webhook from GitHub",
		prompt: "PR #4821 merged.",
		state: "failed",
		createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
		error: "External API returned 503.",
	},
];

test.describe("InboxListRenderer", () => {
	test("streaming state shows in-progress header", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderInbox("list", "list", {}, undefined, true);
		});
		await expect(page.locator("#list")).toContainText(/Listing inbox/i);
	});

	test("empty result shows zero-entries header", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const result = (window as any).__jsonResult({ entries: [] });
			(window as any).__renderInbox("list", "list", { state: "pending" }, result, false);
		});
		await expect(page.locator("#list")).toContainText(/No pending entries/i);
	});

	test("entries render with state badge, title, age and 8-char id chip", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((entries) => {
			const result = (window as any).__jsonResult({ entries });
			(window as any).__renderInbox("list", "list", {}, result, false);
		}, SAMPLE_ENTRIES);

		// Header has total count + state breakdown.
		const header = page.locator("#list");
		await expect(header).toContainText(/3 inbox entries/);
		await expect(header).toContainText(/2 pending/);
		await expect(header).toContainText(/1 failed/);

		// Three rows, each with the truncated 8-char entry id.
		await expect(page.locator("#list .font-mono")).toHaveCount(3);
		await expect(page.locator("#list .font-mono").first()).toHaveText("8af3b1c2");

		// Each entry's title appears.
		await expect(header).toContainText("Daily standup digest");
		await expect(header).toContainText("Investigate flaky test");
		await expect(header).toContainText("Process webhook from GitHub");
	});

	test("error result shows failure text", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const result = (window as any).__jsonResult("Inbox not initialised", true);
			(window as any).__renderInbox("list", "list", {}, result, false);
		});
		await expect(page.locator("#list")).toContainText(/Inbox list failed/i);
		// `.text-destructive` matches both the header icon span and the message div;
		// pin the message div explicitly (it carries `mt-1`).
		await expect(page.locator("#list div.text-destructive")).toContainText("Inbox not initialised");
	});
});

test.describe("InboxCompleteRenderer", () => {
	test("streaming shows entry id being completed", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderInbox("complete", "complete", { entry_id: "8af3b1c2-rest" }, undefined, true);
		});
		await expect(page.locator("#complete")).toContainText(/Completing/);
		await expect(page.locator("#complete .font-mono").first()).toHaveText("8af3b1c2");
	});

	test("success renders title, completed badge and summary text", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const data = { id: "8af3b1c2-x", title: "Daily standup digest", state: "completed", result: "Posted to #standup. 7 PRs." };
			const result = (window as any).__jsonResult(data);
			(window as any).__renderInbox(
				"complete",
				"complete",
				{ entry_id: "8af3b1c2-x", summary: "Posted to #standup. 7 PRs." },
				result,
				false,
			);
		});
		const el = page.locator("#complete");
		await expect(el).toContainText("Completed");
		await expect(el).toContainText("Daily standup digest");
		await expect(el).toContainText("completed");
		await expect(el).toContainText("Posted to #standup. 7 PRs.");
	});

	test("error result shows destructive text", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const result = (window as any).__jsonResult("409 Conflict: entry not in pending state", true);
			(window as any).__renderInbox("complete", "complete", { entry_id: "3df9aa01-x" }, result, false);
		});
		await expect(page.locator("#complete")).toContainText(/Failed to complete/);
		await expect(page.locator("#complete div.text-destructive")).toContainText("409 Conflict");
	});
});

test.describe("InboxDismissRenderer", () => {
	test("streaming shows outcome in header", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderInbox(
				"dismiss",
				"dismiss",
				{ entry_id: "19c8b773-x", outcome: "failed", reason: "boom" },
				undefined,
				true,
			);
		});
		await expect(page.locator("#dismiss")).toContainText(/Dismissing/);
		await expect(page.locator("#dismiss")).toContainText("failed");
	});

	test("success with outcome=failed renders failed badge and reason", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const data = { id: "19c8b773-x", title: "Process webhook", state: "failed", error: "503 from GitHub API." };
			const result = (window as any).__jsonResult(data);
			(window as any).__renderInbox(
				"dismiss",
				"dismiss",
				{ entry_id: "19c8b773-x", outcome: "failed", reason: "503 from GitHub API." },
				result,
				false,
			);
		});
		const el = page.locator("#dismiss");
		await expect(el).toContainText("Dismissed");
		await expect(el).toContainText("Process webhook");
		await expect(el).toContainText("failed");
		await expect(el).toContainText("503 from GitHub API.");
	});

	test("success with outcome=cancelled renders cancelled (line-through) badge", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const data = { id: "ec4abc11-x", title: "Duplicate cron", state: "cancelled", error: "Duplicate of 7c5fe991." };
			const result = (window as any).__jsonResult(data);
			(window as any).__renderInbox(
				"dismiss",
				"dismiss",
				{ entry_id: "ec4abc11-x", outcome: "cancelled", reason: "Duplicate of 7c5fe991." },
				result,
				false,
			);
		});
		const el = page.locator("#dismiss");
		await expect(el).toContainText("cancelled");
		// The cancelled badge uses line-through styling.
		await expect(el.locator(".line-through")).toHaveCount(1);
	});

	test("error result shows destructive text", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const result = (window as any).__jsonResult("409 Conflict", true);
			(window as any).__renderInbox(
				"dismiss",
				"dismiss",
				{ entry_id: "19c8b773-x", outcome: "failed", reason: "boom" },
				result,
				false,
			);
		});
		await expect(page.locator("#dismiss")).toContainText(/Failed to dismiss/);
	});
});
