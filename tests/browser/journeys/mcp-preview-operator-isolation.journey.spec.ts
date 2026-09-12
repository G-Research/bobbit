import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
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
	return `(() => {
		const report = document.getElementById("isolation-result");
		let storageReadable = false;
		let credential = "";
		for (const readStorage of [
			() => localStorage,
			() => parent.localStorage,
			() => opener ? opener.localStorage : null,
		]) {
			try {
				const storage = readStorage();
				if (!storage) continue;
				const raw = storage.getItem("mcp.operator.credentials.v1");
				storageReadable = true;
				if (!raw) continue;
				const parsed = JSON.parse(raw);
				credential = Object.values(parsed).find(value => typeof value === "string") || "";
				if (credential) break;
			} catch {}
		}
		const headers = credential
			? { "Content-Type": "application/json", "X-Bobbit-Mcp-Operator": credential }
			: { "Content-Type": "text/plain" };
		fetch(${JSON.stringify(endpoint)}, {
			method: "POST",
			credentials: "include",
			headers,
			body: ${JSON.stringify(JSON.stringify(body))},
		}).then(response => String(response.status), () => "network-error").then(status => {
			report.setAttribute("data-storage-readable", String(storageReadable));
			report.setAttribute("data-credential-stolen", credential ? "yes" : "no");
			report.setAttribute("data-decision-status", status);
			report.textContent = "attack-finished";
		});
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
	await expect(report).toHaveAttribute("data-credential-stolen", "no");
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

test.use({ enableMcp: true, gatewayStateGroup: "mcp-preview-operator-isolation" });
test.describe.configure({ mode: "serial" });

test("repository inline, mounted, popout, and SVG previews cannot spend browser-held MCP decision authority", async ({ page, gateway }) => {
	test.setTimeout(120_000);
	const fixture = createMcpProjectApprovalFixture();
	const localSpawnMarker = join(fixture.primaryRoot, "local-mcp-spawned.txt");
	let remoteRequests = 0;
	const remoteServer = createServer((_request, response) => {
		remoteRequests += 1;
		response.writeHead(500, { "Content-Type": "text/plain" });
		response.end("pending MCP server must never reach this listener");
	});
	const remotePort = await listen(remoteServer);
	const pairingCode = gateway.createMcpOperatorPairingCode().code;
	const approvalPosts: string[] = [];
	page.context().on("request", request => {
		const url = new URL(request.url());
		if (request.method() === "POST" && url.pathname.includes("/api/mcp-servers/") && url.pathname.endsWith("/approval")) {
			approvalPosts.push(request.url());
		}
	});

	writeFileSync(fixture.primaryConfigPath, JSON.stringify({
		mcpServers: {
			[LOCAL_SERVER_NAME]: {
				command: process.execPath,
				args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(localSpawnMarker)}, "spawned"); setInterval(() => {}, 1000)`],
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
		await navigateToHash(page, `#/session/${sessionId}`);
		const banner = page.locator('[data-testid="mcp-approval-banner"]');
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await banner.locator('[data-testid="mcp-review-servers"]').click();
		const pairing = page.locator('[data-testid="mcp-pairing-callout"]');
		await pairing.locator('[data-testid="mcp-pairing-code"]').fill(pairingCode);
		await pairing.locator('[data-testid="mcp-pair-browser"]').click();
		await expect(pairing.locator('[data-testid="mcp-pairing-notice"]')).toContainText("no decision was made");
		await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem("mcp.operator.credentials.v1")))).toBe(true);

		await navigateToHash(page, `#/session/${sessionId}`);
		await page.reload();
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
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
		const mountResponse = await apiFetch(`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`, {
			method: "POST",
			body: JSON.stringify({ html: htmlAttack(approvalEndpoint, approvalBody, "mounted-or-popout"), entry: "repository-mounted-attack.html" }),
		});
		expect(mountResponse.status).toBe(200);
		await mountResponse.json();

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

		const svgResponse = await apiFetch(`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`, {
			method: "POST",
			body: JSON.stringify({ html: svgAttack(approvalEndpoint, approvalBody), entry: "repository-active-attack.svg" }),
		});
		expect(svgResponse.status).toBe(200);
		const svgMount = await svgResponse.json() as { url: string };
		const svgPage = await page.context().newPage();
		extraPages.push(svgPage);
		await svgPage.goto(new URL(svgMount.url, gateway.baseURL).href);
		await expectIsolated(svgPage);

		await expect.poll(() => approvalPosts.length, {
			timeout: 10_000,
			message: "each hostile preview surface should attempt the real MCP approval endpoint",
		}).toBeGreaterThanOrEqual(4);
		await new Promise(resolve => setTimeout(resolve, 300));
		const afterAttacks = await mcpStatuses(primaryProjectId);
		for (const status of [named(afterAttacks, LOCAL_SERVER_NAME), named(afterAttacks, REMOTE_SERVER_NAME)]) {
			expect(status.approval.state).toBe("pending");
			expect(status.status).toBe("disconnected");
			expect(status.toolCount).toBe(0);
		}
		expect(existsSync(localSpawnMarker), "pending local MCP command must never spawn").toBe(false);
		expect(remoteRequests, "pending remote MCP endpoint must receive no requests").toBe(0);
	} finally {
		for (const extraPage of extraPages) await extraPage.close().catch(() => {});
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		if (secondaryProjectId) await apiFetch(`/api/projects/${encodeURIComponent(secondaryProjectId)}`, { method: "DELETE" }).catch(() => {});
		if (primaryProjectId) await apiFetch(`/api/projects/${encodeURIComponent(primaryProjectId)}`, { method: "DELETE" }).catch(() => {});
		await close(remoteServer).catch(() => {});
		fixture.cleanup();
	}
});
