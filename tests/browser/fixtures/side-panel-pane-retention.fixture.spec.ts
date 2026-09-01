/**
 * Side-panel pane retention — REAL-BROWSER tier, DESKTOP
 * (design docs/design/keep-side-panels-mounted.md §9 criterion 14 and §9 criteria
 * 7 and 9). The mobile round-trip of §9 criteria 10–13 lives in the sibling spec
 * `side-panel-pane-retention-mobile.fixture.spec.ts`; the two files were split because
 * The browser lane is budget-gated at 60s per spec file and the combined file sat on
 * the cap. Both share the rig in `tests/support/helpers/browser/fixtures/side-panel-pane-retention-helpers.ts`, which
 * documents why this tier exists at all (the DOM tier cannot load an iframe, focus
 * anything, or measure a box).
 *
 * COLD SESSION SWITCH. The session round-trips in the first describe are WARM: the
 * target session is already cached, so `connectToSession` takes its fast path and no
 * connecting frame is ever committed. The ordinary FIRST visit to another session is
 * not like that — it nulls the outgoing agent/chat panel, sets
 * `state.connectingSessionId` and renders a loading frame while the WebSocket
 * connects. That frame used to be a standalone loader template at the main-area
 * ChildPart, so lit detached the whole panel shell and every live <iframe> reloaded —
 * on an ordinary session click. The `(cold session switch)` describe below drives that
 * path through a controllable delay so the loader frame is genuinely OBSERVED
 * (asserted visible) before the target connects, including on the return leg, where
 * the incoming session's OWN retained pane must survive its own connecting frame.
 *
 * TERMINAL OWNERS. A session that goes terminal keeps its entry in
 * `state.gatewaySessions` (src/app/team-archived-bucket.ts), so membership was never a
 * liveness test. The claim is that the framed document is DETACHED, not merely hidden,
 * which needs a held element reference in a live document.
 */
import { test, expect, type Page } from "@playwright/test";
import {
	RETENTION_LIMIT,
	beaconCount,
	beginColdSwitch,
	completeColdSwitch,
	expectFrameLoads,
	frameIsConnected,
	frameLoadCount,
	frameLocator,
	heldFrameConnected,
	holdFrame,
	inertnessOf,
	loadFixture,
	openPane,
	readFrameProbe,
	registerRetentionBundleBuild,
	requestCount,
	seedPane,
	selectSession,
	sessionIds,
	settleRender,
	stampFrameProbe,
} from "../../support/helpers/browser/fixtures/side-panel-pane-retention-helpers.js";

registerRetentionBundleBuild();

async function dragRetentionDivider(page: Page, rawPercent: number): Promise<void> {
	const handle = page.getByRole("separator", { name: "Resize side panel" });
	const [handleBox, layoutBox] = await Promise.all([
		handle.boundingBox(),
		page.locator(".side-panel-split-layout").boundingBox(),
	]);
	if (!handleBox || !layoutBox) throw new Error("retention divider has no visible split geometry");
	const startX = handleBox.x + handleBox.width / 2;
	const startY = handleBox.y + handleBox.height / 2;
	const targetX = layoutBox.x + layoutBox.width * (1 - rawPercent / 100);
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(targetX, startY, { steps: 6 });
	await page.mouse.up();
	await settleRender(page);
}

