import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression test for: an agent calling `review_open` from a background
 * (cached) session must not open the review pane on whichever session the
 * user is currently viewing.
 *
 * `RemoteAgent._checkReviewToolResult` writes directly to global
 * `state.review*` fields. Because `selectSession` keeps the outgoing
 * session's RemoteAgent alive in `sessionCache`, message_end events from the
 * background session still flow into that handler. The fix is to gate every
 * mutation on the agent being the active one (`this === state.remoteAgent`).
 */

const FIXTURE = path.resolve("tests/fixtures/review-tool-active-guard.html");
const BUNDLE = path.resolve("tests/fixtures/review-tool-active-guard-bundle.js");
const ENTRY = path.resolve("tests/fixtures/review-tool-active-guard-entry.ts");
const REMOTE_AGENT_SRC = path.resolve("src/app/remote-agent.ts");
const REVIEW_SOURCES_SRC = path.resolve("src/app/review-sources.ts");
const PREVIEW_PANEL_SRC = path.resolve("src/app/preview-panel.ts");
const PANEL_WORKSPACE_SRC = path.resolve("src/app/panel-workspace.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(REMOTE_AGENT_SRC).mtimeMs,
		fs.statSync(REVIEW_SOURCES_SRC).mtimeMs,
		fs.statSync(PREVIEW_PANEL_SRC).mtimeMs,
		fs.statSync(PANEL_WORKSPACE_SRC).mtimeMs,
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

test.describe("review tool active-session guard", () => {
	test("background session's review_open does NOT mutate global review state", async ({ page }) => {
		await gotoAndWait(page);
		const result = await page.evaluate(() => {
			const w = window as any;
			const active = w.__makeAgent("active-session");
			const background = w.__makeAgent("background-session");
			w.__setActive(active);
			w.__clearReviewState();

			// Simulate the bug: background session's agent emits review_open.
			w.__deliverReviewToolResult(background, "review_open", {
				title: "PR-from-background",
				markdown: "# Should not appear",
			});

			return w.__getReviewState();
		});

		expect(result.open).toBe(false);
		expect(result.activeTab).toBe("");
		expect(result.docCount).toBe(0);
	});

	test("active session's review_open DOES open the review pane", async ({ page }) => {
		await gotoAndWait(page);
		const result = await page.evaluate(() => {
			const w = window as any;
			const active = w.__makeAgent("active-session");
			w.__setActive(active);
			w.__clearReviewState();

			w.__deliverReviewToolResult(active, "review_open", {
				title: "PR-from-active",
				markdown: "# Welcome",
			});

			return w.__getReviewState();
		});

		expect(result.open).toBe(true);
		expect(result.activeTab).toBe("PR-from-active");
		expect(result.docCount).toBe(1);
		expect(result.docTitles).toEqual(["PR-from-active"]);
	});

	test("background session's review_close does NOT clear active session's documents", async ({ page }) => {
		await gotoAndWait(page);
		const result = await page.evaluate(() => {
			const w = window as any;
			const active = w.__makeAgent("active-session");
			const background = w.__makeAgent("background-session");
			w.__setActive(active);
			w.__clearReviewState();

			// Active session opens a review.
			w.__deliverReviewToolResult(active, "review_open", {
				title: "Active-PR",
				markdown: "# Important",
			});
			const before = w.__getReviewState();

			// Background session emits review_close — must NOT clear the active doc.
			w.__deliverReviewToolResult(background, "review_close", {});
			const after = w.__getReviewState();

			return { before, after };
		});

		expect(result.before.open).toBe(true);
		expect(result.before.docCount).toBe(1);
		expect(result.after.open).toBe(true);
		expect(result.after.docCount).toBe(1);
		expect(result.after.activeTab).toBe("Active-PR");
	});
});
