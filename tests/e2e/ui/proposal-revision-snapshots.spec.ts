/**
 * E2E - Proposal Revision Snapshots.
 *
 * docs/design/proposal-revision-snapshots.md
 *
 * 1. Navigate - trigger propose_project + edit_proposal; verify two cards in
 *    the transcript and that the slot reflects the latest revision.
 * 2. Happy path - click "Open proposal" on the FIRST card; the panel opens
 *    rev-1 as a distinct historical tab while the live draft remains rev 2.
 * 3. Persistence - on-disk history keeps revs 1-2, and opening historical
 *    tabs is read-only (no synthetic rev 3).
 * 4. Cleanup - archive the session; per-session drafts still survive for
 *    archived proposal resubmit flows.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, bobbitDir } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

async function getDefaultProjectId(): Promise<string> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	const projects = Array.isArray(data) ? data : (data.projects || []);
	expect(projects.length).toBeGreaterThan(0);
	return projects[0].id;
}

async function activeSessionId(page: Page): Promise<string> {
	// Wait for the selected session id to land in state. This used to read
	// `bobbitState.activeSessionId` (which never existed — it's a function,
	// not a property) and fell back to `gatewaySessions[0]?.id`. After Task A
	// (route-level code splitting) the initial sessions list fetch races with
	// createSessionViaUI()'s textarea-visible signal, so gatewaySessions is
	// briefly empty even though the hash route already points at the new
	// session. selectedSessionId is set synchronously by the route handler
	// and is the source of truth used by every other parity spec. See
	// proposal-types-uX-parity.spec.ts:135 for the canonical pattern.
	const sid = await page.waitForFunction(
		() => (window as any).bobbitState?.selectedSessionId ?? null,
		null,
		{ timeout: 10_000 },
	).then((handle) => handle.jsonValue() as Promise<string | null>);
	expect(sid).toBeTruthy();
	return sid as string;
}

const PANEL_TAB_SELECTOR = "button.goal-tab-pill";
const PROJECT_PROPOSAL_TAB_TITLE_RE = /^Project Proposal$/i;
const PROJECT_PROPOSAL_HISTORICAL_TAB_TITLE_RE = /^Project Proposal rev 1$/i;

async function visiblePanelTabs(page: Page): Promise<Array<{ index: number; label: string; title: string; id: string; kind: string }>> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button, index) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
			const label = (button.getAttribute("title") || button.textContent || "").replace(/\s+/g, " ").trim();
			return label ? {
				index,
				label,
				title: (button.getAttribute("data-panel-tab-title") || "").replace(/\s+/g, " ").trim(),
				id: button.getAttribute("data-panel-tab-id") || "",
				kind: button.getAttribute("data-panel-tab-kind") || "",
			} : null;
		})
		.filter(Boolean) as Array<{ index: number; label: string; title: string; id: string; kind: string }>);
}

async function clickPanelTabByIndex(page: Page, index: number, errorPrefix: string): Promise<void> {
	const tab = page.locator(PANEL_TAB_SELECTOR).nth(index);
	await tab.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "center" }));
	await expect(tab, `${errorPrefix}: tab at index ${index} should be visible before click`).toBeVisible({ timeout: 5_000 });
	await tab.click();
}

async function selectPanelTabByTitle(page: Page, title: RegExp, errorPrefix: string): Promise<void> {
	const tabs = await visiblePanelTabs(page);
	const match = tabs.find((tab) => tab.kind === "proposal" && title.test(tab.title));
	if (!match) {
		throw new Error(`${errorPrefix}: expected proposal tab title ${title}; visible tabs were ${tabs.map((tab) => `${tab.label} [${tab.title}]`).join(", ") || "<none>"}`);
	}
	await clickPanelTabByIndex(page, match.index, errorPrefix);
}

async function expectProjectProposalTabCount(page: Page, min: number, errorPrefix: string): Promise<void> {
	await expect.poll(
		async () => (await visiblePanelTabs(page)).filter((tab) => tab.kind === "proposal" && /^Project Proposal/i.test(tab.title)).length,
		{ timeout: 10_000, message: errorPrefix },
	).toBeGreaterThanOrEqual(min);
}

async function clickProposalOpenButtonForRev(page: Page, rev: number, errorPrefix: string): Promise<void> {
	const card = page.locator("tool-message", {
		has: page.locator('[data-testid="proposal-rev"]', { hasText: new RegExp(`^\\s*rev\\s+${rev}\\s*$`) }),
	}).first();
	await expect(card, `${errorPrefix}: rev ${rev} proposal tool card should be present`).toBeVisible({ timeout: 15_000 });
	const button = card.locator('[data-testid="proposal-open-button"]').first();
	await button.scrollIntoViewIfNeeded();
	await expect(button, `${errorPrefix}: rev ${rev} Open proposal button should be enabled`).toBeEnabled({ timeout: 5_000 });
	await button.click();
}

test.describe("Proposal revision snapshots", () => {
	test("propose + edit + open-old card opens a historical tab while the latest draft stays live", async ({ page }) => {
		const projectId = await getDefaultProjectId();
		await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ build_command: "baseline-build" }),
		});

		await openApp(page);
		await createSessionViaUI(page);

		// Capture the session id BEFORE the workflow proceeds. The on-disk
		// proposal-drafts dir is keyed by this id for persistence/cleanup checks.
		const sid = await activeSessionId(page);

		// 1. Navigate - propose then edit.
		await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");
		await page.waitForFunction(
			() => (window as any).bobbitState?.activeProposals?.project?.fields?.build_command === "echo old",
			null,
			{ timeout: 20_000 },
		);

		await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");
		await page.waitForFunction(
			() => (window as any).bobbitState?.activeProposals?.project?.fields?.build_command === "echo new",
			null,
			{ timeout: 15_000 },
		);

		// Slot rev should now be 2 (server-stamped live draft).
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.project?.rev),
			{ timeout: 10_000 },
		).toBe(2);

		await selectPanelTabByTitle(page, PROJECT_PROPOSAL_TAB_TITLE_RE, "PROPOSAL_REVISION_SNAPSHOT_BUG: latest project proposal should be selectable before opening history");
		await expect(page.locator('[data-panel="project-proposal"]').getByText("Editable").first()).toBeVisible({ timeout: 10_000 });

		// Two "Open proposal" buttons should exist (one per card).
		const openButtons = page.locator('[data-testid="proposal-open-button"]');
		await expect(openButtons).toHaveCount(2, { timeout: 15_000 });

		// 2. Happy path - click the FIRST card's button (rev 1).
		await clickProposalOpenButtonForRev(page, 1, "PROPOSAL_REVISION_SNAPSHOT_BUG");

		await expectProjectProposalTabCount(
			page,
			2,
			"PROPOSAL_REVISION_SNAPSHOT_BUG: opening rev 1 should add a distinct historical proposal tab without replacing the live tab",
		);

		const historicalPanel = page.locator('[data-panel="project-proposal"][data-historical-proposal="true"]').first();
		await expect(historicalPanel, "PROPOSAL_REVISION_SNAPSHOT_BUG: rev 1 should render in a historical proposal tab").toBeVisible({ timeout: 10_000 });
		await expect(historicalPanel.locator('[data-testid="proposal-panel-rev"]')).toHaveText("rev 1");
		await expect(historicalPanel).toContainText("echo old");

		// Opening history must not mutate the latest/live draft.
		await expect.poll(
			() => page.evaluate(() => {
				const slot = (window as any).bobbitState?.activeProposals?.project;
				return { build: slot?.fields?.build_command, rev: slot?.rev };
			}),
			{ timeout: 10_000 },
		).toEqual({ build: "echo new", rev: 2 });

		await selectPanelTabByTitle(page, PROJECT_PROPOSAL_TAB_TITLE_RE, "PROPOSAL_REVISION_SNAPSHOT_BUG: live latest proposal tab should remain selectable after opening history");
		const livePanel = page.locator('[data-panel="project-proposal"]:not([data-historical-proposal="true"])').first();
		await expect(livePanel, "PROPOSAL_REVISION_SNAPSHOT_BUG: selecting live latest should render the editable project proposal panel").toBeVisible({ timeout: 10_000 });
		await expect(livePanel.getByText("Editable").first()).toBeVisible({ timeout: 10_000 });

		// 3. Persistence/read-only coverage - repeated earlier-card clicks keep
		// opening rev 1 as history without mutating the live draft or writing rev 3.
		await expect(openButtons).toHaveCount(2, { timeout: 15_000 });
		await clickProposalOpenButtonForRev(page, 1, "PROPOSAL_REVISION_SNAPSHOT_BUG: repeated earlier-card click should keep opening history");
		await selectPanelTabByTitle(page, PROJECT_PROPOSAL_HISTORICAL_TAB_TITLE_RE, "PROPOSAL_REVISION_SNAPSHOT_BUG: historical rev-1 tab should remain selectable after reopening");
		const historicalPanelAfterRepeatOpen = page.locator('[data-panel="project-proposal"][data-historical-proposal="true"]').first();
		await expect(historicalPanelAfterRepeatOpen).toContainText("echo old", { timeout: 10_000 });

		await selectPanelTabByTitle(page, PROJECT_PROPOSAL_TAB_TITLE_RE, "PROPOSAL_REVISION_SNAPSHOT_BUG: live latest proposal should remain accessible after reopening history");
		await expect(page.locator('[data-panel="project-proposal"]:not([data-historical-proposal="true"])').first().getByText("Editable").first()).toBeVisible({ timeout: 10_000 });

		// On-disk: history dir contains only the live proposal revisions. Opening a
		// historical tab is read-only and must not write a synthetic rev 3.
		const stateDir = path.join(bobbitDir(), "state");
		const histDir = path.join(stateDir, "proposal-drafts", sid, "project.history");
		await expect.poll(() => fs.existsSync(histDir), { timeout: 10_000 }).toBe(true);
		await expect.poll(
			() => fs.readdirSync(histDir)
				.filter((e) => /^\d+\.yaml$/.test(e))
				.map((e) => Number.parseInt(e, 10))
				.sort((a, b) => a - b),
			{ timeout: 10_000 },
		).toEqual([1, 2]);

		// 4. Cleanup - terminate (archive) the session.
		// Per the reopen-archived-proposals design, the per-session draft dir
		// now SURVIVES archive (so the user can resubmit / continue later) and
		// is only removed on full purge (the 7-day mark). Smoke-check that the
		// dir is still present right after archive.
		await apiFetch(`/api/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
		const sessionDir = path.join(stateDir, "proposal-drafts", sid);
		expect(fs.existsSync(sessionDir)).toBe(true);
	});
});
