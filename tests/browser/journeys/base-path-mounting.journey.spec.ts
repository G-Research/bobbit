import type { Page, Request as PlaywrightRequest, Response as PlaywrightResponse, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import QRCode from "qrcode";
import { test, expect } from "../../support/helpers/browser/journeys/journey-fixture.js";
import type { GatewayInfo } from "../../support/harnesses/browser/gateway-harness.js";

const BASE_PATH = "/team/bobbit";
const ENTRY = "mounted-preview.html";
const PREVIEW_TEXT = "MOUNTED_BASE_PATH_PREVIEW_OK";
const SIBLING_MARKER = "MOUNTED_SIBLING_ASSET_OK";

test.use({ basePath: BASE_PATH });

interface RequestRecord {
	url: string;
	method: string;
	resourceType: string;
	authorization?: string;
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

async function createHarnessSession(gateway: GatewayInfo): Promise<string> {
	const projects = await adminRequest(gateway, "/api/projects");
	expect(projects.response.status, projects.text).toBe(200);
	const rows = Array.isArray(projects.body) ? projects.body : projects.body?.projects;
	const project = rows?.find((row: any) => row?.name === "default" && row?.id);
	expect(project?.id, `default project missing from ${projects.text}`).toBeTruthy();
	const cwd = join(
		dirname(gateway.bobbitDir),
		`${basename(gateway.bobbitDir)}-default-project`,
		".base-path-session",
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
	}, { timeout: 30_000, message: "mounted session should become idle" }).toBe("idle");
	return created.body.id;
}

async function deleteHarnessSession(gateway: GatewayInfo, sessionId: string): Promise<void> {
	await adminRequest(gateway, `/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
}

function recordSocket(sockets: SocketRecord[], socket: PlaywrightWebSocket): void {
	const record: SocketRecord = { url: socket.url(), sent: 0, received: 0 };
	sockets.push(record);
	socket.on("framesent", () => record.sent++);
	socket.on("framereceived", () => record.received++);
}

async function installBrowserTransportProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const probe: BrowserTransportProbe = {
			fetches: [],
			eventSources: [],
			previewEvents: [],
		};
		(window as any).__basePathTransportProbe = probe;

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
	});
}

async function transportProbe(page: Page): Promise<BrowserTransportProbe> {
	return page.evaluate(() => (window as any).__basePathTransportProbe);
}

function expectExactlyOneMount(url: string, gateway: GatewayInfo, routePrefix: string): void {
	const parsed = new URL(url, gateway.originURL);
	const expectedPrefix = `${BASE_PATH}${routePrefix}`;
	if (routePrefix === "/") expect(parsed.pathname, url).toMatch(new RegExp(`^${BASE_PATH.replace(/\//g, "\\/")}/`));
	else expect(parsed.pathname === expectedPrefix || parsed.pathname.startsWith(`${expectedPrefix}/`), url).toBe(true);
	expect(parsed.pathname, `${url} must not contain a doubled deployment prefix`).not.toContain(`${BASE_PATH}${BASE_PATH}`);
}

async function expectQrImageEncodes(page: Page, selector: string, value: string): Promise<void> {
	const actual = await page.locator(selector).getAttribute("src");
	expect(actual, `${selector} should contain a generated QR image`).toMatch(/^data:image\/png;base64,/);
	const expected = await QRCode.toDataURL(value, {
		width: 280,
		margin: 2,
		color: { dark: "#000000", light: "#ffffff" },
	});
	const pixelsMatch = await page.evaluate(async ({ actualSrc, expectedSrc }) => {
		const load = (src: string) => new Promise<HTMLImageElement>((resolveImage, reject) => {
			const image = new Image();
			image.onload = () => resolveImage(image);
			image.onerror = () => reject(new Error(`failed to decode QR image ${src.slice(0, 32)}`));
			image.src = src;
		});
		const [actualImage, expectedImage] = await Promise.all([load(actualSrc), load(expectedSrc)]);
		if (actualImage.width !== expectedImage.width || actualImage.height !== expectedImage.height) return false;
		const canvas = document.createElement("canvas");
		canvas.width = actualImage.width;
		canvas.height = actualImage.height;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return false;
		context.drawImage(actualImage, 0, 0);
		const actualPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.drawImage(expectedImage, 0, 0);
		const expectedPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
		if (actualPixels.length !== expectedPixels.length) return false;
		for (let index = 0; index < actualPixels.length; index++) {
			if (actualPixels[index] !== expectedPixels[index]) return false;
		}
		return true;
	}, { actualSrc: actual!, expectedSrc: expected });
	expect(pixelsMatch, `${selector} should encode ${value}`).toBe(true);
}

async function clickSessionAction(page: Page, actionId: string): Promise<void> {
	const action = page.locator(`[data-session-action-id="${actionId}"]`).first();
	if (!await action.isVisible({ timeout: 500 }).catch(() => false)) {
		await page.locator('[data-testid="session-actions-trigger"]').first().click();
		await expect(action).toBeVisible({ timeout: 5_000 });
	}
	await action.click();
}

function isMountedApiResponse(
	response: PlaywrightResponse,
	gateway: GatewayInfo,
	path: string,
	status: number,
	authorization: string | undefined,
): boolean {
	const actual = new URL(response.url());
	const expected = new URL(`${gateway.baseURL}${path}`);
	return response.request().method() === "GET"
		&& actual.origin === expected.origin
		&& actual.pathname === expected.pathname
		&& actual.search === expected.search
		&& response.status() === status
		&& response.request().headers().authorization === authorization;
}

async function waitForMountedSessionRoute(page: Page, gateway: GatewayInfo, sessionId: string): Promise<void> {
	await page.waitForFunction((id) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const editor = document.querySelector<HTMLTextAreaElement>("message-editor textarea");
		if (!editor) return false;
		const bounds = editor.getBoundingClientRect();
		return window.location.hash === `#/session/${id}`
			&& state?.selectedSessionId === id
			&& state?.gatewaySessions?.some((session: any) => session?.id === id)
			&& state?.connectingSessionId === null
			&& state?.connectionStatus === "connected"
			&& state?.remoteAgent?.gatewaySessionId === id
			&& editor.isConnected
			&& getComputedStyle(editor).visibility !== "hidden"
			&& bounds.width > 0
			&& bounds.height > 0;
	}, sessionId, { timeout: 20_000 });

	const mounted = await adminRequest(gateway, `/api/sessions/${sessionId}`);
	expect(mounted.response.status, mounted.text).toBe(200);
	expect(mounted.body?.id).toBe(sessionId);
}

function assertBuiltChunksAreRuntimeMounted(): void {
	const assetsDir = join(process.cwd(), "dist", "ui", "assets");
	const chunks = readdirSync(assetsDir).filter(file => file.endsWith(".js"));
	expect(chunks.length, "production build should contain JavaScript chunks").toBeGreaterThan(0);
	const sources = chunks.map(chunk => readFileSync(join(assetsDir, chunk), "utf8"));
	expect(
		sources.some(source => source.includes("__BOBBIT_BASE_PATH__")),
		"emitted JavaScript must resolve assets through the runtime base-path global",
	).toBe(true);
	const offenders = chunks.filter((_chunk, index) => /(?:return\s*|=>)\s*["']\/["']\s*\+/.test(sources[index]));
	expect(offenders, "emitted JS must not contain Vite's root-anchoring asset helper").toEqual([]);
}

test.describe("Journey: production gateway mounted below a nested base path", () => {
	test("keeps shell, API, sockets, lazy chunks, deep links, preview, QR/share, and PWA traffic inside the mount", async ({ page, gateway, request }) => {
		test.setTimeout(150_000);
		expect(gateway.basePath).toBe(BASE_PATH);
		assertBuiltChunksAreRuntimeMounted();

		const requests: RequestRecord[] = [];
		const sockets: SocketRecord[] = [];
		const context = page.context();
		const onRequest = (req: PlaywrightRequest) => requests.push({
			url: req.url(),
			method: req.method(),
			resourceType: req.resourceType(),
			authorization: req.headers().authorization,
		});
		context.on("request", onRequest);
		page.on("websocket", socket => recordSocket(sockets, socket));
		await installBrowserTransportProbe(page);

		let sessionId: string | undefined;
		let popup: Page | undefined;
		const previewFixtureDir = join(gateway.bobbitDir, "base-path-preview-fixture");
		try {
			const token = gatewayToken();
			await page.goto(`${gateway.baseURL}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 25_000 });
			expect(await page.evaluate(() => (window as any).__BOBBIT_BASE_PATH__)).toBe(BASE_PATH);

			await expect.poll(() => sockets.find(socket => new URL(socket.url).pathname === `${BASE_PATH}/ws/viewer`)?.received ?? 0, {
				timeout: 20_000,
				message: "viewer WebSocket should authenticate and receive mounted gateway activity",
			}).toBeGreaterThan(0);

			const shellAssets = requests.filter(record => ["script", "stylesheet", "image", "font"].includes(record.resourceType));
			expect(shellAssets.some(record => record.resourceType === "script"), "mounted shell should load its entry script").toBe(true);
			expect(shellAssets.some(record => record.resourceType === "stylesheet"), "mounted shell should load CSS").toBe(true);
			for (const asset of shellAssets) expectExactlyOneMount(asset.url, gateway, "/");

			const manifestResponse = await request.get(`${gateway.baseURL}/manifest.json`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(manifestResponse.status()).toBe(200);
			const manifest = await manifestResponse.json();
			expect(manifest.start_url).toMatch(new RegExp(`^${BASE_PATH}/`));
			expect(manifest.scope).toBe(`${BASE_PATH}/`);
			for (const icon of manifest.icons ?? []) {
				if (typeof icon?.src === "string" && icon.src.startsWith("/")) expect(icon.src).toMatch(new RegExp(`^${BASE_PATH}/`));
			}

			const barePrefix = await request.get(`${gateway.originURL}${BASE_PATH}?x=1`, { maxRedirects: 0 });
			expect(barePrefix.status()).toBe(301);
			expect(barePrefix.headers().location).toBe(`${BASE_PATH}/?x=1`);
			for (const offMount of ["/", "/api/health", `${BASE_PATH}-other`, "/other/app"]) {
				const response = await request.get(`${gateway.originURL}${offMount}`, { maxRedirects: 0 });
				expect(response.status(), `${offMount} must not be served by mounted Bobbit`).toBe(404);
			}

			sessionId = await createHarnessSession(gateway);
			await page.goto(`${gateway.baseURL}/session/${sessionId}`, { waitUntil: "domcontentloaded" });
			await waitForMountedSessionRoute(page, gateway, sessionId);
			await expect.poll(() => sockets.find(socket => new URL(socket.url).pathname === `${BASE_PATH}/ws/${sessionId}`)?.received ?? 0, {
				timeout: 20_000,
				message: "session WebSocket should authenticate below the mount",
			}).toBeGreaterThan(0);
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForMountedSessionRoute(page, gateway, sessionId);

			const scriptsBeforeLazyNavigation = requests.filter(record => record.resourceType === "script").length;
			await page.evaluate(() => { window.location.hash = "#/market"; });
			await expect(page.getByTestId("market-research-preview-banner")).toBeVisible({ timeout: 25_000 });
			await expect.poll(
				() => requests.filter(record => record.resourceType === "script").length,
				{ timeout: 15_000, message: "marketplace navigation should load a lazy production chunk" },
			).toBeGreaterThan(scriptsBeforeLazyNavigation);
			const marketApi = requests.find(record => new URL(record.url).pathname.startsWith(`${BASE_PATH}/api/marketplace/`));
			expect(marketApi, "lazy API-backed marketplace screen should call the mounted gateway").toBeTruthy();

			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await waitForMountedSessionRoute(page, gateway, sessionId);
			const previewEnabled = await adminRequest(gateway, `/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ preview: true }),
			});
			expect(previewEnabled.response.status, previewEnabled.text).toBe(200);
			await expect.poll(async () => (await transportProbe(page)).eventSources.some(source => {
				const url = new URL(source.url, gateway.originURL);
				return url.pathname === `${BASE_PATH}/api/sessions/${sessionId}/preview-events` && source.withCredentials;
			}), { timeout: 20_000, message: "preview EventSource should connect with credentials below the mount" }).toBe(true);

			mkdirSync(previewFixtureDir, { recursive: true });
			const htmlPath = join(previewFixtureDir, ENTRY);
			writeFileSync(htmlPath, [
				"<!doctype html>",
				"<html><head><link rel=\"stylesheet\" href=\"./sibling.css\"></head>",
				`<body><h1>${PREVIEW_TEXT}</h1><div id=\"sibling\">${SIBLING_MARKER}</div></body></html>`,
			].join(""));
			writeFileSync(join(previewFixtureDir, "sibling.css"), "#sibling { color: rgb(12, 34, 56); }");
			const mounted = await adminRequest(gateway, `/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ file: htmlPath, assets: ["sibling.css"] }),
			});
			expect(mounted.response.status, mounted.text).toBe(200);
			expect(mounted.body?.url).toBe(`/preview/${sessionId}/${ENTRY}`);
			expect(mounted.body?.artifactId).toBeTruthy();

			const snapshot = await adminRequest(gateway, `/api/preview/mount?sessionId=${sessionId}`);
			expect(snapshot.response.status, snapshot.text).toBe(200);
			expect(snapshot.body?.url).toBe(`/preview/${sessionId}/${ENTRY}`);
			await expect.poll(async () => (await transportProbe(page)).previewEvents.some((event: any) => event?.url === `/preview/${sessionId}/${ENTRY}`), {
				timeout: 20_000,
				message: "raw live SSE preview payload should remain mount-relative",
			}).toBe(true);

			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe).toBeVisible({ timeout: 25_000 });
			const iframeSrc = await iframe.getAttribute("src");
			expect(iframeSrc).toBeTruthy();
			expectExactlyOneMount(iframeSrc!, gateway, "/preview");
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("body")).toContainText(PREVIEW_TEXT, { timeout: 20_000 });
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("#sibling")).toHaveCSS("color", "rgb(12, 34, 56)");
			const artifactBasePath = `${BASE_PATH}/preview/${sessionId}/_artifact/${encodeURIComponent(mounted.body.artifactId)}/`;
			const injectedBase = await page.frameLocator(".goal-preview-panel iframe").locator("base[data-bobbit-preview-base]").getAttribute("href");
			expect(injectedBase).toBe(artifactBasePath);
			const siblingRequest = requests.find(record => new URL(record.url).pathname === `${artifactBasePath}sibling.css`);
			expect(siblingRequest, "preview sibling asset should resolve through the injected mounted base").toBeTruthy();

			const newTabLink = page.locator('a[title="Open preview in new tab"]').first();
			await expect(newTabLink).toBeVisible({ timeout: 15_000 });
			const newTabHref = await newTabLink.getAttribute("href");
			expect(newTabHref).toBeTruthy();
			expectExactlyOneMount(newTabHref!, gateway, "/preview");
			const popupPromise = page.waitForEvent("popup");
			await newTabLink.click();
			popup = await popupPromise;
			await popup.waitForLoadState("domcontentloaded");
			expectExactlyOneMount(popup.url(), gateway, "/preview");
			await expect(popup.locator("body")).toContainText(PREVIEW_TEXT, { timeout: 15_000 });
			await popup.close();
			popup = undefined;

			// A stored explicit URL that already includes the runtime mount remains
			// authoritative. The localhost sentinel must never become an HTTP Bearer.
			await page.evaluate(({ baseURL }) => {
				localStorage.setItem("gateway.url", baseURL);
				localStorage.setItem("gateway.token", "localhost");
			}, { baseURL: gateway.baseURL });
			const sentinelRequestStart = requests.length;
			const sentinelHealth = page.waitForResponse((response) => isMountedApiResponse(
				response,
				gateway,
				"/api/health",
				200,
				undefined,
			), { timeout: 15_000 });
			await page.reload({ waitUntil: "domcontentloaded" });
			const healthResponse = await sentinelHealth;
			await healthResponse.finished();
			await page.waitForFunction(() => {
				const state = (window as any).bobbitState ?? (window as any).__bobbitState;
				return state?.appView === "authenticated";
			}, undefined, { timeout: 20_000 });
			const sentinelApiRequests = requests.slice(sentinelRequestStart).filter(record => new URL(record.url).pathname.startsWith(`${BASE_PATH}/api/`));
			expect(sentinelApiRequests.length, "cookie-authenticated sentinel reload should reach the mounted API").toBeGreaterThan(0);
			expect(sentinelApiRequests.some(record => record.authorization === "Bearer localhost"), "localhost sentinel must never be sent as Bearer").toBe(false);
			expect(sentinelApiRequests.every(record => !new URL(record.url).pathname.includes(`${BASE_PATH}${BASE_PATH}`))).toBe(true);
			// Authentication commits the sentinel only after the health body is consumed.
			// Wait for that authoritative app state before replacing storage, otherwise
			// the late commit can overwrite the real token and leave both mounted sockets
			// retrying invalid authentication until the shared IP limiter returns 429.
			await page.evaluate((realToken) => localStorage.setItem("gateway.token", realToken), token);
			const restoredSession = page.waitForResponse((response) => isMountedApiResponse(
				response,
				gateway,
				`/api/sessions/${sessionId}`,
				200,
				`Bearer ${token}`,
			), { timeout: 20_000 });
			await page.reload({ waitUntil: "domcontentloaded" });
			const restoredResponse = await restoredSession;
			await restoredResponse.finished();
			await waitForMountedSessionRoute(page, gateway, sessionId);

			await page.evaluate(() => {
				(window as any).__copiedBasePathLinks = [];
				Object.defineProperty(navigator, "clipboard", {
					configurable: true,
					value: { writeText: async (value: string) => { (window as any).__copiedBasePathLinks.push(value); } },
				});
			});
			await clickSessionAction(page, "copy-link");
			await expect.poll(() => page.evaluate(() => (window as any).__copiedBasePathLinks?.at(-1) ?? ""), { timeout: 5_000 })
				.toBe(`${gateway.baseURL}/#/session/${sessionId}`);

			await page.evaluate(() => {
				(window as any).__openedBasePathLinks = [];
				window.open = ((url?: string | URL) => {
					(window as any).__openedBasePathLinks.push(String(url ?? ""));
					return null;
				}) as typeof window.open;
			});
			await clickSessionAction(page, "open-new-window");
			await expect.poll(() => page.evaluate(() => (window as any).__openedBasePathLinks?.at(-1) ?? ""), { timeout: 5_000 })
				.toBe(`${gateway.baseURL}/session/${sessionId}`);

			const scriptsBeforeQr = requests.filter(record => record.resourceType === "script").length;
			await page.locator('button[title="Show QR code"]').first().click();
			await expect(page.locator('img[alt="Session QR"]')).toBeVisible({ timeout: 20_000 });
			await expectQrImageEncodes(page, 'img[alt="Session QR"]', `${gateway.baseURL}/?token=${encodeURIComponent(token)}`);
			await page.getByRole("button", { name: /First time on this device.*iPhone/i }).click();
			await expect(page.locator('img[alt="CA Certificate QR"]')).toBeVisible({ timeout: 10_000 });
			await expectQrImageEncodes(page, 'img[alt="CA Certificate QR"]', `${gateway.baseURL}/api/ca-cert`);
			await expect.poll(() => requests.filter(record => record.resourceType === "script").length, { timeout: 15_000 })
				.toBeGreaterThan(scriptsBeforeQr);

			const gatewayRequests = requests.filter(record => {
				try { return new URL(record.url).origin === gateway.originURL; } catch { return false; }
			});
			const escaped = gatewayRequests.filter(record => {
				const pathname = new URL(record.url).pathname;
				return pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`);
			});
			expect(escaped, "no production browser request may escape to the shared origin root").toEqual([]);
			for (const socket of sockets) expectExactlyOneMount(socket.url, gateway, "/ws");
		} finally {
			context.off("request", onRequest);
			if (popup && !popup.isClosed()) await popup.close().catch(() => undefined);
			if (sessionId) await deleteHarnessSession(gateway, sessionId);
			rmSync(previewFixtureDir, { recursive: true, force: true });
			await context.clearCookies().catch(() => undefined);
		}
	});
});
