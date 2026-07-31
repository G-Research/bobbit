import { expect, test, type Page, type Response, type TestInfo } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getFreePort, readToken } from "./packaged-runtime-helpers.js";
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
} from "./source-vite-runtime-helpers.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PUBLIC_HOST = "bobbit.example";
const COOKIE_NAME = "bobbit_session";
const ENTRY = "headless-cookie-preview.html";
const PREVIEW_TEXT = "HEADLESS_COOKIE_NATIVE_TRANSPORT_OK";
const SIGNED_COOKIE = /^v1\.2\.\d+\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

interface BrowserRequestResult {
	status: number;
	text: string;
	body?: any;
}

interface EventSourceRecord {
	url: string;
	withCredentials: boolean;
}

async function browserAdminRequest(
	page: Page,
	gatewayBaseUrl: string,
	token: string,
	route: string,
	init: { method?: string; body?: unknown } = {},
): Promise<BrowserRequestResult> {
	return page.evaluate(async ({ baseUrl, authToken, requestRoute, requestInit }) => {
		const headers = new Headers({ Authorization: `Bearer ${authToken}` });
		let body: string | undefined;
		if (requestInit.body !== undefined) {
			headers.set("Content-Type", "application/json");
			body = JSON.stringify(requestInit.body);
		}
		const response = await fetch(`${baseUrl}${requestRoute}`, {
			method: requestInit.method ?? "GET",
			headers,
			body,
			credentials: "include",
		});
		const text = await response.text();
		let parsed: unknown;
		try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
		return { status: response.status, text, body: parsed };
	}, {
		baseUrl: gatewayBaseUrl,
		authToken: token,
		requestRoute: route,
		requestInit: init,
	});
}

