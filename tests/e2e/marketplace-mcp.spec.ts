import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProjectId } from "./e2e-setup.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_MCP_SERVER = path.resolve(__dirname, "..", "fixtures", "mock-mcp-server.mjs");

async function startGateway(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer(async (req, res) => {
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (pathname === "/signin/aigateway") {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		if (pathname !== "/readonly/mcp") {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		if (req.method === "GET") {
			res.writeHead(405, { "content-type": "text/plain", allow: "POST" });
			res.end("method not allowed");
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405, { "content-type": "text/plain", allow: "POST" });
			res.end("method not allowed");
			return;
		}

		let body = "";
		for await (const chunk of req) body += chunk;
		const message = JSON.parse(body || "{}");
		if (message.method === "notifications/initialized") {
			res.writeHead(202, { "content-type": "text/plain" });
			res.end();
			return;
		}
		if (message.method === "initialize") {
			writeSseRpcResult(res, message.id, {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "mcp-gateway", version: "0.0.0-test" },
			});
			return;
		}
		if (message.method === "tools/list") {
			writeSseRpcResult(res, message.id, { tools: gatewayTools() });
			return;
		}
		writeSseRpcResult(res, message.id, {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as any).port;
	return {
		url: `http://127.0.0.1:${port}/readonly/mcp`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function writeSseRpcResult(res: http.ServerResponse, id: unknown, result: Record<string, unknown>): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
}

function gatewayTools(): Array<Record<string, unknown>> {
	return [
		gatewayTool("confluence__confluence_get_page", "Confluence", "Confluence docs tools", "Get a Confluence page"),
		gatewayTool("jira__jira_search", "Jira", "Jira issue tools", "Search Jira issues"),
		gatewayTool("jira__jira_get_issue", "Jira", "Jira issue tools", "Get a Jira issue"),
		gatewayTool("jira-readonly__jira_search", "Jira readonly", "Read-only Jira tools", "Search Jira issues read-only"),
	];
}

function gatewayTool(name: string, providerLabel: string, providerDescription: string, description: string): Record<string, unknown> {
	return { name, providerLabel, providerDescription, description, inputSchema: { type: "object", properties: {} } };
}

function findGatewayServer(servers: any[], subNamespace = "jira"): any | undefined {
	return servers.find((s: any) => s.name === "gr" || s.ownerContributions?.some((c: any) => c.serverName === "gr" && c.subNamespace === subNamespace));
}

function hasGatewaySubNamespace(servers: any[], subNamespace = "jira"): boolean {
	return Boolean(findGatewayServer(servers, subNamespace)?.activeSubNamespaces?.includes(subNamespace));
}

async function cleanup(sourceId?: string, projectId?: string, packNames: string[] = []): Promise<void> {
	for (const packName of new Set(["mcp-drop-pack", ...packNames.filter(Boolean)])) {
		await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName }),
		}).catch(() => {});
		if (projectId) {
			await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "project", projectId, packName }),
			}).catch(() => {});
		}
	}
	if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
}

