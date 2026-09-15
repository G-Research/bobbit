import { expect, test } from "../../support/harnesses/browser/gateway-harness.js";
import type { Page, Response } from "@playwright/test";
import { buildBundle } from "../../support/helpers/browser/fixtures/build-bundle.js";
import {
	apiFetch,
	createSession,
	nonGitCwd,
	readE2ETokenAsync,
} from "../../support/harnesses/browser/e2e-setup.js";
import { createServer, type Server } from "node:http";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

const ENTRY = "request-admission-preview.html";
const INITIAL_MARKER = "REQUEST_ADMISSION_PREVIEW_INITIAL";
const UPDATED_MARKER = "REQUEST_ADMISSION_PREVIEW_SSE_UPDATED";
const INLINE_LIGHT = {
	background: "rgb(241, 242, 243)",
	foreground: "rgb(21, 22, 23)",
	chart: "rgb(31, 111, 211)",
};
const INLINE_DARK = {
	background: "rgb(17, 18, 19)",
	foreground: "rgb(231, 232, 233)",
	chart: "rgb(211, 71, 91)",
};

const bundleRoot = mkdtempSync(join(tmpdir(), "bobbit-request-admission-browser-"));
const bundleEntry = join(bundleRoot, "inline-html-entry.ts");
const bundlePath = join(bundleRoot, "inline-html-bundle.js");
let attackerServer: Server | undefined;
let attackerOrigin = "";

function sourceImport(file: string): string {
	return resolve(file).replace(/\\/g, "/");
}

function inlineDocument(marker: string): string {
	return `<!doctype html><html><head><script>
		window.__admissionInlineAuthored = {
			marker: ${JSON.stringify(marker)},
			runs: (window.__admissionInlineAuthored && window.__admissionInlineAuthored.runs || 0) + 1,
			dark: document.documentElement.classList.contains("dark"),
			palette: document.documentElement.getAttribute("data-palette"),
			tokens: {
				background: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
				foreground: getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim(),
				chart: getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim()
			}
		};
	<\/script></head><body><main data-marker=${JSON.stringify(marker)}>${marker}</main></body></html>`;
}

function writeInlineRendererBundleEntry(): void {
	writeFileSync(bundleEntry, `
import { render } from ${JSON.stringify(sourceImport("node_modules/lit/index.js"))};
import { WriteRenderer } from ${JSON.stringify(sourceImport("src/ui/tools/renderers/WriteRenderer.ts"))};

const completeHost = document.createElement("section");
completeHost.id = "request-admission-inline-complete";
const streamingHost = document.createElement("section");
streamingHost.id = "request-admission-inline-streaming";
document.body.append(completeHost, streamingHost);
const completeRenderer = new WriteRenderer();
const streamingRenderer = new WriteRenderer();
const ok = {
	role: "toolResult",
	toolCallId: "request-admission-html",
	toolName: "write",
	isError: false,
	content: [{ type: "text", text: "ok" }],
	timestamp: Date.now(),
};
function draw(renderer, host, content, complete) {
	const output = renderer.render({ path: "request-admission-card.html", content }, complete ? ok : undefined, !complete);
	render(output.content, host);
}
window.__requestAdmissionInline = {
	setTheme(dark, palette, tokens) {
		const root = document.documentElement;
		root.classList.toggle("dark", dark);
		root.setAttribute("data-palette", palette);
		root.style.setProperty("--background", tokens.background);
		root.style.setProperty("--foreground", tokens.foreground);
		root.style.setProperty("--chart-1", tokens.chart);
	},
	renderComplete(content) { draw(completeRenderer, completeHost, content, true); },
	renderStream(content, complete = false) { draw(streamingRenderer, streamingHost, content, complete); },
	tag(hostId, identity) { document.querySelector("#" + hostId + " iframe").dataset.identity = identity; },
};
window.__requestAdmissionInlineReady = true;
`, "utf8");
	buildBundle({
		entry: bundleEntry,
		outfile: bundlePath,
		deps: [bundleEntry, resolve("src/ui/tools/renderers/WriteRenderer.ts"), resolve("src/ui/tools/renderers/HtmlRenderer.ts"), resolve("src/shared/preview-bridge-scripts.ts")],
	});
}

