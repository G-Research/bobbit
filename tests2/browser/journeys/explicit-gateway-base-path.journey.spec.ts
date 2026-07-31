import type { Page, Request as PlaywrightRequest, Response as PlaywrightResponse, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test, expect } from "../_helpers/journey-fixture.js";
import type { GatewayInfo } from "../gateway-harness.js";

const GATEWAY_PATH = "/team/gw";
const ENTRY = "explicit-preview.html";
const PREVIEW_TEXT = "EXPLICIT_GATEWAY_PREVIEW_OK";
const INVALID_COOKIE = "not-a-signed-bobbit-cookie";

test.use({ basePath: GATEWAY_PATH, separateUiOrigin: true });

interface RequestRecord {
	url: string;
	method: string;
	resourceType: string;
	authorization?: string;
	cookie?: string;
}

interface SocketRecord {
	url: string;
	sent: number;
	received: number;
}

interface BrowserTransportProbe {
	fetches: Array<{ url: string; credentials: string | null }>;
	eventSources: Array<{ url: string; withCredentials: boolean }>;
	previewEvents: unknown[];
}

function gatewayToken(): string {
	const token = process.env.BOBBIT_TOKEN?.trim();
	if (!token) throw new Error("gateway harness did not expose BOBBIT_TOKEN");
	return token;
}

function gatewayAlias(gateway: GatewayInfo, hostname: "localhost" | "127.0.0.1"): string {
	const url = new URL(gateway.baseURL);
	url.hostname = hostname;
	return url.toString().replace(/\/$/, "");
}

async function adminRequest(
	gateway: GatewayInfo,
	path: string,
	init: RequestInit = {},
): Promise<{ response: Response; text: string; body: any }> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${gatewayToken()}`);
	if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	const response = await fetch(`${gateway.baseURL}${path}`, { ...init, headers });
	const text = await response.text();
	let body: any;
	try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
	return { response, text, body };
}

async function createHarnessSession(gateway: GatewayInfo, suffix: string): Promise<string> {
	const projects = await adminRequest(gateway, "/api/projects");
	expect(projects.response.status, projects.text).toBe(200);
	const rows = Array.isArray(projects.body) ? projects.body : projects.body?.projects;
	const project = rows?.find((row: any) => row?.name === "default" && row?.id);
	expect(project?.id, `default project missing from ${projects.text}`).toBeTruthy();
	const cwd = join(
		dirname(gateway.bobbitDir),
		`${basename(gateway.bobbitDir)}-default-project`,
		`.explicit-base-${suffix}`,
	);
	mkdirSync(cwd, { recursive: true });
	const created = await adminRequest(gateway, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ projectId: project.id, cwd }),
	});
	expect(created.response.status, created.text).toBe(201);
	expect(created.body?.id).toMatch(/^[a-f0-9-]{36}$/);
	await expect.poll(async () => {
		const current = await adminRequest(gateway, `/api/sessions/${created.body.id}`);
		return current.body?.status;
	}, { timeout: 30_000 }).toBe("idle");
	return created.body.id;
}

async function deleteHarnessSession(gateway: GatewayInfo, sessionId: string): Promise<void> {
	await adminRequest(gateway, `/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
}

async function installBrowserTransportProbe(page: Page, gatewayBase: string, token: string): Promise<void> {
	await page.addInitScript(({ base, authToken }) => {
		localStorage.setItem("gateway.url", base);
		localStorage.setItem("gateway.token", authToken);
		const probe: BrowserTransportProbe = { fetches: [], eventSources: [], previewEvents: [] };
		(window as any).__explicitGatewayTransportProbe = probe;

		const nativeFetch = window.fetch.bind(window);
		window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : undefined;
			probe.fetches.push({
				url: request?.url ?? String(input),
				credentials: String(init?.credentials ?? request?.credentials ?? "") || null,
			});
			return nativeFetch(input, init);
		}) as typeof window.fetch;

		const NativeEventSource = window.EventSource;
		class RecordingEventSource extends NativeEventSource {
			constructor(url: string | URL, init?: EventSourceInit) {
				super(url, init);
				probe.eventSources.push({ url: String(url), withCredentials: init?.withCredentials === true });
				this.addEventListener("preview-changed", (event: MessageEvent) => {
					try { probe.previewEvents.push(JSON.parse(event.data)); }
					catch { probe.previewEvents.push(event.data); }
				});
			}
		}
		Object.defineProperty(window, "EventSource", { configurable: true, value: RecordingEventSource });
	}, { base: gatewayBase, authToken: token });
}

