import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../../../tests/support/harnesses/browser/gateway-harness.js";
import {
	apiFetch,
	deleteSession,
	waitForSessionStatus,
} from "../../../tests/support/harnesses/browser/e2e-setup.js";
import {
	createSessionViaUI,
	openApp,
	sendMessage,
} from "../../../tests/support/helpers/browser/e2e/ui-helpers.js";

/**
 * Request-admission compatibility journey for installed extension surfaces.
 *
 * The artifacts pack is useful here because one user gesture crosses every
 * supported boundary: the app fetches an authenticated panel module, mints its
 * scoped capability over the authenticated app-owned session WebSocket, calls
 * the Host API store over authenticated REST, then mounts authored HTML in an
 * opaque-origin sandbox. The sandbox may communicate with its host by
 * postMessage, but a direct browser fetch from that opaque origin must still be
 * rejected by the gateway's outer request-admission policy.
 */
test.describe.configure({ mode: "serial" });

const SOURCE_DIR = fileURLToPath(new URL("../../../market-packs", import.meta.url));
const PACK = "artifacts";
const ARTIFACT_ID = "art-demo-1";
const PANEL_MODULE_PATH = "/api/ext/packs/artifacts/panels/artifacts.viewer";
const STORE_PUT_PATH = "/api/ext/store/put";
const STORE_GET_PATH = "/api/ext/store/get";

let installedSourceId: string | undefined;
let createdSessionId: string | undefined;

function requestPath(url: string): string {
	return new URL(url).pathname;
}

async function installArtifactsPack(): Promise<void> {
	const sourceResponse = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const sourceBody = await sourceResponse.text();
	expect(sourceResponse.status, sourceBody).toBe(201);
	installedSourceId = (JSON.parse(sourceBody) as { source: { id: string } }).source.id;

	const installResponse = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId: installedSourceId, dirName: PACK, scope: "server" }),
	});
	const installBody = await installResponse.text();
	expect(installResponse.status, installBody).toBe(201);
}

async function installAppWebSocketProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const NativeWebSocket = window.WebSocket;
		const sockets: Array<{
			url: string;
			authSent: number;
			authOk: number;
			extSurfaceTokenSent: number;
			extSurfaceTokenOk: number;
		}> = [];
		(window as any).__requestAdmissionExtensionWs = { sockets };

		window.WebSocket = class RequestAdmissionWebSocketProbe extends NativeWebSocket {
			private readonly probeRecord: (typeof sockets)[number];

			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols as string | string[]);
				this.probeRecord = {
					url: String(url),
					authSent: 0,
					authOk: 0,
					extSurfaceTokenSent: 0,
					extSurfaceTokenOk: 0,
				};
				sockets.push(this.probeRecord);
				this.addEventListener("message", (event: MessageEvent) => {
					try {
						const message = JSON.parse(String(event.data));
						if (message?.type === "auth_ok") this.probeRecord.authOk += 1;
						if (message?.type === "ext_surface_token_result" && message?.ok === true) {
							this.probeRecord.extSurfaceTokenOk += 1;
						}
					} catch {
						// Ignore non-JSON application frames.
					}
				});
			}

			override send(data: any): void {
				try {
					const message = typeof data === "string" ? JSON.parse(data) : undefined;
					if (message?.type === "auth" && typeof message?.token === "string" && message.token.length > 0) {
						this.probeRecord.authSent += 1;
					}
					if (message?.type === "ext_surface_token") this.probeRecord.extSurfaceTokenSent += 1;
				} catch {
					// Ignore non-JSON application frames.
				}
				super.send(data);
			}
		} as typeof WebSocket;
	});
}

async function cleanup(): Promise<void> {
	if (createdSessionId) {
		await deleteSession(createdSessionId).catch(() => {});
		createdSessionId = undefined;
	}
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	}).catch(() => {});
	if (installedSourceId) {
		await apiFetch(`/api/marketplace/sources/${encodeURIComponent(installedSourceId)}`, {
			method: "DELETE",
		}).catch(() => {});
		installedSourceId = undefined;
	}
}

test.afterEach(async () => {
	await cleanup();
});