test.describe("side-panel pane retention (desktop)", () => {
	test("a retained pane's framed document loads exactly once across collapse, tab switch, session round-trip and the mode ladder — and cold-mounts after the tab is closed", async ({ page }) => {
		const requests = await loadFixture(page);
		const [sessionA, sessionB] = await sessionIds(page);

		const tabA1 = await openPane(page, sessionA, "one", "a1");
		await expect(frameLocator(page, "a1")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "a1", 1, "the pane's framed document should load once on first mount");
		const probe = await stampFrameProbe(page, "a1");

		// 1. Real pointer resize, then pointer-driven collapse → expand. Neither may
		// detach or re-navigate the retained pack iframe.
		const divider = page.getByRole("separator", { name: "Resize side panel" });
		await expect(divider, "the retained-pane fixture exposes the production-sized divider hit target").toBeVisible();
		const dividerBox = await divider.boundingBox();
		expect(dividerBox?.width, "the visible divider keeps its 8px pointer target").toBeCloseTo(8, 0);
		await dragRetentionDivider(page, 63);
		await expect(divider).toHaveAttribute("aria-valuenow", "63");
		const resizedGeometry = await page.locator(".side-panel-split-layout").evaluate((layout) => {
			const row = layout.getBoundingClientRect();
			const panel = layout.querySelector<HTMLElement>(":scope > .side-panel-workspace")!.getBoundingClientRect();
			return { panelPercent: panel.width / row.width * 100, handleColor: getComputedStyle(layout.querySelector(".side-panel-resize-handle")!, "::after").backgroundColor };
		});
		expect(resizedGeometry.panelPercent, "the real drag must change retained-pane geometry to the requested split").toBeCloseTo(63, 0);
		expect(resizedGeometry.handleColor, "the hovered divider exposes its theme-token line").not.toBe("rgba(0, 0, 0, 0)");
		expect(await frameLoadCount(page, "a1"), "an interior pointer resize must not reload the framed document").toBe(1);
		expect((await readFrameProbe(page, "a1")).property, "interior resize keeps the same iframe element").toBe(probe);
		await dragRetentionDivider(page, 24);
		await expect(page.getByTestId("side-panel-restore")).toBeVisible({ timeout: 5_000 });
		expect(await inertnessOf(page, '[data-panel-workspace="content"]'), "a collapsed workspace stays mounted but inert")
			.toMatchObject({ display: "none", hidden: true, inert: true, ariaHidden: "true" });
		await page.getByTestId("side-panel-restore").click();
		await expect(frameLocator(page, "a1")).toBeVisible({ timeout: 5_000 });

		// 2. Tab switch between two pack panes in the same session.
		const tabA2 = await openPane(page, sessionA, "two", "a2");
		await expect(frameLocator(page, "a2")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "a2", 1, "the second pane should also load once");
		expect(tabA2, "the two panes are distinct tabs").not.toBe(tabA1);
		await page.locator(`.goal-tab-pill[data-panel-tab-id="${tabA1}"]`).first().click();
		await expect(frameLocator(page, "a1")).toBeVisible({ timeout: 5_000 });
		expect(await inertnessOf(page, '[data-panel-pane-key]:has(iframe[data-retention-frame="a2"])'), "the non-active pane stays mounted but inert")
			.toMatchObject({ display: "none", hidden: true, inert: true, ariaHidden: "true" });

		// 3. Session round-trip. B gets its own pane; A's panes stay mounted, hidden.
		await openPane(page, sessionB, "one", "b1");
		await expect(frameLocator(page, "b1")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "b1", 1, "session B's pane should load once");
		await expect(frameLocator(page, "a1"), "A's pane stays in the DOM while B is selected").toHaveCount(1);
		await expect(frameLocator(page, "a1")).toBeHidden();
		await selectSession(page, sessionA);
		await expect(frameLocator(page, "a1")).toBeVisible({ timeout: 5_000 });

		// 4. Pointer-driven split → fullscreen → split.
		await dragRetentionDivider(page, 76);
		await expect.poll(async () => page.locator('[data-panel-workspace="content"]').first().getAttribute("data-side-panel-mode"), { timeout: 5_000 })
			.toBe("fullscreen");
		await expect(page.getByTestId("side-panel-restore"), "fullscreen shows no restore button").toHaveCount(0);
		await page.getByTestId("side-panel-collapse").first().click();
		await expect.poll(async () => page.locator('[data-panel-workspace="content"]').first().getAttribute("data-side-panel-mode"), { timeout: 5_000 })
			.toBe("split");
		await expect(frameLocator(page, "a1")).toBeVisible({ timeout: 5_000 });

		// CRITERION 14: still exactly one load, three independent ways.
		expect(await frameLoadCount(page, "a1"), "the framed document must not have re-navigated").toBe(1);
		expect(await beaconCount(page, "a1"), "exactly one load beacon must have reached the parent").toBe(1);
		expect(requestCount(requests, "a1"), "no second network request for the frame URL").toBe(1);
		expect(await frameLoadCount(page, "a2")).toBe(1);
		expect(await frameLoadCount(page, "b1")).toBe(1);

		// ELEMENT IDENTITY: the very same element object is still mounted. A rebuilt
		// iframe loses the probe; a surviving element whose `src` was re-committed
		// keeps the probe but would have shown up above as a second load/request.
		const readBack = await readFrameProbe(page, "a1");
		expect(readBack.count, "exactly one iframe per retained pane").toBe(1);
		expect(readBack.property, "the same element object must still be mounted").toBe(probe);
		expect(readBack.dataset).toBe(probe);

		// TEARDOWN → COLD MOUNT: closing the tab destroys the pane, so reopening it
		// loads the framed document a SECOND time. Without this the spec would pass
		// even if the panel were somehow never re-created at all.
		// NOTE: a pack tab id is pack-scoped, so the SAME id exists in session B —
		// identify A's slot by its own frame instead.
		await page.locator(`.goal-tab-pill[data-panel-tab-id="${tabA1}"] [data-testid="side-panel-close"]`).first().click();
		await expect(frameLocator(page, "a1"), "closing the tab destroys the pane subtree")
			.toHaveCount(0, { timeout: 5_000 });
		await openPane(page, sessionA, "one", "a1");
		await expect(frameLocator(page, "a1")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "a1", 2, "a reopened pane must be a COLD mount (load #2)");
		expect(requestCount(requests, "a1"), "the cold mount must issue a second network request").toBe(2);
		expect((await readFrameProbe(page, "a1")).property, "the cold mount must be a different element object").toBeNull();
	});

	test(`retention is capped at ${RETENTION_LIMIT}: the least-recently-active pane is evicted and cold-mounts on return, while the newest panes are retained`, async ({ page }) => {
		await loadFixture(page);
		const sessions = await sessionIds(page);
		// One pane per session, in first-seen order, one MORE than the cap.
		const opened = sessions.slice(0, RETENTION_LIMIT + 1);
		const tags = opened.map((_, index) => `cap${index}`);
		for (let index = 0; index < opened.length; index += 1) {
			await openPane(page, opened[index], "one", tags[index]);
			await expect(frameLocator(page, tags[index])).toBeVisible({ timeout: 10_000 });
			await expectFrameLoads(page, tags[index], 1, `pane ${tags[index]} should load once`);
		}

		// The oldest pane is beyond the cap: its subtree is gone, the newest ones stay.
		await expect(page.locator("[data-panel-pane-key]"), "no more than the cap may be retained")
			.toHaveCount(RETENTION_LIMIT, { timeout: 5_000 });
		await expect(frameLocator(page, tags[0]), "the least-recently-active pane is evicted").toHaveCount(0);
		for (const tag of tags.slice(1)) {
			await expect(frameLocator(page, tag), `pane ${tag} is within the cap and must stay mounted`).toHaveCount(1);
		}

		// Returning to the evicted session must COLD MOUNT it (load #2).
		await openPane(page, opened[0], "one", tags[0]);
		await expect(frameLocator(page, tags[0])).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, tags[0], 2, "an evicted pane must cold-mount on return");
		// The most recently active pane before this switch was never evicted.
		expect(await frameLoadCount(page, tags[tags.length - 1]), "the newest pane must still be its original load").toBe(1);
	});

	test("hidden panes and a hidden pack host are inert: keyboard focus never enters them and they are absent from the accessibility tree", async ({ page }) => {
		await loadFixture(page);
		const sessions = await sessionIds(page);
		const [sessionA, sessionB] = sessions;
		const sessionWithoutTabs = sessions[sessions.length - 1];

		await openPane(page, sessionA, "one", "vis");
		await openPane(page, sessionB, "one", "hid");
		await expect(frameLocator(page, "hid")).toBeVisible({ timeout: 10_000 });
		await selectSession(page, sessionA);
		await expect(frameLocator(page, "vis")).toBeVisible({ timeout: 5_000 });
		await expect(frameLocator(page, "hid")).toBeHidden();
		await expect(page.locator('[data-panel-pane-hidden="true"]'), "a hidden pane must exist, or the inertness assertions are vacuous")
			.toHaveCount(1, { timeout: 5_000 });

		// Tab traversal from the composer must never land inside a hidden slot. The
		// same walk records whether it reached the VISIBLE pane, which is the
		// anti-vacuity guard: if focus never moved into any pane at all, the "never
		// lands in a hidden pane" assertion would be worthless.
		const tabWalk = async (): Promise<{ offenders: string[]; reachedVisiblePane: boolean }> => {
			await page.locator("[data-testid='fixture-composer']").focus();
			const offenders: string[] = [];
			let reachedVisiblePane = false;
			for (let press = 0; press < 24; press += 1) {
				await page.keyboard.press("Tab");
				const landing = await page.evaluate(() => {
					const active = document.activeElement as HTMLElement | null;
					if (!active) return null;
					const hiddenSlot = active.closest('[data-panel-pane-hidden="true"]');
					const host = active.closest("[data-panel-pane-host]") as HTMLElement | null;
					const hiddenHost = host && window.getComputedStyle(host).display === "none" ? host : null;
					const track = active.closest("[data-mobile-pane-track]") as HTMLElement | null;
					const hiddenTrack = track && track.getAttribute("data-mobile-track-active") === "false" ? track : null;
					const offending = (hiddenSlot || hiddenHost || hiddenTrack) as HTMLElement | null;
					const visiblePane = active.closest('[data-panel-pane-hidden="false"]') as HTMLElement | null;
					return {
						offender: offending ? `${active.tagName}:${offending.dataset.panelPaneKey ?? offending.nodeName}` : null,
						inVisiblePane: !!visiblePane && !offending,
					};
				});
				if (landing?.offender) offenders.push(landing.offender);
				if (landing?.inVisiblePane) reachedVisiblePane = true;
			}
			return { offenders, reachedVisiblePane };
		};
		const walk = await tabWalk();
		expect(walk.offenders, "Tab from the composer must never reach a hidden pane or hidden host").toEqual([]);
		expect(walk.reachedVisiblePane, "self-check: the walk must actually reach the VISIBLE pane, otherwise it proves nothing").toBe(true);

		// The hidden pane contributes nothing to the accessibility tree, while the
		// visible one does — so the assertion cannot pass vacuously. `ariaSnapshot()`
		// is Playwright's accessibility-tree projection (the successor to the removed
		// `page.accessibility.snapshot()`), so it excludes anything hidden or
		// aria-hidden exactly as assistive technology would.
		const axe = await page.locator("body").ariaSnapshot();
		expect(axe, "the visible pane must be exposed to assistive technology").toContain("pane vis action");
		expect(axe, "a hidden pane must NOT be exposed to assistive technology").not.toContain("pane hid action");

		// A selected session with no content tab hides the whole host (design §5a),
		// which must also be inert and out of the tab order.
		await selectSession(page, sessionWithoutTabs);
		await expect.poll(() => inertnessOf(page, "[data-panel-pane-host]"), {
			timeout: 5_000,
			message: "with no active content tab the pack host stays mounted but hidden and inert",
		}).toMatchObject({ display: "none", hidden: true, inert: true, ariaHidden: "true" });
		expect((await tabWalk()).offenders, "Tab must never reach a pane inside the hidden host").toEqual([]);
		const axeNoTabs = await page.locator("body").ariaSnapshot();
		expect(axeNoTabs).not.toContain("pane vis action");
		expect(axeNoTabs).not.toContain("pane hid action");
	});

	test("collapsed and visible-split geometry are unchanged (real bounding boxes)", async ({ page }) => {
		await loadFixture(page);
		const sessions = await sessionIds(page);
		const [sessionA] = sessions;
		const sessionWithoutTabs = sessions[sessions.length - 1];

		// Baseline: a session with no panel tabs — today's plain-chat geometry. The
		// chat panel is rendered straight into the main column, so its width IS the
		// main column width, and every later measurement is compared against it
		// instead of a hardcoded pixel value.
		await selectSession(page, sessionWithoutTabs);
		const mainColumnWidth = await page.evaluate(() =>
			(document.querySelector("[data-testid='fixture-chat']") as HTMLElement).getBoundingClientRect().width);
		expect(mainColumnWidth, "the plain-chat baseline must be a real measurement").toBeGreaterThan(100);

		// Visible split: chat and workspace each take half of the row.
		await openPane(page, sessionA, "one", "geo");
		await expect(frameLocator(page, "geo")).toBeVisible({ timeout: 10_000 });
		const split = await page.evaluate(() => {
			const row = document.querySelector(".side-panel-split-layout") as HTMLElement;
			const chat = row.querySelector(".side-panel-chat-pane") as HTMLElement;
			const workspace = row.querySelector('[data-panel-workspace="content"]') as HTMLElement;
			return {
				row: row.getBoundingClientRect().width,
				chat: chat.getBoundingClientRect().width,
				workspace: workspace.getBoundingClientRect().width,
			};
		});
		expect(split.chat, "split chat pane keeps its 50% share").toBeCloseTo(split.row / 2, 0);
		expect(split.workspace, "split workspace keeps its 50% share").toBeCloseTo(split.row / 2, 0);
		expect(split.row, "the main column is the same width as in plain chat").toBeCloseTo(mainColumnWidth, 0);

		// Collapsed: the hidden workspace contributes NO width; the chat pane fills
		// the row apart from the restore button, which sits at the row's right edge.
		await page.getByTestId("side-panel-collapse").first().click();
		await expect(page.getByTestId("side-panel-restore")).toBeVisible({ timeout: 5_000 });
		const collapsed = await page.evaluate(() => {
			const row = document.querySelector(".side-panel-split-layout") as HTMLElement;
			const chat = row.firstElementChild as HTMLElement;
			const restore = row.querySelector('[data-testid="side-panel-restore"]') as HTMLElement;
			const workspace = row.querySelector('[data-panel-workspace="content"]') as HTMLElement;
			const rowRect = row.getBoundingClientRect();
			const chatRect = chat.getBoundingClientRect();
			const restoreRect = restore.getBoundingClientRect();
			return {
				row: rowRect.width,
				chat: chatRect.width,
				chatHasSplitClass: chat.classList.contains("side-panel-chat-pane"),
				restoreWidth: restoreRect.width,
				restoreRightEdge: restoreRect.right,
				rowRightEdge: rowRect.right,
				restoreLeftEdge: restoreRect.left,
				chatRightEdge: chatRect.right,
				workspaceWidth: workspace.getBoundingClientRect().width,
			};
		});
		expect(collapsed.chatHasSplitClass, "the collapsed chat pane must not carry the 50% class").toBe(false);
		expect(collapsed.workspaceWidth, "a hidden workspace occupies no layout").toBe(0);
		expect(collapsed.restoreWidth, "the restore button is visible").toBeGreaterThan(0);
		expect(collapsed.chat, "chat fills everything except the restore button")
			.toBeCloseTo(collapsed.row - collapsed.restoreWidth, 0);
		expect(collapsed.restoreLeftEdge, "the restore button still sits immediately right of the chat pane")
			.toBeCloseTo(collapsed.chatRightEdge, 0);
		expect(collapsed.restoreRightEdge, "the restore button still sits at the row's right edge")
			.toBeCloseTo(collapsed.rowRightEdge, 0);
		expect(collapsed.row, "collapsing does not resize the main column").toBeCloseTo(mainColumnWidth, 0);
	});

	// The design assumed archive/terminate removes the session from
	// `state.gatewaySessions`. It does not: src/app/team-archived-bucket.ts documents
	// that a terminated session lingers there (and may appear in BOTH collections), so
	// membership was never a liveness test and a terminal session's hidden pane
	// outlived its owner. `resolveLivePackPane` now rejects a terminal owner using the
	// app's own definition (`isArchivedSessionActionSource`). Only a real browser can
	// show the framed document is genuinely DETACHED rather than just hidden.
	test("a retained pane is destroyed when its owning session goes terminal while still listed among the live sessions", async ({ page }) => {
		await loadFixture(page);
		const [sessionA, sessionB] = await sessionIds(page);

		await openPane(page, sessionA, "one", "term");
		await expect(frameLocator(page, "term")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "term", 1, "the pane's framed document should load once on first mount");
		await holdFrame(page, "term");

		// Hide A's pane behind session B, which owns a pane of its own so the workspace
		// survives the teardown and the assertion below is about A's slot alone.
		await openPane(page, sessionB, "one", "keep");
		await expect(frameLocator(page, "keep")).toBeVisible({ timeout: 10_000 });
		await expect(frameLocator(page, "term"), "A's pane is retained while B is selected").toHaveCount(1);
		await expect(frameLocator(page, "term")).toBeHidden();
		expect(await heldFrameConnected(page, "term"),
			"anti-vacuity: the pane must be alive and attached BEFORE its owner terminates").toBe(true);

		// One terminal representation is enough here — the DOM tier covers archived=true,
		// status=archived and the both-collections case. `terminated` is the realistic one.
		await page.evaluate((sid) => (window as any).__setSessionStatus(sid, "terminated"), sessionA);
		await settleRender(page);

		const listing = await page.evaluate(() => (window as any).__paneRetentionState());
		expect(listing.gatewaySessionIds, "the terminal owner is STILL a listed live session, so membership cannot be what pruned it")
			.toContain(sessionA);
		expect(listing.gatewaySessionStatuses[sessionA]).toBe("terminated");

		// The claim this tier exists for: DETACHED, not merely hidden.
		await expect.poll(() => heldFrameConnected(page, "term"), {
			timeout: 5_000,
			message: "the framed document must be DETACHED from the document, not merely hidden",
		}).toBe(false);
		await expect(page.locator("[data-panel-pane-key]"), "only the selected session's pane remains")
			.toHaveCount(1, { timeout: 5_000 });
		await expect(frameLocator(page, "term"), "the terminal session's pane subtree is gone").toHaveCount(0);
		expect(await frameLoadCount(page, "keep"), "the selected session's own pane is untouched").toBe(1);
	});

	test("uninstalling the owning pack destroys every retained pane subtree", async ({ page }) => {
		await loadFixture(page);
		const sessions = await sessionIds(page);
		const [sessionA, sessionB] = sessions;

		await openPane(page, sessionA, "one", "un1");
		await openPane(page, sessionB, "one", "un2");
		await expect(page.locator("[data-panel-pane-key]")).toHaveCount(2, { timeout: 10_000 });
		const stillConnected = await page.evaluate(() => {
			const frame = document.querySelector('iframe[data-retention-frame="un2"]') as HTMLIFrameElement;
			(window as any).__retainedFrame = frame;
			return frame.isConnected;
		});
		expect(stillConnected).toBe(true);

		await page.evaluate(() => (window as any).__uninstallRetentionPacks());
		await expect(page.locator("[data-panel-pane-key]"), "uninstall reconcile must close every pack pane")
			.toHaveCount(0, { timeout: 10_000 });
		expect(await page.evaluate(() => ((window as any).__retainedFrame as HTMLIFrameElement).isConnected),
			"the retained iframe must be detached, not resurrected from the cache").toBe(false);
		await expect(page.locator("[data-testid='fixture-chat'] textarea"), "the shell falls back to plain chat").toBeVisible();
	});
});

