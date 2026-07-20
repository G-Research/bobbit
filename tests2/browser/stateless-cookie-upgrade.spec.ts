import type { BrowserContext, Page, Response } from "@playwright/test";
import { test, expect } from "./gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	nonGitCwd,
	readE2ETokenAsync,
	waitForSessionStatus,
} from "./e2e-setup.js";

const COOKIE_NAME = "bobbit_session";
const LEGACY_COOKIE = "a".repeat(64);
const ENTRY = "stateless-cookie-upgrade.html";
const PREVIEW_TEXT = "STATELESS_COOKIE_PREVIEW_OK";
const SSE_PREVIEW_TEXT = "STATELESS_COOKIE_SSE_UPDATE_OK";
const SIGNED_COOKIE = /^v1\.\d+\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

interface CookieWrite {
	url: string;
	method: string;
	header: string;
}

function pathname(response: Response): string {
	return new URL(response.url()).pathname;
}

async function setCookieHeader(response: Response): Promise<string | null> {
	return response.headerValue("set-cookie");
}

function cookieValueFromSetCookie(header: string): string {
	return header.match(new RegExp(`${COOKIE_NAME}=([^;,\\s]+)`, "i"))?.[1] ?? "";
}

function createCookieWriteRecorder(context: BrowserContext, origin: string) {
	const writes: CookieWrite[] = [];
	const pending = new Set<Promise<void>>();
	const attached = new Set<Page>();

	const onResponse = (response: Response): void => {
		if (new URL(response.url()).origin !== origin) return;
		const work = (async () => {
			try {
				const header = await setCookieHeader(response);
				if (header && new RegExp(`${COOKIE_NAME}=`, "i").test(header)) {
					writes.push({
						url: response.url(),
						method: response.request().method(),
						header,
					});
				}
			} catch {
				// A page may close while its response headers are being collected.
			}
		})();
		pending.add(work);
		void work.finally(() => pending.delete(work));
	};

	const attach = (page: Page): void => {
		if (attached.has(page)) return;
		attached.add(page);
		page.on("response", onResponse);
	};

	for (const page of context.pages()) attach(page);
	context.on("page", attach);

	return {
		writes,
		async flush(): Promise<void> {
			while (pending.size > 0) await Promise.all([...pending]);
		},
		dispose(): void {
			context.off("page", attach);
			for (const page of attached) page.off("response", onResponse);
		},
	};
}

async function expectCookieOnlyRequest(response: Response, cookieValue: string): Promise<void> {
	expect(
		await response.request().headerValue("authorization"),
		`${response.url()} must authenticate with the browser cookie, not Bearer`,
	).toBeNull();
	expect(await response.request().headerValue("cookie")).toContain(`${COOKIE_NAME}=${cookieValue}`);
	expect(await setCookieHeader(response), `${response.url()} must not issue another cookie`).toBeNull();
}

async function expectCookieAuthenticatedNavigation(response: Response): Promise<void> {
	// Playwright does not expose Chromium's Cookie header for document
	// navigations. On this force-auth gateway, 200 with no Bearer/query token
	// proves the already-asserted stored browser cookie authorized the request.
	expect(
		await response.request().headerValue("authorization"),
		`${response.url()} must authenticate with the browser cookie, not Bearer`,
	).toBeNull();
	expect(new URL(response.url()).searchParams.has("token"), `${response.url()} must not use a query token`).toBe(false);
	expect(await setCookieHeader(response), `${response.url()} must not issue another cookie`).toBeNull();
}

async function cookieOnlySessionFetch(page: Page, sessionId: string): Promise<Response> {
	const responsePromise = page.waitForResponse(
		response => pathname(response) === `/api/sessions/${sessionId}`
			&& response.request().method() === "GET",
		{ timeout: 15_000 },
	);
	const result = await page.evaluate(async (id) => {
		const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
			credentials: "include",
		});
		return { status: response.status, body: await response.text() };
	}, sessionId);
	const response = await responsePromise;
	expect(result.status, `cookie-only session API failed: ${result.body}`).toBe(200);
	expect(JSON.parse(result.body)).toEqual(expect.objectContaining({ id: sessionId }));
	return response;
}

async function storedCookie(context: BrowserContext, origin: string) {
	return (await context.cookies(origin)).find(cookie => cookie.name === COOKIE_NAME);
}