async function startAttackerServer(): Promise<void> {
	attackerServer = createServer((_req, res) => {
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end("<!doctype html><html><body><main>cross-site navigation source</main></body></html>");
	});
	await new Promise<void>((resolveListen, reject) => {
		attackerServer!.once("error", reject);
		attackerServer!.listen(0, "localhost", () => {
			attackerServer!.off("error", reject);
			resolveListen();
		});
	});
	attackerOrigin = `http://localhost:${(attackerServer.address() as AddressInfo).port}`;
}

async function stopAttackerServer(): Promise<void> {
	if (!attackerServer?.listening) return;
	await new Promise<void>((resolveClose, reject) => {
		attackerServer!.close(error => error ? reject(error) : resolveClose());
		attackerServer!.closeAllConnections?.();
	});
}

function previewHtml(marker: string): string {
	return `<!doctype html>
<html><head>
	<link rel="stylesheet" href="./assets/site.css">
	<script>
		function readable(read) { try { read(); return true; } catch { return false; } }
		window.__previewAdmissionState = {
			marker: ${JSON.stringify(marker)},
			parentReadable: readable(function () { return parent.document.documentElement; }),
			parentIsSelf: parent === window,
			localStorageReadable: readable(function () { return localStorage.getItem("preview-parent-secret"); }),
			sessionStorageReadable: readable(function () { return sessionStorage.getItem("preview-parent-secret"); }),
			classic: null,
			module: null,
			json: null,
			font: null
		};
	<\/script>
	<script src="./assets/classic.js"><\/script>
	<script type="module" crossorigin="use-credentials" src="./assets/module.js"><\/script>
</head><body>
	<main id="preview-marker">${marker}</main>
	<div id="relative-css">relative stylesheet loaded</div>
	<div id="font-probe">relative font requested</div>
	<img id="relative-image" src="./assets/pixel.svg" alt="relative asset">
	<script>
		fetch("./assets/data.json", { credentials: "include" })
			.then(function (response) { return response.json(); })
			.then(function (value) { window.__previewAdmissionState.json = value.marker; })
			.catch(function () { window.__previewAdmissionState.json = "fetch-failed"; });
		fetch("./assets/font.woff2", { credentials: "include" })
			.then(function (response) { return response.arrayBuffer(); })
			.then(function (bytes) { return new FontFace("AdmissionFixture", bytes).load(); })
			.then(function (face) {
				document.fonts.add(face);
				window.__previewAdmissionState.font = document.fonts.check('16px "AdmissionFixture"');
			})
			.catch(function () { window.__previewAdmissionState.font = false; });
	<\/script>
</body></html>`;
}

async function openAuthenticatedApp(page: Page, baseURL: string, sessionId?: string): Promise<void> {
	const token = await readE2ETokenAsync();
	const hash = sessionId ? `#/session/${sessionId}` : "";
	const response = await page.goto(`${baseURL}/?token=${encodeURIComponent(token)}${hash}`, { waitUntil: "domcontentloaded" });
	expect(response?.status(), "trusted-host top-level UI navigation should be admitted").toBe(200);
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
	if (sessionId) {
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
			{ timeout: 15_000, message: "session route should become active" },
		).toBe(sessionId);
	}
}

async function enablePreview(sessionId: string): Promise<void> {
	const response = await apiFetch(`/api/sessions/${sessionId}`, {
		method: "PATCH",
		body: JSON.stringify({ preview: true }),
	});
	expect(response.status, `enable preview failed: ${await response.text()}`).toBe(200);
}

async function mountFilePreview(sessionId: string, htmlPath: string): Promise<{ artifactId: string; contentHash: string }> {
	const response = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
		method: "POST",
		body: JSON.stringify({
			file: htmlPath,
			assets: [
				"assets/site.css",
				"assets/pixel.svg",
				"assets/classic.js",
				"assets/module.js",
				"assets/module-dependency.js",
				"assets/data.json",
				"assets/font.woff2",
			],
		}),
	});
	const text = await response.text();
	expect(response.status, `mount preview failed: ${text}`).toBe(200);
	const body = JSON.parse(text) as { artifactId?: string; contentHash?: string };
	expect(body.artifactId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
	expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
	return body as { artifactId: string; contentHash: string };
}

function isPreviewResponse(response: Response, sessionId: string): boolean {
	return new URL(response.url()).pathname.startsWith(`/preview/${encodeURIComponent(sessionId)}`);
}