async function transportProbe(page: Page): Promise<BrowserTransportProbe> {
	return page.evaluate(() => (window as any).__explicitGatewayTransportProbe);
}

function recordSocket(sockets: SocketRecord[], socket: PlaywrightWebSocket): void {
	const record: SocketRecord = { url: socket.url(), sent: 0, received: 0 };
	sockets.push(record);
	socket.on("framesent", () => record.sent++);
	socket.on("framereceived", () => record.received++);
}

function expectGatewayPathOnce(url: string, gatewayBase: string, routePrefix: string): void {
	const pathname = new URL(url, gatewayBase).pathname;
	const expected = `${GATEWAY_PATH}${routePrefix}`;
	expect(pathname === expected || pathname.startsWith(`${expected}/`), url).toBe(true);
	expect(pathname, `${url} must not double-prefix the explicit gateway base`).not.toContain(`${GATEWAY_PATH}${GATEWAY_PATH}`);
}

async function cookieOnlyHealth(gatewayBase: string, uiOrigin: string, cookieHeader: string): Promise<Response> {
	return fetch(`${gatewayBase}/api/health`, {
		headers: {
			Cookie: cookieHeader,
			Origin: uiOrigin,
			"Sec-Fetch-Mode": "cors",
			"Sec-Fetch-Site": "same-site",
			"User-Agent": "Mozilla/5.0 Bobbit base-path browser test",
		},
	});
}

function gatewayRouteRequestsAtUiOrigin(requests: RequestRecord[], uiOrigin: string): RequestRecord[] {
	return requests.filter(record => {
		const url = new URL(record.url);
		return url.origin === uiOrigin && /^\/(?:api|preview|ws)(?:\/|$)/.test(url.pathname);
	});
}

async function waitForViewerSocket(sockets: SocketRecord[], gatewayBase: string): Promise<void> {
	const expectedOrigin = new URL(gatewayBase).origin.replace(/^http/, "ws");
	await expect.poll(() => sockets.find(socket => {
		const url = new URL(socket.url);
		return url.origin === expectedOrigin && url.pathname === `${GATEWAY_PATH}/ws/viewer`;
	})?.received ?? 0, {
		timeout: 20_000,
		message: "explicit gateway viewer socket should authenticate and receive activity",
	}).toBeGreaterThan(0);
}

async function waitForSessionSocket(sockets: SocketRecord[], gatewayBase: string, sessionId: string): Promise<void> {
	const expectedOrigin = new URL(gatewayBase).origin.replace(/^http/, "ws");
	await expect.poll(() => sockets.find(socket => {
		const url = new URL(socket.url);
		return url.origin === expectedOrigin && url.pathname === `${GATEWAY_PATH}/ws/${sessionId}`;
	})?.received ?? 0, {
		timeout: 20_000,
		message: "explicit gateway session socket should authenticate and receive activity",
	}).toBeGreaterThan(0);
}

function collectPageTraffic(page: Page): { requests: RequestRecord[]; sockets: SocketRecord[]; dispose(): void } {
	const requests: RequestRecord[] = [];
	const sockets: SocketRecord[] = [];
	const onRequest = (request: PlaywrightRequest) => requests.push({
		url: request.url(),
		method: request.method(),
		resourceType: request.resourceType(),
		authorization: request.headers().authorization,
		cookie: request.headers().cookie,
	});
	page.context().on("request", onRequest);
	page.on("websocket", socket => recordSocket(sockets, socket));
	return { requests, sockets, dispose: () => page.context().off("request", onRequest) };
}