test.describe("Stateless browser cookie upgrade", () => {
	test("upgrades a legacy cookie once, then keeps API, preview iframe/new-tab, and SSE cookie-authenticated", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const context = page.context();
		const browserURL = new URL(gateway.baseURL);
		browserURL.hostname = "localhost";
		const browserOrigin = browserURL.origin;
		const recorder = createCookieWriteRecorder(context, browserOrigin);
		let sessionId: string | undefined;
		let popup: Page | undefined;

		try {
			sessionId = await createSession({ cwd: nonGitCwd() });
			await waitForSessionStatus(sessionId, "idle");

			const enable = await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ preview: true }),
			});
			expect(enable.status, `enable preview failed: ${await enable.text()}`).toBe(200);

			const mount = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({
					entry: ENTRY,
					html: `<!doctype html><html><body><h1>${PREVIEW_TEXT}</h1></body></html>`,
				}),
			});
			const mountText = await mount.text();
			expect(mount.status, `mount preview failed: ${mountText}`).toBe(200);
			expect(JSON.parse(mountText)).toEqual(expect.objectContaining({
				entry: ENTRY,
				contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			}));

			await context.addCookies([{
				name: COOKIE_NAME,
				value: LEGACY_COOKIE,
				url: `${browserOrigin}/`,
				httpOnly: true,
				sameSite: "Lax",
			}]);
			expect((await storedCookie(context, browserOrigin))?.value).toBe(LEGACY_COOKIE);

			const token = await readE2ETokenAsync();
			const healthPromise = page.waitForResponse(
				response => pathname(response) === "/api/health"
					&& response.request().method() === "GET"
					&& response.request().headers().authorization?.startsWith("Bearer ") === true,
				{ timeout: 20_000 },
			);
			const ssePromise = page.waitForResponse(
				response => pathname(response) === `/api/sessions/${sessionId}/preview-events`,
				{ timeout: 20_000 },
			);
			const iframePromise = page.waitForResponse(
				response => pathname(response) === `/preview/${sessionId}/${ENTRY}`
					&& response.request().resourceType() === "document",
				{ timeout: 20_000 },
			);

			await page.goto(
				`${browserOrigin}/?token=${encodeURIComponent(token)}#/session/${sessionId}`,
				{ waitUntil: "domcontentloaded" },
			);

			const health = await healthPromise;
			expect(await health.request().headerValue("cookie")).toContain(`${COOKIE_NAME}=${LEGACY_COOKIE}`);
			const upgradeHeader = await setCookieHeader(health);
			expect(upgradeHeader, "the first authenticated UI request must replace the legacy cookie").not.toBeNull();
			expect(upgradeHeader!.match(new RegExp(`${COOKIE_NAME}=`, "gi"))).toHaveLength(1);
			const signedValue = cookieValueFromSetCookie(upgradeHeader!);
			expect(signedValue).toMatch(SIGNED_COOKIE);
			expect(signedValue).not.toBe(LEGACY_COOKIE);
			expect(upgradeHeader).toMatch(/;\s*HttpOnly(?:;|$)/i);
			expect(upgradeHeader).toMatch(/;\s*SameSite=Lax(?:;|$)/i);
			expect(upgradeHeader).toMatch(/;\s*Path=\/(?:;|$)/i);
			expect(upgradeHeader).toMatch(/;\s*Max-Age=2592000(?:;|$)/i);
			expect(upgradeHeader).toMatch(/;\s*Secure(?:;|$)/i);

			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expect.poll(
				() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
				{ timeout: 15_000, message: "the authenticated UI should restore the preview session" },
			).toBe(sessionId);

			const upgraded = await storedCookie(context, browserOrigin);
			expect(upgraded).toEqual(expect.objectContaining({
				value: signedValue,
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
				path: "/",
			}));

			const sse = await ssePromise;
			expect(sse.status()).toBe(200);
			expect(await sse.headerValue("content-type")).toContain("text/event-stream");
			await expectCookieOnlyRequest(sse, signedValue);

			const iframeResponse = await iframePromise;
			expect(iframeResponse.status()).toBe(200);
			await expectCookieAuthenticatedNavigation(iframeResponse);
			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe).toBeVisible({ timeout: 20_000 });
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("body")).toContainText(PREVIEW_TEXT, { timeout: 15_000 });

			const apiResponse = await cookieOnlySessionFetch(page, sessionId);
			await expectCookieOnlyRequest(apiResponse, signedValue);

			// Change the mounted bytes after the EventSource is open. No client API
			// request performs this update, so the iframe can reach the new content
			// only through the live preview-changed SSE event.
			const sseIframePromise = page.waitForResponse(
				response => pathname(response) === `/preview/${sessionId}/${ENTRY}`
					&& response.request().resourceType() === "document",
				{ timeout: 15_000 },
			);
			const sseMount = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({
					entry: ENTRY,
					html: `<!doctype html><html><body><h1>${SSE_PREVIEW_TEXT}</h1></body></html>`,
				}),
			});
			const sseMountText = await sseMount.text();
			expect(sseMount.status, `SSE preview update failed: ${sseMountText}`).toBe(200);
			const sseMountBody = JSON.parse(sseMountText) as { contentHash?: string };
			expect(sseMountBody.contentHash).toMatch(/^[a-f0-9]{64}$/);
			const sseIframeResponse = await sseIframePromise;
			expect(sseIframeResponse.status()).toBe(200);
			await expectCookieAuthenticatedNavigation(sseIframeResponse);
			await expect.poll(
				() => page.evaluate(() => (window as any).bobbitState?.previewPanelContentHash ?? ""),
				{ timeout: 15_000, message: "preview SSE should deliver the updated mount identity" },
			).toBe(sseMountBody.contentHash);
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("body")).toContainText(SSE_PREVIEW_TEXT, { timeout: 15_000 });

			const newTabLink = page.locator('a[title="Open preview in new tab"]').first();
			await expect(newTabLink).toHaveAttribute("href", `/preview/${sessionId}/${ENTRY}`, { timeout: 15_000 });
			const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
			await newTabLink.click();
			popup = await popupPromise;
			await popup.waitForLoadState("domcontentloaded");
			await expect(popup.locator("body")).toContainText(SSE_PREVIEW_TEXT, { timeout: 15_000 });
			const popupReload = await popup.reload({ waitUntil: "domcontentloaded" });
			expect(popupReload, "new-tab preview reload should return a response").not.toBeNull();
			expect(popupReload!.status()).toBe(200);
			await expectCookieAuthenticatedNavigation(popupReload!);
			await popup.close();
			popup = undefined;

			await recorder.flush();
			expect(recorder.writes, "upgrade and all post-upgrade traffic must produce exactly one cookie write").toHaveLength(1);
			expect(cookieValueFromSetCookie(recorder.writes[0].header)).toBe(signedValue);

			const reloadHealthPromise = page.waitForResponse(
				response => pathname(response) === "/api/health"
					&& response.request().method() === "GET"
					&& response.request().headers().authorization?.startsWith("Bearer ") === true,
				{ timeout: 20_000 },
			);
			const reloadSsePromise = page.waitForResponse(
				response => pathname(response) === `/api/sessions/${sessionId}/preview-events`,
				{ timeout: 20_000 },
			);
			const reloadIframePromise = page.waitForResponse(
				response => pathname(response) === `/preview/${sessionId}/${ENTRY}`
					&& response.request().resourceType() === "document",
				{ timeout: 20_000 },
			);
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expect.poll(
				() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
				{ timeout: 15_000, message: "reload should restore the same cookie-authenticated session" },
			).toBe(sessionId);

			const reloadHealth = await reloadHealthPromise;
			expect(await setCookieHeader(reloadHealth), "a fresh signed cookie must not be refreshed on reload").toBeNull();
			const reloadSse = await reloadSsePromise;
			expect(reloadSse.status()).toBe(200);
			await expectCookieOnlyRequest(reloadSse, signedValue);
			const reloadIframe = await reloadIframePromise;
			expect(reloadIframe.status()).toBe(200);
			await expectCookieAuthenticatedNavigation(reloadIframe);
			await expect(page.frameLocator(".goal-preview-panel iframe").locator("body")).toContainText(SSE_PREVIEW_TEXT, { timeout: 15_000 });

			const reloadedApi = await cookieOnlySessionFetch(page, sessionId);
			await expectCookieOnlyRequest(reloadedApi, signedValue);
			expect((await storedCookie(context, browserOrigin))?.value).toBe(signedValue);
			await recorder.flush();
			expect(recorder.writes, "reload, API, preview, and SSE must not reissue the cookie").toHaveLength(1);

			await deleteSession(sessionId);
			sessionId = undefined;
			await context.clearCookies();
			expect(await storedCookie(context, browserOrigin)).toBeUndefined();
		} finally {
			recorder.dispose();
			if (popup && !popup.isClosed()) await popup.close().catch(() => {});
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await context.clearCookies().catch(() => {});
		}
	});
});