async function serverAdminRequest(
	page: Page,
	gatewayConnectUrl: string,
	token: string,
	route: string,
	init: { method?: string; body?: unknown } = {},
): Promise<BrowserRequestResult> {
	const response = await page.context().request.fetch(`${gatewayConnectUrl}${route}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(init.body === undefined ? {} : { data: init.body }),
	});
	const text = await response.text();
	let body: unknown;
	try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
	return { status: response.status(), text, body };
}

async function expectAdminOk(result: BrowserRequestResult, status = 200): Promise<any> {
	expect(result.status, result.text).toBe(status);
	return result.body;
}

async function createSession(page: Page, gatewayBaseUrl: string, token: string, workspaceDir: string): Promise<string> {
	await expectAdminOk(await browserAdminRequest(page, gatewayBaseUrl, token, "/api/preferences", {
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
	await expectAdminOk(await browserAdminRequest(page, gatewayBaseUrl, token, "/api/preferences", {
		method: "PUT",
		body: {
			"default.sessionModel": "mock/source-vite-write-agent",
			"default.sessionThinkingLevel": "off",
		},
	}));
	const project = await expectAdminOk(await browserAdminRequest(page, gatewayBaseUrl, token, "/api/projects", {
		method: "POST",
		body: {
			name: `headless-cookie-${process.pid}`,
			rootPath: workspaceDir,
			upsert: true,
			acceptCanonical: true,
		},
	}), 201);
	expect(project?.id).toMatch(/^[a-f0-9-]{36}$/);
	const session = await expectAdminOk(await browserAdminRequest(page, gatewayBaseUrl, token, "/api/sessions", {
		method: "POST",
		body: { projectId: project.id, cwd: workspaceDir },
	}), 201);
	expect(session?.id).toMatch(/^[a-f0-9-]{36}$/);
	await expect.poll(async () => {
		const current = await browserAdminRequest(page, gatewayBaseUrl, token, `/api/sessions/${session.id}`);
		return current.body?.status;
	}, { message: "headless fixture session should become idle" }).toBe("idle");
	return session.id;
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
	await testInfo.attach("source-vite-headless-cookie-processes.json", {
		body: Buffer.from(`${JSON.stringify({ gateway: processLog(gateway), vite: processLog(vite) }, null, 2)}\n`),
		contentType: "application/json",
	});
}

function gatewayResponse(response: Response, gatewayOrigin: string, pathname: string): boolean {
	const url = new URL(response.url());
	return url.origin === gatewayOrigin && url.pathname === pathname;
}

// Real source Vite supplies the UI only; the gateway intentionally has no
// staticDir and does not enable the Vite cookie-policy exception.
test.use({
	ignoreHTTPSErrors: true,
	launchOptions: { args: [`--host-resolver-rules=MAP ${PUBLIC_HOST} 127.0.0.1`] },
});

test.describe("TLS headless gateway browser-cookie transports", () => {
	test.describe.configure({ retries: 0 });

	test("wildcard public-Host gateway bootstraps one Secure cookie then reloads REST, EventSource, iframe, and popout without Bearer", async ({ page }, testInfo) => {
		const tempRoot = await mkdtemp(join(tmpdir(), "bobbit-source-vite-headless-cookie-"));
		const workspaceDir = join(tempRoot, "workspace");
		const agentPath = join(tempRoot, "source-vite-write-agent.mjs");
		let gateway: RunningSourceProcess | undefined;
		let vite: RunningSourceProcess | undefined;

		try {
			await mkdir(workspaceDir, { recursive: true });
			await writeSourceViteAgent(agentPath);
			await writeSourceTlsFixture(tempRoot, [PUBLIC_HOST, "0.0.0.0", "127.0.0.1", "localhost"]);

			const gatewayPort = await getFreePort();
			const vitePort = await getFreePort();
			const gatewayConnectUrl = `https://127.0.0.1:${gatewayPort}`;
			const viteConnectUrl = `https://127.0.0.1:${vitePort}`;
			const gatewayBaseUrl = `https://${PUBLIC_HOST}:${gatewayPort}`;
			const viteBaseUrl = `https://${PUBLIC_HOST}:${vitePort}`;
			const gatewayOrigin = new URL(gatewayBaseUrl).origin;
			const viteOrigin = new URL(viteBaseUrl).origin;
			expect(new URL(gatewayBaseUrl).hostname).toBe(new URL(viteBaseUrl).hostname);
			expect(new URL(gatewayBaseUrl).port).not.toBe(new URL(viteBaseUrl).port);

			gateway = startIsolatedSourceGateway({
				repoRoot: REPO_ROOT,
				tempRoot,
				workspaceDir,
				agentPath,
				port: gatewayPort,
				host: "0.0.0.0",
				tls: true,
				viteDevProxy: false,
			});
			await waitForSourceGateway(gatewayConnectUrl, gateway, 120_000, [401]);
			const token = await readToken(join(tempRoot, "secrets"));
			await expect.poll(() => gateway!.stdout.join(""), {
				message: "headless CLI should report its wildcard TLS bind",
			}).toContain(`https://0.0.0.0:${gatewayPort}`);

			vite = startSourceVite({
				repoRoot: REPO_ROOT,
				tempRoot,
				gatewayUrl: gatewayConnectUrl,
				port: vitePort,
				publicHost: PUBLIC_HOST,
			});
			await waitForSourceVite(viteConnectUrl, vite);

			const context = page.context();
			await page.addInitScript(({ baseUrl, authToken, marker }) => {
				if (window.top !== window) return;
				if (sessionStorage.getItem(marker) !== "1") {
					localStorage.setItem("gateway.url", baseUrl);
					localStorage.setItem("gateway.token", authToken);
					sessionStorage.setItem(marker, "1");
				}
				const records: EventSourceRecord[] = [];
				(window as any).__headlessCookieEventSources = records;
				const NativeEventSource = window.EventSource;
				class RecordingEventSource extends NativeEventSource {
					constructor(url: string | URL, init?: EventSourceInit) {
						super(url, init);
						records.push({ url: String(url), withCredentials: init?.withCredentials === true });
					}
				}
				Object.defineProperty(window, "EventSource", { configurable: true, value: RecordingEventSource });
			}, { baseUrl: gatewayBaseUrl, authToken: token, marker: "headless-cookie-bootstrap" });

			const bootstrapHealthPromise = page.waitForResponse(response =>
				gatewayResponse(response, gatewayOrigin, "/api/health"));
			await page.goto(viteBaseUrl, { waitUntil: "domcontentloaded" });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible();
			const bootstrapHealth = await bootstrapHealthPromise;
			expect(bootstrapHealth.status()).toBe(200);
			expect(await bootstrapHealth.request().headerValue("authorization")).toBe(`Bearer ${token}`);
			expect(await bootstrapHealth.headerValue("access-control-allow-origin")).toBe(viteOrigin);
			expect(await bootstrapHealth.headerValue("access-control-allow-credentials")).toBe("true");
			const setCookie = await bootstrapHealth.headerValue("set-cookie");
			expect(setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=v1\\.2\\.`));
			expect(setCookie).toMatch(/;\s*Secure(?:;|$)/i);
			expect(setCookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
			expect(setCookie).toMatch(/;\s*SameSite=Lax(?:;|$)/i);
			expect(setCookie).toMatch(/;\s*Path=\/(?:;|$)/i);

			await expect.poll(() => page.evaluate(() => localStorage.getItem("gateway.token")), {
				message: "same-host cross-port bootstrap must persist only the cookie sentinel",
			}).toBe("localhost");
			const cookie = (await context.cookies(gatewayBaseUrl)).find(entry => entry.name === COOKIE_NAME);
			expect(cookie).toEqual(expect.objectContaining({
				value: expect.stringMatching(SIGNED_COOKIE),
				domain: PUBLIC_HOST,
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
			}));

			const sessionId = await createSession(page, gatewayBaseUrl, token, workspaceDir);
			const ssePath = `/api/sessions/${sessionId}/preview-events`;
			const previewPath = `/preview/${sessionId}/${ENTRY}`;
			await expectAdminOk(await serverAdminRequest(page, gatewayConnectUrl, token, `/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: { preview: true },
			}));
			const mounted = await serverAdminRequest(page, gatewayConnectUrl, token, `/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: {
					entry: ENTRY,
					html: `<!doctype html><html><body><h1>${PREVIEW_TEXT}</h1></body></html>`,
				},
			});
			const mountedBody = await expectAdminOk(mounted);
			expect(mountedBody?.url).toBe(previewPath);

			// Let the bearer-holding initial document settle its first native
			// transports. The promises registered below therefore observe only the
			// fresh, sentinel-hydrated reload generation.
			const initialSsePromise = page.waitForResponse(response => gatewayResponse(response, gatewayOrigin, ssePath));
			const initialIframePromise = page.waitForResponse(response =>
				gatewayResponse(response, gatewayOrigin, previewPath)
				&& response.request().resourceType() === "document");
			await page.evaluate(id => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("message-editor textarea").first()).toBeVisible();
			expect((await initialSsePromise).status()).toBe(200);
			expect((await initialIframePromise).status()).toBe(200);

			const reloadHealthPromise = page.waitForResponse(response =>
				gatewayResponse(response, gatewayOrigin, "/api/health"));
			const reloadSsePromise = page.waitForResponse(response => gatewayResponse(response, gatewayOrigin, ssePath));
			const reloadIframePromise = page.waitForResponse(response =>
				gatewayResponse(response, gatewayOrigin, previewPath)
				&& response.request().resourceType() === "document");
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible();
			const reloadHealth = await reloadHealthPromise;
			expect(reloadHealth.status()).toBe(200);
			expect(await reloadHealth.request().headerValue("authorization"), "reloaded UI must not recover the admin bearer").toBeNull();
			expect(await reloadHealth.headerValue("set-cookie"), "cookie-only reload must not mint a replacement").toBeNull();
			expect(gateway.stdout.join(""), "--no-ui gateway banner must not advertise an embedded static UI").not.toContain("  UI:         ");

			const sse = await reloadSsePromise;
			expect(sse.status()).toBe(200);
			expect(await sse.headerValue("content-type")).toContain("text/event-stream");
			expect(await sse.request().headerValue("authorization"), "EventSource must authenticate only through the Secure cookie").toBeNull();
			await expect.poll(() => page.evaluate(() => (window as any).__headlessCookieEventSources as EventSourceRecord[]), {
				message: "preview EventSource should use credentialed direct-gateway transport",
			}).toContainEqual({
				url: `${gatewayBaseUrl}${ssePath}`,
				withCredentials: true,
			});

			const iframeResponse = await reloadIframePromise;
			expect(iframeResponse.status()).toBe(200);
			expect(await iframeResponse.request().headerValue("authorization"), "preview iframe must use only the Secure cookie").toBeNull();
			expect(new URL(iframeResponse.url()).searchParams.has("token")).toBe(false);
			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe).toBeVisible();
			const iframeSrc = new URL((await iframe.getAttribute("src"))!);
			expect(iframeSrc.origin).toBe(gatewayOrigin);
			expect(iframeSrc.pathname).toBe(previewPath);
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("body")).toContainText(PREVIEW_TEXT);

			const popoutLink = page.locator('a[title="Open preview in new tab"]').first();
			await expect(popoutLink).toBeVisible();
			const popoutHref = new URL((await popoutLink.getAttribute("href"))!);
			expect(popoutHref.origin).toBe(gatewayOrigin);
			expect(popoutHref.pathname).toBe(previewPath);
			expect(popoutHref.search).toBe("");
			const popupPromise = page.waitForEvent("popup");
			await popoutLink.click();
			const popup = await popupPromise;
			await popup.waitForLoadState("domcontentloaded");
			await expect(popup.locator("body")).toContainText(PREVIEW_TEXT);
			const popupReload = await popup.reload({ waitUntil: "domcontentloaded" });
			expect(popupReload?.status()).toBe(200);
			expect(await popupReload!.request().headerValue("authorization"), "preview popout reload must use only the Secure cookie").toBeNull();
			expect(new URL(popupReload!.url()).searchParams.has("token")).toBe(false);
			await popup.close();

			const finalCookie = (await context.cookies(gatewayBaseUrl)).find(entry => entry.name === COOKIE_NAME);
			expect(finalCookie?.value, "all native transports must retain the bootstrapped cookie").toBe(cookie?.value);
		} catch (error) {
			if (gateway && gateway.child.exitCode !== null) throw processFailure(gateway, `failed during test: ${String(error)}`);
			if (vite && vite.child.exitCode !== null) throw processFailure(vite, `failed during test: ${String(error)}`);
			throw error;
		} finally {
			if (vite) await stopSourceProcess(vite);
			if (gateway) await stopSourceProcess(gateway);
			await attachLogs(testInfo, gateway, vite);
			await rm(tempRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
		}
	});
});
