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
        {
          id: "purpose",
          navLabel: "Context",
          eyebrow: "Context",
          heading: "What changed",
          body: "The panel moved to a first-party pack.",
          verdict: { recommendation: "comment", confidence: "medium" },
          showStats: true,
          concerns: [{ severity: "non_blocking", text: "Keep reviewer workflow controls visible while preserving diff parity." }],
          fileRoles: [{ role: "core", file: "market-packs/pr-walkthrough/src/panel.js", note: "Restored shell implementation." }],
        },
        {
          id: "risk",
          navLabel: "Risk",
          eyebrow: "Risk",
          heading: "What to inspect",
          body: "Diff review controls and comment affordances regressed.",
          showStats: true,
          concerns: [{ severity: "blocking", text: "The submit flow must not unlock until every review card is complete." }],
          fileRoles: [{ role: "verify", file: "tests/pr-walkthrough-panel-parity.spec.ts", note: "Browser fixture coverage." }],
        },
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
          oldPath: "src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts",
          externalUrl: "https://github.com/SuuBro/bobbit/blob/fedcba0987654321/market-packs/pr-walkthrough/src/panel.js",
          hunks: [
            {
              id: "panel-main-hunk",
              header: "@@ -10,26 +10,29 @@ function renderReviewDiffPanel(block) {",
              lines: [
                { id: "L10", kind: "context", oldLine: 10, newLine: 10, text: "function renderReviewDiffPanel(block) {" },
                { id: "L11", kind: "context", oldLine: 11, newLine: 11, text: "  const mode = block.mode;" },
                { id: "L12", kind: "context", oldLine: 12, newLine: 12, text: "  const meta = { retries: 3, label: \"Diff review\" }; // token sample" },
                { id: "L13", kind: "context", oldLine: 13, newLine: 13, text: "  const phase = currentPhase();" },
                { id: "L14", kind: "context", oldLine: 14, newLine: 14, text: "  const comments = loadLineComments(block.id);" },
                { id: "L15", kind: "context", oldLine: 15, newLine: 15, text: "  const counts = calculateCounts(block.hunks);" },
                { id: "L16", kind: "context", oldLine: 16, newLine: 16, text: "  // keep reviewer state local" },
                { id: "L17", kind: "del", oldLine: 17, text: "  renderCompactDiff(block);" },
                { id: "L18", kind: "add", newLine: 18, text: "  renderReferenceDiff(block, diffMode);" },
                { id: "L19", kind: "context", oldLine: 18, newLine: 19, text: "  renderDiffFooter(block);" },
                { id: "L20", kind: "context", oldLine: 19, newLine: 20, text: "  preserveReviewDecision(block.id);" },
                { id: "L21", kind: "context", oldLine: 20, newLine: 21, text: "  persistCollapsedState(block.id);" },
                { id: "L22", kind: "context", oldLine: 21, newLine: 22, text: "  syncCardProgress(block.cardId);" },
                { id: "L23", kind: "context", oldLine: 22, newLine: 23, text: "  queueMicrotask(() => requestRender());" },
                { id: "L24", kind: "context", oldLine: 23, newLine: 24, text: "  renderCardChecklist(block.cardId);" },
                { id: "L25", kind: "context", oldLine: 24, newLine: 25, text: "  renderSuggestedConcerns(block.cardId);" },
                { id: "L26", kind: "context", oldLine: 25, newLine: 26, text: "  restoreScrollPosition(block.id);" },
                { id: "L27", kind: "context", oldLine: 26, newLine: 27, text: "  bindKeyboardShortcuts(block.id);" },
                { id: "L28", kind: "context", oldLine: 27, newLine: 28, text: "  renderPhaseRail(block.cardId);" },
                { id: "L29", kind: "context", oldLine: 28, newLine: 29, text: "  rememberFocusedLine(block.id);" },
                { id: "L30", kind: "context", oldLine: 29, newLine: 30, text: "  renderModeChooser(diffMode);" },
                { id: "L31", kind: "context", oldLine: 30, newLine: 31, text: "  const cue = createCommentCue(block.id);" },
                { id: "L32", kind: "context", oldLine: 31, newLine: 32, text: "  attachCommentMarkers(cue);" },
                { id: "L33", kind: "context", oldLine: 32, newLine: 33, text: "  markResolvedSuggestions(block.id);" },
                { id: "L34", kind: "context", oldLine: 33, newLine: 34, text: "  const line = getTargetLine(block);" },
                { id: "L35", kind: "context", oldLine: 34, newLine: 35, text: "  ensureOneHorizontalScrollbar(block.id);" },
                { id: "L36", kind: "add", newLine: 36, text: "  renderLineCommentButton(line, { density: \"compact\", limit: 3 }); // restore cue" },
                { id: "L37", kind: "context", oldLine: 35, newLine: 37, text: "  return block;" },
                { id: "L38", kind: "context", oldLine: 36, newLine: 38, text: "}" },
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
        { id: "comment-1", diffBlockId: "panel-diff", lineId: "L36", body: "Consider keeping one horizontal scrollbar per diff widget." },
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
  const buttonText = (pattern) => Array.from(document.querySelectorAll("button")).some((button) => pattern.test([button.textContent, button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean).join(" ")));
  const missing = [];
  if (!hasText(/PR\s*#?42|#42|pull\/42/i)) missing.push("prominent PR number/title header");
  if (!hasText(/3\s+files?/i) || !hasText(/\+128/) || !hasText(/-14/)) missing.push("file/addition/deletion stats");
  if (!hasText(/\d+\s*\/\s*\d+\s+reviewed/i) && !document.querySelector('[role="progressbar"], [data-testid="prw-review-progress"]')) missing.push("review progress indicator");
  if (!document.querySelector('a[href*="github.com"][href*="/pull/42"]')) missing.push("GitHub PR link affordance");
  if (!buttonText(/side-by-side|split diff/i) || !buttonText(/inline/i)) missing.push("side-by-side/inline diff mode controls");
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

async function renderReady(page: any) {
	await loadFixture(page);
	await page.evaluate(() => (window as any).__renderPrwReady());
}

async function expectRenderedReadyPanel(page: any) {
	await expect(page.locator('[data-testid="prw-bundle"], [data-testid="pr-walkthrough-panel"]').first()).toBeVisible({ timeout: 10_000 });
}

async function startReviewFromGuide(page: any) {
	await expect(page.locator('[data-testid="pr-walkthrough-orientation-guide"]'), "pr-walkthrough shell parity: guided orientation card is required before review cards").toBeVisible();
	await expect(page.locator('[data-testid="pr-walkthrough-guide-counter"]')).toContainText(/1\s*\/\s*2/);
	await page.locator('[data-testid="pr-walkthrough-guide-next"]').click();
	await expect(page.locator('[data-testid="pr-walkthrough-guide-counter"]')).toContainText(/2\s*\/\s*2/);
	await expect(page.locator('[data-testid="pr-walkthrough-guide-next"]')).toContainText(/Start review/i);
	await page.locator('[data-testid="pr-walkthrough-guide-next"]').click();
	await expect(page.locator('[data-testid="pr-walkthrough-card-title"]')).toContainText("Diff review controls and comments");
}

async function visibleRailTestIds(page: any): Promise<string[]> {
	return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="pr-walkthrough-labelled-rail"], [data-testid="pr-walkthrough-collapsed-rail"]'))
		.filter((element) => {
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
		})
		.map((element) => element.dataset.testid || ""));
}

test.describe("PR walkthrough pack panel UI parity", () => {
	test("renders a pending reviewer-child state without falling back to an owner-session loader", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwPending());

		await expect(page.locator('[data-testid="prw-panel-root"]')).toBeVisible();
		await expect(page.locator('[data-testid="prw-pending"]')).toContainText("PR Walkthrough: In Progress");
		await expect(page.locator("body")).not.toContainText(/Run walkthrough|Load walkthrough/i);
	});

	test("pr-walkthrough shell parity: compact historical header toolbar is restored", async ({ page }) => {
		await renderReady(page);
		await expectRenderedReadyPanel(page);

		const shell = page.locator('[data-testid="pr-walkthrough-panel"]');
		await expect(shell, "pr-walkthrough shell parity: restored root .shell must expose data-testid=pr-walkthrough-panel").toBeVisible();
		await expect(shell).toHaveClass(/\bshell\b/);
		await expect(page.locator(".shell > .body > .content"), "pr-walkthrough shell parity: dense .shell/.body/.content layout classes must be present").toBeVisible();

		const typography = await shell.evaluate((element: HTMLElement) => {
			const style = getComputedStyle(element);
			return { fontSize: style.fontSize, lineHeight: style.lineHeight };
		});
		expect(typography.fontSize, "pr-walkthrough shell parity: root font must be 13px/1.45 system-ui").toBe("13px");
		const lineHeight = Number.parseFloat(typography.lineHeight);
		expect(lineHeight, "pr-walkthrough shell parity: root line-height must be approximately 1.45").toBeGreaterThanOrEqual(18);
		expect(lineHeight, "pr-walkthrough shell parity: root line-height must be approximately 1.45").toBeLessThanOrEqual(19.5);

		const header = page.locator('[data-testid="pr-walkthrough-header"]');
		await expect(header, "pr-walkthrough shell parity: compact header data-testid=pr-walkthrough-header is required").toBeVisible();
		await expect(header).toHaveClass(/\bheader\b/);
		const box = await header.boundingBox();
		expect(box?.height, "pr-walkthrough shell parity: header must remain a compact ~58px toolbar").toBeGreaterThanOrEqual(50);
		expect(box?.height, "pr-walkthrough shell parity: header must remain a compact ~58px toolbar").toBeLessThanOrEqual(70);
		await expect(page.locator('[data-testid="pr-walkthrough-pr-title"]')).toContainText("Restore PR walkthrough panel parity");
		await expect(page.locator('[data-testid="pr-walkthrough-pr-stats"]')).toContainText(/3 files/);
		await expect(page.locator('[data-testid="pr-walkthrough-pr-stats"]')).toContainText(/\+128/);
		await expect(page.locator('[data-testid="pr-walkthrough-pr-stats"]')).toContainText(/-14/);
		await expect(page.locator('[data-testid="pr-walkthrough-pr-link"]')).toHaveAttribute("href", /github\.com\/SuuBro\/bobbit\/pull\/42/);
		await expect(page.locator('[data-testid="pr-walkthrough-progress"]')).toContainText(/0\s*\/\s*2\s+reviewed/);
		await expect(page.locator('[data-testid="pr-walkthrough-submit-review"]')).toBeDisabled();
	});

	test("pr-walkthrough shell parity: single rail toggles, resizes, and keeps orientation steps", async ({ page }) => {
		await renderReady(page);
		await expectRenderedReadyPanel(page);

		await expect(page.locator('[data-testid="pr-walkthrough-labelled-rail"]'), "pr-walkthrough shell parity: labelled rail must be the single desktop sidebar").toBeVisible();
		expect(await visibleRailTestIds(page), "pr-walkthrough shell parity: only the labelled rail should be visible before toggle").toEqual(["pr-walkthrough-labelled-rail"]);
		await expect(page.locator('[data-testid="pr-walkthrough-rail-toggle"]'), "pr-walkthrough-rail-toggle must collapse/expand the single rail").toBeVisible();
		await expect(page.locator('[data-testid="pr-walkthrough-rail-resize"]'), "pr-walkthrough shell parity: desktop labelled rail must expose pr-walkthrough-rail-resize").toBeVisible();
		await expect(page.locator('[data-testid="pr-walkthrough-phase-button"]')).not.toHaveCount(0);
		await expect(page.locator('[data-testid="pr-walkthrough-card-step"]')).not.toHaveCount(0);
		await expect(page.locator('[data-testid="pr-walkthrough-orientation-rail"]')).toBeVisible();
		await expect(page.locator('[data-testid="pr-walkthrough-orientation-step"]')).toHaveCount(2);

		const rail = page.locator('[data-testid="pr-walkthrough-labelled-rail"]');
		const beforeWidth = (await rail.boundingBox())?.width || 0;
		const handleBox = await page.locator('[data-testid="pr-walkthrough-rail-resize"]').boundingBox();
		expect(handleBox, "pr-walkthrough shell parity: resize handle must have a measurable hit target").toBeTruthy();
		await page.mouse.move((handleBox?.x || 0) + (handleBox?.width || 1) / 2, (handleBox?.y || 0) + (handleBox?.height || 1) / 2);
		await page.mouse.down();
		await page.mouse.move((handleBox?.x || 0) + 85, (handleBox?.y || 0) + (handleBox?.height || 1) / 2);
		await page.mouse.up();
		const afterWidth = (await rail.boundingBox())?.width || 0;
		expect(afterWidth, "pr-walkthrough shell parity: dragging pr-walkthrough-rail-resize must resize the rail").toBeGreaterThan(beforeWidth + 20);
		expect(afterWidth, "pr-walkthrough shell parity: rail resize must clamp near the historical 360px maximum").toBeLessThanOrEqual(365);

		await page.locator('[data-testid="pr-walkthrough-rail-toggle"]').click();
		await expect(page.locator('[data-testid="pr-walkthrough-collapsed-rail"]'), "pr-walkthrough shell parity: collapsed rail must replace labelled rail after toggle").toBeVisible();
		expect(await visibleRailTestIds(page), "pr-walkthrough shell parity: only the collapsed rail should be visible after toggle").toEqual(["pr-walkthrough-collapsed-rail"]);
		await expect(page.locator('[data-testid="pr-walkthrough-collapsed-rail"] [data-testid="pr-walkthrough-orientation-step"]')).toHaveCount(2);
		await expect(page.locator('[data-testid="pr-walkthrough-collapsed-rail"] [data-testid="pr-walkthrough-rail-resize"]')).toHaveCount(0);
	});

	test("pr-walkthrough shell parity: container-narrow panels auto-collapse the rail in a wide viewport", async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 800 });
		await loadFixture(page);
		await page.evaluate(() => {
			const root = document.getElementById("root");
			if (root) root.style.width = "520px";
			(window as any).__renderPrwReady();
		});
		await expectRenderedReadyPanel(page);

		await expect(page.locator('[data-testid="pr-walkthrough-collapsed-rail"]'), "pr-walkthrough shell parity: ResizeObserver must collapse a narrow embedded panel even when the viewport is wide").toBeVisible();
		expect(await visibleRailTestIds(page)).toEqual(["pr-walkthrough-collapsed-rail"]);
		await expect(page.locator('[data-testid="pr-walkthrough-rail-resize"]')).toHaveCount(0);

		await page.evaluate(() => {
			const root = document.getElementById("root");
			if (root) root.style.width = "1120px";
		});
		await expect(page.locator('[data-testid="pr-walkthrough-labelled-rail"]'), "pr-walkthrough shell parity: labelled rail should recover when the observed panel width grows").toBeVisible();
		expect(await visibleRailTestIds(page)).toEqual(["pr-walkthrough-labelled-rail"]);
	});

	test("pr-walkthrough shell parity: guided orientation rail and card navigation match the historical flow", async ({ page }) => {
		await renderReady(page);
		await expectRenderedReadyPanel(page);

		await expect(page.locator('[data-testid="pr-walkthrough-orientation-guide"]'), "pr-walkthrough shell parity: first card with sections must render the dedicated guide card").toBeVisible();
		await expect(page.locator('[data-testid="pr-walkthrough-guide-counter"]')).toContainText(/1\s*\/\s*2/);
		await expect(page.locator('[data-testid="pr-walkthrough-beat-heading"]')).toContainText("What changed");
		await expect(page.locator('[data-testid="pr-walkthrough-beat-verdict"]')).toContainText(/COMMENT/);
		await expect(page.locator('[data-testid="pr-walkthrough-beat-stats"]')).toContainText(/3 files/);
		await expect(page.locator('[data-testid="pr-walkthrough-beat-concerns"]')).toContainText(/non-blocking/i);
		await expect(page.locator('[data-testid="pr-walkthrough-beat-filemap"]')).toContainText("market-packs/pr-walkthrough/src/panel.js");
		await expect(page.locator('[data-testid="pr-walkthrough-guide-back"]')).toBeDisabled();
		await expect(page.locator('[data-testid="pr-walkthrough-orientation-step"]').first()).toHaveAttribute("data-state", "current");

		await page.locator('[data-testid="pr-walkthrough-orientation-step"]').nth(1).click();
		await expect(page.locator('[data-testid="pr-walkthrough-guide-counter"]')).toContainText(/2\s*\/\s*2/);
		await expect(page.locator('[data-testid="pr-walkthrough-beat-heading"]')).toContainText("What to inspect");
		await expect(page.locator('[data-testid="pr-walkthrough-guide-back"]')).toBeEnabled();
		await expect(page.locator('[data-testid="pr-walkthrough-guide-next"]')).toContainText(/Start review/i);
		await page.locator('[data-testid="pr-walkthrough-guide-back"]').click();
		await expect(page.locator('[data-testid="pr-walkthrough-guide-counter"]')).toContainText(/1\s*\/\s*2/);

		await startReviewFromGuide(page);
		await expect(page.locator('[data-testid="pr-walkthrough-orientation-guide"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="pr-walkthrough-card"][data-card-id="diff-review"]')).toBeVisible();
		await expect(page.locator('[data-testid="pr-walkthrough-orientation-step"]').first()).toHaveAttribute("data-state", "visited");
	});

	test("pr-walkthrough shell parity: Like completes the card, persists state, updates progress, and auto-advances", async ({ page }) => {
		await renderReady(page);
		await expectRenderedReadyPanel(page);
		await startReviewFromGuide(page);

		await expect(page.locator('[data-testid="pr-walkthrough-progress"]')).toContainText(/1\s*\/\s*2\s+reviewed/);
		await expect(page.locator('[data-testid="pr-walkthrough-dislike"]')).toBeDisabled();
		await page.locator('[data-testid="pr-walkthrough-like"]').click();
		await expect(page.locator('[data-testid="pr-walkthrough-card-title"]')).toContainText("Final review controls");
		await expect(page.locator('[data-testid="pr-walkthrough-progress"]')).toContainText(/2\s*\/\s*2\s+reviewed/);
		await expect(page.locator('[data-testid="pr-walkthrough-submit-review"]')).toBeEnabled();

		await page.locator('[data-testid="pr-walkthrough-prev"]').click();
		await expect(page.locator('[data-testid="pr-walkthrough-card-title"]')).toContainText("Diff review controls and comments");
		await expect(page.locator('[data-testid="pr-walkthrough-like"]')).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator('[data-testid="pr-walkthrough-like"]')).toHaveClass(/decision-selected/);
		const likedStep = page.locator('[data-testid="pr-walkthrough-card-step"][data-card-id="diff-review"]');
		await expect(likedStep, "pr-walkthrough shell parity: labelled rail must show completed liked state").toHaveClass(/complete/);
		await expect(likedStep).toHaveClass(/liked/);

		await page.locator('[data-testid="pr-walkthrough-rail-toggle"]').click();
		await expect(page.locator('[data-testid="pr-walkthrough-collapsed-rail"] [data-testid="pr-walkthrough-card-step"][data-card-id="diff-review"]'), "pr-walkthrough shell parity: collapsed rail must preserve liked/completed state").toHaveClass(/liked/);
	});

	test("pr-walkthrough shell parity: Dislike requires a saved comment, then persists and auto-advances", async ({ page }) => {
		await renderReady(page);
		await expectRenderedReadyPanel(page);
		await startReviewFromGuide(page);

		const dislike = page.locator('[data-testid="pr-walkthrough-dislike"]');
		await expect(dislike, "pr-walkthrough shell parity: Dislike must stay disabled until a saved comment exists").toBeDisabled();
		await page.locator('[data-testid="pr-walkthrough-add-card-comment"]').click();
		const editor = page.locator('[data-testid="pr-walkthrough-comment-editor"][data-comment-scope="card"]');
		await expect(editor).toBeVisible();
		await editor.locator('[data-testid="pr-walkthrough-comment-input"]').fill("Needs the historical compact shell before approval.");
		await expect(dislike).toBeDisabled();
		await editor.locator('[data-testid="pr-walkthrough-comment-save"]').click();
		await expect(page.locator('[data-testid="pr-walkthrough-comment"][data-comment-scope="card"]')).toContainText("historical compact shell");
		await expect(dislike).toBeEnabled();

		await dislike.click();
		await expect(page.locator('[data-testid="pr-walkthrough-card-title"]')).toContainText("Final review controls");
		await page.locator('[data-testid="pr-walkthrough-prev"]').click();
		await expect(page.locator('[data-testid="pr-walkthrough-dislike"]')).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator('[data-testid="pr-walkthrough-dislike"]')).toHaveClass(/decision-selected/);
		const dislikedStep = page.locator('[data-testid="pr-walkthrough-card-step"][data-card-id="diff-review"]');
		await expect(dislikedStep, "pr-walkthrough shell parity: labelled rail must show completed disliked state").toHaveClass(/complete/);
		await expect(dislikedStep).toHaveClass(/disliked/);

		await page.locator('[data-testid="pr-walkthrough-rail-toggle"]').click();
		await expect(page.locator('[data-testid="pr-walkthrough-collapsed-rail"] [data-testid="pr-walkthrough-card-step"][data-card-id="diff-review"]'), "pr-walkthrough shell parity: collapsed rail must preserve disliked/completed state").toHaveClass(/disliked/);
	});

	test("pr-walkthrough shell parity: Submit unlocks only after review completion and opens export preview", async ({ page }) => {
		await renderReady(page);
		await expectRenderedReadyPanel(page);
		const submit = page.locator('[data-testid="pr-walkthrough-submit-review"]');
		await expect(submit, "pr-walkthrough-submit-review must be disabled until all non-audit cards are complete").toBeDisabled();

		await startReviewFromGuide(page);
		await expect(submit).toBeDisabled();
		const firstBlock = page.locator('.diff-block[data-file-path="market-packs/pr-walkthrough/src/panel.js"], [data-testid="pr-walkthrough-diff-block"][data-file-path="market-packs/pr-walkthrough/src/panel.js"]').first();
		await firstBlock.locator('.diff-line[data-line-id="L36"] .comment-cue').click();
		let editor = page.locator('[data-testid="pr-walkthrough-comment-editor"], [data-testid="prw-line-comment-editor"]').last();
		await editor.locator('textarea').fill("Export this valid line comment.");
		await editor.getByRole("button", { name: /Save comment|Save/ }).click();
		await page.locator('[data-testid="pr-walkthrough-add-card-comment"]').click();
		editor = page.locator('[data-testid="pr-walkthrough-comment-editor"][data-comment-scope="card"]');
		await editor.locator('[data-testid="pr-walkthrough-comment-input"]').fill("Export this card-level fallback comment.");
		await editor.locator('[data-testid="pr-walkthrough-comment-save"]').click();
		await page.locator('[data-testid="pr-walkthrough-like"]').click();
		await expect(submit).toBeEnabled();
		await submit.click();

		await expect(page.locator('[data-testid="pr-walkthrough-export-preview"]'), "pr-walkthrough shell parity: Submit must open the historical export preview/unavailable dialog").toBeVisible();
		await expect(page.locator('[data-testid="pr-walkthrough-export-preview"]')).toContainText(/Review export preview/i);
		await expect(page.locator('[data-testid="pr-walkthrough-export-unavailable"]')).toContainText(/Export unavailable|not available/i);
		await expect(page.locator('[data-testid="pr-walkthrough-export-body"]')).toContainText(/Diff review controls and comments|Final review controls|Restore PR walkthrough/i);
		await expect(page.locator('[data-testid="pr-walkthrough-export-row"]')).toHaveCount(2);
		await expect(page.locator('[data-testid="pr-walkthrough-export-row"][data-export-scope="line"]')).toContainText(/Valid: valid line mapping/);
		await expect(page.locator('[data-testid="pr-walkthrough-export-row"][data-export-scope="card"]')).toContainText(/Unmappable: card comment/);
		await expect(page.locator('[data-testid="pr-walkthrough-export-submit"]')).toBeDisabled();
		await expect(page.locator('[data-testid="pr-walkthrough-export-preview"]').getByRole("button", { name: /Copy draft/i })).toBeVisible();
		await page.locator('[data-testid="pr-walkthrough-export-preview"]').getByRole("button", { name: /^Close$/i }).click();
		await expect(page.locator('[data-testid="pr-walkthrough-export-preview"]')).toHaveCount(0);
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

	test("side-by-side diff uses the historical compact split-grid renderer", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('.prw-phase-rail button[data-prw-nav="diff-review"]').click();

		await expect(page.locator('#diff-mode-split.active, .mode-toggle [aria-label="Split diff"][aria-checked="true"]')).toBeVisible();
		const firstBlock = page.locator('.diff-block[data-file-path="market-packs/pr-walkthrough/src/panel.js"], [data-testid="pr-walkthrough-diff-block"][data-file-path="market-packs/pr-walkthrough/src/panel.js"]').first();
		await expect(firstBlock).toBeVisible();
		await expect(firstBlock.locator('.prw-diff-table')).toHaveCount(0);
		await expect(firstBlock.locator('.diff-overflow > .split-grid')).toBeVisible();
		await expect(firstBlock.locator('.split-row')).not.toHaveCount(0);
		await expect(firstBlock.locator('.diff-line')).not.toHaveCount(0);
		await expect(firstBlock.locator('.line-text')).not.toHaveCount(0);
		await expect(firstBlock.locator('.comment-cue').first()).toHaveText('+');

		const paired = firstBlock.locator('.split-row:has(.diff-line[data-line-id="L17"]):has(.diff-line[data-line-id="L18"])').first();
		await expect(paired.locator('.diff-line.del .line-text')).toContainText('renderCompactDiff(block);');
		await expect(paired.locator('.diff-line.add .line-text')).toContainText('renderReferenceDiff(block, diffMode);');
		await expect(paired.locator('.diff-line.del .comment-cue')).toHaveAttribute('aria-label', /Add line comment/i);
		await expect(paired.locator('.diff-line.add .comment-cue')).toHaveAttribute('aria-label', /Add line comment/i);

		const additionOnly = firstBlock.locator('.split-row:has(.diff-line[data-line-id="L36"])').first();
		await expect(additionOnly.locator('.diff-line.empty')).toHaveCount(1);
		await expect(additionOnly.locator('.diff-line.add .line-text')).toContainText('renderLineCommentButton(line');
	});

	test("line suggestions render with historical inline suggestion actions", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('.prw-phase-rail button[data-prw-nav="diff-review"]').click();

		const suggestion = page.locator('.suggestions .suggestion[data-line-id="L36"], [data-testid="pr-walkthrough-suggested-comment"][data-line-id="L36"]');
		await expect(suggestion).toContainText("Consider keeping one horizontal scrollbar per diff widget.");
		await expect(suggestion.locator('.suggestion-actions')).toBeVisible();
		await expect(suggestion.getByRole('button', { name: 'Accept' })).toBeVisible();
		await expect(suggestion.getByRole('button', { name: 'Edit' })).toBeVisible();
		await expect(suggestion.getByRole('button', { name: 'Delete' })).toBeVisible();
	});

	test("diff syntax highlighting, scoped hunk signatures, and context expansion are pinned", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('.prw-phase-rail button[data-prw-nav="diff-review"]').click();

		const firstBlock = page.locator('.diff-block[data-file-path="market-packs/pr-walkthrough/src/panel.js"], [data-testid="pr-walkthrough-diff-block"][data-file-path="market-packs/pr-walkthrough/src/panel.js"]').first();
		await expect(firstBlock.locator('.tok-keyword')).not.toHaveCount(0);
		await expect(firstBlock.locator('.tok-function')).not.toHaveCount(0);
		await expect(firstBlock.locator('.tok-string')).not.toHaveCount(0);
		await expect(firstBlock.locator('.tok-number')).not.toHaveCount(0);
		await expect(firstBlock.locator('.tok-comment')).not.toHaveCount(0);
		await expect(firstBlock.locator('.tok-property')).not.toHaveCount(0);

		const hunkSignature = firstBlock.locator('.hunk-header .hunk-signature').first();
		await expect(hunkSignature).toContainText('function renderReviewDiffPanel(block) {');
		await expect(hunkSignature).not.toContainText('@@');

		const visibleBefore = await firstBlock.locator('.diff-line:not(.empty)').count();
		await expect(firstBlock.locator('[data-testid="pr-walkthrough-context-toggle"], .context-toggle').first()).toBeVisible();
		await firstBlock.locator('[data-testid="pr-walkthrough-context-toggle"], .context-toggle').first().click();
		await expect.poll(async () => firstBlock.locator('.diff-line:not(.empty)').count()).toBeGreaterThan(visibleBefore);
	});

	test("inline mode uses historical inline diff-line rows instead of tables", async ({ page }) => {
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('.prw-phase-rail button[data-prw-nav="diff-review"]').click();
		await page.locator('#diff-mode-inline, .mode-toggle [aria-label="Inline diff"]').click();

		const firstBlock = page.locator('.diff-block[data-file-path="market-packs/pr-walkthrough/src/panel.js"], [data-testid="pr-walkthrough-diff-block"][data-file-path="market-packs/pr-walkthrough/src/panel.js"]').first();
		await expect(page.locator('#diff-mode-inline.active, .mode-toggle [aria-label="Inline diff"][aria-checked="true"]')).toBeVisible();
		await expect(firstBlock.locator('.prw-diff-table')).toHaveCount(0);
		await expect(firstBlock.locator('.diff-overflow > .inline-lines')).toBeVisible();
		await expect(firstBlock.locator('.inline-lines .diff-line[data-line-id="L17"].del')).toContainText('renderCompactDiff(block);');
		await expect(firstBlock.locator('.inline-lines .diff-line[data-line-id="L18"].add')).toContainText('renderReferenceDiff(block, diffMode);');
	});

	test("ready state supports user comments, dislike gating, narrow inline default, historical file headers, and diff collapse", async ({ page }) => {
		await page.setViewportSize({ width: 500, height: 800 });
		await loadFixture(page);
		await page.evaluate(() => (window as any).__renderPrwReady());
		await expect(page.locator('[data-testid="prw-bundle"]')).toBeVisible({ timeout: 10_000 });

		await page.locator('.prw-phase-rail-collapsed button[aria-label="Diff review controls and comments"]').click();
		await expect(page.locator('#diff-mode-inline.active, .mode-toggle [aria-label="Inline diff"][aria-checked="true"]')).toBeVisible();
		await page.locator('#diff-mode-split, .mode-toggle [aria-label="Split diff"]').click();
		await expect(page.locator('#diff-mode-split.active, .mode-toggle [aria-label="Split diff"][aria-checked="true"]')).toBeVisible();

		const firstBlock = page.locator('.diff-block[data-file-path="market-packs/pr-walkthrough/src/panel.js"], [data-testid="pr-walkthrough-diff-block"][data-file-path="market-packs/pr-walkthrough/src/panel.js"]').first();
		const header = firstBlock.locator('.diff-file-header-row');
		await expect(header.locator('.diff-file-header')).toBeVisible();
		await expect(header.locator('.caret')).toBeVisible();
		await expect(header.locator('.diff-path')).toContainText('src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts → market-packs/pr-walkthrough/src/panel.js');
		await expect(header.locator('.diff-add-count')).toContainText('+2');
		await expect(header.locator('.diff-del-count')).toContainText('-1');
		await expect(header.locator('a.diff-external-link, [data-testid="pr-walkthrough-external-file-link"]')).toHaveAttribute('href', /github\.com\/SuuBro\/bobbit\/blob\/fedcba/);

		const dislike = page.getByRole("button", { name: "Dislike" });
		await expect(dislike).toBeDisabled();
		await firstBlock.locator('.diff-line[data-line-id="L36"] .comment-cue').click();
		const editor = page.locator('[data-testid="pr-walkthrough-comment-editor"], [data-testid="prw-line-comment-editor"]').last();
		await expect(editor).toBeVisible();
		await editor.locator('textarea').fill("Please keep the compact cue functional.");
		await expect(dislike).toBeDisabled();
		await editor.getByRole("button", { name: /Save comment|Save/ }).click();
		await expect(firstBlock.locator('.diff-line.commented[data-line-id="L36"]')).toBeVisible();
		await expect(header.locator('.diff-comment-count')).toContainText(/1 comment/);
		await expect(firstBlock.locator('.line-comments, [data-testid="prw-line-user-comment"]')).toContainText("compact cue");
		await expect(dislike).toBeEnabled();

		const blocks = page.locator('.diff-block, [data-testid="pr-walkthrough-diff-block"]');
		await expect(blocks).toHaveCount(2);
		await blocks.nth(0).locator('.diff-file-header, [data-testid="pr-walkthrough-diff-toggle"]').click();
		await expect(blocks.nth(0)).toHaveClass(/closed/);
		await expect(blocks.nth(0).locator('.diff-overflow')).toHaveCount(0);
		await expect(blocks.nth(1).locator('.diff-overflow')).toHaveCount(1);

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
