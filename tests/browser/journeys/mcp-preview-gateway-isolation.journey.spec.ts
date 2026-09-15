import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Response } from "@playwright/test";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	registerProject,
	test,
} from "../../support/helpers/browser/journeys/journey-fixture.js";
import {
	createMcpProjectApprovalFixture,
	LOCAL_SERVER_NAME,
	REMOTE_SERVER_NAME,
} from "../../support/browser/mcp-project-approval-fixture.js";

type McpStatus = {
	name: string;
	status: string;
	toolCount: number;
	approval: { state: string; fingerprint?: string };
	source: { projectId?: string; sourceId: string };
};

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("remote MCP probe did not bind a TCP port");
	return address.port;
}

async function close(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function mcpStatuses(projectId: string): Promise<McpStatus[]> {
	const response = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&ensure=true`);
	expect(response.status).toBe(200);
	return response.json() as Promise<McpStatus[]>;
}

function named(statuses: McpStatus[], name: string): McpStatus {
	const status = statuses.find(entry => entry.name === name);
	expect(status, `missing MCP server ${name}`).toBeDefined();
	return status!;
}

function attackScript(endpoint: string, body: Record<string, unknown>): string {
	return `(async () => {
		const report = document.getElementById("isolation-result");
		let storageReadable = false;
		let bearer = "";
		for (const readStorage of [
			() => localStorage,
			() => sessionStorage,
			() => parent === window ? null : parent.localStorage,
			() => parent === window ? null : parent.sessionStorage,
			() => opener ? opener.localStorage : null,
			() => opener ? opener.sessionStorage : null,
		]) {
			try {
				const storage = readStorage();
				if (!storage) continue;
				storageReadable = true;
				bearer ||= storage.getItem("gateway.token") || "";
			} catch {}
		}
		let parentDomReadable = false;
		for (const readPrivilegedDocument of [
			() => parent === window ? null : parent.document.documentElement,
			() => opener ? opener.document.documentElement : null,
		]) {
			try {
				if (readPrivilegedDocument()) parentDomReadable = true;
			} catch {}
		}
		let cookieReadable = false;
		try { cookieReadable = document.cookie.length > 0; } catch {}
		const indexedDbReadable = await new Promise(resolve => {
			let settled = false;
			const finish = value => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			try {
				const databaseName = "preview-isolation-" + Date.now();
				const request = indexedDB.open(databaseName);
				request.onsuccess = () => {
					request.result.close();
					indexedDB.deleteDatabase(databaseName);
					finish(true);
				};
				request.onerror = () => finish(false);
				setTimeout(() => finish(false), 2000);
			} catch {
				finish(false);
			}
		});
		const headers = bearer
			? { "Content-Type": "application/json", "Authorization": "Bearer " + bearer }
			: { "Content-Type": "text/plain" };
		const status = await fetch(${JSON.stringify(endpoint)}, {
			method: "POST",
			credentials: "include",
			headers,
			body: ${JSON.stringify(JSON.stringify(body))},
		}).then(response => String(response.status), () => "network-error");
		report.setAttribute("data-storage-readable", String(storageReadable));
		report.setAttribute("data-bearer-stolen", bearer ? "yes" : "no");
		report.setAttribute("data-cookie-readable", String(cookieReadable));
		report.setAttribute("data-indexeddb-readable", String(indexedDbReadable));
		report.setAttribute("data-parent-dom-readable", String(parentDomReadable));
		report.setAttribute("data-decision-status", status);
		report.textContent = "attack-finished";
	})();`;
}

function htmlAttack(endpoint: string, body: Record<string, unknown>, surface: string): string {
	return `<!doctype html><html><body><output id="isolation-result" data-surface=${JSON.stringify(surface)}>starting</output><script>${attackScript(endpoint, body)}</script></body></html>`;
}

function svgAttack(endpoint: string, body: Record<string, unknown>): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><text id="isolation-result" data-surface="svg" x="4" y="24">starting</text><script><![CDATA[${attackScript(endpoint, body)}]]></script></svg>`;
}

async function expectIsolated(frameOrPage: ReturnType<Page["frameLocator"]> | Page): Promise<void> {
	const report = frameOrPage.locator("#isolation-result");
	await expect(report).toHaveText("attack-finished", { timeout: 15_000 });
	await expect(report).toHaveAttribute("data-storage-readable", "false");
	await expect(report).toHaveAttribute("data-bearer-stolen", "no");
	await expect(report).toHaveAttribute("data-cookie-readable", "false");
	await expect(report).toHaveAttribute("data-indexeddb-readable", "false");
	await expect(report).toHaveAttribute("data-parent-dom-readable", "false");
	await expect(report).not.toHaveAttribute("data-decision-status", "200");
}

function expectOpaquePreviewResponse(response: Response): void {
	expect(response.status()).toBe(200);
	const csp = response.headers()["content-security-policy"] ?? "";
	expect(csp, "successful preview responses must be response-sandboxed").toContain("sandbox allow-scripts");
	expect(csp, "preview response CSP must not restore same-origin authority").not.toContain("allow-same-origin");
}

async function installSignedGatewayCookie(page: Page, gatewayBaseUrl: string): Promise<void> {
	const bootstrap = await apiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	expect(bootstrap.status).toBe(200);
	const setCookies = (bootstrap.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
		?? (bootstrap.headers.get("set-cookie") ? [bootstrap.headers.get("set-cookie")!] : []);
	const serialized = setCookies.find(cookie => cookie.startsWith("bobbit_session="));
	expect(serialized, "browser-signaled gateway auth must mint a signed session cookie").toBeDefined();
	const value = serialized!.slice("bobbit_session=".length).split(";", 1)[0];
	// The browser harness uses HTTP loopback. Install the genuine signed value as
	// a non-Secure test cookie so Chromium can send it on the attack/control POSTs.
	await page.context().addCookies([{
		name: "bobbit_session",
		value,
		url: gatewayBaseUrl,
		httpOnly: true,
		secure: false,
		sameSite: "Lax",
	}]);
}

function seedInlineAttack(gateway: any, sessionId: string, html: string): void {
	const agent = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent;
	if (!Array.isArray(agent?.conversationMessages)) throw new Error("preview isolation journey requires the in-process mock agent transcript");
	const toolCallId = "preview-isolation-inline-write";
	const input = { path: "repository-inline-attack.html", content: html };
	agent.conversationMessages = [
		{
			id: `${toolCallId}-assistant`,
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "write", arguments: input, input }],
			timestamp: Date.now(),
		},
		{
			id: `${toolCallId}-result`,
			role: "toolResult",
			toolCallId,
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "Wrote repository inline attack fixture" }],
			timestamp: Date.now() + 1,
		},
	];
}