async function waitForPreview(page: Page, marker: string): Promise<void> {
	const frame = page.frameLocator(".goal-preview-panel iframe").first();
	await expect(frame.locator("#preview-marker"), "opaque preview iframe should be admitted").toHaveText(marker, { timeout: 20_000 });
	await expect(frame.locator("#relative-css"), "relative CSS should load through preview admission").toHaveCSS("color", "rgb(12, 34, 56)", { timeout: 15_000 });
	await expect.poll(
		() => frame.locator("#relative-image").evaluate((image: HTMLImageElement) => ({ complete: image.complete, width: image.naturalWidth })),
		{ timeout: 15_000, message: "relative image should load through preview admission" },
	).toEqual({ complete: true, width: 4 });
	await expect.poll(
		() => frame.locator("body").evaluate(() => {
			const state = (window as any).__previewAdmissionState;
			return { classic: state?.classic, module: state?.module, json: state?.json, font: state?.font };
		}),
		{ timeout: 15_000, message: "classic script, CORS module dependency, credentialed JSON, and font should load from the opaque preview mount" },
	).toEqual({ classic: "classic-loaded", module: "module-dependency-loaded", json: "json-loaded", font: true });
}

async function inlineFrameState(page: Page, hostId: "request-admission-inline-complete" | "request-admission-inline-streaming"): Promise<any> {
	const host = await page.evaluate((id) => {
		const iframe = document.querySelector(`#${id} iframe`) as HTMLIFrameElement | null;
		return {
			identity: iframe?.dataset.identity || "",
			sandbox: iframe?.getAttribute("sandbox") ?? null,
			src: iframe?.getAttribute("src") ?? null,
			srcdoc: iframe?.srcdoc || "",
			streamingChrome: iframe?.nextElementSibling instanceof HTMLDivElement,
		};
	}, hostId);
	const child = await page.frameLocator(`#${hostId} iframe`).locator("html").evaluate((root) => {
		const styles = getComputedStyle(root);
		let parentReadable = true;
		let localStorageReadable = true;
		let sessionStorageReadable = true;
		try { void parent.document.documentElement; } catch { parentReadable = false; }
		try { void localStorage.getItem("preview-parent-secret"); } catch { localStorageReadable = false; }
		try { void sessionStorage.getItem("preview-parent-secret"); } catch { sessionStorageReadable = false; }
		return {
			location: location.href,
			dark: root.classList.contains("dark"),
			palette: root.getAttribute("data-palette"),
			tokens: {
				background: styles.getPropertyValue("--background").trim(),
				foreground: styles.getPropertyValue("--foreground").trim(),
				chart: styles.getPropertyValue("--chart-1").trim(),
			},
			authored: (window as any).__admissionInlineAuthored ?? null,
			opacity: { parentReadable, localStorageReadable, sessionStorageReadable },
		};
	});
	return { ...host, ...child };
}

async function addExternalLink(page: Page, id: string, href: string): Promise<void> {
	await page.evaluate(({ id, href }) => {
		const link = document.createElement("a");
		link.id = id;
		link.href = href;
		link.target = "_blank";
		link.rel = "noopener";
		link.textContent = id;
		document.body.appendChild(link);
	}, { id, href });
}

async function openExternalLink(page: Page, id: string): Promise<Page> {
	const popupPromise = page.context().waitForEvent("page", { timeout: 15_000 });
	await page.locator(`#${id}`).click();
	const popup = await popupPromise;
	await popup.waitForLoadState("domcontentloaded");
	return popup;
}

test.use({ gatewayStateGroup: "request-admission-preview-compatibility" });
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
	writeInlineRendererBundleEntry();
	await startAttackerServer();
});

test.afterAll(async () => {
	await stopAttackerServer();
	rmSync(bundleRoot, { recursive: true, force: true });
});

