/**
 * Reproducing browser-fixture test for the first-party PR walkthrough pack panel
 * parity regression after the pack migration.
 *
 * The fixture renders the real market-packs/pr-walkthrough/src/panel.js module via
 * the same lit contract used by pack panels, then asserts the reference
 * affordances documented by docs/design/pr-walkthrough-panel.md. These assertions
 * intentionally fail against the current compact pack panel; they should pass once
 * the pack panel is restored to the prototype/built-in UX.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TMP_DIR = path.resolve(".bobbit/tmp/pr-walkthrough-panel-parity");
const ENTRY = path.join(TMP_DIR, "entry.ts");
const BUNDLE = path.join(TMP_DIR, "bundle.js");
const PANEL_SRC = path.resolve("market-packs/pr-walkthrough/src/panel.js");
const IDS_SRC = path.resolve("src/shared/pr-walkthrough/ids.ts");

const ENTRY_SOURCE = String.raw`
import { html, nothing, render } from "lit";
import createPanel from "../../../market-packs/pr-walkthrough/src/panel.js";

const panel = createPanel({ html, nothing, renderHeader: () => nothing });
const root = () => document.getElementById("root");
let currentParams = {};
let currentHost = undefined;
let renderQueued = false;

const READY_YAML = ` + JSON.stringify(`pr:
  provider: github
  owner: SuuBro
  repo: bobbit
  number: 42
  title: Restore PR walkthrough panel parity
  url: https://github.com/SuuBro/bobbit/pull/42
  base_sha: abcdef1234567890
  head_sha: fedcba0987654321
walkthrough:
  summary: Restore the full review walkthrough surface.
`) + String.raw`;

const READY_BUNDLE = {
  found: true,
  persistedAt: "2026-06-13T12:00:00.000Z",
  changeset: {
    provider: "github",
    owner: "SuuBro",
    repo: "bobbit",
    number: 42,
    url: "https://github.com/SuuBro/bobbit/pull/42",
    prTitle: "Restore PR walkthrough panel parity",
    title: "Restore PR walkthrough panel parity",
    baseSha: "abcdef1234567890",
    headSha: "fedcba0987654321",
    filesChanged: 3,
    additions: 128,
    deletions: 14,
  },
  cards: [
    {
      id: "orientation-overview",
      phaseId: "orientation",
      navLabel: "Why this PR exists",
      title: "Why this PR exists",
      summary: "The pack panel needs to match the reference walkthrough shell before reviewers rely on it.",
      rationale: "This card supplies the orientation beats used by the reference stepper.",
      sections: [
        { id: "purpose", eyebrow: "Context", heading: "What changed", body: "The panel moved to a first-party pack." },
        { id: "risk", eyebrow: "Risk", heading: "What to inspect", body: "Diff review controls and comment affordances regressed." },
      ],
      checklist: ["Confirm the guided orientation remains visible", "Confirm the reviewer can leave feedback"],
      diffBlocks: [],
      suggestedComments: [],
    },
    {
      id: "diff-review",
      phaseId: "significant",
      navLabel: "Diff review",
      title: "Diff review controls and comments",
      summary: "Exercises multi-card navigation, diff rendering, suggested comments, and review controls.",
      rationale: "The reference panel offered inline/side-by-side diff modes and line/card comment workflows.",
      checklist: ["Toggle side-by-side and inline diffs", "Comment on individual lines", "Comment on the card"],
      diffBlocks: [
        {
          id: "panel-diff",
          filePath: "market-packs/pr-walkthrough/src/panel.js",
          status: "modified",
          hunks: [
            {
              header: "@@ -10,4 +10,7 @@",
              lines: [
                { id: "L10", kind: "ctx", text: "const phase = currentPhase();" },
                { id: "L11", kind: "del", text: "renderCompactDiff(block);" },
                { id: "L12", kind: "add", text: "renderReferenceDiff(block, diffMode);" },
                { id: "L13", kind: "add", text: "renderLineCommentButton(line);" },
              ],
            },
          ],
        },
        {
          id: "panel-styles-diff",
          filePath: "market-packs/pr-walkthrough/src/panel.css",
          status: "modified",
          hunks: [
            {
              header: "@@ -44,3 +44,5 @@",
              lines: [
                { id: "S44", kind: "ctx", text: ".prw-diff { overflow-x: auto; }" },
                { id: "S45", kind: "add", text: ".prw-diff-block { border-radius: 14px; }" },
              ],
            },
          ],
        },
      ],
      suggestedComments: [
        { id: "comment-1", diffBlockId: "panel-diff", lineId: "L13", body: "Consider keeping one horizontal scrollbar per diff widget." },
      ],
    },
    {
      id: "audit-summary",
      phaseId: "audit",
      navLabel: "Audit",
      title: "Final review controls",
      summary: "Pins Prev, Like, and Dislike as first-class reviewer controls.",
      rationale: "The old panel used explicit card-level review decisions.",
      checklist: ["Previous card navigation", "Like decision", "Dislike decision"],
      diffBlocks: [],
      suggestedComments: [],
    },
  ],
};

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render(panel.render(currentParams, currentHost), root());
  });
}

function makeHost(mode) {
  return {
    store: {
      async get(key) {
        if (!key.startsWith("binding/")) return undefined;
        return { jobId: mode === "ready" ? "job-ready" : "job-pending", baseSha: "abcdef1234567890", headSha: "fedcba0987654321" };
      },
    },
    async callRoute(route) {
      if (mode === "pending") {
        if (route === "recover") return { found: false };
        if (route === "status") return { phase: "running" };
      }
      if (route === "recover") return { found: true, yaml: READY_YAML, baseSha: "abcdef1234567890", headSha: "fedcba0987654321" };
      if (route === "publish") return { ok: true };
      if (route === "bundle") return READY_BUNDLE;
      if (route === "status") return { phase: "submitted", yaml: READY_YAML, baseSha: "abcdef1234567890", headSha: "fedcba0987654321" };
      return undefined;
    },
    requestRender: scheduleRender,
  };
}

function renderPanel(params, host) {
  currentParams = params;
  currentHost = host;
  render(panel.render(currentParams, currentHost), root());
}

window.__renderPrwPending = () => renderPanel({ __sessionId: "child-pending", jobId: "job-pending" }, makeHost("pending"));
window.__renderPrwReady = () => renderPanel({ __sessionId: "child-ready", jobId: "job-ready" }, makeHost("ready"));
window.__prwMissingReadyParityAffordances = () => {
  const hasText = (pattern) => pattern.test(document.body.textContent || "");
  const buttonText = (pattern) => Array.from(document.querySelectorAll("button")).some((button) => pattern.test(button.textContent || ""));
  const missing = [];
  if (!hasText(/PR\s*#?42|#42|pull\/42/i)) missing.push("prominent PR number/title header");
  if (!hasText(/3\s+files?/i) || !hasText(/\+128/) || !hasText(/-14/)) missing.push("file/addition/deletion stats");
  if (!hasText(/\d+\s*\/\s*\d+\s+reviewed/i) && !document.querySelector('[role="progressbar"], [data-testid="prw-review-progress"]')) missing.push("review progress indicator");
  if (!document.querySelector('a[href*="github.com"][href*="/pull/42"]')) missing.push("GitHub PR link affordance");
  if (!buttonText(/side-by-side/i) || !buttonText(/inline/i)) missing.push("side-by-side/inline diff mode controls");
  if (!document.querySelector('[data-testid="prw-phase-rail"], [aria-label="PR walkthrough phase rail"]')) missing.push("full phase rail structure");
  if (!document.querySelector('[data-testid="prw-phase-rail-collapsed"], [aria-label="Collapsed PR walkthrough phase rail"]')) missing.push("collapsed/narrow phase rail structure");
  if (!buttonText(/add line comment|comment on line|line comment/i)) missing.push("line-level comment affordance");
  if (!buttonText(/add card comment|comment on card|card comment/i)) missing.push("card-level comment affordance");
  if (!buttonText(/^\s*prev(ious)?\s*$/i) || !buttonText(/^\s*like\s*$/i) || !buttonText(/^\s*dislike\s*$/i)) missing.push("Prev/Like/Dislike review controls");
  return missing;
};
window.__ready = true;
`;

test.beforeAll(() => {
	fs.mkdirSync(TMP_DIR, { recursive: true });
	fs.writeFileSync(ENTRY, ENTRY_SOURCE, "utf8");
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(PANEL_SRC).mtimeMs, fs.statSync(IDS_SRC).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild "${ENTRY}"`,
				"--bundle --format=iife --target=es2022",
				`--outfile="${BUNDLE}"`,
				"--tsconfig=tsconfig.web.json",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

async function loadFixture(page: any) {
	await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>PR Walkthrough Panel Parity</title></head><body><div id="root"></div></body></html>`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("PR walkthrough pack panel UI parity", () => {
	test("renders a pending reviewer-child state without falling back to an owner-session loader", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwPending());

		await expect(page.locator('[data-testid="prw-panel-root"]')).toBeVisible();
		await expect(page.locator('[data-testid="prw-pending"]')).toContainText("PR Walkthrough: In Progress");
		await expect(page.locator("body")).not.toContainText(/Run walkthrough|Load walkthrough/i);
	});

	test("ready multi-card state exposes the reference walkthrough review affordances", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="prw-card"]')).toHaveCount(1);
		await expect(page.locator('[data-testid="prw-nav-card"]')).toHaveCount(3);

		const missing = await page.evaluate(() => (window as any).__prwMissingReadyParityAffordances());
		expect(missing, `PR walkthrough panel parity affordances missing: ${(missing as string[]).join(", ")}`).toEqual([]);
	});

	test("side-by-side diff pairs adjacent deletion and addition lines", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('.prw-phase-rail button[data-prw-nav="diff-review"]').click();

		await expect(page.locator(".prw-segment.is-active")).toContainText("Side-by-side");
		const firstBlock = page.locator('[data-testid="prw-diffblock"]').first();
		const sideRows = firstBlock.locator('[data-testid="prw-side-diff-row"]');
		await expect(sideRows).toHaveCount(3);

		const paired = firstBlock.locator('[data-testid="prw-side-diff-row"][data-prw-old-line-id="L11"][data-prw-new-line-id="L12"]');
		await expect(paired.locator(".prw-old")).toContainText("renderCompactDiff(block);");
		await expect(paired.locator(".prw-new")).toContainText("renderReferenceDiff(block, diffMode);");
		await expect(paired.locator(".prw-old-comment").getByRole("button", { name: "Add line comment" })).toBeVisible();
		await expect(paired.locator(".prw-new-comment").getByRole("button", { name: "Add line comment" })).toBeVisible();

		const additionOnly = firstBlock.locator('[data-testid="prw-side-diff-row"][data-prw-old-line-id=""][data-prw-new-line-id="L13"]');
		await expect(additionOnly.locator(".prw-old")).toHaveText("");
		await expect(additionOnly.locator(".prw-new")).toContainText("renderLineCommentButton(line);");
	});

	test("line suggestions render inline and Use suggestion prepares the target editor", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('.prw-phase-rail button[data-prw-nav="diff-review"]').click();

		const inlineSuggestion = page.locator('[data-testid="prw-inline-suggested-comment"][data-prw-line="L13"]');
		await expect(inlineSuggestion).toContainText("Consider keeping one horizontal scrollbar per diff widget.");
		await expect(page.locator(".prw-line-suggestions")).toHaveCount(0);
		await inlineSuggestion.getByRole("button", { name: "Use suggestion" }).click();

		const editor = page.locator('[data-testid="prw-line-comment-editor"]');
		await expect(editor).toBeVisible();
		await expect(editor.locator("textarea")).toHaveValue("Consider keeping one horizontal scrollbar per diff widget.");
		await page.getByRole("button", { name: "Save comment" }).click();
		await expect(page.locator('[data-testid="prw-line-user-comment"]')).toContainText("one horizontal scrollbar");
	});

	test("ready state supports user comments, dislike gating, narrow inline default, and diff collapse", async ({ page }) => {
		await page.setViewportSize({ width: 500, height: 800 });
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });

		await page.locator('.prw-phase-rail-collapsed button[aria-label="Diff review controls and comments"]').click();
		await expect(page.locator(".prw-segment.is-active")).toContainText("Inline");
		await page.getByRole("button", { name: "Side-by-side" }).click();
		await expect(page.locator(".prw-segment.is-active")).toContainText("Side-by-side");

		const dislike = page.getByRole("button", { name: "Dislike" });
		await expect(dislike).toBeDisabled();
		await page.getByRole("button", { name: "Add line comment" }).first().click();
		await expect(page.locator('[data-testid="prw-line-comment-editor"]')).toBeVisible();
		await page.locator('[data-testid="prw-line-comment-editor"] textarea').fill("Please keep the line-level affordance functional.");
		await expect(dislike).toBeDisabled();
		await page.getByRole("button", { name: "Save comment" }).click();
		await expect(page.locator('[data-testid="prw-line-user-comment"]')).toContainText("line-level affordance");
		await expect(dislike).toBeEnabled();

		const blocks = page.locator('[data-testid="prw-diffblock"]');
		await expect(blocks).toHaveCount(2);
		await blocks.nth(0).getByTestId("prw-diff-toggle").click();
		await expect(blocks.nth(0).locator("table")).toHaveCount(0);
		await expect(blocks.nth(1).locator("table")).toHaveCount(1);

		await page.locator('.prw-phase-rail-collapsed button[aria-label="Final review controls"]').click();
		await expect(dislike).toBeDisabled();
		await page.getByRole("button", { name: "Add card comment" }).click();
		await page.locator('[data-testid="prw-card-comment-editor"] textarea').fill("Needs a follow-up before approval.");
		await expect(dislike).toBeDisabled();
		await page.getByRole("button", { name: "Save comment" }).click();
		await expect(page.locator('[data-testid="prw-card-user-comment"]')).toContainText("follow-up");
		await expect(dislike).toBeEnabled();
	});
});