test.use({ enableMcp: true, gatewayStateGroup: "mcp-preview-gateway-isolation" });
test.describe.configure({ mode: "serial" });

test("MCP preview isolation keeps repository documents from spending gateway authority", async ({ page, gateway }) => {
	test.setTimeout(120_000);
	const fixture = createMcpProjectApprovalFixture();
	const localSpawnMarker = join(fixture.primaryRoot, "local-mcp-spawned.txt");
	const localMarkerProcess = join(fixture.primaryRoot, "local-mcp-marker.cjs");
	const mockMcpServerUrl = new URL("../../fixtures/mock-mcp-server.mjs", import.meta.url).href;
	writeFileSync(localMarkerProcess, [
		'const { writeFileSync } = require("node:fs");',
		'writeFileSync(process.argv[2], "spawned");',
		`import(${JSON.stringify(mockMcpServerUrl)}).catch(error => { console.error(error); process.exit(1); });`,
	].join("\n"));
	let remoteRequests = 0;
	const remoteServer = createServer((_request, response) => {
		remoteRequests += 1;
		response.writeHead(500, { "Content-Type": "text/plain" });
		response.end("pending MCP server must never reach this listener");
	});
	const remotePort = await listen(remoteServer);
	const approvalPosts: Array<{ url: string; authorization: string | null }> = [];
	page.context().on("request", request => {
		const url = new URL(request.url());
		if (request.method() === "POST" && url.pathname.includes("/api/mcp-servers/") && url.pathname.endsWith("/approval")) {
			approvalPosts.push({
				url: request.url(),
				authorization: request.headers()["authorization"] ?? null,
			});
		}
	});

	writeFileSync(fixture.primaryConfigPath, JSON.stringify({
		mcpServers: {
			[LOCAL_SERVER_NAME]: {
				command: process.execPath,
				args: [localMarkerProcess, localSpawnMarker],
				cwd: ".",
			},
		},
	}, null, 2));
	writeFileSync(fixture.secondaryConfigPath, JSON.stringify({
		mcpServers: {
			[REMOTE_SERVER_NAME]: { url: `http://127.0.0.1:${remotePort}/mcp` },
		},
	}, null, 2));

	let primaryProjectId = "";
	let secondaryProjectId = "";
	let sessionId = "";
	const extraPages: Page[] = [];
	try {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		primaryProjectId = (await registerProject({ name: `Preview Isolation ${stamp}`, rootPath: fixture.primaryRoot, seedWorkflows: false })).id;
		secondaryProjectId = (await registerProject({ name: `Remote Isolation ${stamp}`, rootPath: fixture.secondaryRoot, seedWorkflows: false })).id;
		sessionId = await createSession({ projectId: primaryProjectId, cwd: fixture.primaryRoot });

		const initial = await mcpStatuses(primaryProjectId);
		const local = named(initial, LOCAL_SERVER_NAME);
		const remote = named(initial, REMOTE_SERVER_NAME);
		for (const status of [local, remote]) {
			expect(status.approval.state).toBe("pending");
			expect(status.status).toBe("disconnected");
			expect(status.toolCount).toBe(0);
		}
		expect(existsSync(localSpawnMarker)).toBe(false);
		expect(remoteRequests).toBe(0);

		const approvalEndpoint = `${gateway.baseURL}/api/mcp-servers/${encodeURIComponent(local.name)}/approval?projectId=${encodeURIComponent(primaryProjectId)}`;
		const approvalBody = {
			decision: "approved",
			fingerprint: local.approval.fingerprint,
			sourceProjectId: local.source.projectId,
			sourceId: local.source.sourceId,
		};
		seedInlineAttack(gateway, sessionId, htmlAttack(approvalEndpoint, approvalBody, "inline"));

		await openApp(page);
		expect(await page.evaluate(() => Boolean(localStorage.getItem("gateway.token"))), "trusted UI must hold ordinary gateway bearer authority").toBe(true);
		await installSignedGatewayCookie(page, gateway.baseURL);
		expect((await page.context().cookies(gateway.baseURL)).some(cookie => cookie.name === "bobbit_session" && cookie.httpOnly), "trusted UI must hold the signed gateway cookie attacked with credentials: include").toBe(true);
		await navigateToHash(page, `#/session/${sessionId}`);
		const banner = page.locator('[data-testid="mcp-approval-banner"]');
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await page.reload();
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		const inlineFrameElement = page.locator('iframe[title="repository-inline-attack.html"]');
		await expect(inlineFrameElement, "inline repository HTML must have no same-origin sandbox capability").toHaveAttribute("sandbox", "allow-scripts");
		const inlineFrame = page.frameLocator('iframe[title="repository-inline-attack.html"]');
		await expectIsolated(inlineFrame);

		const previewState = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
			method: "PATCH",
			body: JSON.stringify({ preview: true }),
		});
		expect(previewState.status).toBe(200);
		await page.evaluate(() => {
			const state: any = (window as any).bobbitState ?? (window as any).__bobbitState;
			state.previewPanelActiveTab = "preview";
		});
		const mountedDocumentResponse = page.waitForResponse(response => {
			const url = new URL(response.url());
			return url.pathname.includes(`/preview/${sessionId}/`) && response.request().resourceType() === "document";
		}, { timeout: 20_000 });
		const mountResponse = await apiFetch(`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`, {
			method: "POST",
			body: JSON.stringify({ html: htmlAttack(approvalEndpoint, approvalBody, "mounted-or-popout"), entry: "repository-mounted-attack.html" }),
		});
		expect(mountResponse.status).toBe(200);
		await mountResponse.json();
		const mountedNavigation = await mountedDocumentResponse;
		expectOpaquePreviewResponse(mountedNavigation);
		const previewCookieHeader = (await mountedNavigation.headersArray())
			.find(header => header.name.toLowerCase() === "set-cookie" && header.value.startsWith("bobbit_preview="))?.value ?? "";
		expect(previewCookieHeader, "the first authenticated preview response must issue a narrow resource cookie").toContain("HttpOnly");
		expect(previewCookieHeader).toContain("Secure");
		expect(previewCookieHeader).toContain("SameSite=None");
		expect(previewCookieHeader).toContain(`Path=/preview/${sessionId}/`);

		const mountedFrameElement = page.locator(".goal-preview-panel iframe");
		await expect(mountedFrameElement, "mounted repository HTML must have no same-origin sandbox capability").toHaveAttribute("sandbox", "allow-scripts");
		const mountedFrame = page.frameLocator(".goal-preview-panel iframe");
		await expectIsolated(mountedFrame);
		const popoutLink = page.locator('a[title="Open preview in new tab"]');
		await expect(popoutLink).toBeVisible({ timeout: 15_000 });
		const popupPromise = page.waitForEvent("popup");
		await popoutLink.click();
		const popup = await popupPromise;
		extraPages.push(popup);
		await popup.waitForLoadState("domcontentloaded");
		await expectIsolated(popup);
		const popupReload = await popup.reload({ waitUntil: "domcontentloaded" });
		expect(popupReload, "preview popout reload must return a response").not.toBeNull();
		expectOpaquePreviewResponse(popupReload!);
		await expectIsolated(popup);

		const svgResponse = await apiFetch(`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`, {
			method: "POST",
			body: JSON.stringify({ html: svgAttack(approvalEndpoint, approvalBody), entry: "repository-active-attack.svg" }),
		});
		expect(svgResponse.status).toBe(200);
		const svgMount = await svgResponse.json() as { url: string };
		const svgPage = await page.context().newPage();
		extraPages.push(svgPage);
		const svgNavigation = await svgPage.goto(new URL(svgMount.url, gateway.baseURL).href);
		expect(svgNavigation, "active SVG navigation must return a response").not.toBeNull();
		expectOpaquePreviewResponse(svgNavigation!);
		await expectIsolated(svgPage);

		await expect.poll(() => approvalPosts.length, {
			timeout: 10_000,
			message: "each hostile preview surface should attempt the real MCP approval endpoint",
		}).toBeGreaterThanOrEqual(4);
		expect(approvalPosts.every(request => request.authorization === null), "opaque previews must not recover the stored gateway bearer").toBe(true);
		await new Promise(resolve => setTimeout(resolve, 300));
		const afterAttacks = await mcpStatuses(primaryProjectId);
		for (const status of [named(afterAttacks, LOCAL_SERVER_NAME), named(afterAttacks, REMOTE_SERVER_NAME)]) {
			expect(status.approval.state).toBe("pending");
			expect(status.status).toBe("disconnected");
			expect(status.toolCount).toBe(0);
		}
		expect(existsSync(localSpawnMarker), "pending local MCP command must never spawn").toBe(false);
		expect(remoteRequests, "pending remote MCP endpoint must receive no requests").toBe(0);

		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await banner.locator('[data-testid="mcp-review-servers"]').click();
		const localRow = page.locator(`[data-testid="mcp-server-row"][data-server-name="${LOCAL_SERVER_NAME}"]`);
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Pending approval", { timeout: 20_000 });
		const localToggle = localRow.locator('[data-testid="mcp-server-toggle"]');
		if (await localToggle.getAttribute("aria-expanded") !== "true") await localToggle.click();
		await localRow.locator('[data-testid="mcp-approve-server"]').click();
		await expect(localRow.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
		await expect.poll(() => existsSync(localSpawnMarker), {
			timeout: 15_000,
			message: "a deliberate decision from the trusted Tools UI should start the local server",
		}).toBe(true);
		await expect.poll(() => approvalPosts.some(request => request.authorization?.startsWith("Bearer ")), {
			timeout: 10_000,
			message: "the trusted Tools UI should decide with established gateway bearer authority",
		}).toBe(true);
		const afterTrustedApproval = await mcpStatuses(primaryProjectId);
		expect(named(afterTrustedApproval, LOCAL_SERVER_NAME).approval.state).toBe("approved");
		expect(named(afterTrustedApproval, REMOTE_SERVER_NAME).approval.state).toBe("pending");
		expect(remoteRequests, "the still-pending remote MCP endpoint must receive no requests").toBe(0);
	} finally {
		for (const extraPage of extraPages) await extraPage.close().catch(() => {});
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		if (secondaryProjectId) await apiFetch(`/api/projects/${encodeURIComponent(secondaryProjectId)}`, { method: "DELETE" }).catch(() => {});
		if (primaryProjectId) await apiFetch(`/api/projects/${encodeURIComponent(primaryProjectId)}`, { method: "DELETE" }).catch(() => {});
		await close(remoteServer).catch(() => {});
		fixture.cleanup();
	}
});
