import type { Page } from "@playwright/test";
import {
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForAgentResponse,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

const PORTRAIT = { width: 375, height: 667 };
const LANDSCAPE = { width: 900, height: 667 };
const A_TRANSCRIPT = "portrait-cache-history-A";
const B_TRANSCRIPT = "portrait-cache-history-B";
const A_ORIGINAL_PANEL = "portrait-cache-panel-A-original";
const A_FRESH_PANEL = "portrait-cache-panel-A-fresh";
const B_ORIGINAL_PANEL = "portrait-cache-panel-B-original";

type LoaderObservation = { mounted: boolean; mountCount: number };

function sessionRow(page: Page, sessionId: string) {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function sessionSocketCount(urls: readonly string[], sessionId: string): number {
	return urls.filter((url) => {
		try {
			return new URL(url).pathname === `/ws/${sessionId}`;
		} catch {
			return false;
		}
	}).length;
}

async function waitForActiveSession(page: Page, sessionId: string): Promise<void> {
	await expect.poll(
		() => page.evaluate((expectedId) => {
			const win = window as any;
			const appState = win.bobbitState ?? win.__bobbitState;
			const panel = document.querySelector("pi-chat-panel");
			return appState?.selectedSessionId === expectedId
				&& appState?.remoteAgent?.gatewaySessionId === expectedId
				&& appState.remoteAgent.connected === true
				&& appState.chatPanel === panel
				&& appState.chatPanel?.agentInterface
				? expectedId
				: null;
		}, sessionId),
		{ timeout: 20_000, message: `session ${sessionId} should own a connected panel` },
	).toBe(sessionId);
	await expect(page.locator("pi-chat-panel message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
}

async function expectTranscript(page: Page, text: string): Promise<void> {
	await expect(
		page.locator("pi-chat-panel user-message").filter({ hasText: text }).first(),
		`transcript should contain ${text}`,
	).toBeVisible({ timeout: 20_000 });
}

async function seedTranscript(page: Page, sessionId: string, text: string): Promise<void> {
	await sendMessage(page, text);
	await expectTranscript(page, text);
	await waitForAgentResponse(page);
	await expect.poll(
		() => page.evaluate((expectedId) => {
			const win = window as any;
			const appState = win.bobbitState ?? win.__bobbitState;
			return appState?.remoteAgent?.gatewaySessionId === expectedId
				? appState.remoteAgent.state?.status
				: null;
		}, sessionId),
		{ timeout: 20_000, message: `session ${sessionId} should be idle before it is cached` },
	).toBe("idle");
}

async function rememberActivePanel(page: Page, identity: string, rememberAgentAs?: string): Promise<void> {
	await page.evaluate(({ identity: panelIdentity, rememberAgentAs: agentKey }) => {
		const win = window as any;
		const appState = win.bobbitState ?? win.__bobbitState;
		const panel = document.querySelector("pi-chat-panel") as HTMLElement | null;
		if (!panel || appState?.chatPanel !== panel) throw new Error("active pi-chat-panel missing from app state");
		panel.dataset.portraitCachePanelIdentity = panelIdentity;
		win.__portraitSessionCachePanelRefs ??= {};
		win.__portraitSessionCachePanelRefs[panelIdentity] = panel;
		if (agentKey) {
			if (!appState.remoteAgent?.connected) throw new Error("active RemoteAgent is not connected");
			win.__portraitSessionCacheAgentRefs ??= {};
			win.__portraitSessionCacheAgentRefs[agentKey] = appState.remoteAgent;
		}
	}, { identity, rememberAgentAs });
}

async function expectRememberedPanel(page: Page, identity: string): Promise<void> {
	expect(
		await page.evaluate((panelIdentity) => {
			const win = window as any;
			const panel = document.querySelector("pi-chat-panel") as HTMLElement | null;
			return panel !== null
				&& panel === win.__portraitSessionCachePanelRefs?.[panelIdentity]
				&& panel.dataset.portraitCachePanelIdentity === panelIdentity;
		}, identity),
		`pi-chat-panel ${identity} should retain exact DOM identity`,
	).toBe(true);
}

async function expectPanelIdentityAbsent(page: Page, identity: string): Promise<void> {
	expect(
		await page.locator("pi-chat-panel").first().evaluate(
			(panel, oldIdentity) => (panel as HTMLElement).dataset.portraitCachePanelIdentity !== oldIdentity,
			identity,
		),
		`pi-chat-panel ${identity} should have been replaced`,
	).toBe(true);
}

async function installLoaderObserver(page: Page): Promise<void> {
	await expect(page.getByTestId("bobbit-loader")).toHaveCount(0);
	await page.evaluate(() => {
		const win = window as any;
		win.__portraitSessionCacheLoaderObserver?.disconnect();
		const seen = new WeakSet<Element>();
		const observation: LoaderObservation = { mounted: false, mountCount: 0 };
		const record = (root: Node) => {
			const candidates: Element[] = [];
			if (root instanceof Element && root.matches('[data-testid="bobbit-loader"]')) candidates.push(root);
			if (root instanceof Element || root instanceof Document || root instanceof DocumentFragment) {
				candidates.push(...root.querySelectorAll('[data-testid="bobbit-loader"]'));
			}
			for (const candidate of candidates) {
				if (seen.has(candidate)) continue;
				seen.add(candidate);
				observation.mounted = true;
				observation.mountCount++;
			}
		};
		const observer = new MutationObserver((records) => {
			for (const mutation of records) {
				if (mutation.type === "attributes") record(mutation.target);
				for (const node of mutation.addedNodes) record(node);
			}
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-testid"],
			childList: true,
			subtree: true,
		});
		win.__portraitSessionCacheLoaderObservation = observation;
		win.__portraitSessionCacheLoaderObserver = observer;
	});
}

async function readLoaderObservation(page: Page): Promise<LoaderObservation> {
	return page.evaluate(() => {
		const win = window as any;
		win.__portraitSessionCacheLoaderObserver?.disconnect();
		return win.__portraitSessionCacheLoaderObservation ?? { mounted: false, mountCount: 0 };
	});
}

async function backToSessionList(page: Page): Promise<void> {
	const back = page.getByTitle("Back to session list");
	await expect(back).toBeVisible({ timeout: 10_000 });
	await back.click();
	await expect.poll(
		() => page.evaluate(() => {
			const win = window as any;
			const appState = win.bobbitState ?? win.__bobbitState;
			return appState?.selectedSessionId === null
				&& appState?.chatPanel === null
				&& appState?.remoteAgent === null
				&& window.location.hash === "#/";
		}),
		{ timeout: 10_000, message: "portrait back should release active ownership and show the session list" },
	).toBe(true);
}

async function openSessionFromList(page: Page, sessionId: string): Promise<void> {
	const row = sessionRow(page, sessionId);
	await expect(row).toBeVisible({ timeout: 15_000 });
	await row.getByTestId("sidebar-session-title-text").click();
	await waitForActiveSession(page, sessionId);
}

test.describe("Journey: Portrait session cache", () => {
	test.use({ viewport: PORTRAIT });

	test("portrait list round-trips reuse panels, stale sockets reconnect, and reload stays memory-only", async ({ page }) => {
		const createdSessionIds: string[] = [];
		const websocketUrls: string[] = [];
		page.on("websocket", (socket) => websocketUrls.push(socket.url()));

		try {
			const sessionA = await createSession();
			createdSessionIds.push(sessionA);
			const sessionB = await createSession();
			createdSessionIds.push(sessionB);
			await waitForSessionStatus(sessionA, "idle");
			await waitForSessionStatus(sessionB, "idle");

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionA}`);
			await waitForActiveSession(page, sessionA);
			await seedTranscript(page, sessionA, A_TRANSCRIPT);
			await rememberActivePanel(page, A_ORIGINAL_PANEL, "sessionA");
			expect(sessionSocketCount(websocketUrls, sessionA), "initial A visit should create a session WebSocket").toBeGreaterThan(0);

			await backToSessionList(page);
			await openSessionFromList(page, sessionB);
			await seedTranscript(page, sessionB, B_TRANSCRIPT);
			await rememberActivePanel(page, B_ORIGINAL_PANEL);
			expect(sessionSocketCount(websocketUrls, sessionB), "initial B visit should create a session WebSocket").toBeGreaterThan(0);

			await backToSessionList(page);
			const healthyACount = sessionSocketCount(websocketUrls, sessionA);
			await installLoaderObserver(page);
			await openSessionFromList(page, sessionA);
			await expectTranscript(page, A_TRANSCRIPT);
			await expectRememberedPanel(page, A_ORIGINAL_PANEL);
			expect(
				await readLoaderObservation(page),
				"healthy portrait cache return must never mount the connection loader",
			).toEqual({ mounted: false, mountCount: 0 });
			expect(
				sessionSocketCount(websocketUrls, sessionA),
				"healthy portrait cache return must not create another session WebSocket",
			).toBe(healthyACount);

			await rememberActivePanel(page, A_ORIGINAL_PANEL, "cachedSessionA");
			await backToSessionList(page);
			await page.evaluate(() => {
				const win = window as any;
				const cachedAgent = win.__portraitSessionCacheAgentRefs?.cachedSessionA;
				if (!cachedAgent?.connected) throw new Error("cached A RemoteAgent was not connected before invalidation");
				cachedAgent.disconnect();
				if (cachedAgent.connected) throw new Error("cached A RemoteAgent remained connected after invalidation");
			});

			const staleACount = sessionSocketCount(websocketUrls, sessionA);
			await installLoaderObserver(page);
			await openSessionFromList(page, sessionA);
			await expectTranscript(page, A_TRANSCRIPT);
			await expectPanelIdentityAbsent(page, A_ORIGINAL_PANEL);
			const staleObservation = await readLoaderObservation(page);
			expect(staleObservation.mounted, "stale cached A must mount the normal connection loader").toBe(true);
			expect(staleObservation.mountCount, "stale cached A must record at least one loader mount").toBeGreaterThan(0);
			expect(
				sessionSocketCount(websocketUrls, sessionA),
				"stale cached A must create exactly one replacement session WebSocket",
			).toBe(staleACount + 1);
			await rememberActivePanel(page, A_FRESH_PANEL);

			await page.setViewportSize(LANDSCAPE);
			await expect(page.getByTitle("Back to session list")).toHaveCount(0);
			const landscapeBCount = sessionSocketCount(websocketUrls, sessionB);
			await installLoaderObserver(page);
			await sessionRow(page, sessionB).click({ position: { x: 8, y: 8 } });
			await waitForActiveSession(page, sessionB);
			await expectTranscript(page, B_TRANSCRIPT);
			await expectRememberedPanel(page, B_ORIGINAL_PANEL);
			expect(
				await readLoaderObservation(page),
				"landscape direct switch should reuse the same cache without mounting a loader",
			).toEqual({ mounted: false, mountCount: 0 });
			expect(
				sessionSocketCount(websocketUrls, sessionB),
				"landscape direct switch should not create another B session WebSocket",
			).toBe(landscapeBCount);

			const reloadBCount = sessionSocketCount(websocketUrls, sessionB);
			await page.reload();
			await waitForActiveSession(page, sessionB);
			await expectTranscript(page, B_TRANSCRIPT);
			await expectPanelIdentityAbsent(page, B_ORIGINAL_PANEL);
			expect(
				sessionSocketCount(websocketUrls, sessionB),
				"reload should construct one new active B connection",
			).toBe(reloadBCount + 1);

			const postReloadACount = sessionSocketCount(websocketUrls, sessionA);
			await installLoaderObserver(page);
			await sessionRow(page, sessionA).click({ position: { x: 8, y: 8 } });
			await waitForActiveSession(page, sessionA);
			await expectTranscript(page, A_TRANSCRIPT);
			await expectPanelIdentityAbsent(page, A_FRESH_PANEL);
			const postReloadObservation = await readLoaderObservation(page);
			expect(postReloadObservation.mounted, "reload must discard the in-memory A cache").toBe(true);
			expect(postReloadObservation.mountCount, "post-reload A must record at least one loader mount").toBeGreaterThan(0);
			expect(
				sessionSocketCount(websocketUrls, sessionA),
				"opening A after reload should create exactly one new connection while hydrating history",
			).toBe(postReloadACount + 1);
		} finally {
			for (const sessionId of createdSessionIds.reverse()) {
				await deleteSession(sessionId);
			}
		}
	});
});
