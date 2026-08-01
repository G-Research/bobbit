import type { Request as PlaywrightRequest, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { test, expect } from "../_helpers/journey-fixture.js";
import type { GatewayInfo } from "../gateway-harness.js";

const GATEWAY_PATH = "/team/gw";

test.use({ basePath: GATEWAY_PATH, separateUiOrigin: true });

interface RequestRecord {
	url: string;
	authorization?: string;
}

interface SocketRecord {
	url: string;
	received: number;
}

function gatewayToken(): string {
	const token = process.env.BOBBIT_TOKEN?.trim();
	if (!token) throw new Error("gateway harness did not expose BOBBIT_TOKEN");
	return token;
}

function gatewayAtUiHostname(gateway: GatewayInfo): string {
	const explicit = new URL(gateway.baseURL);
	explicit.hostname = new URL(gateway.uiBaseURL).hostname;
	return explicit.toString().replace(/\/$/, "");
}

function expectMountedExactlyOnce(raw: string): void {
	const pathname = new URL(raw).pathname;
	expect(pathname === GATEWAY_PATH || pathname.startsWith(`${GATEWAY_PATH}/`), raw).toBe(true);
	expect(pathname, `${raw} must not double-prefix the explicit gateway base`).not.toContain(`${GATEWAY_PATH}${GATEWAY_PATH}`);
}

test.describe("Journey: authoritative explicit prefixed gateway", () => {
	test("keeps REST and viewer traffic on the stored prefix and never sends Bearer localhost", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		expect(gateway.basePath).toBe(GATEWAY_PATH);
		expect(gateway.uiBaseURL).not.toBe(gateway.baseURL);

		const explicitBase = gatewayAtUiHostname(gateway);
		const explicitOrigin = new URL(explicitBase).origin;
		const uiOrigin = new URL(gateway.uiBaseURL).origin;
		const requests: RequestRecord[] = [];
		const sockets: SocketRecord[] = [];
		const onRequest = (request: PlaywrightRequest) => requests.push({
			url: request.url(),
			authorization: request.headers().authorization,
		});
		const onSocket = (socket: PlaywrightWebSocket) => {
			const record: SocketRecord = { url: socket.url(), received: 0 };
			sockets.push(record);
			socket.on("framereceived", () => record.received++);
		};
		page.context().on("request", onRequest);
		page.on("websocket", onSocket);
		await page.addInitScript(({ base, token }) => {
			localStorage.setItem("gateway.url", base);
			localStorage.setItem("gateway.token", token);
		}, { base: explicitBase, token: gatewayToken() });

		try {
			const firstHealth = page.waitForResponse((response) => {
				const url = new URL(response.url());
				return response.request().method() === "GET"
					&& url.origin === explicitOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/health`;
			}, { timeout: 25_000 });
			await page.goto(`${uiOrigin}/`, { waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 25_000 });
			const authenticatedHealth = await firstHealth;
			expect(authenticatedHealth.status()).toBe(200);
			expect(await authenticatedHealth.request().headerValue("authorization")).toBe(`Bearer ${gatewayToken()}`);
			expectMountedExactlyOnce(authenticatedHealth.url());

			await expect.poll(() => sockets.find((socket) => {
				const url = new URL(socket.url);
				return url.origin === explicitOrigin.replace(/^http/, "ws")
					&& url.pathname === `${GATEWAY_PATH}/ws/viewer`;
			})?.received ?? 0, {
				timeout: 20_000,
				message: "viewer socket should use the authoritative explicit gateway mount",
			}).toBeGreaterThan(0);

			const stored = await page.evaluate(() => ({
				url: localStorage.getItem("gateway.url"),
				token: localStorage.getItem("gateway.token"),
			}));
			expect(stored.url).toBe(explicitBase);
			expect([gatewayToken(), "localhost"]).toContain(stored.token);

			await page.evaluate(() => localStorage.setItem("gateway.token", "localhost"));
			const requestStart = requests.length;
			const sentinelHealth = page.waitForResponse((response) => {
				const url = new URL(response.url());
				return response.request().method() === "GET"
					&& url.origin === explicitOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/health`;
			}, { timeout: 25_000 });
			await page.reload({ waitUntil: "domcontentloaded" });
			const cookieHealth = await sentinelHealth;
			expect(cookieHealth.status()).toBe(200);
			expectMountedExactlyOnce(cookieHealth.url());

			const explicitApiRequests = requests.slice(requestStart).filter((request) => {
				const url = new URL(request.url);
				return url.origin === explicitOrigin && url.pathname.startsWith(`${GATEWAY_PATH}/api/`);
			});
			expect(explicitApiRequests.length).toBeGreaterThan(0);
			expect(explicitApiRequests.some((request) => request.authorization === "Bearer localhost")).toBe(false);
			expect(explicitApiRequests.every((request) => !new URL(request.url).pathname.includes(`${GATEWAY_PATH}${GATEWAY_PATH}`))).toBe(true);
			expect(await page.evaluate(() => localStorage.getItem("gateway.url"))).toBe(explicitBase);
		} finally {
			page.context().off("request", onRequest);
			page.off("websocket", onSocket);
			await page.context().clearCookies().catch(() => undefined);
		}
	});
});