test.describe("side-panel pane retention (cold session switch, desktop)", () => {
	test("a first visit to another session keeps every retained pane mounted through the loader frame, outward and on the return leg", async ({ page }) => {
		const requests = await loadFixture(page);
		const [sessionA, sessionB] = await sessionIds(page);

		await openPane(page, sessionA, "one", "colda");
		await expect(frameLocator(page, "colda")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "colda", 1, "A's pane loads once on first mount");
		const probeA = await stampFrameProbe(page, "colda");
		// B owns a pane in its own workspace but has never been selected, so the switch
		// below takes the slow (cold) path exactly as a first visit does in production.
		await seedPane(page, sessionB, "two", "coldb");
		await expect(frameLocator(page, "coldb"), "a non-selected session's pane is not mounted yet").toHaveCount(0);

		// ── A → B: the connecting frame ────────────────────────────────────────────
		await beginColdSwitch(page, sessionB);
		await expect(page.locator("[data-testid='fixture-chat']"), "the outgoing chat panel must not stand in for the incoming session")
			.toHaveCount(0);
		await expect(frameLocator(page, "colda"), "A's retained pane must survive the loader frame").toHaveCount(1);
		await expect(frameLocator(page, "colda")).toBeHidden();
		expect(await frameIsConnected(page, "colda"), "A's iframe must still be in the document").toBe(true);
		expect(await frameLoadCount(page, "colda"), "the connecting frame must not re-navigate the retained frame").toBe(1);
		expect(requestCount(requests, "colda"), "no second network request during the connecting frame").toBe(1);
		expect((await readFrameProbe(page, "colda")).property, "the same element object must still be mounted").toBe(probeA);
		// A retained foreign slot keeps the workspace mounted but never lets it occupy
		// layout, and the incoming session has no active tab to restore (design §3.1a/§5a).
		expect(await inertnessOf(page, '[data-panel-workspace="content"]'), "the workspace stays mounted but hidden and inert")
			.toMatchObject({ display: "none", hidden: true, inert: true, ariaHidden: "true" });
		await expect(page.getByTestId("side-panel-restore"), "the connecting frame shows no restore rail").toHaveCount(0);

		// ── the connection completes ───────────────────────────────────────────────
		await completeColdSwitch(page, sessionB);
		await expect(frameLocator(page, "coldb")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "coldb", 1, "B's pane cold-mounts exactly once");
		await expect(frameLocator(page, "colda"), "A's pane is still retained, hidden").toHaveCount(1);
		expect(await frameLoadCount(page, "colda")).toBe(1);
		const probeB = await stampFrameProbe(page, "coldb");

		// ── return leg: A is now the INCOMING (connecting) session ─────────────────
		// Its own retained pane has to survive its own connecting frame, which is a
		// different code path from surviving someone else's.
		await beginColdSwitch(page, sessionA);
		await expect(frameLocator(page, "colda"), "the incoming session's OWN pane must survive its connecting frame").toHaveCount(1);
		await expect(frameLocator(page, "coldb"), "the outgoing session's pane must survive too").toHaveCount(1);
		expect(await frameIsConnected(page, "colda")).toBe(true);
		expect(await frameLoadCount(page, "colda")).toBe(1);
		expect(await frameLoadCount(page, "coldb")).toBe(1);
		await completeColdSwitch(page, sessionA);
		await expect(frameLocator(page, "colda")).toBeVisible({ timeout: 5_000 });

		// Three independent signals, for both panes, across the whole sequence.
		expect(await frameLoadCount(page, "colda"), "A's framed document must have loaded exactly once").toBe(1);
		expect(await beaconCount(page, "colda")).toBe(1);
		expect(requestCount(requests, "colda")).toBe(1);
		expect(await frameLoadCount(page, "coldb"), "B's framed document must have loaded exactly once").toBe(1);
		expect(await beaconCount(page, "coldb")).toBe(1);
		expect(requestCount(requests, "coldb")).toBe(1);
		expect((await readFrameProbe(page, "colda")).property, "A is the same element object throughout").toBe(probeA);
		expect((await readFrameProbe(page, "coldb")).property, "B is the same element object throughout").toBe(probeB);
	});

	test("with nothing retained, a cold switch still shows the plain loader as the whole main area", async ({ page }) => {
		await loadFixture(page);
		const [, sessionB] = await sessionIds(page);
		// Guards the "responsive within one render frame" behaviour the fix had to
		// preserve: with no live pane to protect, the loader must NOT be wrapped in a
		// panel shell.
		await expect(page.locator("[data-panel-pane-key]"), "nothing may be retained for this case to be meaningful").toHaveCount(0);

		await beginColdSwitch(page, sessionB);
		await expect(page.locator(".side-panel-split-layout"), "the bare loader is the whole main area").toHaveCount(0);
		await expect(page.locator('[data-panel-workspace="content"]')).toHaveCount(0);
		await expect(page.locator("[data-panel-pane-host]")).toHaveCount(0);
		await expect(page.locator("[data-testid='fixture-chat']")).toHaveCount(0);
		const box = await page.evaluate(() => {
			const main = document.getElementById("app-main")!.getBoundingClientRect();
			const loader = document.querySelector('[data-testid="bobbit-loader"]')!.getBoundingClientRect();
			return { mainWidth: main.width, mainHeight: main.height, width: loader.width, height: loader.height };
		});
		expect(box.width, "the loader fills the main column").toBeCloseTo(box.mainWidth, 0);
		expect(box.height, "the loader fills the main column").toBeCloseTo(box.mainHeight, 0);

		await completeColdSwitch(page, sessionB);
		await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible();
	});

	test("a cold switch to a tabless session whose stored size is collapsed shows no restore rail and keeps the retained frame alive", async ({ page }) => {
		const requests = await loadFixture(page);
		const sessions = await sessionIds(page);
		const sessionA = sessions[0];
		const sessionWithoutTabs = sessions[sessions.length - 1];

		await openPane(page, sessionA, "one", "rail");
		await expect(frameLocator(page, "rail")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "rail", 1, "the retained pane loads once");
		const probe = await stampFrameProbe(page, "rail");
		// The tabless session remembers "collapsed" from an earlier life with a panel.
		await page.evaluate((sid) => (window as any).__setPaneSizeMode("collapsed", sid), sessionWithoutTabs);
		await settleRender(page);

		await beginColdSwitch(page, sessionWithoutTabs);
		await expect(page.getByTestId("side-panel-restore"), "a rail in the connecting frame would consume width and reveal nothing")
			.toHaveCount(0);
		await completeColdSwitch(page, sessionWithoutTabs);

		await expect(page.getByTestId("side-panel-restore"), "a tabless session must not show the restore rail").toHaveCount(0);
		await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible();
		const geometry = await page.evaluate(() => {
			const row = document.querySelector(".side-panel-split-layout") as HTMLElement;
			const chat = row.firstElementChild as HTMLElement;
			const workspace = row.querySelector('[data-panel-workspace="content"]') as HTMLElement;
			return {
				row: row.getBoundingClientRect().width,
				chat: chat.getBoundingClientRect().width,
				chatHasSplitClass: chat.classList.contains("side-panel-chat-pane"),
				workspace: workspace.getBoundingClientRect().width,
			};
		});
		expect(geometry.chatHasSplitClass, "the chat pane must not carry the 50% class").toBe(false);
		expect(geometry.workspace, "a hidden workspace occupies no layout").toBe(0);
		expect(geometry.chat, "chat takes the full row width").toBeCloseTo(geometry.row, 0);

		await expect(frameLocator(page, "rail"), "the retained pane is still mounted, hidden").toHaveCount(1);
		expect(await frameIsConnected(page, "rail")).toBe(true);
		expect(await frameLoadCount(page, "rail"), "the retained frame must not have re-navigated").toBe(1);
		expect(requestCount(requests, "rail")).toBe(1);
		expect((await readFrameProbe(page, "rail")).property).toBe(probe);
	});
});
