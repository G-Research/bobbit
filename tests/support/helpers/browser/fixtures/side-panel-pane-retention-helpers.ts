/**
 * Shared fixture rig for the side-panel pane retention REAL-BROWSER specs
 * (`side-panel-pane-retention.spec.ts` desktop + cold-switch,
 * `side-panel-pane-retention-mobile.spec.ts` mobile slider).
 *
 * WHY THIS TIER EXISTS. The DOM tier
 * (`tests/dom/side-panel-pane-retention.dom.test.ts`, `tests/dom/mobile-pane-retention.dom.test.ts`)
 * stubs the pack-panel projection and asserts the class/style contract. It CANNOT
 * prove the claim the feature exists for: happy-dom never loads an iframe
 * document, has no focus/`inert`/accessibility model, and returns 0 from
 * `getBoundingClientRect()`. Everything in these specs is therefore asserted from
 * OBSERVABLE BROWSER BEHAVIOUR:
 *
 *   - the framed document's OWN load counter (it increments a `sessionStorage`
 *     entry in its own context on every load, and posts a beacon to the parent),
 *     corroborated by the network-level request count for its URL;
 *   - element identity, stamped from page context on first sight and re-read later;
 *   - real keyboard focus traversal and the real accessibility tree;
 *   - real `getBoundingClientRect()` geometry.
 *
 * A retained pane must reach a load count of exactly 1 across collapse/expand, tab
 * switch, a session round-trip and the split↔fullscreen ladder — and MUST reach 2
 * after a genuine teardown (tab close, retention-cap eviction). Both directions are
 * asserted, so the specs fail both if retention silently retains forever and if
 * nothing is retained at all.
 *
 * This module holds ONLY the rig: the fixture bundle build, the framed document, and
 * the page-driving/read helpers. Every assertion lives in the spec files, so the
 * desktop/mobile split is a pure move of tests, not of expectations.
 *
 * WHY THE SPLIT EXISTS. The browser lane is budget-gated at 60s per spec file
 * (`scripts/testing-v2/assert-budget.*`). The single combined file measured ~28s warm
 * / ~50s cold, i.e. sitting on the cap, so the mobile describe was moved to a sibling
 * spec. Both files share this rig; neither duplicates an assertion.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./build-bundle.js";

export const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
export const FIXTURE_ORIGIN = "http://fixture.localhost";
export const FIXTURE_SHELL_URL = `${FIXTURE_ORIGIN}/fixture-shell.html`;
export const ENTRY = path.resolve("tests/ui-fixtures/side-panel-pane-retention-entry.ts");
export const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
export const BUNDLE = path.join(BUNDLE_DIR, "side-panel-pane-retention-bundle.js");

const APP_RENDER_SRC = path.resolve("src/app/render.ts");
const APP_STATE_SRC = path.resolve("src/app/state.ts");
const RETENTION_SRC = path.resolve("src/app/panel-pane-retention.ts");
const SIDE_PANEL_WORKSPACE_SRC = path.resolve("src/app/side-panel-workspace.ts");
const PANEL_WORKSPACE_SRC = path.resolve("src/app/panel-workspace.ts");
const PACK_PANELS_SRC = path.resolve("src/app/pack-panels.ts");
/** `resolveLivePackPane` rejects a terminal owner via this module's definition. */
const SESSION_ACTIONS_SRC = path.resolve("src/app/session-actions.ts");

/** Design §4.1 `PANEL_PANE_RETENTION_LIMIT`. Read from source so the specs cannot
 *  silently disagree with the shipped constant. */
export const RETENTION_LIMIT = (() => {
	const source = fs.readFileSync(RETENTION_SRC, "utf8");
	const match = /PANEL_PANE_RETENTION_LIMIT\s*=\s*(\d+)/.exec(source);
	if (!match) throw new Error("PANEL_PANE_RETENTION_LIMIT not found in src/app/panel-pane-retention.ts");
	return Number(match[1]);
})();

/** The framed document. Counts its OWN loads in `sessionStorage` (shared with the
 *  same-origin parent) and posts a beacon, so a reload is observable two ways. */