async function browseRemoteGatewayPack(sourceId: string): Promise<any> {
	const browse = await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}/packs`);
	expect(browse.status).toBe(200);
	const packs = (await browse.json()).packs;
	expect(packs.map((p: any) => p.gatewayProviderId).sort()).toEqual(["confluence", "jira", "jira-readonly"]);
	const pack = packs.find((p: any) => p.gatewayProviderId === "jira");
	expect(pack).toBeTruthy();
	return pack;
}

function writeAuthoredMcpPack(repo: string): void {
	const packDir = path.join(repo, "mcp-drop-pack");
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.mkdirSync(path.join(packDir, "mcp"), { recursive: true });
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"name: mcp-drop-pack",
		"description: MCP update regression pack",
		"version: 1.0.0",
		"schema: 2",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  mcp: [drop-server]",
		"",
	].join("\n"), "utf-8");
	fs.writeFileSync(path.join(packDir, "mcp", "drop-server.json"), JSON.stringify({
		server: "drop_runtime",
		transport: { type: "stdio", command: process.execPath, args: [MOCK_MCP_SERVER] },
	}, null, 2), "utf-8");
}

function writeAuthoredNonMcpPack(repo: string): void {
	const packDir = path.join(repo, "mcp-drop-pack");
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.mkdirSync(packDir, { recursive: true });
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"name: mcp-drop-pack",
		"description: MCP update regression pack without MCP",
		"version: 2.0.0",
		"schema: 2",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"",
	].join("\n"), "utf-8");
}

test.describe("Marketplace MCP API integration", () => {
	test("gateway browse, install, activation reload, and uninstall update MCP runtime", async ({ gateway }) => {
		await gateway.sessionManager.initMcp(gateway.bobbitDir);
		const gatewaySource = await startGateway();
		let sourceId: string | undefined;
		let packName: string | undefined;
		try {
			const add = await apiFetch("/api/marketplace/sources", {
				method: "POST",
				body: JSON.stringify({ url: gatewaySource.url, type: "mcp-gateway" }),
			});
			expect(add.status).toBe(201);
			const addBody = await add.json();
			sourceId = addBody.source.id;
			expect(addBody.source.displayName).toMatch(/127\.0\.0\.1:\d+\/readonly\/mcp/);

			const unionBrowse = await apiFetch("/api/marketplace/browse");
			expect(unionBrowse.status).toBe(200);
			const unionBrowseBody = await unionBrowse.json();
			expect(unionBrowseBody.sources).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId, sourceType: "mcp-gateway", status: "ok", sourceName: addBody.source.displayName })]));

			const pack = await browseRemoteGatewayPack(sourceId!);
			packName = pack.name;
			expect(pack.name).toMatch(/^mcp-jira-/);
			expect(pack).toMatchObject({
				virtual: true,
				sourceType: "mcp-gateway",
				gatewayProviderId: "jira",
				mcp: [{ ref: "jira", serverName: "gr", subNamespace: "jira", transport: "http", url: expect.stringContaining("/readonly/mcp") }],
			});

			const install = await apiFetch("/api/marketplace/install", {
				method: "POST",
				body: JSON.stringify({ sourceId, dirName: pack.dirName, scope: "server" }),
			});
			expect(install.status).toBe(201);
			const installBody = await install.json();
			expect(installBody.installed.manifest.contents.mcp).toEqual(["jira"]);
			expect(installBody.mcpReload?.status).toBeTruthy();

			const activation = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${encodeURIComponent(pack.name)}`);
			expect(activation.status).toBe(200);
			const activationBody = await activation.json();
			const contributionId = activationBody.catalogue.mcp[0].contributionId;
			expect(contributionId).toMatch(/^mcp:[a-f0-9]{16}$/);
			expect(activationBody.catalogue.mcp[0]).toMatchObject({ ref: "jira", contributionId, serverName: "gr", subNamespace: "jira", label: "Jira", transport: "http", totalOperationCount: 2, selectedOperationCount: 2 });
			expect(activationBody.catalogue.mcp[0].operations.map((op: any) => op.name)).toEqual(["jira_search", "jira_get_issue"]);
			expect(activationBody.revision).toMatch(/^act:/);

			const stalePatch = await apiFetch("/api/marketplace/pack-activation/mcp-operation", {
				method: "PATCH",
				body: JSON.stringify({ scope: "server", contributionId, operationName: "jira_search", disabled: true, expectedRevision: "act:stale" }),
			});
			expect(stalePatch.status).toBe(409);
			expect((await stalePatch.json()).code).toBe("STALE_REVISION");

			const invalidPatch = await apiFetch("/api/marketplace/pack-activation/mcp-operation", {
				method: "PATCH",
				body: JSON.stringify({ scope: "server", contributionId, operationName: "missing_op", disabled: true, expectedRevision: activationBody.revision }),
			});
			expect(invalidPatch.status).toBe(400);

			const patchOp = await apiFetch("/api/marketplace/pack-activation/mcp-operation", {
				method: "PATCH",
				body: JSON.stringify({ scope: "server", contributionId, operationName: "jira_search", disabled: true, expectedRevision: activationBody.revision }),
			});
			expect(patchOp.status).toBe(200);
			const patchOpBody = await patchOp.json();
			expect(patchOpBody.disabled.mcpOperations[contributionId]).toEqual(["jira_search"]);
			expect(patchOpBody.catalogue.mcp[0]).toMatchObject({ selectedOperationCount: 1, totalOperationCount: 2, disabledOperations: ["jira_search"] });

			let mcp = await apiFetch("/api/mcp-servers");
			expect(mcp.status).toBe(200);
			let servers = await mcp.json();
			let gr = findGatewayServer(servers);
			expect(gr?.activeSubNamespaces).toContain("jira");
			expect(gr?.tools).toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "mcp__gr__jira__jira_get_issue", subNamespace: "jira", op: "jira_get_issue" }),
			]));
			expect(gr?.tools?.some((tool: any) => tool.name === "mcp__gr__jira__jira_search")).toBe(false);

			const disable = await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName: pack.name, disabled: { mcp: [contributionId], mcpOperations: { [contributionId]: ["jira_search", "retired_op"] } } }),
			});
			expect(disable.status).toBe(200);
			const disableBody = await disable.json();
			expect(disableBody.disabled.mcp).toEqual([contributionId]);
			expect(disableBody.disabled.mcpOperations[contributionId]).toEqual(["jira_search", "retired_op"]);
			expect(disableBody.catalogue.mcp[0].staleDisabledOperations).toEqual(["retired_op"]);
			mcp = await apiFetch("/api/mcp-servers");
			servers = await mcp.json();
			gr = findGatewayServer(servers);
			expect(gr?.activeSubNamespaces ?? []).not.toContain("jira");

			const enable = await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName: pack.name, disabled: { mcp: [] } }),
			});
			expect(enable.status).toBe(200);
			mcp = await apiFetch("/api/mcp-servers");
			servers = await mcp.json();
			gr = findGatewayServer(servers);
			expect(gr?.activeSubNamespaces).toContain("jira");

			const del = await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "server", packName: pack.name }),
			});
			expect(del.status).toBe(204);
			mcp = await apiFetch("/api/mcp-servers");
			expect(hasGatewaySubNamespace(await mcp.json())).toBe(false);
		} finally {
			await cleanup(sourceId, undefined, packName ? [packName] : []);
			await gatewaySource.close();
		}
	});

	test("new mcp-registry source creation is rejected with migration message", async () => {
		const add = await apiFetch("/api/marketplace/sources", {
			method: "POST",
			body: JSON.stringify({ url: "https://registry.modelcontextprotocol.io/v0/servers", type: "mcp-registry" }),
		});
		expect(add.status).toBe(400);
		expect((await add.json()).error).toMatch(/mcp-registry sources are no longer supported; use type mcp-gateway/i);
	});

	test("authored pack update from MCP to non-MCP disconnects stale runtime and tools", async ({ gateway }) => {
		await gateway.sessionManager.initMcp(gateway.bobbitDir);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-mcp-update-"));
		const repo = path.join(root, "repo");
		fs.mkdirSync(repo, { recursive: true });
		writeAuthoredMcpPack(repo);
		let sourceId: string | undefined;
		try {
			const add = await apiFetch("/api/marketplace/sources", {
				method: "POST",
				body: JSON.stringify({ url: repo }),
			});
			expect(add.status).toBe(201);
			sourceId = (await add.json()).source.id;

			const install = await apiFetch("/api/marketplace/install", {
				method: "POST",
				body: JSON.stringify({ sourceId, dirName: "mcp-drop-pack", scope: "server" }),
			});
			expect(install.status).toBe(201);
			expect((await install.json()).mcpReload?.connected).toContain("drop_runtime");

			let mcp = await apiFetch("/api/mcp-servers");
			expect(mcp.status).toBe(200);
			expect((await mcp.json()).some((s: any) => s.name === "drop_runtime" && s.status === "connected")).toBe(true);
			let toolsBody = await (await apiFetch("/api/tools")).json();
			expect(toolsBody.tools.map((t: any) => t.name)).toContain("mcp__drop_runtime__echo");

			writeAuthoredNonMcpPack(repo);
			const update = await apiFetch("/api/marketplace/update", {
				method: "POST",
				body: JSON.stringify({ scope: "server", packName: "mcp-drop-pack" }),
			});
			expect(update.status).toBe(200);
			const updateBody = await update.json();
			expect(updateBody.installed.manifest.contents.mcp).toEqual([]);
			expect(updateBody.mcpReload?.disconnected).toContain("drop_runtime");

			mcp = await apiFetch("/api/mcp-servers");
			expect((await mcp.json()).some((s: any) => s.name === "drop_runtime")).toBe(false);
			toolsBody = await (await apiFetch("/api/tools")).json();
			expect(toolsBody.tools.map((t: any) => t.name)).not.toContain("mcp__drop_runtime__echo");
		} finally {
			await cleanup(sourceId);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("project-scope gateway install appears only in project MCP runtime", async ({ gateway }) => {
		await gateway.sessionManager.initMcp(gateway.bobbitDir);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const gatewaySource = await startGateway();
		let sourceId: string | undefined;
		let packName: string | undefined;
		try {
			const add = await apiFetch("/api/marketplace/sources", {
				method: "POST",
				body: JSON.stringify({ url: gatewaySource.url, type: "mcp-gateway" }),
			});
			expect(add.status).toBe(201);
			sourceId = (await add.json()).source.id;
			const pack = await browseRemoteGatewayPack(sourceId!);
			packName = pack.name;

			const install = await apiFetch("/api/marketplace/install", {
				method: "POST",
				body: JSON.stringify({ sourceId, dirName: pack.dirName, scope: "project", projectId }),
			});
			expect(install.status).toBe(201);
			expect((await install.json()).mcpReload?.status).toBeTruthy();

			const scoped = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId!)}`);
			expect(scoped.status).toBe(200);
			const scopedGr = findGatewayServer(await scoped.json());
			expect(scopedGr?.activeSubNamespaces).toContain("jira");
			expect(scopedGr?.tools).toEqual(expect.arrayContaining([
				expect.objectContaining({ name: "mcp__gr__jira__jira_search", subNamespace: "jira", op: "jira_search" }),
			]));

			const global = await apiFetch("/api/mcp-servers");
			expect(global.status).toBe(200);
			expect(hasGatewaySubNamespace(await global.json())).toBe(false);

			const activation = await apiFetch(`/api/marketplace/pack-activation?scope=project&projectId=${encodeURIComponent(projectId!)}&packName=${encodeURIComponent(pack.name)}`);
			expect(activation.status).toBe(200);
			expect((await activation.json()).catalogue.mcp[0]).toMatchObject({ ref: "jira", serverName: "gr", subNamespace: "jira", transport: "http" });
		} finally {
			await cleanup(sourceId, projectId, packName ? [packName] : []);
			await gatewaySource.close();
		}
	});
});
