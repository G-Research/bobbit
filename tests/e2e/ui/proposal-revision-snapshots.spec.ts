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
import { apiFetch, bobbitDir, nonGitCwd } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, navigateToHash } from "./ui-helpers.js";

async function getDefaultProjectId(): Promise<string> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	const projects = Array.isArray(data) ? data : (data.projects || []);
	expect(projects.length).toBeGreaterThan(0);
	return projects[0].id;
}

async function createGoalAssistantSessionViaApi(page: Page): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), assistantType: "goal" }),
	});
	const text = await resp.text();
	expect(resp.status, `create goal assistant session: ${text}`).toBe(201);
	const sessionId = JSON.parse(text).id as string;
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000, message: "goal assistant session should be selected" },
	).toBe(sessionId);
	return sessionId;
}

async function activeSessionId(page: Page): Promise<string> {
	// Wait for the selected session id to land in state. This used to read
	// `bobbitState.activeSessionId` (which never existed — it's a function,
	// not a property) and fell back to `gatewaySessions[0]?.id`. After Task A
	// (route-level code splitting) the initial sessions list fetch races with
	// createSessionViaUI()'s textarea-visible signal, so gatewaySessions is
	// briefly empty even though the hash route already points at the new
	// session. selectedSessionId is set synchronously by the route handler
	// and is the source of truth used by the proposal/review fixture matrix.
	const sid = await page.waitForFunction(
		() => (window as any).bobbitState?.selectedSessionId ?? null,
		null,
		{ timeout: 10_000 },
	).then((handle) => handle.jsonValue() as Promise<string | null>);
	expect(sid).toBeTruthy();
	return sid as string;
}

const PANEL_TAB_SELECTOR = ".goal-tab-pill";
const GOAL_PROPOSAL_TAB_TITLE_RE = /^Goal Proposal$/i;
const PROJECT_PROPOSAL_TAB_TITLE_RE = /^Project Proposal$/i;
const PROJECT_PROPOSAL_HISTORICAL_TAB_TITLE_RE = /^Project Proposal \(v1\)$/i;

async function visiblePanelTabs(page: Page): Promise<Array<{ index: number; label: string; title: string; id: string; kind: string; active: boolean }>> {
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
				active: button.classList.contains("goal-tab-pill--active"),
			} : null;
		})
		.filter(Boolean) as Array<{ index: number; label: string; title: string; id: string; kind: string; active: boolean }>);
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

async function expectExactGoalProposalTabCount(page: Page, expected: number, errorPrefix: string): Promise<void> {
	await expect.poll(
		async () => (await visiblePanelTabs(page)).filter((tab) => tab.kind === "proposal" && /^Goal Proposal/i.test(tab.title)).length,
		{ timeout: 10_000, message: errorPrefix },
	).toBe(expected);
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

async function seedProjectProposalRevision(page: Page, sessionId: string, fields: Record<string, unknown>): Promise<number> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
		method: "POST",
		body: JSON.stringify({ args: fields }),
	});
	const text = await resp.text();
	expect(resp.status, `seed project proposal revision: ${text}`).toBe(200);
	const body = JSON.parse(text) as { rev?: number };
	expect(typeof body.rev, `seed response should include rev: ${text}`).toBe("number");
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.project?.rev ?? 0),
		{ timeout: 10_000, message: `project proposal rev ${body.rev} should hydrate in the UI` },
	).toBe(body.rev);
	return body.rev!;
}

async function expectMissingRevisionFallback(page: Page, missingRev: number, errorPrefix: string): Promise<void> {
	try {
		await expect.poll(async () => {
			const loadingVisible = await page.getByText(new RegExp(`Loading proposal revision\\s+${missingRev}`)).isVisible().catch(() => false);
			const tabs = await visiblePanelTabs(page);
			const activeTab = tabs.find((tab) => tab.active);
			const missingRevisionActive = !!activeTab && activeTab.kind === "proposal" && new RegExp(`rev\\s+${missingRev}\\b`, "i").test(`${activeTab.title} ${activeTab.label}`);
			const liveProposalVisible = await page.locator('[data-panel="project-proposal"]:not([data-historical-proposal="true"])').first().isVisible().catch(() => false);
			const chatVisible = await page.locator("textarea").first().isVisible().catch(() => false);
			return !loadingVisible && !missingRevisionActive && (liveProposalVisible || chatVisible);
		}, { timeout: 10_000, message: `${errorPrefix}: missing snapshot should not leave a selected historical tab stuck loading` }).toBe(true);
	} catch {
		const tabs = await visiblePanelTabs(page);
		const panelText = ((await page.locator('[data-panel="project-proposal"]').first().textContent({ timeout: 500 }).catch(() => "")) || "").replace(/\s+/g, " ").trim();
		throw new Error(`${errorPrefix}: missing snapshot should remove the failed historical tab or select a live/chat fallback; tabs=${JSON.stringify(tabs)}; panel=${JSON.stringify(panelText)}`);
	}
}