const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>retention frame</title></head>
<body style="margin:0;font:14px system-ui;">
<script>
(function () {
	var tag = new URLSearchParams(location.search).get("frame") || "anon";
	var key = "retention-frame-loads:" + tag;
	var count = Number(sessionStorage.getItem(key) || "0") + 1;
	sessionStorage.setItem(key, String(count));
	document.title = tag + " #" + count;
	try { parent.postMessage({ type: "retention-frame-load", tag: tag, count: count }, "*"); } catch (err) { /* ignore */ }
})();
</script>
<button id="frame-inner-button" type="button">frame content</button>
</body></html>`;

export type FrameRequests = { urls: string[] };

/**
 * Register the `beforeAll` that builds the fixture bundle. Called at module scope of
 * each spec file; `buildBundle` is lock-guarded and mtime-gated, so two spec files
 * running in parallel workers share one build.
 */
export function registerRetentionBundleBuild(): void {
	test.beforeAll(() => {
		fs.mkdirSync(BUNDLE_DIR, { recursive: true });
		buildBundle({
			entry: ENTRY,
			outfile: BUNDLE,
			deps: [ENTRY, APP_RENDER_SRC, APP_STATE_SRC, RETENTION_SRC, SIDE_PANEL_WORKSPACE_SRC, PANEL_WORKSPACE_SRC, PACK_PANELS_SRC, SESSION_ACTIONS_SRC],
		});
	});
}

/** Boot the fixture and start recording every framed-document request. */
export async function loadFixture(page: Page): Promise<FrameRequests> {
	const requests: FrameRequests = { urls: [] };
	page.on("request", (request) => {
		const url = request.url();
		if (url.includes("/retention-frame.html")) requests.urls.push(url);
	});
	// Collect the framed documents' load beacons in the parent page.
	await page.addInitScript(() => {
		(window as any).__frameLoadBeacons = [];
		window.addEventListener("message", (event: MessageEvent) => {
			const data = event.data as { type?: string; tag?: string; count?: number } | null;
			if (data && data.type === "retention-frame-load") {
				(window as any).__frameLoadBeacons.push({ tag: data.tag, count: data.count });
			}
		});
	});
	await page.route(`${FIXTURE_ORIGIN}/**`, async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (pathname === "/fixture-shell.html") {
			await route.fulfill({ contentType: "text/html", body: fs.readFileSync(SHELL, "utf8") });
			return;
		}
		if (pathname === "/retention-frame.html") {
			await route.fulfill({ contentType: "text/html", body: FRAME_HTML });
			return;
		}
		await route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" });
	});
	await page.goto(FIXTURE_SHELL_URL);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__paneRetentionReady === true, null, { timeout: 15_000 });
	await page.evaluate(() => (window as any).__resetPaneRetentionFixture());
	await expect(page.locator("[data-testid='fixture-chat'] textarea")).toBeVisible({ timeout: 10_000 });
	return requests;
}

export const frameLocator = (page: Page, tag: string) => page.locator(`iframe[data-retention-frame="${tag}"]`);

export async function openPane(page: Page, sessionId: string, panelKey: "one" | "two", tag: string): Promise<string> {
	const tabId = await page.evaluate(async ({ sessionId, panelKey, tag }) => {
		const panels = (window as any).__paneRetentionPanels;
		return (window as any).__openPackPane({ sessionId, panelId: panels[panelKey], frameTag: tag });
	}, { sessionId, panelKey, tag });
	await settleRender(page);
	return tabId;
}

/**
 * Open a pane in the SELECTED session without focusing it, so it is mounted by the
 * mobile track but has NEVER been the active tab. A tab that was momentarily active
 * is already in retention's append-only order for that reason alone, which would make
 * an "inactive pane survives" assertion pass for the wrong reason.
 */
export async function openUnfocusedPane(page: Page, sessionId: string, panelKey: "one" | "two", tag: string): Promise<string> {
	const tabId = await page.evaluate(async ({ sessionId, panelKey, tag }) => {
		const panels = (window as any).__paneRetentionPanels;
		return (window as any).__openPackPane({ sessionId, panelId: panels[panelKey], frameTag: tag, focus: false });
	}, { sessionId, panelKey, tag });
	await settleRender(page);
	return tabId;
}

/** The framed document's own load count, read from the shared session storage. */
export async function frameLoadCount(page: Page, tag: string): Promise<number> {
	return page.evaluate((t) => Number(sessionStorage.getItem(`retention-frame-loads:${t}`) || "0"), tag);
}

export async function beaconCount(page: Page, tag: string): Promise<number> {
	return page.evaluate((t) => ((window as any).__frameLoadBeacons as Array<{ tag: string }>).filter((b) => b.tag === t).length, tag);
}

export function requestCount(requests: FrameRequests, tag: string): number {
	return requests.urls.filter((url) => url.includes(`frame=${tag}`)).length;
}

/** Wait for a pane's frame to have loaded exactly `expected` times. */
export async function expectFrameLoads(page: Page, tag: string, expected: number, message: string): Promise<void> {
	await expect.poll(() => frameLoadCount(page, tag), { timeout: 10_000, message }).toBe(expected);
}

/** Stamp an identity probe on first sight; re-read it later to prove the very same
 *  element object survived (a rebuilt iframe has no probe). */
export async function stampFrameProbe(page: Page, tag: string): Promise<string> {
	return page.evaluate((t) => {
		const frame = document.querySelector(`iframe[data-retention-frame="${t}"]`) as HTMLIFrameElement | null;
		if (!frame) throw new Error(`no iframe for ${t}`);
		const probe = crypto.randomUUID();
		(frame as any).__retentionProbe = probe;
		frame.dataset.probe = probe;
		return probe;
	}, tag);
}

export async function readFrameProbe(page: Page, tag: string): Promise<{ property: string | null; dataset: string | null; count: number }> {
	return page.evaluate((t) => {
		const frames = [...document.querySelectorAll(`iframe[data-retention-frame="${t}"]`)] as HTMLIFrameElement[];
		const frame = frames[0];
		return {
			property: frame ? ((frame as any).__retentionProbe ?? null) : null,
			dataset: frame ? (frame.dataset.probe ?? null) : null,
			count: frames.length,
		};
	}, tag);
}