test.describe("Request admission preview compatibility", () => {
	test("admits trusted top-level, iframe, asset, redirect, SSE, popout, and restart preview flows while rejecting cross-site embedding", async ({ page, gateway }) => {
		test.setTimeout(55_000);
		const fixtureDir = mkdtempSync(join(nonGitCwd(), "request-admission-preview-"));
		const assetsDir = join(fixtureDir, "assets");
		const htmlPath = join(fixtureDir, ENTRY);
		let sessionId: string | undefined;
		let popup: Page | undefined;
		let attacker: Page | undefined;
		const previewFailures: string[] = [];
		const successfulPreviewResponses = new Map<string, { csp: string; allowOrigin: string; allowCredentials: string }>();

		mkdirSync(assetsDir, { recursive: true });
		writeFileSync(join(assetsDir, "site.css"), '#relative-css { color: rgb(12, 34, 56); } #font-probe { font-family: "AdmissionFixture"; }', "utf8");
		writeFileSync(join(assetsDir, "pixel.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3" viewBox="0 0 4 3"><rect width="4" height="3" fill="currentColor"/></svg>', "utf8");
		writeFileSync(join(assetsDir, "classic.js"), 'window.__previewAdmissionState.classic = "classic-loaded";', "utf8");
		writeFileSync(join(assetsDir, "module-dependency.js"), 'export const marker = "module-dependency-loaded";', "utf8");
		writeFileSync(join(assetsDir, "module.js"), 'import { marker } from "./module-dependency.js"; window.__previewAdmissionState.module = marker;', "utf8");
		writeFileSync(join(assetsDir, "data.json"), JSON.stringify({ marker: "json-loaded" }), "utf8");
		copyFileSync(resolve("node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2"), join(assetsDir, "font.woff2"));
		writeFileSync(htmlPath, previewHtml(INITIAL_MARKER), "utf8");

		try {
			sessionId = await createSession({ cwd: fixtureDir });
			await enablePreview(sessionId);
			const initialMount = await mountFilePreview(sessionId, htmlPath);

			page.on("response", response => {
				if (!isPreviewResponse(response, sessionId!)) return;
				const pathname = new URL(response.url()).pathname;
				if (response.status() >= 400) {
					previewFailures.push(`${response.status()} ${pathname}`);
				} else if (response.status() === 200) {
					const headers = response.headers();
					successfulPreviewResponses.set(pathname, {
						csp: headers["content-security-policy"] || "",
						allowOrigin: headers["access-control-allow-origin"] || "",
						allowCredentials: headers["access-control-allow-credentials"] || "",
					});
				}
			});
			page.on("requestfailed", request => {
				if (new URL(request.url()).pathname.startsWith(`/preview/${encodeURIComponent(sessionId!)}`)) {
					previewFailures.push(`failed ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? "unknown"}`);
				}
			});

			await openAuthenticatedApp(page, gateway.baseURL, sessionId);
			await page.evaluate(() => {
				localStorage.setItem("preview-parent-secret", "must-not-cross-preview-boundary");
				sessionStorage.setItem("preview-parent-secret", "must-not-cross-preview-boundary");
			});
			await waitForPreview(page, INITIAL_MARKER);
			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe).toHaveAttribute("src", new RegExp(`/preview/${sessionId}/_artifact/${initialMount.artifactId}/${ENTRY.replace(".", "\\.")}\\?mtime=\\d+$`));
			await expect(iframe, "repository previews must have no same-origin sandbox capability").toHaveAttribute("sandbox", "allow-scripts");
			const embeddedState = await page.frameLocator(".goal-preview-panel iframe").locator("body").evaluate(() => (window as any).__previewAdmissionState);
			expect(embeddedState).toMatchObject({
				marker: INITIAL_MARKER,
				parentReadable: false,
				parentIsSelf: false,
				localStorageReadable: false,
				sessionStorageReadable: false,
				classic: "classic-loaded",
				module: "module-dependency-loaded",
				json: "json-loaded",
				font: true,
			});
			const injectedBase = await page.frameLocator(".goal-preview-panel iframe").locator("base[data-bobbit-preview-base]").getAttribute("href");
			expect(injectedBase, "artifact-relative resources must retain the canonical preview base").toBe(`/preview/${sessionId}/_artifact/${initialMount.artifactId}/`);
			await page.evaluate(() => {
				const root = document.documentElement;
				root.classList.add("dark");
				root.setAttribute("data-palette", "request-admission-preview");
				root.style.setProperty("--chart-1", "rgb(41, 91, 141)");
			});
			await expect.poll(
				() => page.frameLocator(".goal-preview-panel iframe").locator("html").evaluate(root => ({
					dark: root.classList.contains("dark"),
					palette: root.getAttribute("data-palette"),
					chart: getComputedStyle(root).getPropertyValue("--chart-1").trim(),
				})),
				{ timeout: 10_000, message: "opaque preview bridge should mirror live parent theme and palette changes" },
			).toEqual({ dark: true, palette: "request-admission-preview", chart: "rgb(41, 91, 141)" });

			// A different-site iframe must not gain gateway preview access. Authentication
			// may reject it with 401 before the admission implementation, while the outer
			// admission boundary rejects it with 403; either result must remain non-rendering.
			attacker = await page.context().newPage();
			await attacker.goto(attackerOrigin, { waitUntil: "domcontentloaded" });
			const embeddedResponsePromise = attacker.waitForResponse(
				response => isPreviewResponse(response, sessionId!) && response.request().resourceType() === "document",
				{ timeout: 15_000 },
			);
			await attacker.evaluate(url => {
				const frame = document.createElement("iframe");
				frame.id = "cross-site-preview";
				frame.src = url;
				document.body.appendChild(frame);
			}, `${gateway.baseURL}/preview/${encodeURIComponent(sessionId)}/`);
			const embeddedResponse = await embeddedResponsePromise;
			expect([401, 403], "cross-site iframe navigation must be rejected before preview bytes render").toContain(embeddedResponse.status());
			await expect(attacker.frameLocator("#cross-site-preview").locator("body")).not.toContainText(INITIAL_MARKER);

			// The route matrix deliberately permits Chromium's proven originless,
			// cross-site navigate/empty popup shape only for safe top-level UI and
			// preview routes. Iframe, resource, API, and WebSocket shapes remain denied.
			// The preview link also exercises both canonical redirects:
			// /preview/<session> -> trailing slash -> current entry.
			await addExternalLink(attacker, "external-ui", `${gateway.baseURL}/`);
			popup = await openExternalLink(attacker, "external-ui");
			await expect(popup.locator("button").filter({ hasText: "Settings" }).first(), "external top-level UI navigation should be admitted").toBeVisible({ timeout: 15_000 });
			await popup.close();
			popup = undefined;

			await addExternalLink(attacker, "external-preview", `${gateway.baseURL}/preview/${encodeURIComponent(sessionId)}`);
			popup = await openExternalLink(attacker, "external-preview");
			await expect(popup.locator("#preview-marker"), "external top-level preview redirect chain should be admitted").toHaveText(INITIAL_MARKER, { timeout: 15_000 });
			expect(await popup.evaluate(() => (window as any).__previewAdmissionState)).toMatchObject({
				marker: INITIAL_MARKER,
				parentReadable: true,
				parentIsSelf: true,
				localStorageReadable: false,
				sessionStorageReadable: false,
			});
			await popup.close();
			popup = undefined;

			// A real remount is broadcast over the cookie-authenticated EventSource and
			// switches the side panel to the new immutable artifact and relative assets.
			writeFileSync(htmlPath, previewHtml(UPDATED_MARKER), "utf8");
			const updatedMount = await mountFilePreview(sessionId, htmlPath);
			expect(updatedMount.contentHash).not.toBe(initialMount.contentHash);
			await waitForPreview(page, UPDATED_MARKER);
			await expect(iframe).toHaveAttribute("src", new RegExp(`/preview/${sessionId}/_artifact/${updatedMount.artifactId}/${ENTRY.replace(".", "\\.")}\\?mtime=\\d+$`));
			await expect(page.locator(`[data-panel-tab-id="preview:entry:${encodeURIComponent(ENTRY)}"]`), "artifact-backed preview tab should remain active").toHaveCount(1);

			const popoutLink = page.locator('a[title="Open preview in new tab"]').first();
			await expect(popoutLink).toBeVisible({ timeout: 10_000 });
			const popoutPromise = page.waitForEvent("popup", { timeout: 15_000 });
			await popoutLink.click();
			popup = await popoutPromise;
			await popup.waitForLoadState("domcontentloaded");
			await expect(popup.locator("#preview-marker"), "standalone artifact popout should be admitted").toHaveText(UPDATED_MARKER, { timeout: 15_000 });
			await expect.poll(
				() => popup!.evaluate(() => {
					const state = (window as any).__previewAdmissionState;
					return { localStorageReadable: state?.localStorageReadable, sessionStorageReadable: state?.sessionStorageReadable };
				}),
				{ timeout: 10_000, message: "response CSP must keep a raw popout opaque without an iframe sandbox" },
			).toEqual({ localStorageReadable: false, sessionStorageReadable: false });
			const popoutTheme = await popup.evaluate(() => {
				const styles = getComputedStyle(document.documentElement);
				return {
					background: styles.getPropertyValue("--background").trim(),
					foreground: styles.getPropertyValue("--foreground").trim(),
				};
			});
			expect(popoutTheme.background, "standalone preview should retain its server-injected theme snapshot").not.toBe("");
			expect(popoutTheme.foreground).not.toBe("");
			const popoutReload = await popup.reload({ waitUntil: "domcontentloaded" });
			expect(popoutReload?.status()).toBe(200);
			await expect(popup.locator("#preview-marker")).toHaveText(UPDATED_MARKER);
			await popup.close();
			popup = undefined;

			await gateway.crash();
			await gateway.restart();
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expect.poll(
				() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
				{ timeout: 15_000, message: "durable reload should restore the preview session after restart" },
			).toBe(sessionId);
			await waitForPreview(page, UPDATED_MARKER);

			const requiredResourceSuffixes = [
				`/${ENTRY}`,
				"/assets/site.css",
				"/assets/pixel.svg",
				"/assets/classic.js",
				"/assets/module.js",
				"/assets/module-dependency.js",
				"/assets/data.json",
				"/assets/font.woff2",
			];
			for (const suffix of requiredResourceSuffixes) {
				const matches = [...successfulPreviewResponses.entries()].filter(([pathname]) => pathname.endsWith(suffix));
				expect(matches.length, `opaque preview resource ${suffix} should receive a successful response`).toBeGreaterThan(0);
				for (const [, headers] of matches) {
					expect(headers.csp, `successful preview response ${suffix} must be response-sandboxed`).toContain("sandbox allow-scripts");
					expect(headers.csp, `successful preview response ${suffix} must remain opaque`).not.toContain("allow-same-origin");
				}
			}
			for (const suffix of ["/assets/module.js", "/assets/module-dependency.js", "/assets/data.json", "/assets/font.woff2"]) {
				const matches = [...successfulPreviewResponses.entries()].filter(([pathname]) => pathname.endsWith(suffix));
				for (const [, headers] of matches) {
					expect(headers.allowOrigin, `opaque CORS resource ${suffix} must admit only the null origin`).toBe("null");
					expect(headers.allowCredentials, `opaque CORS resource ${suffix} must require the scoped preview credential`).toBe("true");
				}
			}
			expect(previewFailures, `trusted preview traffic must not fail admission: ${previewFailures.join(", ")}`).toEqual([]);
		} finally {
			if (popup && !popup.isClosed()) await popup.close().catch(() => {});
			if (attacker && !attacker.isClosed()) await attacker.close().catch(() => {});
			// Release the iframe, relative assets, EventSource, and app WebSocket before
			// asking Windows to remove the directory they were consuming.
			await page.goto("about:blank", { waitUntil: "load" });
			if (sessionId) {
				const response = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
				expect(response.status, `session cleanup failed: ${await response.text()}`).toBe(200);
			}
			rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	test("keeps completed and streaming HtmlRenderer cards as srcdoc documents with live parent theme synchronization", async ({ page, gateway }) => {
		test.setTimeout(60_000);
		await openAuthenticatedApp(page, gateway.baseURL);
		const previewRequests: string[] = [];
		page.on("request", request => {
			if (new URL(request.url()).pathname.startsWith("/preview/")) previewRequests.push(request.url());
		});
		await page.addScriptTag({ path: bundlePath });
		await page.waitForFunction(() => (window as any).__requestAdmissionInlineReady === true, undefined, { timeout: 15_000 });
		await page.evaluate(() => {
			localStorage.setItem("preview-parent-secret", "must-not-cross-preview-boundary");
			sessionStorage.setItem("preview-parent-secret", "must-not-cross-preview-boundary");
		});

		const completed = inlineDocument("completed-inline-html");
		await page.evaluate(({ content, tokens }) => {
			const fixture = (window as any).__requestAdmissionInline;
			fixture.setTheme(false, "admission-light", tokens);
			fixture.renderComplete(content);
		}, { content: completed, tokens: INLINE_LIGHT });
		await expect.poll(
			async () => (await inlineFrameState(page, "request-admission-inline-complete")).authored?.marker ?? "",
			{ timeout: 10_000, message: "completed HtmlRenderer srcdoc should execute" },
		).toBe("completed-inline-html");
		await page.evaluate(() => (window as any).__requestAdmissionInline.tag("request-admission-inline-complete", "same-completed-frame"));
		const completedState = await inlineFrameState(page, "request-admission-inline-complete");
		expect(completedState).toMatchObject({
			identity: "same-completed-frame",
			sandbox: "allow-scripts",
			src: null,
			location: "about:srcdoc",
			dark: false,
			palette: "admission-light",
			tokens: INLINE_LIGHT,
			authored: { marker: "completed-inline-html", runs: 1 },
			opacity: { parentReadable: false, localStorageReadable: false, sessionStorageReadable: false },
		});

		await page.evaluate(tokens => (window as any).__requestAdmissionInline.setTheme(true, "admission-dark", tokens), INLINE_DARK);
		await expect.poll(
			async () => {
				const state = await inlineFrameState(page, "request-admission-inline-complete");
				return { identity: state.identity, dark: state.dark, palette: state.palette, tokens: state.tokens, authoredRuns: state.authored?.runs };
			},
			{ timeout: 10_000, message: "completed srcdoc should mirror live theme and palette mutations without reloading or rerunning authored code" },
		).toEqual({ identity: "same-completed-frame", dark: true, palette: "admission-dark", tokens: INLINE_DARK, authoredRuns: 1 });

		const streamInitial = inlineDocument("streaming-inline-initial");
		await page.evaluate(content => (window as any).__requestAdmissionInline.renderStream(content), streamInitial);
		await expect.poll(
			async () => (await inlineFrameState(page, "request-admission-inline-streaming")).authored?.marker ?? "",
			{ timeout: 10_000, message: "streaming HtmlRenderer should assign its initial opaque srcdoc document" },
		).toBe("streaming-inline-initial");
		await page.evaluate(() => (window as any).__requestAdmissionInline.tag("request-admission-inline-streaming", "same-streaming-frame"));
		const streamUpdated = inlineDocument("streaming-inline-updated");
		await page.evaluate(content => (window as any).__requestAdmissionInline.renderStream(content), streamUpdated);
		await expect.poll(
			async () => (await inlineFrameState(page, "request-admission-inline-streaming")).authored?.marker ?? "",
			{ timeout: 5_000, intervals: [250], message: "debounced streaming update should remain browser-generated and admitted" },
		).toBe("streaming-inline-updated");
		let streamingState = await inlineFrameState(page, "request-admission-inline-streaming");
		expect(streamingState).toMatchObject({
			identity: "same-streaming-frame",
			sandbox: "allow-scripts",
			src: null,
			location: "about:srcdoc",
			dark: true,
			palette: "admission-dark",
			tokens: INLINE_DARK,
			authored: { marker: "streaming-inline-updated", runs: 1 },
			opacity: { parentReadable: false, localStorageReadable: false, sessionStorageReadable: false },
			streamingChrome: true,
		});

		const streamComplete = inlineDocument("streaming-inline-complete");
		await page.evaluate(content => (window as any).__requestAdmissionInline.renderStream(content, true), streamComplete);
		await expect.poll(
			async () => (await inlineFrameState(page, "request-admission-inline-streaming")).authored?.marker ?? "",
			{ timeout: 10_000, message: "stream completion should keep the canonical opaque srcdoc path" },
		).toBe("streaming-inline-complete");
		streamingState = await inlineFrameState(page, "request-admission-inline-streaming");
		expect(streamingState).toMatchObject({
			sandbox: "allow-scripts",
			src: null,
			location: "about:srcdoc",
			dark: true,
			palette: "admission-dark",
			tokens: INLINE_DARK,
			authored: { marker: "streaming-inline-complete", runs: 1 },
			opacity: { parentReadable: false, localStorageReadable: false, sessionStorageReadable: false },
			streamingChrome: false,
		});
		expect(streamingState.srcdoc).toContain("data-bobbit-inline-theme-bridge");
		expect(completedState.srcdoc).toContain("data-bobbit-inline-theme-bridge");
		expect(previewRequests, "inline HtmlRenderer srcdoc documents must not make a gateway document request").toEqual([]);
	});
});
