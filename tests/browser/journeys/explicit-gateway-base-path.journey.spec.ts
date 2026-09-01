import type { Page, Request as PlaywrightRequest, WebSocket as PlaywrightWebSocket } from "@playwright/test";
import { test, expect } from "../../support/helpers/browser/journeys/journey-fixture.js";
import type { GatewayInfo } from "../../support/harnesses/browser/gateway-harness.js";

const GATEWAY_PATH = "/team/gw";

test.use({ basePath: GATEWAY_PATH, separateUiOrigin: true });

interface RequestRecord {
	url: string;
	method: string;
	authorization?: string;
}

interface InboxEntryRecord {
	id: string;
	state: string;
	title: string;
	[key: string]: unknown;
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

async function gatewayApiFetch(gateway: GatewayInfo, route: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${gatewayToken()}`);
	if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	return fetch(`${gateway.baseURL}${route}`, { ...init, headers });
}

async function listInbox(gateway: GatewayInfo, staffId: string): Promise<InboxEntryRecord[]> {
	const response = await gatewayApiFetch(gateway, `/api/staff/${encodeURIComponent(staffId)}/inbox`);
	const text = await response.text();
	expect(response.status, text).toBe(200);
	return (JSON.parse(text) as { entries: InboxEntryRecord[] }).entries;
}

async function mountStandaloneInboxPanel(
	page: Page,
	args: { staffId: string; sessionId: string; entry: InboxEntryRecord },
): Promise<void> {
	await page.evaluate(async ({ staffId, sessionId, entry }) => {
		await customElements.whenDefined("inbox-panel");
		document.querySelector("[data-explicit-gateway-inbox]")?.remove();
		const panel = document.createElement("inbox-panel") as HTMLElement & {
			staffId: string;
			sessionId: string;
			entries: unknown[];
			updateComplete: Promise<unknown>;
		};
		panel.dataset.explicitGatewayInbox = "";
		panel.staffId = staffId;
		panel.sessionId = sessionId;
		panel.entries = [entry];
		document.body.appendChild(panel);
		await panel.updateComplete;
	}, args);
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
		let staffId = "";
		const onRequest = (request: PlaywrightRequest) => requests.push({
			url: request.url(),
			method: request.method(),
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

			const projectsResponse = await gatewayApiFetch(gateway, "/api/projects");
			const projectsText = await projectsResponse.text();
			expect(projectsResponse.status, projectsText).toBe(200);
			const projects = JSON.parse(projectsText) as Array<{ id: string; name?: string; rootPath: string; hidden?: boolean }>;
			const project = projects.find((candidate) => candidate.name === "default" && !candidate.hidden)
				?? projects.find((candidate) => !candidate.hidden);
			if (!project) throw new Error("explicit gateway harness has no visible project");

			const createStaffResponse = await gatewayApiFetch(gateway, "/api/staff", {
				method: "POST",
				body: JSON.stringify({
					name: `Explicit gateway inbox ${Date.now()}`,
					systemPrompt: "Exercise explicit cross-origin inbox actions.",
					cwd: project.rootPath,
					projectId: project.id,
					worktree: false,
				}),
			});
			const createStaffText = await createStaffResponse.text();
			expect(createStaffResponse.status, createStaffText).toBe(201);
			const staff = JSON.parse(createStaffText) as { id: string; currentSessionId?: string };
			staffId = staff.id;
			if (!staff.currentSessionId) throw new Error("created staff has no session");

			await page.evaluate(async (id) => {
				await customElements.whenDefined("add-to-inbox-dialog");
				delete document.body.dataset.explicitInboxSubmitted;
				const dialog = document.createElement("add-to-inbox-dialog") as HTMLElement & {
					staffId: string;
					updateComplete: Promise<unknown>;
				};
				dialog.dataset.explicitGatewayDialog = "";
				dialog.staffId = id;
				dialog.addEventListener("inbox-add-submitted", () => {
					document.body.dataset.explicitInboxSubmitted = "1";
				}, { once: true });
				document.body.appendChild(dialog);
				await dialog.updateComplete;
			}, staffId);

			const title = `Explicit bearer entry ${Date.now()}`;
			await page.locator("add-to-inbox-dialog[data-explicit-gateway-dialog] input.add-to-inbox-title").fill(title);
			await page.locator("add-to-inbox-dialog[data-explicit-gateway-dialog] textarea.add-to-inbox-prompt").fill("Verify the final gateway REST target.");
			const inboxBasePath = `${GATEWAY_PATH}/api/staff/${encodeURIComponent(staffId)}/inbox`;
			const addResponsePromise = page.waitForResponse((response) => {
				const url = new URL(response.url());
				return response.request().method() === "POST"
					&& url.origin === explicitOrigin
					&& url.pathname === inboxBasePath;
			});
			await page.locator("add-to-inbox-dialog[data-explicit-gateway-dialog] button.add-to-inbox-submit").click();
			const addResponse = await addResponsePromise;
			expect(addResponse.status()).toBe(201);
			expect(await addResponse.request().headerValue("authorization")).toBe(`Bearer ${gatewayToken()}`);
			await expect.poll(() => page.locator("body").getAttribute("data-explicit-inbox-submitted")).toBe("1");
			await page.locator("add-to-inbox-dialog[data-explicit-gateway-dialog]").evaluate((element) => element.remove());

			let entry: InboxEntryRecord | undefined;
			await expect.poll(async () => {
				entry = (await listInbox(gateway, staffId)).find((candidate) => candidate.title === title);
				return entry?.state;
			}).toBe("pending");
			if (!entry) throw new Error("added inbox entry was not persisted");

			await mountStandaloneInboxPanel(page, { staffId, sessionId: staff.currentSessionId, entry });
			const dismissPath = `${inboxBasePath}/${encodeURIComponent(entry.id)}/dismiss`;
			const dismissResponsePromise = page.waitForResponse((response) => {
				const url = new URL(response.url());
				return response.request().method() === "POST"
					&& url.origin === explicitOrigin
					&& url.pathname === dismissPath;
			});
			await page.locator("[data-explicit-gateway-inbox] button.inbox-cancel-btn").click();
			const dismissResponse = await dismissResponsePromise;
			expect(dismissResponse.status()).toBe(200);

			await expect.poll(async () => {
				entry = (await listInbox(gateway, staffId)).find((candidate) => candidate.id === entry?.id);
				return entry?.state;
			}).toBe("cancelled");
			if (!entry) throw new Error("cancelled inbox entry disappeared before delete");

			await mountStandaloneInboxPanel(page, { staffId, sessionId: staff.currentSessionId, entry });
			await page.locator("[data-explicit-gateway-inbox] details > summary").click();
			const deletePath = `${inboxBasePath}/${encodeURIComponent(entry.id)}`;
			const deleteResponsePromise = page.waitForResponse((response) => {
				const url = new URL(response.url());
				return response.request().method() === "DELETE"
					&& url.origin === explicitOrigin
					&& url.pathname === deletePath;
			});
			await page.locator("[data-explicit-gateway-inbox] button.inbox-delete-btn").click();
			const deleteResponse = await deleteResponsePromise;
			expect(deleteResponse.status()).toBe(200);
			await expect.poll(async () => !(await listInbox(gateway, staffId)).some((candidate) => candidate.id === entry?.id)).toBe(true);

			const actionPaths = [inboxBasePath, dismissPath, deletePath];
			const browserActions = requests.filter((request) => {
				const url = new URL(request.url);
				return url.origin === explicitOrigin
					&& actionPaths.includes(url.pathname)
					&& (request.method === "POST" || request.method === "DELETE");
			});
			expect(browserActions.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
				`POST ${inboxBasePath}`,
				`POST ${dismissPath}`,
				`DELETE ${deletePath}`,
			]);
			expect(browserActions.every((request) => request.authorization === `Bearer ${gatewayToken()}`)).toBe(true);
			browserActions.forEach((request) => expectMountedExactlyOnce(request.url));

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
			if (staffId) await gatewayApiFetch(gateway, `/api/staff/${encodeURIComponent(staffId)}`, { method: "DELETE" }).catch(() => undefined);
			page.context().off("request", onRequest);
			page.off("websocket", onSocket);
			await page.context().clearCookies().catch(() => undefined);
		}
	});
});