/** `renderApp()` is rAF-debounced (src/app/state.ts), so a state change is not in
 *  the DOM until the next frame. Locator assertions poll, but a raw `evaluate`
 *  read would race the commit — wait two frames first. */
export async function settleRender(page: Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	}));
}

export async function selectSession(page: Page, sessionId: string): Promise<void> {
	await page.evaluate((sid) => (window as any).__selectPaneRetentionSession(sid), sessionId);
	await expect.poll(() => page.evaluate(() => (window as any).__paneRetentionState().selectedSessionId), { timeout: 5_000 })
		.toBe(sessionId);
	await settleRender(page);
}

/** Open a pack pane for a session WITHOUT selecting it, so a later switch to that
 *  session is a genuine first (cold) visit rather than a cached fast-path one. */
export async function seedPane(page: Page, sessionId: string, panelKey: "one" | "two", tag: string): Promise<string> {
	const tabId = await page.evaluate(async ({ sessionId, panelKey, tag }) => {
		const panels = (window as any).__paneRetentionPanels;
		return (window as any).__openPackPane({ sessionId, panelId: panels[panelKey], frameTag: tag, select: false });
	}, { sessionId, panelKey, tag });
	await settleRender(page);
	return tabId;
}

/**
 * Enter the CONNECTING frame of a cold switch and stay there. The fixture mirrors
 * `connectToSession`'s slow-path ordering and then blocks on a promise this helper
 * leaves unresolved, so the loader frame is a real, observable state — asserted
 * visible here, because a cold-switch test that never sees the loader proves
 * nothing at all.
 */
export async function beginColdSwitch(page: Page, sessionId: string): Promise<void> {
	await page.evaluate((sid) => (window as any).__beginColdSelect(sid), sessionId);
	await expect.poll(() => page.evaluate(() => (window as any).__paneRetentionConnecting()), {
		timeout: 5_000,
		message: "the fixture must be mid-connect: no remote agent yet, connectingSessionId set",
	}).toMatchObject({ connectingSessionId: sessionId, hasRemoteAgent: false });
	await settleRender(page);
	await expect(page.getByTestId("bobbit-loader"), "the cold switch must actually render a visible loader frame")
		.toBeVisible({ timeout: 5_000 });
}

/** Let the pending connection finish, i.e. commit the final frame. */
export async function completeColdSwitch(page: Page, sessionId: string): Promise<void> {
	await page.evaluate(() => (window as any).__completeColdSelect());
	await expect.poll(() => page.evaluate(() => (window as any).__paneRetentionConnecting()), { timeout: 5_000 })
		.toMatchObject({ connectingSessionId: null, hasRemoteAgent: true });
	await settleRender(page);
	await expect(page.getByTestId("bobbit-loader"), "the loader must be gone once the session is connected")
		.toHaveCount(0, { timeout: 5_000 });
	expect(await page.evaluate(() => (window as any).__paneRetentionState().selectedSessionId)).toBe(sessionId);
}

/**
 * Park a direct reference to a pane's iframe on `window`, so a later read
 * distinguishes DETACHED from merely HIDDEN. A selector-based check cannot: a
 * removed element and a `display:none` element both stop matching "visible", and a
 * removed element stops matching the selector entirely — which is also what a pane
 * that was never rendered looks like.
 */
export async function holdFrame(page: Page, tag: string): Promise<void> {
	await page.evaluate((t) => {
		const frame = document.querySelector(`iframe[data-retention-frame="${t}"]`) as HTMLIFrameElement | null;
		if (!frame) throw new Error(`no iframe to hold for ${t}`);
		(window as any).__heldFrames = (window as any).__heldFrames || {};
		(window as any).__heldFrames[t] = frame;
	}, tag);
}

export async function heldFrameConnected(page: Page, tag: string): Promise<boolean> {
	return page.evaluate((t) => {
		const frame = (window as any).__heldFrames?.[t] as HTMLIFrameElement | undefined;
		if (!frame) throw new Error(`no held iframe for ${t}`);
		return frame.isConnected;
	}, tag);
}

export async function frameIsConnected(page: Page, tag: string): Promise<boolean> {
	return page.evaluate((t) => {
		const frame = document.querySelector(`iframe[data-retention-frame="${t}"]`) as HTMLIFrameElement | null;
		return !!frame && frame.isConnected;
	}, tag);
}

export async function sessionIds(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as any).__paneRetentionSessions);
}

/** Computed visibility/inertness of one hidden-capable element. */
export async function inertnessOf(page: Page, selector: string): Promise<{ display: string; hidden: boolean; inert: boolean; ariaHidden: string | null } | null> {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (!el) return null;
		return {
			display: window.getComputedStyle(el).display,
			hidden: el.hasAttribute("hidden"),
			inert: el.hasAttribute("inert"),
			ariaHidden: el.getAttribute("aria-hidden"),
		};
	}, selector);
}
