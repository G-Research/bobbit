import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import http from "node:http";

async function startRegistry(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url === "/registry.json") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				schemaVersion: 1,
				servers: [
					{
						id: "docs-remote",
						name: "docs_runtime",
						label: "Docs MCP",
						description: "Remote docs MCP",
						version: "1.0.0",
						transport: { type: "http", url: `http://127.0.0.1:${(server.address() as any).port}/mcp` },
					},
					{
						id: "stdio-docs",
						name: "stdio_docs",
						description: "Stdio docs MCP",
						transport: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] },
					},
				],
			}));
			return;
		}
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as any).port;
	return {
		url: `http://127.0.0.1:${port}/registry.json`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function cleanup(sourceId?: string): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: "mcp-docs-remote" }),
	}).catch(() => {});
	if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Marketplace MCP API integration", () => {
	test("registry browse, install, activation reload, and uninstall update MCP runtime", async ({ gateway }) => {
		await gateway.sessionManager.initMcp(gateway.bobbitDir);
		const registry = await startRegistry();
		let sourceId: string | undefined;
		try {
			const add = await apiFetch("/api/marketplace/sources", {
				method: "POST",
				body: JSON.stringify({ url: registry.url, type: "mcp-registry" }),
			});
			expect(add.status).toBe(201);
			sourceId = (await add.json()).source.id;

			const browse = await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId!)}/packs`);
			expect(browse.status).toBe(200);
			const packs = (await browse.json()).packs;
			expect(packs.map((p: any) => p.name)).toContain("mcp-docs-remote");
			expect(packs.find((p: any) => p.name === "mcp-docs-remote")).toMatchObject({ virtual: true, sourceType: "mcp-registry", serverName: "docs_runtime" });

			const install = await apiFetch("/api/marketplace/install", {
				method: "POST",
				body: JSON.stringify({ sourceId, dirName: "mcp-docs-remote", scope: "server" }),
			});
			expect(install.status).toBe(201);
			const installBody = await install.json();
			expect(installBody.installed.manifest.contents.mcp).toEqual(["docs-remote"]);
			expect(installBody.mcpReload?.status).toBeTruthy();

			const activation = await apiFetch("/api/marketplace/pack-activation?scope=server&packName=mcp-docs-remote");
			expect(activation.status).toBe(200);
			const activationBody = await activation.json();
			expect(activationBody.catalogue.mcp[0]).toMatchObject({ ref: "docs-remote", serverName: "docs_runtime", label: "Docs MCP", transport: "http" });

			let mcp = await apiFetch("/api/mcp-servers");
			expect(mcp.status).toBe(200);
			expect((await mcp.json()).some((s: any) => s.name === "docs_runtime")).toBe(true);

			const disable = await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName: "mcp-docs-remote", disabled: { mcp: ["docs-remote"] } }),
			});
			expect(disable.status).toBe(200);
			expect((await disable.json()).disabled.mcp).toEqual(["docs-remote"]);
			mcp = await apiFetch("/api/mcp-servers");
			expect((await mcp.json()).some((s: any) => s.name === "docs_runtime")).toBe(false);

			const enable = await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({ scope: "server", packName: "mcp-docs-remote", disabled: { mcp: [] } }),
			});
			expect(enable.status).toBe(200);
			mcp = await apiFetch("/api/mcp-servers");
			expect((await mcp.json()).some((s: any) => s.name === "docs_runtime")).toBe(true);

			const del = await apiFetch("/api/marketplace/installed", {
				method: "DELETE",
				body: JSON.stringify({ scope: "server", packName: "mcp-docs-remote" }),
			});
			expect(del.status).toBe(204);
			mcp = await apiFetch("/api/mcp-servers");
			expect((await mcp.json()).some((s: any) => s.name === "docs_runtime")).toBe(false);
		} finally {
			await cleanup(sourceId);
			await registry.close();
		}
	});
});
