/**
 * UX-02 — id-less transcript rows must keep their DOM node identity across a
 * re-snapshot/resync, not just an unchanged reduce().
 *
 * Background (`~/Documents/dev/bobbit-fable-refactor/FINDINGS.md` UX-02,
 * `design/raciness-and-testing-rethink.md` §A1): pi persists user/aborted/
 * errored rows WITHOUT an id, and the reducer's snapshot path never invents
 * one. `MessageList`'s `repeat()` render key for those rows therefore falls
 * back to synthetic reducer metadata. The bug: that fallback used to include
 * `_insertionTick`, a counter the reducer bumps and stamps across the WHOLE
 * row set on every "snapshot" action (reconnect / tab-refocus resync / any
 * `requestMessages()`) — even when a row's position and content are
 * unchanged. Lit's `repeat()` then saw a "new" key for every id-less row on
 * every resync and tore down + recreated its DOM node (focus loss, scroll
 * jumps, transient duplicate/flash rows).
 *
 * This fixture drives the ACTUAL `<message-list>` component (not a reducer
 * unit test) end-to-end: mount with id-less rows carrying reducer metadata,
 * tag the rendered DOM nodes with a non-attribute JS marker (only survives
 * if the SAME node is reused), re-render with a bumped `_insertionTick`
 * (simulating the second snapshot), and assert the markers survive.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.ts";

const FIXTURE = path.resolve("tests/fixtures/message-list-row-identity.html");
const BUNDLE = path.resolve("tests/fixtures/message-list-row-identity-bundle.js");
const ENTRY = path.resolve("tests/fixtures/message-list-row-identity-entry.ts");
const MESSAGELIST_SRC = path.resolve("src/ui/components/MessageList.ts");
const KEY_SRC = path.resolve("src/app/message-render-key.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, MESSAGELIST_SRC, KEY_SRC],
	});
	if (!fs.existsSync(BUNDLE)) throw new Error(`bundle missing: ${BUNDLE}`);
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.evaluate(() => {
		const c = document.getElementById("container")!;
		c.innerHTML = '<div id="slot"></div>';
	});
}

/** Two id-less "server" (snapshot-origin) user rows, as the reducer's
 *  snapshot `stamp()` would produce them: no `id`, but `_order`/`_origin`/
 *  `_insertionTick` present. */
function snapshotRows(tick: number) {
	return [
		{ role: "user", content: "hello", _order: 0, _origin: "server", _insertionTick: tick },
		{ role: "user", content: "world", _order: 1, _origin: "server", _insertionTick: tick },
	];
}

test.describe("MessageList row identity across a re-snapshot (UX-02)", () => {
	test("id-less rows keep their DOM node when only _insertionTick changes", async ({ page }) => {
		await gotoAndWait(page);

		await page.evaluate((rows) => {
			(window as any).__mountMessageList("slot", rows);
		}, snapshotRows(1));
		expect(await page.evaluate(() => (window as any).__countRowNodes())).toBe(2);

		await page.evaluate(() => (window as any).__tagRows());
		const before = await page.evaluate(() => (window as any).__readRowMarkers());
		expect(before).toEqual(["marker-0", "marker-1"]);

		// Re-render with the SAME position/content but a bumped _insertionTick —
		// exactly what happens when a tab reconnects/refocuses and the reducer
		// re-applies a fresh snapshot of an unchanged transcript.
		await page.evaluate((rows) => {
			(window as any).__mountMessageList("slot", rows);
		}, snapshotRows(2));

		expect(await page.evaluate(() => (window as any).__countRowNodes())).toBe(2);
		const after = await page.evaluate(() => (window as any).__readRowMarkers());
		expect(after).toEqual(before);
	});

	test("sanity: rows at the same position with genuinely different content DO get a new node", async ({ page }) => {
		await gotoAndWait(page);

		await page.evaluate((rows) => {
			(window as any).__mountMessageList("slot", rows);
		}, snapshotRows(1));
		await page.evaluate(() => (window as any).__tagRows());
		const before = await page.evaluate(() => (window as any).__readRowMarkers());
		expect(before).toEqual(["marker-0", "marker-1"]);

		const changedRows = [
			{ role: "user", content: "hello", _order: 0, _origin: "server", _insertionTick: 2 },
			{ role: "user", content: "COMPLETELY DIFFERENT TEXT", _order: 1, _origin: "server", _insertionTick: 2 },
		];
		await page.evaluate((rows) => {
			(window as any).__mountMessageList("slot", rows);
		}, changedRows);

		const after = await page.evaluate(() => (window as any).__readRowMarkers());
		// Row 0 (unchanged content) keeps its node; row 1 (different content) is
		// a fresh node — the marker on it is gone (Lit created a new element).
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBeUndefined();
	});
});