test.describe("request admission — extension compatibility", () => {
	test("keeps authenticated extension transports and opaque postMessage while denying direct sandbox access", async ({ page, gateway }) => {
		await page.setViewportSize({ width: 1400, height: 900 });
		await installArtifactsPack();
		await installAppWebSocketProbe(page);
		await openApp(page);
		await createSessionViaUI(page);
		createdSessionId = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | undefined);
		expect(createdSessionId).toBeTruthy();

		await expect.poll(async () => page.evaluate((sessionId) => {
			const sockets = (window as any).__requestAdmissionExtensionWs?.sockets ?? [];
			const socket = sockets.find((candidate: any) => {
				try { return new URL(candidate.url).pathname.endsWith(`/ws/${sessionId}`); }
				catch { return false; }
			});
			return socket ? { authSent: socket.authSent, authOk: socket.authOk } : null;
		}, createdSessionId), {
			timeout: 10_000,
			message: "the app-owned session WebSocket should pass admission and authenticate",
		}).toEqual({ authSent: 1, authOk: 1 });

		await sendMessage(page, "ARTIFACT_DEMO_TOOL please");
		const pill = page.locator(`[data-testid="artifact-pill"][data-artifact-id="${ARTIFACT_ID}"]`).first();
		await expect(pill).toBeVisible({ timeout: 25_000 });
		await waitForSessionStatus(createdSessionId!, "idle").catch(() => {});

		const moduleResponsePromise = page.waitForResponse(
			(response) => requestPath(response.url()).endsWith(PANEL_MODULE_PATH),
			{ timeout: 15_000 },
		);
		const storePutResponsePromise = page.waitForResponse(
			(response) => requestPath(response.url()).endsWith(STORE_PUT_PATH) && response.request().method() === "POST",
			{ timeout: 15_000 },
		);
		const storeGetResponsePromise = page.waitForResponse(
			(response) => requestPath(response.url()).endsWith(STORE_GET_PATH) && response.request().method() === "POST",
			{ timeout: 15_000 },
		);

		await pill.click();
		const [moduleResponse, storePutResponse, storeGetResponse] = await Promise.all([
			moduleResponsePromise,
			storePutResponsePromise,
			storeGetResponsePromise,
		]);

		for (const response of [moduleResponse, storePutResponse, storeGetResponse]) {
			expect(response.status(), `${requestPath(response.url())} should pass request admission`).toBe(200);
			const authorization = response.request().headers().authorization;
			expect(Boolean(authorization?.startsWith("Bearer ")), "extension HTTP transport should carry app authentication").toBe(true);
		}
		expect(storePutResponse.request().headers()["x-bobbit-session-id"]).toBe(createdSessionId);
		expect(storeGetResponse.request().headers()["x-bobbit-session-id"]).toBe(createdSessionId);

		await expect.poll(async () => page.evaluate((sessionId) => {
			const sockets = (window as any).__requestAdmissionExtensionWs?.sockets ?? [];
			const socket = sockets.find((candidate: any) => {
				try { return new URL(candidate.url).pathname.endsWith(`/ws/${sessionId}`); }
				catch { return false; }
			});
			return socket ? {
				extSurfaceTokenSent: socket.extSurfaceTokenSent,
				extSurfaceTokenOk: socket.extSurfaceTokenOk,
			} : null;
		}, createdSessionId), {
			timeout: 10_000,
			message: "the installed panel should mint its Host API scope over the app-owned WebSocket",
		}).toEqual({ extSurfaceTokenSent: 1, extSurfaceTokenOk: 1 });

		const viewer = page.locator('[data-testid="artifact-viewer-content"]').first();
		await expect(viewer).toBeVisible({ timeout: 15_000 });
		const inheritedTheme = await viewer.evaluate((element) => {
			const rootForeground = getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim();
			const panelForeground = getComputedStyle(element).getPropertyValue("--foreground").trim();
			return {
				sameHostDocument: element.ownerDocument === document,
				hasThemeToken: rootForeground.length > 0,
				inheritsThemeToken: panelForeground === rootForeground,
			};
		});
		expect(inheritedTheme).toEqual({
			sameHostDocument: true,
			hasThemeToken: true,
			inheritsThemeToken: true,
		});

		const iframe = page.locator('[data-testid="artifact-viewer-iframe"]').first();
		await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
		const iframeHandle = await iframe.elementHandle();
		const artifactFrame = await iframeHandle?.contentFrame();
		expect(artifactFrame, "the opaque artifact iframe should have a live browsing context").toBeTruthy();
		expect(await artifactFrame!.evaluate(() => location.origin)).toBe("null");

		const firstPostMessage = "opaque-artifact-postmessage-ok";
		await artifactFrame!.evaluate((message) => console.log(message), firstPostMessage);
		await expect(page.locator('[data-testid="artifact-viewer-console-entry"]').filter({ hasText: firstPostMessage })).toBeVisible({ timeout: 10_000 });

		const healthUrl = `${gateway.baseURL}/api/health`;
		const deniedResponsePromise = page.waitForResponse(
			(response) => response.url() === healthUrl,
			{ timeout: 10_000 },
		);
		const directFetchPromise = artifactFrame!.evaluate(async (url) => {
			try {
				const response = await fetch(url);
				return { readable: true, status: response.status };
			} catch {
				return { readable: false, status: null };
			}
		}, healthUrl);
		const [deniedResponse, directFetch] = await Promise.all([
			deniedResponsePromise,
			directFetchPromise,
		]);
		expect(deniedResponse.status(), "opaque-origin direct gateway access must not succeed").toBeGreaterThanOrEqual(400);
		expect(
			directFetch.status === null || directFetch.status >= 400,
			"the opaque artifact must never receive a successful gateway response",
		).toBe(true);

		const secondPostMessage = "opaque-artifact-postmessage-after-denial";
		await artifactFrame!.evaluate((message) => console.log(message), secondPostMessage);
		await expect(page.locator('[data-testid="artifact-viewer-console-entry"]').filter({ hasText: secondPostMessage })).toBeVisible({ timeout: 10_000 });
	});
});
