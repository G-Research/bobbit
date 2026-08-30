/**
 * Side-panel pane retention — REAL-BROWSER tier, MOBILE SLIDER
 * (design docs/design/keep-side-panels-mounted.md §9 criteria 10–13 and the mobile
 * half of criterion 14). Split out of `side-panel-pane-retention.fixture.spec.ts` because
 * `tests2/browser` is budget-gated at 60s per spec file and the combined file sat on
 * the cap; the desktop and cold-switch describes stayed there. Both files share the
 * rig in `tests2/browser/fixtures/side-panel-pane-retention-helpers.ts`, which documents why this tier
 * exists at all (the DOM tier cannot load an iframe, focus anything, or measure a
 * box).
 *
 * ALREADY-MOUNTED PANES. The mobile active track mounts EVERY content tab of the
 * selected session, so an open-but-INACTIVE pack tab already has a live <iframe>. The
 * claim is that a session switch well under the retention cap does not re-navigate it,
 * which needs the framed document's own load counter.
 *
 * TERMINAL OWNERS. A session that goes terminal keeps its entry in
 * `state.gatewaySessions` (src/app/team-archived-bucket.ts), so membership was never a
 * liveness test. Desktop pack panes render solely from the retention plan, so pruning
 * a terminal owner destroys them; the ACTIVE mobile track projects the selected
 * session's own tabs and therefore needed its own liveness filter. Both the hidden
 * foreign track and the SELECTED track are covered below, and the claim in each case
 * is that the framed document is DETACHED, not merely hidden — which needs a held
 * element reference in a live document.
 */
import { test, expect } from "@playwright/test";
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
	openUnfocusedPane,
	readFrameProbe,
	registerRetentionBundleBuild,
	requestCount,
	seedPane,
	selectSession,
	sessionIds,
	settleRender,
	stampFrameProbe,
} from "../../../tests2/browser/fixtures/side-panel-pane-retention-helpers.js";

registerRetentionBundleBuild();

