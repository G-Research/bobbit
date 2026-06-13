import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function installViewerWsProbe(page: import("@playwright/test").Page): Promise<void> {
	await page.addInitScript(() => {
		const NativeWebSocket = window.WebSocket;
		const stats = {
			authOk: 0,
			sessionInvalidations: 0,
			viewerConnections: 0,
			messages: [] as string[],
		};
		(window as any).__sessionListPushProbe = stats;
		window.WebSocket = class BobbitWsProbe extends NativeWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols as any);
				if (String(url).includes("/ws/viewer")) {
					stats.viewerConnections++;
					this.addEventListener("message", (event: MessageEvent) => {
						try {
							const msg = JSON.parse(String(event.data));
							if (typeof msg?.type === "string") stats.messages.push(msg.type);
							if (msg?.type === "auth_ok") stats.authOk++;
							if (msg?.type === "session_created" || msg?.type === "sessions_changed") stats.sessionInvalidations++;
						} catch {
							// ignore malformed frames
						}
					});
				}
			}
		} as any;
	});
}

test.describe("session-created push sync UI", () => {
	test("mobile landing with no active RemoteAgent refreshes from viewer push before polling", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await installViewerWsProbe(page);
		await openApp(page);

		await expect.poll(async () => page.evaluate(() => ({
			appView: (window as any).__bobbitState?.appView,
			hasRemoteAgent: !!(window as any).__bobbitState?.remoteAgent,
		})), { timeout: 5_000 }).toEqual({ appView: "authenticated", hasRemoteAgent: false });

		await expect.poll(
			async () => page.evaluate(() => (window as any).__sessionListPushProbe?.authOk ?? 0),
			{ timeout: 5_000, message: "landing page should keep an authenticated /ws/viewer listener without a RemoteAgent" },
		).toBeGreaterThan(0);

		let createdSessionId: string | undefined;
		try {
			createdSessionId = await createSession();

			await expect.poll(async () => page.evaluate(() => (window as any).__sessionListPushProbe?.sessionInvalidations ?? 0), {
				timeout: 2_000,
				intervals: [50, 100, 250],
				message: "viewer socket should receive session_created/sessions_changed before the 5s polling fallback",
			}).toBeGreaterThan(0);

			await expect.poll(async () => page.evaluate((sessionId) => {
				return !!(window as any).__bobbitState?.gatewaySessions?.some((session: any) => session?.id === sessionId);
			}, createdSessionId), {
				timeout: 2_000,
				intervals: [50, 100, 250],
				message: "landing session list state should include the pushed session before the 5s polling fallback",
			}).toBe(true);

			await expect.poll(async () => page.evaluate(() => !!(window as any).__bobbitState?.remoteAgent), {
				timeout: 500,
				message: "refreshing the landing session list must not create an active RemoteAgent",
			}).toBe(false);
		} finally {
			if (createdSessionId) await deleteSession(createdSessionId);
		}
	});
});