test.describe("Proposal revision snapshots", () => {
	test("current propose card keeps the server-stamped rev and opens the live tab", async ({ page }) => {
		test.setTimeout(60_000);
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "GOAL_PROPOSAL_PARITY");
		await expect(page.locator('[data-testid="proposal-rev"]').first()).toHaveText("rev 1", { timeout: 20_000 });
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal?.rev ?? 0),
			{ timeout: 10_000, message: "PROPOSAL_CURRENT_REV_BUG: live goal proposal rev should match the server snapshot rev" },
		).toBe(1);

		await clickProposalOpenButtonForRev(page, 1, "PROPOSAL_CURRENT_REV_BUG");
		await expectExactGoalProposalTabCount(
			page,
			1,
			"PROPOSAL_CURRENT_REV_BUG: opening the current rev should select the live Goal tab, not add a historical duplicate",
		);
		await selectPanelTabByTitle(page, GOAL_PROPOSAL_TAB_TITLE_RE, "PROPOSAL_CURRENT_REV_BUG: live goal proposal tab should remain selectable");
		await expect(page.locator('[data-historical-proposal="true"]')).toHaveCount(0);
		await expect(page.locator('input[placeholder="Goal title"]').first()).toHaveValue("Parity Goal A", { timeout: 5_000 });
	});

	test("streaming proposal previews do not synthesize snapshot revisions", async ({ page }) => {
		test.setTimeout(60_000);
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "STAY_BUSY:propose_goal:8");
		await page.waitForFunction(
			() => String((window as any).bobbitState?.activeProposals?.goal?.fields?.spec ?? "").includes("Paragraph 4"),
			null,
			{ timeout: 15_000 },
		);
		await expect(page.locator('[data-testid="proposal-streaming-badge"]').first()).toBeVisible({ timeout: 5_000 });
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal?.rev ?? 0),
			{ timeout: 5_000, message: "PROPOSAL_STREAMING_REV_BUG: streaming preview deltas must not increment immutable proposal revs" },
		).toBe(0);
		await expect(page.locator('[data-testid="proposal-panel-rev"]')).toHaveCount(0);
	});

	test("goal assistant draft restore preserves the latest server revision", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		const sessionId = await createGoalAssistantSessionViaApi(page);

		await sendMessage(page, "GOAL_PROPOSAL_PARITY");
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal?.rev ?? 0),
			{ timeout: 20_000, message: "PROPOSAL_GOAL_DRAFT_REV_BUG: first goal proposal should hydrate rev 1" },
		).toBe(1);

		await sendMessage(page, "GOAL_PROPOSAL_PARITY_EDIT");
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal?.rev ?? 0),
			{ timeout: 20_000, message: "PROPOSAL_GOAL_DRAFT_REV_BUG: revised goal proposal should hydrate rev 2" },
		).toBe(2);
		await expect(page.locator('input[placeholder="Goal title"]').first()).toHaveValue("Parity Goal A — edited", { timeout: 5_000 });

		await page.reload();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
			{ timeout: 10_000, message: "goal assistant session should stay selected after reload" },
		).toBe(sessionId);
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.goal?.rev ?? 0),
			{ timeout: 20_000, message: "PROPOSAL_GOAL_DRAFT_REV_BUG: draft restore must not downgrade the server-stamped goal rev" },
		).toBe(2);
		await expect(page.locator('[data-testid="proposal-panel-rev"]').first()).toHaveText("rev 2", { timeout: 10_000 });
	});

	test("failed historical proposal snapshot read falls back instead of leaving a loading revision selected", async ({ page }) => {
		test.setTimeout(60_000);
		await openApp(page);
		await createSessionViaUI(page);
		const sid = await activeSessionId(page);

		const failedRev = await seedProjectProposalRevision(page, sid, {
			name: "Failed Snapshot Historical Project",
			root_path: "/tmp/failed-snapshot-history",
			build_command: "echo historical",
		});
		await seedProjectProposalRevision(page, sid, {
			name: "Failed Snapshot Live Project",
			root_path: "/tmp/failed-snapshot-live",
			build_command: "echo live",
		});

		await selectPanelTabByTitle(page, PROJECT_PROPOSAL_TAB_TITLE_RE, "PROPOSAL_REVISION_MISSING_SNAPSHOT_BUG: live project proposal should be selectable before opening a failed historical revision");
		await expect(page.locator('[data-panel="project-proposal"]:not([data-historical-proposal="true"])').first()).toContainText("Failed Snapshot Live Project", { timeout: 10_000 });

		await page.route(
			(url) => url.pathname === `/api/sessions/${sid}/proposal/project/snapshot` && url.searchParams.get("rev") === String(failedRev),
			(route) => route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ ok: false, code: "SNAPSHOT_READ_FAILED" }),
			}),
		);
		const failedSnapshotResponse = page.waitForResponse(
			(resp) => resp.url().includes(`/api/sessions/${sid}/proposal/project/snapshot?rev=${failedRev}`),
			{ timeout: 10_000 },
		);
		await page.evaluate((rev) => {
			document.dispatchEvent(new CustomEvent("proposal-open", { detail: { type: "project", rev } }));
		}, failedRev);
		const response = await failedSnapshotResponse;
		expect(response.status(), "PROPOSAL_REVISION_MISSING_SNAPSHOT_BUG: failed rev should request a failed historical snapshot read").toBeGreaterThanOrEqual(400);

		await expectMissingRevisionFallback(page, failedRev, "PROPOSAL_REVISION_MISSING_SNAPSHOT_BUG");
	});

	// FIXME: Fails deterministically on origin/master HEAD 130595bb.
	// NOT introduced by this branch — verified by running on a fresh worktree of
	// origin/master with the same Playwright config; same symptom reproduces.
	// Symptom: `[data-panel="project-proposal"][data-historical-proposal="true"]`
	// panel never contains "echo old" within the 5s poll; the historical tab
	// renders but its body lacks the old build_command value.
	// Suspected culprit: editable-historical-proposals render path — the
	// `_proposalOverride` seeded by `proposalPanelContent` for the historical
	// tab isn't being reflected into the rendered project-proposal form fields.
	// Likely a real product bug introduced by the recent master chain:
	//   98f7f0ce Chrome-style panel tab strip with SortableJS drag-and-drop
	//   122f76fc Editable historical proposal tabs + render-time override
	//   dac36684 Update tests + docs for Chrome-style tab system
	// Restore to `test(...)` once those bugs are fixed on master.
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