test.describe("side-panel pane retention (mobile slider)", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("a mobile session round-trip keeps the same framed document, with exactly one active track and inert foreign tracks", async ({ page }) => {
		const requests = await loadFixture(page);
		const sessions = await sessionIds(page);
		const [sessionA, sessionB] = sessions;
		const sessionWithoutTabs = sessions[sessions.length - 1];

		await openPane(page, sessionA, "one", "m1");
		await expect(frameLocator(page, "m1")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "m1", 1, "the mobile pane's framed document should load once");
		const probe = await stampFrameProbe(page, "m1");
		await expect(page.locator('[data-mobile-pane-track][data-mobile-track-active="true"]'), "exactly one active track")
			.toHaveCount(1);

		// A → B (B also has a pack pane) → A.
		await openPane(page, sessionB, "one", "m2");
		await expect(frameLocator(page, "m2")).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-mobile-pane-track][data-mobile-track-active="true"]')).toHaveCount(1);
		expect(await inertnessOf(page, `[data-mobile-pane-track][data-mobile-track-session-key="${sessionA}"]`),
			"the foreign track stays mounted but inert").toMatchObject({ display: "none", hidden: true, inert: true, ariaHidden: "true" });
		await selectSession(page, sessionA);
		await expect(frameLocator(page, "m1")).toBeVisible({ timeout: 5_000 });

		// A → a session with NO panel tabs → A (design §3.7 chat-only track).
		await selectSession(page, sessionWithoutTabs);
		await expect(page.locator("[data-testid='fixture-chat'] textarea"), "a session with no panel tabs shows plain chat").toBeVisible();
		await expect(page.locator(`[data-mobile-pane-track][data-mobile-track-active="true"][data-mobile-track-session-key="${sessionWithoutTabs}"]`),
			"the selected session owns the only active track").toHaveCount(1, { timeout: 5_000 });
		await expect(page.locator('[data-mobile-pane-track][data-mobile-track-active="true"]')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => {
			const track = document.querySelector('[data-mobile-pane-track][data-mobile-track-active="true"]') as HTMLElement;
			return {
				sessionKey: track.dataset.mobileTrackSessionKey,
				panes: track.querySelectorAll("[data-mobile-pane-key]").length,
				transform: track.style.transform,
			};
		}), {
			timeout: 5_000,
			message: "the chat-only track must hold exactly one pane with no slide offset (design §3.7 parity with today's bare-chat branch)",
		}).toMatchObject({ sessionKey: sessionWithoutTabs, panes: 1, transform: "translateX(0%)" });
		await expect(frameLocator(page, "m1"), "the foreign session's pane stays mounted").toHaveCount(1);
		await selectSession(page, sessionA);
		await expect(frameLocator(page, "m1")).toBeVisible({ timeout: 5_000 });

		// CRITERION 14 on mobile: one load, one request, same element object.
		expect(await frameLoadCount(page, "m1"), "the mobile round-trip must not re-navigate the frame").toBe(1);
		expect(await beaconCount(page, "m1")).toBe(1);
		expect(requestCount(requests, "m1")).toBe(1);
		expect((await readFrameProbe(page, "m1")).property, "the same element object survived the round-trip").toBe(probe);

		// And a real teardown still cold-mounts, so retention is not unconditional.
		const tabId = await page.evaluate(() => (window as any).__paneRetentionState().activeTabId);
		await page.evaluate(({ sessionA, tabId }) => (window as any).__closePackPane(sessionA, tabId), { sessionA, tabId });
		await expect(frameLocator(page, "m1")).toHaveCount(0, { timeout: 5_000 });
		await openPane(page, sessionA, "one", "m1");
		await expectFrameLoads(page, "m1", 2, "a reopened mobile pane must cold-mount");
	});

	// The mobile active track mounts the chat pane plus EVERY content tab of the
	// selected session, so an open-but-INACTIVE pack tab already has a live <iframe>.
	// Retention used to observe only the ACTIVE key, so a hidden foreign track (which
	// projects only the retained slots) dropped that pane on any session switch — the
	// feature retained LESS than the slider already had mounted, well below the cap.
	test("an open-but-inactive mobile pack pane survives a session round-trip under the cap, including when the active tab is not a pack tab", async ({ page }) => {
		const requests = await loadFixture(page);
		const sessions = await sessionIds(page);
		const sessionA = sessions[0];
		const sessionWithoutTabs = sessions[sessions.length - 1];

		const activeTabId = await openPane(page, sessionA, "one", "mact");
		// "minact" is opened UNFOCUSED, so it has never been the active tab and cannot be
		// in retention's order as an `activeKey` — only as an already-mounted pane.
		await openUnfocusedPane(page, sessionA, "two", "minact");
		await expect(frameLocator(page, "mact")).toBeVisible({ timeout: 10_000 });
		await expect.poll(() => page.evaluate(() => (window as any).__paneRetentionState().activeTabId), {
			timeout: 5_000,
			message: "the second pane must be open but NEVER active, or it is retained for the wrong reason",
		}).toBe(activeTabId);
		await expect(frameLocator(page, "minact"), "the slider already mounts the inactive content tab").toHaveCount(1);
		await expectFrameLoads(page, "minact", 1, "the inactive pane's framed document loads once on first mount");
		const probe = await stampFrameProbe(page, "minact");
		// The whole point: retention is never under pressure here, so eviction cannot
		// explain a loss. The tabless session contributes no pane of its own.
		expect(2, "the round trip must stay strictly UNDER the retention cap").toBeLessThan(RETENTION_LIMIT);

		// ── leg 1: A's active tab IS a pack tab, so `activeKey` is defined ─────────
		await selectSession(page, sessionWithoutTabs);
		await expect(frameLocator(page, "minact"), "the inactive pane must stay mounted in the hidden foreign track")
			.toHaveCount(1);
		expect(await frameIsConnected(page, "minact")).toBe(true);
		await selectSession(page, sessionA);
		await expect(frameLocator(page, "mact")).toBeVisible({ timeout: 5_000 });

		expect(await frameLoadCount(page, "minact"), "the inactive pane must not have re-navigated").toBe(1);
		expect(await beaconCount(page, "minact")).toBe(1);
		expect(requestCount(requests, "minact"), "no second network request for the inactive pane's frame").toBe(1);
		expect((await readFrameProbe(page, "minact")).property, "the same element object survived the round-trip").toBe(probe);

		// ── leg 2: the harder case ────────────────────────────────────────────────
		// A non-pack active tab means retention derives NO active key at all, so an
		// already-mounted pane is the ONLY thing that can keep EITHER frame alive.
		await page.evaluate((sid) => (window as any).__openPreviewPane(sid), sessionA);
		await settleRender(page);
		await expect.poll(() => page.evaluate(() => (window as any).__paneRetentionState().activeTabId), {
			timeout: 5_000,
			message: "the active tab must be the NON-PACK one, or `activeKey` would still be defined",
		}).toMatch(/^preview:/);
		await expect(frameLocator(page, "minact")).toHaveCount(1);

		await selectSession(page, sessionWithoutTabs);
		await expect(frameLocator(page, "minact"), "with no active pack key, only the observed mounted panes can retain this frame")
			.toHaveCount(1);
		await expect(frameLocator(page, "mact")).toHaveCount(1);
		await selectSession(page, sessionA);

		expect(await frameLoadCount(page, "minact"), "still exactly one load after the non-pack-active round-trip").toBe(1);
		expect(await beaconCount(page, "minact")).toBe(1);
		expect(requestCount(requests, "minact")).toBe(1);
		expect((await readFrameProbe(page, "minact")).property, "still the same element object").toBe(probe);
		expect(await frameLoadCount(page, "mact"), "the formerly-active pane is retained on the same terms").toBe(1);
	});

	test("a cold mobile session switch keeps every retained track mounted, outward and on the return leg", async ({ page }) => {
		const requests = await loadFixture(page);
		const [sessionA, sessionB] = await sessionIds(page);

		// The mobile TOP-LEVEL shell branch is chosen by connectedness, so it swapped
		// mid-connect as well. Start with the nothing-retained case, where the bare
		// loader must still be what the user sees and no track may exist.
		await beginColdSwitch(page, sessionB);
		await expect(page.locator("[data-mobile-pane-track]"), "with nothing retained there is no slider to keep").toHaveCount(0);
		await completeColdSwitch(page, sessionB);

		await openPane(page, sessionA, "one", "mcolda");
		await expect(frameLocator(page, "mcolda")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "mcolda", 1, "A's mobile pane loads once on first mount");
		const probeA = await stampFrameProbe(page, "mcolda");
		await seedPane(page, sessionB, "two", "mcoldb");

		// ── A → B: the connecting frame ────────────────────────────────────────────
		await beginColdSwitch(page, sessionB);
		await expect(frameLocator(page, "mcolda"), "A's track must survive the loader frame").toHaveCount(1);
		expect(await frameIsConnected(page, "mcolda")).toBe(true);
		expect(await frameLoadCount(page, "mcolda"), "the connecting frame must not re-navigate A's frame").toBe(1);
		expect(requestCount(requests, "mcolda")).toBe(1);
		expect((await readFrameProbe(page, "mcolda")).property).toBe(probeA);
		expect(await inertnessOf(page, `[data-mobile-pane-track][data-mobile-track-session-key="${sessionA}"]`),
			"the outgoing track stays mounted but inert").toMatchObject({ display: "none", hidden: true, inert: true, ariaHidden: "true" });
		await expect(page.locator('[data-mobile-pane-track][data-mobile-track-active="true"]'), "exactly one active track")
			.toHaveCount(1);
		await expect.poll(() => page.evaluate(() => {
			const track = document.querySelector('[data-mobile-pane-track][data-mobile-track-active="true"]') as HTMLElement;
			return { sessionKey: track.dataset.mobileTrackSessionKey, panes: track.querySelectorAll("[data-mobile-pane-key]").length };
		}), {
			timeout: 5_000,
			message: "the incoming session gets a chat-only track carrying the loader, never its own panes yet",
		}).toMatchObject({ sessionKey: sessionB, panes: 1 });

		await completeColdSwitch(page, sessionB);
		await expect(frameLocator(page, "mcoldb")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "mcoldb", 1, "B's mobile pane cold-mounts once");
		const probeB = await stampFrameProbe(page, "mcoldb");

		// ── return leg: A is the INCOMING (connecting) session ─────────────────────
		await beginColdSwitch(page, sessionA);
		await expect(frameLocator(page, "mcolda"), "the incoming session's OWN retained pane must survive its connecting frame")
			.toHaveCount(1);
		expect(await frameIsConnected(page, "mcolda")).toBe(true);
		expect(await frameLoadCount(page, "mcolda")).toBe(1);
		await expect(frameLocator(page, "mcoldb"), "the outgoing session's pane must survive too").toHaveCount(1);
		expect(await frameLoadCount(page, "mcoldb")).toBe(1);
		await completeColdSwitch(page, sessionA);
		await expect(frameLocator(page, "mcolda")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(`[data-mobile-pane-track][data-mobile-track-active="true"][data-mobile-track-session-key="${sessionA}"]`))
			.toHaveCount(1, { timeout: 5_000 });

		// Three independent signals, both panes, across both cold legs.
		expect(await frameLoadCount(page, "mcolda")).toBe(1);
		expect(await beaconCount(page, "mcolda")).toBe(1);
		expect(requestCount(requests, "mcolda")).toBe(1);
		expect(await frameLoadCount(page, "mcoldb")).toBe(1);
		expect(await beaconCount(page, "mcoldb")).toBe(1);
		expect(requestCount(requests, "mcoldb")).toBe(1);
		expect((await readFrameProbe(page, "mcolda")).property, "A is the same element object throughout").toBe(probeA);
		expect((await readFrameProbe(page, "mcoldb")).property, "B is the same element object throughout").toBe(probeB);
	});

	// The SELECTED-track case, which the desktop and hidden-foreign-track terminal
	// tests structurally cannot reach. `resolveLivePackPane` rejects a terminal owner,
	// so the retention PLAN drops the pane — and desktop pack panes render only from
	// that plan, so they die with it. The ACTIVE mobile track does not: it projects the
	// selected session's own tab list, so before the liveness filter a session that went
	// terminal WHILE SELECTED kept its <iframe> mounted and live, in defiance of
	// "archiving/terminating the session must still destroy the panel". The existing
	// terminal coverage selects the OTHER session first, so it only ever exercised the
	// hidden foreign track, which projects the plan and was already correct.
	//
	// Only a real browser can tell DETACHED from merely HIDDEN, which is the whole
	// claim: a held element reference must report `isConnected === false`.
	test("a pack pane on the SELECTED mobile track is destroyed when its own session goes terminal while still listed among the live sessions", async ({ page }) => {
		await loadFixture(page);
		const [sessionA] = await sessionIds(page);

		await openPane(page, sessionA, "one", "mselterm");
		await expect(frameLocator(page, "mselterm")).toBeVisible({ timeout: 10_000 });
		await expectFrameLoads(page, "mselterm", 1, "the mobile pane's framed document should load once on first mount");
		await holdFrame(page, "mselterm");

		// Anti-vacuity, three ways: the doomed session is the SELECTED one (not a hidden
		// foreign track), it is genuinely connected (a non-null remote agent, so this is
		// not the cold-switch path where the incoming track is chat-only anyway), and its
		// framed document is attached RIGHT NOW.
		await expect.poll(() => page.evaluate(() => (window as any).__paneRetentionConnecting()), {
			timeout: 5_000,
			message: "the doomed session must be fully connected, not mid-connect",
		}).toMatchObject({ connectingSessionId: null, hasRemoteAgent: true });
		await expect(page.locator(`[data-mobile-pane-track][data-mobile-track-active="true"][data-mobile-track-session-key="${sessionA}"]`),
			"the doomed session must own the ACTIVE track, or this is the already-covered foreign-track case")
			.toHaveCount(1, { timeout: 5_000 });
		await expect(page.locator(`[data-mobile-pane-track][data-mobile-track-session-key="${sessionA}"] iframe[data-retention-frame="mselterm"]`),
			"the pane must be mounted inside its own session's active track").toHaveCount(1);
		expect(await heldFrameConnected(page, "mselterm"),
			"anti-vacuity: the pane must be alive and attached BEFORE its owner terminates").toBe(true);

		// One terminal representation is enough here — the DOM tier covers archived=true,
		// status=archived and the both-collections case. `terminated` is the realistic one.
		await page.evaluate((sid) => (window as any).__setSessionStatus(sid, "terminated"), sessionA);
		await settleRender(page);

		const listing = await page.evaluate(() => (window as any).__paneRetentionState());
		expect(listing.selectedSessionId, "the terminal session is STILL the selected one").toBe(sessionA);
		expect(listing.gatewaySessionIds, "the terminal owner is STILL a listed live session, so membership cannot be what pruned it")
			.toContain(sessionA);
		expect(listing.gatewaySessionStatuses[sessionA]).toBe("terminated");

		// The claim this tier exists for: DETACHED, not merely hidden.
		await expect.poll(() => heldFrameConnected(page, "mselterm"), {
			timeout: 5_000,
			message: "the framed document must be DETACHED from the document, not merely hidden",
		}).toBe(false);
		await expect(frameLocator(page, "mselterm"), "no pack iframe may remain anywhere for the terminal session")
			.toHaveCount(0, { timeout: 5_000 });
		await expect(page.locator(`[data-mobile-pane-track][data-mobile-track-session-key="${sessionA}"] iframe`),
			"the terminal session's track holds no framed pane at all").toHaveCount(0);
		// The rest of the shell is untouched: the session still renders its chat.
		await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible();
	});
});