test.describe("Journey: explicit prefixed gateway on a distinct browser origin", () => {
	test("uses the same-host remote mount exactly once for REST, WS, SSE, iframe, assets, popout, CORS, and duplicate cookies", async ({ page, gateway }) => {
		test.setTimeout(150_000);
		expect(gateway.basePath).toBe(GATEWAY_PATH);
		expect(gateway.uiBaseURL).not.toBe(gateway.baseURL);
		const explicitBase = gatewayAlias(gateway, "localhost");
		const uiOrigin = new URL(gateway.uiBaseURL).origin;
		const gatewayOrigin = new URL(explicitBase).origin;
		const context = page.context();
		const traffic = collectPageTraffic(page);
		await context.addCookies([{
			name: "bobbit_session",
			value: INVALID_COOKIE,
			url: `${uiOrigin}/`,
			httpOnly: true,
			sameSite: "Lax",
		}]);
		await installBrowserTransportProbe(page, explicitBase, gatewayToken());

		let sessionId: string | undefined;
		let popup: Page | undefined;
		const fixtureDir = join(gateway.bobbitDir, "explicit-base-preview");
		try {
			const healthPromise = page.waitForResponse(response => {
				const url = new URL(response.url());
				return response.request().method() === "GET"
					&& url.origin === gatewayOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/health`;
			}, { timeout: 25_000 });
			await page.goto(`${uiOrigin}/`, { waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 25_000 });
			const health = await healthPromise;
			expect(health.status()).toBe(200);
			expect(await health.headerValue("access-control-allow-origin")).toBe(uiOrigin);
			expect(await health.headerValue("access-control-allow-credentials")).toBe("true");
			expect((await health.headerValue("vary"))?.toLowerCase()).toContain("origin");
			expect(await health.request().headerValue("authorization")).toBe(`Bearer ${gatewayToken()}`);
			expect(await health.request().headerValue("cookie")).toContain(`bobbit_session=${INVALID_COOKIE}`);

			await waitForViewerSocket(traffic.sockets, explicitBase);
			const probeAfterBoot = await transportProbe(page);
			const explicitRest = probeAfterBoot.fetches.filter(entry => {
				try {
					const url = new URL(entry.url, uiOrigin);
					return url.origin === gatewayOrigin && url.pathname.startsWith(`${GATEWAY_PATH}/api/`);
				} catch { return false; }
			});
			expect(explicitRest.length, "app boot should call the explicit gateway directly").toBeGreaterThan(0);
			expect(explicitRest.every(entry => entry.credentials === "include"), "remote REST must include credentials").toBe(true);

			const cookies = await context.cookies(`${explicitBase}/`);
			const rootCookie = cookies.find(cookie => cookie.name === "bobbit_session" && cookie.path === "/");
			const mountedCookie = cookies.find(cookie => cookie.name === "bobbit_session" && cookie.path === `${GATEWAY_PATH}/`);
			expect(rootCookie?.value).toBe(INVALID_COOKIE);
			expect(mountedCookie?.value, "same-host credentialed REST should bootstrap a mount-scoped signed cookie").toMatch(/^v1\./);

			for (const values of [
				[`bobbit_session=${INVALID_COOKIE}`, `bobbit_session=${mountedCookie!.value}`],
				[`bobbit_session=${mountedCookie!.value}`, `bobbit_session=${INVALID_COOKIE}`],
			]) {
				const response = await cookieOnlyHealth(explicitBase, uiOrigin, values.join("; "));
				expect(response.status, `valid mounted cookie must win in either duplicate-cookie order: ${values.join("; ")}`).toBe(200);
				expect(response.headers.get("access-control-allow-origin")).toBe(uiOrigin);
			}

			sessionId = await createHarnessSession(gateway, "same-host");
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await waitForSessionSocket(traffic.sockets, explicitBase, sessionId);

			const sseResponsePromise = page.waitForResponse(response => {
				const url = new URL(response.url());
				return url.origin === gatewayOrigin && url.pathname === `${GATEWAY_PATH}/api/sessions/${sessionId}/preview-events`;
			}, { timeout: 20_000 });
			const enabled = await adminRequest(gateway, `/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ preview: true }),
			});
			expect(enabled.response.status, enabled.text).toBe(200);
			const sseResponse = await sseResponsePromise;
			expect(sseResponse.status()).toBe(200);
			expect(await sseResponse.headerValue("content-type")).toContain("text/event-stream");
			expect(await sseResponse.headerValue("access-control-allow-origin")).toBe(uiOrigin);
			expect(await sseResponse.headerValue("access-control-allow-credentials")).toBe("true");
			await expect.poll(async () => (await transportProbe(page)).eventSources.some(source => {
				const url = new URL(source.url, uiOrigin);
				return url.origin === gatewayOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/sessions/${sessionId}/preview-events`
					&& source.withCredentials;
			}), { timeout: 15_000 }).toBe(true);

			mkdirSync(fixtureDir, { recursive: true });
			const htmlPath = join(fixtureDir, ENTRY);
			writeFileSync(htmlPath, `<!doctype html><link rel="stylesheet" href="./asset.css"><body><h1>${PREVIEW_TEXT}</h1><p id="asset">asset</p></body>`);
			writeFileSync(join(fixtureDir, "asset.css"), "#asset { font-weight: 700; }");
			const mounted = await adminRequest(gateway, `/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ file: htmlPath, assets: ["asset.css"] }),
			});
			expect(mounted.response.status, mounted.text).toBe(200);
			expect(mounted.body?.url).toBe(`/preview/${sessionId}/${ENTRY}`);
			const snapshot = await adminRequest(gateway, `/api/preview/mount?sessionId=${sessionId}`);
			expect(snapshot.response.status, snapshot.text).toBe(200);
			expect(snapshot.body?.url).toBe(`/preview/${sessionId}/${ENTRY}`);
			await expect.poll(async () => (await transportProbe(page)).previewEvents.some((event: any) => event?.url === `/preview/${sessionId}/${ENTRY}`), {
				timeout: 20_000,
				message: "remote raw SSE payload must remain the internal preview route",
			}).toBe(true);

			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe).toBeVisible({ timeout: 25_000 });
			const iframeSrc = await iframe.getAttribute("src");
			expect(iframeSrc).toBeTruthy();
			expect(new URL(iframeSrc!, uiOrigin).origin).toBe(gatewayOrigin);
			expectGatewayPathOnce(iframeSrc!, explicitBase, "/preview");
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("body")).toContainText(PREVIEW_TEXT, { timeout: 20_000 });
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("#asset")).toHaveCSS("font-weight", "700");
			const assetRequest = traffic.requests.find(record => {
				const url = new URL(record.url);
				return url.origin === gatewayOrigin
					&& new RegExp(`^${GATEWAY_PATH}/preview/${sessionId}/_content/[^/]+/asset\\.css$`).test(url.pathname);
			});
			expect(assetRequest, "explicit preview sibling asset should stay on the remote mount").toBeTruthy();

			const popoutLink = page.locator('a[title="Open preview in new tab"]').first();
			await expect(popoutLink).toBeVisible({ timeout: 15_000 });
			await expect(popoutLink).toHaveClass(/hover:text-foreground/);
			await expect(popoutLink).toHaveCSS("cursor", "pointer");
			const href = await popoutLink.getAttribute("href");
			expect(new URL(href!, uiOrigin).origin).toBe(gatewayOrigin);
			expectGatewayPathOnce(href!, explicitBase, "/preview");
			const popupPromise = page.waitForEvent("popup");
			await popoutLink.click();
			popup = await popupPromise;
			await popup.waitForLoadState("domcontentloaded");
			expect(new URL(popup.url()).origin).toBe(gatewayOrigin);
			expectGatewayPathOnce(popup.url(), explicitBase, "/preview");
			await expect(popup.locator("body")).toContainText(PREVIEW_TEXT, { timeout: 15_000 });
			await popup.close();
			popup = undefined;

			expect(gatewayRouteRequestsAtUiOrigin(traffic.requests, uiOrigin), "gateway transports must never fall back to the static UI origin").toEqual([]);
			for (const record of traffic.requests.filter(record => new URL(record.url).origin === gatewayOrigin && /^\/(?:team\/gw\/)?(?:api|preview)(?:\/|$)/.test(new URL(record.url).pathname))) {
				const pathname = new URL(record.url).pathname;
				expectGatewayPathOnce(record.url, explicitBase, pathname.startsWith(`${GATEWAY_PATH}/preview/`) ? "/preview" : "/api");
			}
			for (const socket of traffic.sockets) expectGatewayPathOnce(socket.url, explicitBase, "/ws");
		} finally {
			traffic.dispose();
			if (popup && !popup.isClosed()) await popup.close().catch(() => undefined);
			if (sessionId) await deleteHarnessSession(gateway, sessionId);
			rmSync(fixtureDir, { recursive: true, force: true });
			await context.clearCookies().catch(() => undefined);
		}
	});

	test("recovers sentinel cookie REST, WebSockets, and later preflights after a gateway restart", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const explicitBase = gatewayAlias(gateway, "localhost");
		const gatewayOrigin = new URL(explicitBase).origin;
		const uiOrigin = new URL(gateway.uiBaseURL).origin;
		const context = page.context();
		const traffic = collectPageTraffic(page);
		const initMarker = "bobbit-explicit-restart-bootstrap";
		await page.addInitScript(({ base, token, marker }) => {
			if (sessionStorage.getItem(marker) === "1") return;
			localStorage.setItem("gateway.url", base);
			localStorage.setItem("gateway.token", token);
			sessionStorage.setItem(marker, "1");
		}, { base: explicitBase, token: gatewayToken(), marker: initMarker });

		try {
			const bootstrapPromise = page.waitForResponse(response => {
				const url = new URL(response.url());
				return response.request().method() === "GET"
					&& url.origin === gatewayOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/health`;
			}, { timeout: 25_000 });
			await page.goto(`${uiOrigin}/`, { waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 25_000 });
			const bootstrap = await bootstrapPromise;
			expect(await bootstrap.request().headerValue("authorization")).toBe(`Bearer ${gatewayToken()}`);
			await expect.poll(() => page.evaluate(() => localStorage.getItem("gateway.token")), {
				timeout: 15_000,
				message: "same-host bootstrap should replace the persisted bearer with the cookie sentinel",
			}).toBe("localhost");
			expect(await page.evaluate(() => localStorage.getItem("gateway.url"))).toBe(explicitBase);
			const mountedCookie = (await context.cookies(`${explicitBase}/`))
				.find(cookie => cookie.name === "bobbit_session" && cookie.path === `${GATEWAY_PATH}/`);
			expect(mountedCookie?.value).toMatch(/^v1\.2\./);

			// Reload once so the live connection also hydrates the sentinel instead
			// of retaining the successful bootstrap bearer in this tab's memory.
			const cookieReadPromise = page.waitForRequest(request => {
				const url = new URL(request.url());
				return request.method() === "GET"
					&& url.origin === gatewayOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/sessions`;
			}, { timeout: 25_000 });
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 25_000 });
			const cookieRead = await cookieReadPromise;
			expect(await cookieRead.headerValue("authorization")).toBeNull();
			expect(await cookieRead.headerValue("content-type"), "bodyless gatewayFetch GET must remain CORS-simple").toBeNull();
			await waitForViewerSocket(traffic.sockets, explicitBase);

			await gateway.crash();
			await gateway.restart();
			const websocketRecovery = await page.evaluate(async (base) => {
				const url = new URL(`${base}/ws/viewer`);
				url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
				const token = localStorage.getItem("gateway.token") ?? "";
				return await new Promise<{ token: string; messageType: string }>((resolve, reject) => {
					const socket = new WebSocket(url);
					const timer = window.setTimeout(() => {
						socket.close();
						reject(new Error("cookie-authenticated viewer WebSocket timed out after restart"));
					}, 15_000);
					socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
					socket.addEventListener("message", (event) => {
						const message = JSON.parse(String(event.data));
						if (message?.type !== "auth_ok") return;
						window.clearTimeout(timer);
						socket.close();
						resolve({ token, messageType: message.type });
					});
					socket.addEventListener("error", () => {
						window.clearTimeout(timer);
						reject(new Error("cookie-authenticated viewer WebSocket failed after restart"));
					});
				});
			}, explicitBase);
			expect(websocketRecovery).toEqual({ token: "localhost", messageType: "auth_ok" });

			const simpleReadPromise = page.waitForResponse(response => {
				const url = new URL(response.url());
				return response.request().method() === "GET"
					&& url.origin === gatewayOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/health`;
			}, { timeout: 15_000 });
			const simpleReadResult = await page.evaluate(async (base) => {
				const response = await fetch(`${base}/api/health`, { credentials: "include" });
				return { status: response.status, body: await response.text() };
			}, explicitBase);
			const simpleRead = await simpleReadPromise;
			expect(simpleReadResult.status, simpleReadResult.body).toBe(200);
			expect(await simpleRead.request().headerValue("authorization")).toBeNull();
			expect(await simpleRead.request().headerValue("content-type")).toBeNull();
			expect(await simpleRead.headerValue("access-control-allow-origin")).toBe(uiOrigin);

			const recoveredPreflight = await fetch(`${explicitBase}/api/setup-status/dismiss`, {
				method: "OPTIONS",
				headers: {
					Origin: uiOrigin,
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "content-type",
				},
			});
			expect(recoveredPreflight.status).toBe(204);
			expect(recoveredPreflight.headers.get("access-control-allow-origin")).toBe(uiOrigin);

			const mutationTrafficStart = traffic.requests.length;
			const mutationPromise = page.waitForResponse(response => {
				const url = new URL(response.url());
				return response.request().method() === "POST"
					&& url.origin === gatewayOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/setup-status/dismiss`;
			}, { timeout: 15_000 });
			const mutationResult = await page.evaluate(async (base) => {
				const response = await fetch(`${base}/api/setup-status/dismiss`, {
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				});
				return { status: response.status, body: await response.text() };
			}, explicitBase);
			const mutation = await mutationPromise;
			expect(mutationResult.status, mutationResult.body).toBe(200);
			expect(await mutation.request().headerValue("authorization")).toBeNull();
			expect(await mutation.headerValue("access-control-allow-origin")).toBe(uiOrigin);
			const mutationTraffic = traffic.requests.slice(mutationTrafficStart).filter(record => {
				const url = new URL(record.url);
				return url.origin === gatewayOrigin && url.pathname === `${GATEWAY_PATH}/api/setup-status/dismiss`;
			});
			expect(mutationTraffic.some(record => record.method === "POST" && !record.authorization)).toBe(true);

			const uiPort = Number(new URL(uiOrigin).port);
			const siblingPort = [uiPort + 1, uiPort + 2, uiPort - 1]
				.find(port => port > 0 && port < 65_536 && port !== gateway.port)!;
			const siblingOrigin = `http://localhost:${siblingPort}`;
			const deniedPreflight = await fetch(`${explicitBase}/api/setup-status/dismiss`, {
				method: "OPTIONS",
				headers: {
					Origin: siblingOrigin,
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "content-type",
				},
			});
			expect(deniedPreflight.status).toBe(204);
			expect(deniedPreflight.headers.get("access-control-allow-origin")).toBeNull();
			const deniedRead = await fetch(`${explicitBase}/api/health`, {
				headers: {
					Cookie: `bobbit_session=${mountedCookie!.value}`,
					Origin: siblingOrigin,
				},
			});
			expect(deniedRead.status).toBe(401);
			expect(deniedRead.headers.get("access-control-allow-origin")).toBeNull();
		} finally {
			traffic.dispose();
			await context.clearCookies().catch(() => undefined);
		}
	});

	test("keeps bearer REST and WebSockets on a different-host prefix but blocks cookie-only preview transports with guidance", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const incompatibleBase = gatewayAlias(gateway, "127.0.0.1");
		const gatewayOrigin = new URL(incompatibleBase).origin;
		const uiOrigin = new URL(gateway.uiBaseURL).origin;
		expect(new URL(incompatibleBase).hostname).not.toBe(new URL(uiOrigin).hostname);
		const traffic = collectPageTraffic(page);
		await installBrowserTransportProbe(page, incompatibleBase, gatewayToken());

		let sessionId: string | undefined;
		try {
			const healthPromise: Promise<PlaywrightResponse> = page.waitForResponse(response => {
				const url = new URL(response.url());
				return response.request().method() === "GET"
					&& url.origin === gatewayOrigin
					&& url.pathname === `${GATEWAY_PATH}/api/health`;
			}, { timeout: 25_000 });
			await page.goto(`${uiOrigin}/`, { waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 25_000 });
			const health = await healthPromise;
			expect(health.status()).toBe(200);
			expect(await health.headerValue("access-control-allow-origin")).toBe(uiOrigin);
			expect(await health.request().headerValue("authorization")).toBe(`Bearer ${gatewayToken()}`);
			await waitForViewerSocket(traffic.sockets, incompatibleBase);

			const restProbe = await transportProbe(page);
			expect(restProbe.fetches.some(entry => {
				try {
					const url = new URL(entry.url, uiOrigin);
					return url.origin === gatewayOrigin && url.pathname.startsWith(`${GATEWAY_PATH}/api/`) && entry.credentials === "include";
				} catch { return false; }
			}), "different-host bearer REST should remain usable at the explicit mount").toBe(true);

			sessionId = await createHarnessSession(gateway, "different-host");
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await waitForSessionSocket(traffic.sockets, incompatibleBase, sessionId);

			const enabled = await adminRequest(gateway, `/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ preview: true }),
			});
			expect(enabled.response.status, enabled.text).toBe(200);
			const mounted = await adminRequest(gateway, `/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ entry: ENTRY, html: `<!doctype html><body>${PREVIEW_TEXT}</body>` }),
			});
			expect(mounted.response.status, mounted.text).toBe(200);
			expect(mounted.body?.url).toBe(`/preview/${sessionId}/${ENTRY}`);

			await expect(page.locator("body")).toContainText(
				"Preview live updates and embedded previews require the Bobbit UI and gateway to use the same HTTPS hostname (loopback HTTP is also supported). Serve the UI from the gateway origin or through a same-host reverse proxy.",
				{ timeout: 20_000 },
			);
			const disabledPopout = page.getByTestId("preview-popout-disabled").first();
			await expect(disabledPopout).toBeVisible({ timeout: 15_000 });
			await expect(disabledPopout).toBeDisabled();
			await expect(disabledPopout).not.toHaveClass(/hover:text-foreground/);
			await expect(disabledPopout).toHaveCSS("cursor", "not-allowed");
			await expect(disabledPopout).toHaveCSS("opacity", "0.5");
			const probe = await transportProbe(page);
			expect(probe.eventSources.some(source => {
				const url = new URL(source.url, uiOrigin);
				return url.origin === gatewayOrigin && url.pathname.includes("/preview-events");
			}), "different-host preview must be blocked before native EventSource starts").toBe(false);
			expect(traffic.requests.some(record => {
				const url = new URL(record.url);
				return url.origin === gatewayOrigin && record.resourceType === "document" && url.pathname.startsWith(`${GATEWAY_PATH}/preview/`);
			}), "different-host preview must be blocked before iframe/popout navigation").toBe(false);
			expect(gatewayRouteRequestsAtUiOrigin(traffic.requests, uiOrigin), "blocked native preview must not fall back to the UI origin").toEqual([]);
			for (const socket of traffic.sockets) expectGatewayPathOnce(socket.url, incompatibleBase, "/ws");
		} finally {
			traffic.dispose();
			if (sessionId) await deleteHarnessSession(gateway, sessionId);
			await page.context().clearCookies().catch(() => undefined);
		}
	});
});
