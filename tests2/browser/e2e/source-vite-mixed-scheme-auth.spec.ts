import { expect, test, type Browser, type BrowserContext, type Page, type Response, type TestInfo } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createProjectAndSession,
	getFreePort,
	readToken,
} from "./packaged-runtime-helpers.js";
import {
	processFailure,
	startIsolatedSourceGateway,
	startSourceVite,
	stopSourceProcess,
	waitForSourceGateway,
	waitForSourceVite,
	writeSourceTlsFixture,
	writeSourceViteAgent,
	type RunningSourceProcess,
	type SourceGatewayOptions,
} from "./source-vite-runtime-helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const MOUNT = "/team/bobbit";
const COOKIE_NAME = "bobbit_session";
const ENTRY = "mixed-scheme-cookie.html";
const PREVIEW_TEXT = "MIXED_SCHEME_COOKIE_PREVIEW_OK";

interface BrowserProbe {
	storageWrites: Array<{ key: string; value: string }>;
	tokenWrites: string[];
	eventSources: Array<{ url: string; withCredentials: boolean }>;
	sentinelProbe?: Promise<{ status: number; text: string; storedBefore: string | null }>;
}

interface SocketRecord {
	url: string;
	sent: string[];
	received: string[];
}

interface AdminResult {
	status: number;
	text: string;
	body?: any;
}

async function adminRequest(
	baseUrl: string,
	token: string,
	route: string,
	init: { method?: string; body?: unknown } = {},
): Promise<AdminResult> {
	const response = await fetch(`${baseUrl}${route}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	});
	const text = await response.text();
	let body: unknown;
	try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
	return { status: response.status, text, body };
}

async function expectAdminOk(result: AdminResult, status = 200): Promise<any> {
	expect(result.status, result.text).toBe(status);
	return result.body;
}

async function createPreviewSession(baseUrl: string, token: string, workspaceDir: string): Promise<string> {
	await expectAdminOk(await adminRequest(baseUrl, token, "/api/preferences", {
		method: "PUT",
		body: {
			customProviders: [{
				id: "mock",
				name: "mock",
				type: "manual",
				baseUrl: "http://127.0.0.1",
				models: [{ id: "source-vite-write-agent", name: "source-vite-write-agent" }],
			}],
		},
	}));
	await expectAdminOk(await adminRequest(baseUrl, token, "/api/preferences", {
		method: "PUT",
		body: {
			"default.sessionModel": "mock/source-vite-write-agent",
			"default.sessionThinkingLevel": "off",
		},
	}));
	const sessionId = await createProjectAndSession(baseUrl, token, workspaceDir);
	await expect.poll(async () => {
		const current = await adminRequest(baseUrl, token, `/api/sessions/${sessionId}`);
		return current.body?.status;
	}, { message: "mixed-scheme source-Vite session should become idle" }).toBe("idle");
	await expectAdminOk(await adminRequest(baseUrl, token, `/api/sessions/${sessionId}`, {
		method: "PATCH",
		body: { preview: true },
	}));
	const previewPath = `/preview/${sessionId}/${ENTRY}`;
	const mounted = await expectAdminOk(await adminRequest(baseUrl, token, `/api/preview/mount?sessionId=${sessionId}`, {
		method: "POST",
		body: {
			entry: ENTRY,
			html: `<!doctype html><html><body><h1>${PREVIEW_TEXT}</h1></body></html>`,
		},
	}));
	expect(mounted?.url).toBe(previewPath);
	return sessionId;
}

/** Add the real CLI --auth flag without expanding the shared source-runtime helper API. */
async function startForcedAuthGateway(options: SourceGatewayOptions): Promise<RunningSourceProcess> {
	const hookPath = join(options.tempRoot, "force-source-gateway-auth.cjs");
	await writeFile(hookPath, `if (/[\\\\/]dist[\\\\/]server[\\\\/]cli\\.js$/i.test(process.argv[1] || "")) process.argv.push("--auth");\n`, "utf8");
	const previous = process.env.NODE_OPTIONS;
	const portableHookPath = hookPath.replace(/\\/g, "/");
	process.env.NODE_OPTIONS = `${previous ? `${previous} ` : ""}--require ${JSON.stringify(portableHookPath)}`;
	try {
		return startIsolatedSourceGateway(options);
	} finally {
		if (previous === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = previous;
	}
}

async function installBrowserProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		if (window.top !== window) return;
		const probe: BrowserProbe = { storageWrites: [], tokenWrites: [], eventSources: [] };
		(window as any).__mixedSchemeAuthProbe = probe;

		const nativeSetItem = Storage.prototype.setItem;
		Storage.prototype.setItem = function setItem(key: string, value: string): void {
			if (this === window.localStorage) {
				probe.storageWrites.push({ key, value });
			}
			if (this === window.localStorage && key === "gateway.token") {
				probe.tokenWrites.push(value);
				if (value === "localhost" && !probe.sentinelProbe) {
					const storedBefore = window.localStorage.getItem(key);
					// fetch() starts the cookie-only request synchronously before the
					// original setter can publish the sentinel.
					probe.sentinelProbe = fetch("/api/health?sentinel-cookie-probe=1", {
						credentials: "include",
					}).then(async response => ({
						status: response.status,
						text: await response.text(),
						storedBefore,
					}));
				}
			}
			return nativeSetItem.call(this, key, value);
		};

		const NativeEventSource = window.EventSource;
		class RecordingEventSource extends NativeEventSource {
			constructor(url: string | URL, init?: EventSourceInit) {
				super(url, init);
				probe.eventSources.push({ url: String(url), withCredentials: init?.withCredentials === true });
			}
		}
		Object.defineProperty(window, "EventSource", { configurable: true, value: RecordingEventSource });
	});
}

function responseAt(response: Response, origin: string, pathname: string, search = ""): boolean {
	const url = new URL(response.url());
	return url.origin === origin && url.pathname === pathname && url.search === search;
}

async function probeState(page: Page): Promise<Pick<BrowserProbe, "storageWrites" | "tokenWrites" | "eventSources">> {
	return page.evaluate(() => {
		const probe = (window as any).__mixedSchemeAuthProbe as BrowserProbe;
		return {
			storageWrites: probe.storageWrites.map(entry => ({ ...entry })),
			tokenWrites: [...probe.tokenWrites],
			eventSources: [...probe.eventSources],
		};
	});
}

async function cookieOnlyViewerSocket(page: Page): Promise<{ type?: string }> {
	return page.evaluate(() => new Promise((resolveSocket, rejectSocket) => {
		const timeout = window.setTimeout(() => {
			ws.close();
			rejectSocket(new Error("cookie-only viewer WebSocket timed out"));
		}, 10_000);
		const url = new URL("/ws/viewer", window.location.origin);
		url.protocol = "wss:";
		const ws = new WebSocket(url);
		ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", token: "localhost" })));
		ws.addEventListener("message", event => {
			let message: { type?: string };
			try { message = JSON.parse(String(event.data)); } catch { return; }
			if (message.type !== "auth_ok" && message.type !== "auth_failed") return;
			window.clearTimeout(timeout);
			ws.close();
			resolveSocket(message);
		});
		ws.addEventListener("error", () => {
			window.clearTimeout(timeout);
			rejectSocket(new Error("cookie-only viewer WebSocket failed"));
		});
	}));
}

function processLog(runtime: RunningSourceProcess | undefined): { stdout?: string; stderr?: string } {
	if (!runtime) return {};
	return {
		stdout: runtime.stdout.join("").slice(-20_000),
		stderr: runtime.stderr.join("").slice(-20_000),
	};
}

async function attachLogs(
	testInfo: TestInfo,
	gateway: RunningSourceProcess | undefined,
	vite: RunningSourceProcess | undefined,
): Promise<void> {
	await testInfo.attach("source-vite-mixed-scheme-auth-processes.json", {
		body: Buffer.from(`${JSON.stringify({ gateway: processLog(gateway), vite: processLog(vite) }, null, 2)}\n`),
		contentType: "application/json",
	});
}

async function proveUnavailableCookieRetainsBearer(
	browser: Browser,
	viteBaseUrl: string,
	token: string,
): Promise<void> {
	let context: BrowserContext | undefined;
	try {
		context = await browser.newContext({ ignoreHTTPSErrors: true });
		await context.route(`${viteBaseUrl}/api/health*`, async route => {
			const response = await route.fetch();
			const headers = { ...response.headers() };
			delete headers["set-cookie"];
			await route.fulfill({ response, headers });
		});
		const page = await context.newPage();
		await page.goto(`${viteBaseUrl}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 30_000 });
		await expect.poll(
			() => page.evaluate(() => localStorage.getItem("gateway.token")),
			{
				timeout: 20_000,
				message: "a blocked cookie confirmation must retain the real bearer for reload",
			},
		).toBe(token);
	} finally {
		await context?.close().catch(() => undefined);
	}
}

test.use({ ignoreHTTPSErrors: true });

test.describe("HTTPS source Vite to mounted HTTP gateway authentication", () => {
	test.describe.configure({ retries: 0 });

	test("confirms a cookie before persisting the sentinel, then keeps REST, WS, SSE, iframe, and popout cookie-only across reload", async ({ browser, page }, testInfo) => {
		test.setTimeout(4 * 60_000);
		const tempRoot = await mkdtemp(join(tmpdir(), "bobbit-source-vite-mixed-scheme-auth-"));
		const workspaceDir = join(tempRoot, "workspace");
		const agentPath = join(tempRoot, "source-vite-write-agent.mjs");
		let gateway: RunningSourceProcess | undefined;
		let vite: RunningSourceProcess | undefined;
		let popup: Page | undefined;

		try {
			await mkdir(workspaceDir, { recursive: true });
			await writeSourceViteAgent(agentPath);
			await writeSourceTlsFixture(tempRoot, ["127.0.0.1", "localhost"]);

			const gatewayPort = await getFreePort();
			const vitePort = await getFreePort();
			const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
			const gatewayBaseUrl = `${gatewayOrigin}${MOUNT}`;
			const viteBaseUrl = `https://127.0.0.1:${vitePort}`;
			const viteOrigin = new URL(viteBaseUrl).origin;

			gateway = await startForcedAuthGateway({
				repoRoot: REPO_ROOT,
				tempRoot,
				workspaceDir,
				agentPath,
				port: gatewayPort,
				host: "127.0.0.1",
				tls: false,
				viteDevProxy: true,
				basePath: MOUNT,
			});
			await waitForSourceGateway(gatewayBaseUrl, gateway, 120_000, [401]);
			const token = await readToken(join(tempRoot, "secrets"));
			await expect.poll(() => gateway!.stdout.join(""), {
				message: "loopback gateway must actually run with --auth",
			}).toContain(`Auth token: ${token}`);
			expect((await fetch(`${gatewayOrigin}/api/health`)).status, "off-mount API must not reach Bobbit").toBe(404);
			expect((await fetch(`${gatewayOrigin}${MOUNT}-other/api/health`)).status, "sibling mount must not reach Bobbit").toBe(404);
			expect((await fetch(`${gatewayBaseUrl}/api/health`)).status, "mounted loopback gateway must enforce auth").toBe(401);

			vite = startSourceVite({
				repoRoot: REPO_ROOT,
				tempRoot,
				gatewayUrl: gatewayBaseUrl,
				port: vitePort,
				publicHost: "127.0.0.1",
			});
			await waitForSourceVite(viteBaseUrl, vite);

			const sockets: SocketRecord[] = [];
			page.on("websocket", socket => {
				const record: SocketRecord = { url: socket.url(), sent: [], received: [] };
				sockets.push(record);
				socket.on("framesent", event => record.sent.push(String(event.payload)));
				socket.on("framereceived", event => record.received.push(String(event.payload)));
			});
			await installBrowserProbe(page);

			const bootstrapHealthPromise = page.waitForResponse(response =>
				responseAt(response, viteOrigin, "/api/health"));
			const sentinelProbeResponsePromise = page.waitForResponse(response =>
				responseAt(response, viteOrigin, "/api/health", "?sentinel-cookie-probe=1"));
			await page.goto(`${viteBaseUrl}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 30_000 });

			const bootstrapHealth = await bootstrapHealthPromise;
			expect(bootstrapHealth.status()).toBe(200);
			expect(await bootstrapHealth.request().headerValue("authorization")).toBe(`Bearer ${token}`);
			const bootstrapSetCookie = await bootstrapHealth.headerValue("set-cookie");
			expect(bootstrapSetCookie ?? "",
				"MIXED_SCHEME_VITE_COOKIE_NOT_ESTABLISHED_BEFORE_SENTINEL").toMatch(/^bobbit_session=v1\.2\./);
			const sentinelProbeResponse = await sentinelProbeResponsePromise;
			expect(sentinelProbeResponse.status(), "cookie-only request started before the sentinel write must succeed").toBe(200);
			expect(await sentinelProbeResponse.request().headerValue("authorization")).toBeNull();
			expect(await sentinelProbeResponse.request().headerValue("cookie")).toContain(`${COOKIE_NAME}=`);
			const sentinelProbe = await page.evaluate(() => (window as any).__mixedSchemeAuthProbe.sentinelProbe);
			expect(sentinelProbe).toMatchObject({ status: 200, storedBefore: null });

			await expect.poll(() => page.evaluate(() => localStorage.getItem("gateway.token")), {
				message: "successful cookie confirmation must persist only the sentinel",
			}).toBe("localhost");
			const bootstrapProbe = await probeState(page);
			expect(bootstrapProbe.tokenWrites.length).toBeGreaterThan(0);
			expect(bootstrapProbe.tokenWrites).not.toContain(token);
			expect(bootstrapProbe.tokenWrites.every(value => value === "localhost")).toBe(true);
			expect(bootstrapProbe.storageWrites.some(entry => entry.value.includes(token)),
				"successful bootstrap must never serialize the real bearer under any storage key").toBe(false);
			expect(await page.evaluate(secret => JSON.stringify({ ...localStorage }).includes(secret), token)).toBe(false);
			expect(await page.evaluate(() => localStorage.getItem("gateway.url"))).toBe(viteBaseUrl);
			const cookie = (await page.context().cookies(viteBaseUrl)).find(entry => entry.name === COOKIE_NAME);
			expect(cookie).toEqual(expect.objectContaining({
				value: expect.stringMatching(/^v1\.2\./),
				domain: "127.0.0.1",
				path: "/",
				httpOnly: true,
			}));

			const sessionId = await createPreviewSession(gatewayBaseUrl, token, workspaceDir);
			const previewPath = `/preview/${sessionId}/${ENTRY}`;
			const ssePath = `/api/sessions/${sessionId}/preview-events`;
			const restResponsePromise = page.waitForResponse(response =>
				responseAt(response, viteOrigin, "/api/projects", "?cookie-only-probe=1"));
			const restResult = await page.evaluate(async () => {
				const response = await fetch("/api/projects?cookie-only-probe=1", { credentials: "include" });
				return { status: response.status, text: await response.text() };
			});
			const restResponse = await restResponsePromise;
			expect(restResult.status, restResult.text).toBe(200);
			expect(await restResponse.request().headerValue("authorization")).toBeNull();
			expect(await restResponse.request().headerValue("cookie")).toContain(`${COOKIE_NAME}=`);
			expect(await cookieOnlyViewerSocket(page)).toEqual({ type: "auth_ok" });

			await page.evaluate(id => history.replaceState({}, "", `/#/session/${id}`), sessionId);
			const socketStart = sockets.length;
			const reloadHealthPromise = page.waitForResponse(response =>
				responseAt(response, viteOrigin, "/api/health"));
			const sseResponsePromise = page.waitForResponse(response =>
				responseAt(response, viteOrigin, ssePath));
			const iframeResponsePromise = page.waitForResponse(response =>
				responseAt(response, viteOrigin, previewPath)
					&& response.request().resourceType() === "document");
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 30_000 });

			const reloadHealth = await reloadHealthPromise;
			expect(reloadHealth.status()).toBe(200);
			expect(await reloadHealth.request().headerValue("authorization"), "reload REST must be cookie-only").toBeNull();
			expect(await reloadHealth.request().headerValue("cookie")).toContain(`${COOKIE_NAME}=`);
			expect(await page.evaluate(() => localStorage.getItem("gateway.token"))).toBe("localhost");
			expect(await page.evaluate(() => localStorage.getItem("gateway.token"))).not.toBe(token);

			await expect.poll(() => sockets.slice(socketStart).filter(record => {
				const path = new URL(record.url).pathname;
				return (path === "/ws/viewer" || path === `/ws/${sessionId}`)
					&& record.received.some(frame => frame.includes('"type":"auth_ok"'));
			}).map(record => new URL(record.url).pathname), {
				timeout: 20_000,
				message: "viewer and session WebSockets must authenticate through the proxied cookie",
			}).toEqual(expect.arrayContaining(["/ws/viewer", `/ws/${sessionId}`]));
			for (const socket of sockets.slice(socketStart)) {
				const url = new URL(socket.url);
				if (url.pathname !== "/ws/viewer" && url.pathname !== `/ws/${sessionId}`) continue;
				expect(url.protocol).toBe("wss:");
				expect(url.origin).toBe(viteOrigin.replace(/^https:/, "wss:"));
				expect(url.searchParams.has("token")).toBe(false);
				expect(socket.sent.join("\n")).not.toContain(token);
			}

			const sseResponse = await sseResponsePromise;
			expect(sseResponse.status()).toBe(200);
			expect(await sseResponse.request().headerValue("authorization")).toBeNull();
			expect(await sseResponse.request().headerValue("cookie")).toContain(`${COOKIE_NAME}=`);
			await expect.poll(() => probeState(page), {
				message: "reload must create the preview EventSource with credentials at Vite's root route",
			}).toMatchObject({
				eventSources: expect.arrayContaining([{
					url: `${viteBaseUrl}${ssePath}`,
					withCredentials: true,
				}]),
			});

			const iframeResponse = await iframeResponsePromise;
			expect(iframeResponse.status()).toBe(200);
			expect(await iframeResponse.request().headerValue("authorization")).toBeNull();
			expect(await iframeResponse.request().headerValue("cookie")).toContain(`${COOKIE_NAME}=`);
			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe).toBeVisible();
			const iframeUrl = new URL((await iframe.getAttribute("src"))!, viteBaseUrl);
			expect(iframeUrl.origin).toBe(viteOrigin);
			expect(iframeUrl.pathname).toBe(previewPath);
			expect(iframeUrl.pathname).not.toContain(MOUNT);
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("body")).toContainText(PREVIEW_TEXT);

			const popoutLink = page.locator('a[title="Open preview in new tab"]').first();
			await expect(popoutLink).toBeVisible();
			const popoutHref = new URL((await popoutLink.getAttribute("href"))!, viteBaseUrl);
			expect(popoutHref.origin).toBe(viteOrigin);
			expect(popoutHref.pathname).toBe(previewPath);
			const popupPromise = page.waitForEvent("popup");
			await popoutLink.click();
			popup = await popupPromise;
			await expect(popup.locator("body")).toContainText(PREVIEW_TEXT);
			const popupReload = await popup.reload({ waitUntil: "domcontentloaded" });
			expect(popupReload?.status()).toBe(200);
			expect(await popupReload!.request().headerValue("authorization")).toBeNull();
			expect(await popupReload!.request().headerValue("cookie")).toContain(`${COOKIE_NAME}=`);
			expect(new URL(popupReload!.url()).pathname).toBe(previewPath);
			await popup.close();
			popup = undefined;

			const browserGatewayRoutes = await page.evaluate(() => performance.getEntriesByType("resource")
				.map(entry => new URL(entry.name))
				.filter(url => url.origin === location.origin && /^(?:\/api\/|\/preview\/)/.test(url.pathname))
				.map(url => url.pathname));
			expect(browserGatewayRoutes.length).toBeGreaterThan(0);
			expect(browserGatewayRoutes.every(path => !path.includes(MOUNT))).toBe(true);

			await proveUnavailableCookieRetainsBearer(browser, viteBaseUrl, token);
		} catch (error) {
			if (gateway && gateway.child.exitCode !== null) throw processFailure(gateway, `failed during test: ${String(error)}`);
			if (vite && vite.child.exitCode !== null) throw processFailure(vite, `failed during test: ${String(error)}`);
			throw error;
		} finally {
			if (popup && !popup.isClosed()) await popup.close().catch(() => undefined);
			if (vite) await stopSourceProcess(vite);
			if (gateway) await stopSourceProcess(gateway);
			await attachLogs(testInfo, gateway, vite);
			await rm(tempRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
		}
	});
});
