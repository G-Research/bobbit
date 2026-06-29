import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const {
	McpGatewayError,
	candidateGatewayCatalogueUrls,
	fetchMcpGatewayWithDiagnostics,
	gatewayPackNameForProvider,
	gatewayProviderToVirtualPack,
	isLegacyMcpRegistrySource,
	isMcpGatewaySource,
	materializeGatewayProviderPack,
	parseMcpGatewayDocument,
} = await import("../src/server/agent/mcp-gateway-source.ts");

let TMP: string;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gateway-")); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

const SOURCE_URL = "http://mcp-local.t3.zone/readonly/mcp";

function source(url = SOURCE_URL): any {
	return { id: "gateway", type: "mcp-gateway", url, addedAt: "2026-01-01T00:00:00.000Z" };
}

type MockGatewayRequest = { method?: string; path?: string; rpcMethod?: string };

async function withStreamableMcpGateway(fn: (ctx: { url: string; requests: MockGatewayRequest[] }) => Promise<void>): Promise<void> {
	const requests: MockGatewayRequest[] = [];
	const server = http.createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		requests.push({ method: req.method, path });
		if (path === "/signin/aigateway") {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		if (path !== "/readonly/mcp") {
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
		requests[requests.length - 1].rpcMethod = message.method;
		if (message.method === "initialize") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "mcp-gateway", version: "0.0.0-test" },
				},
			}));
			return;
		}
		if (message.method === "tools/list") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					tools: [
						{ name: "jira__jira_search", description: "Search Jira issues", inputSchema: { type: "object", properties: {} } },
						{ name: "jira__jira_get_issue", description: "Get a Jira issue", inputSchema: { type: "object", properties: {} } },
						{ name: "confluence__confluence_get_page", description: "Get a Confluence page", inputSchema: { type: "object", properties: {} } },
					],
				},
			}));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	try {
		await fn({ url: `http://127.0.0.1:${port}/readonly/mcp`, requests });
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe("MCP gateway catalogue primitives", () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(TMP, "case-")); });

	it("identifies gateway and legacy registry source rows", () => {
		assert.equal(isMcpGatewaySource(source()), true);
		assert.equal(isLegacyMcpRegistrySource(source()), false);
		assert.equal(isMcpGatewaySource({ id: "reg", type: "mcp-registry", url: SOURCE_URL, addedAt: "now" } as any), false);
		assert.equal(isLegacyMcpRegistrySource({ id: "reg", type: "mcp-registry", url: SOURCE_URL, addedAt: "now" } as any), true);
	});

	it("derives catalogue URL candidates from read and write MCP endpoints", () => {
		assert.deepEqual(candidateGatewayCatalogueUrls("http://mcp-local.t3.zone/readonly/mcp/"), [
			"http://mcp-local.t3.zone/signin/aigateway",
			"http://mcp-local.t3.zone/readonly/mcp",
		]);
		assert.deepEqual(candidateGatewayCatalogueUrls("https://mcp.example.com/write/mcp"), [
			"https://mcp.example.com/signin/aigateway",
			"https://mcp.example.com/write/mcp",
		]);
		assert.deepEqual(candidateGatewayCatalogueUrls("https://mcp.example.com/catalogue"), ["https://mcp.example.com/catalogue"]);
		assert.throws(() => candidateGatewayCatalogueUrls("https://user:pass@mcp.example.com/readonly/mcp"), /must not contain credentials/);
		assert.throws(() => candidateGatewayCatalogueUrls("file:///tmp/catalogue.json"), /must use http or https/);
	});

	it("fetches bounded JSON, falls back from derived candidate to original, and reports malformed responses", async () => {
		const fetched: string[] = [];
		const parsed = await fetchMcpGatewayWithDiagnostics(source(), {
			fetchFn: async (input: RequestInfo | URL) => {
				const url = String(input);
				fetched.push(url);
				if (url.endsWith("/signin/aigateway")) return new Response(JSON.stringify({ unsupported: true }));
				return new Response(JSON.stringify({ providers: [{ id: "jira", label: "Jira" }] }));
			},
		});
		assert.deepEqual(fetched, ["http://mcp-local.t3.zone/signin/aigateway", SOURCE_URL]);
		assert.deepEqual(parsed.providers.map((p: any) => p.id), ["jira"]);

		await assert.rejects(
			() => fetchMcpGatewayWithDiagnostics(source("https://mcp.example.com/catalogue"), {
				maxBodyBytes: 10,
				fetchFn: async () => new Response("{}", { headers: { "content-length": "11" } }),
			}),
			/Content-Length 11 exceeds limit 10/,
		);
		await assert.rejects(
			() => fetchMcpGatewayWithDiagnostics(source("https://mcp.example.com/catalogue"), {
				maxBodyBytes: 20,
				fetchFn: async () => new Response(JSON.stringify({ providers: [] }).repeat(3)),
			}),
			/body exceeds limit 20/,
		);
		await assert.rejects(
			() => fetchMcpGatewayWithDiagnostics(source("https://mcp.example.com/catalogue"), {
				fetchFn: async () => new Response("not json"),
			}),
			/not valid JSON/,
		);
		await assert.rejects(
			() => fetchMcpGatewayWithDiagnostics(source("https://mcp.example.com/catalogue"), {
				timeoutMs: 1,
				fetchFn: (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
			}),
			/timed out after 1ms/,
		);
	});

	it("discovers providers from streamable HTTP MCP tools/list when no JSON catalogue exists", async () => {
		await withStreamableMcpGateway(async ({ url, requests }) => {
			const parsed = await fetchMcpGatewayWithDiagnostics(source(url));
			assert.deepEqual(parsed.providers.map((p: any) => p.id).sort(), ["confluence", "jira"]);
			const jira = parsed.providers.find((p: any) => p.id === "jira");
			assert.deepEqual(jira.operations.map((op: any) => op.name), ["jira_search", "jira_get_issue"]);
			const confluence = parsed.providers.find((p: any) => p.id === "confluence");
			assert.deepEqual(confluence.operations.map((op: any) => op.name), ["confluence_get_page"]);
			assert.ok(requests.some((r) => r.method === "POST" && r.path === "/readonly/mcp" && r.rpcMethod === "initialize"));
			assert.ok(requests.some((r) => r.method === "POST" && r.path === "/readonly/mcp" && r.rpcMethod === "tools/list"));
			assert.equal(requests.some((r) => r.path === "/signin/aigateway"), false);
		});
	});

	it("parses provider catalogues while skipping unsafe, duplicate, and non-HTTP entries", () => {
		const parsed = parseMcpGatewayDocument({
			providers: [
				{ id: "jira", label: "Jira", description: "Jira issue tools", operations: [{ name: "jira_search", description: "Search issues" }] },
				{ id: "jira", label: "Duplicate Jira" },
				{ id: "bad/id", label: "Unsafe" },
				{ id: "confluence", read: { url: "ftp://mcp.example.com/mcp" } },
			],
		}, SOURCE_URL);
		assert.equal(parsed.providers.length, 1);
		assert.equal(parsed.providers[0].id, "jira");
		assert.equal(parsed.providers[0].read.server, "gr");
		assert.equal(parsed.providers[0].read.url, SOURCE_URL);
		assert.deepEqual(parsed.providers[0].operations, [{ name: "jira_search", description: "Search issues" }]);
		assert.equal(parsed.skipped.length, 3);
		assert.ok(parsed.skipped.some((entry: any) => /duplicate gateway provider id: jira/.test(entry.reason)));
		assert.ok(parsed.skipped.some((entry: any) => /unsafe gateway provider id: bad\/id/.test(entry.reason)));
		assert.ok(parsed.skipped.some((entry: any) => /read gateway URL must use http or https/.test(entry.reason)));
		assert.ok(McpGatewayError);
	});

	it("accepts data.providers and tools grouped by provider namespace", () => {
		const dataParsed = parseMcpGatewayDocument({ data: { providers: [{ namespace: "confluence", title: "Confluence" }] } }, SOURCE_URL);
		assert.deepEqual(dataParsed.providers.map((p: any) => p.id), ["confluence"]);
		assert.equal(dataParsed.providers[0].label, "Confluence");

		const toolsParsed = parseMcpGatewayDocument({
			tools: [
				{ name: "jira__jira_search", providerLabel: "Jira", providerDescription: "Jira issue tools" },
				{ name: "jira__jira_get_issue" },
				{ name: "confluence__search", providerLabel: "Confluence" },
			],
		}, SOURCE_URL);
		assert.deepEqual(toolsParsed.providers.map((p: any) => p.id).sort(), ["confluence", "jira"]);
		const jira = toolsParsed.providers.find((p: any) => p.id === "jira");
		assert.deepEqual(jira.operations.map((op: any) => op.name), ["jira_search", "jira_get_issue"]);
	});

	it("builds provider-scoped virtual packs", () => {
		const [provider] = parseMcpGatewayDocument({ providers: [{ id: "jira", label: "Jira", description: "Jira issue tools", version: "1.2.3", headers: { "X-Gateway": "readonly" } }] }, SOURCE_URL).providers;
		const pack = gatewayProviderToVirtualPack(provider);
		assert.equal(pack.virtual, true);
		assert.equal(pack.sourceType, "mcp-gateway");
		assert.equal(pack.gatewayProviderId, "jira");
		assert.equal(pack.serverName, "gr");
		assert.equal(pack.name, gatewayPackNameForProvider("jira"));
		assert.equal(pack.schema, 2);
		assert.deepEqual(pack.contents, { roles: [], tools: [], skills: [], entrypoints: [], mcp: ["jira"] });
		assert.deepEqual(pack.descriptions, { mcp: { jira: "Jira issue tools" } });
		assert.deepEqual(pack.mcp, [{ ref: "jira", listName: "jira", serverName: "gr", subNamespace: "jira", label: "Jira", description: "Jira issue tools", transport: "http", url: SOURCE_URL, headers: ["X-Gateway"] }]);
	});

	it("materializes read and write gateway provider MCP contributions", () => {
		const [provider] = parseMcpGatewayDocument({
			providers: [{
				id: "jira",
				label: "Jira",
				description: "Jira issue tools",
				readUrl: SOURCE_URL,
				writeUrl: "http://mcp-local.t3.zone/write/mcp",
				writeHeaders: { "X-Gateway": "write" },
			}],
		}, SOURCE_URL).providers;
		const dest = path.join(dir, "mcp-jira");
		const manifest = materializeGatewayProviderPack(provider, dest, { sourceUrl: SOURCE_URL, materializedAt: "2026-06-29T00:00:00.000Z" });
		assert.equal(manifest.name, "mcp-jira");
		assert.deepEqual(parse(fs.readFileSync(path.join(dest, "pack.yaml"), "utf-8")), {
			schema: 2,
			name: "mcp-jira",
			description: "Jira issue tools",
			version: "0.0.0",
			contents: { roles: [], tools: [], skills: [], entrypoints: [], mcp: ["jira", "jira-write"] },
		});
		assert.deepEqual(parse(fs.readFileSync(path.join(dest, "mcp", "jira.yaml"), "utf-8")), {
			server: "gr",
			subNamespace: "jira",
			label: "Jira",
			description: "Jira issue tools",
			transport: { type: "http", url: SOURCE_URL },
		});
		assert.deepEqual(parse(fs.readFileSync(path.join(dest, "mcp", "jira-write.yaml"), "utf-8")), {
			server: "gr-write",
			subNamespace: "jira",
			label: "Jira write",
			description: "Jira issue tools (write-capable)",
			transport: { type: "http", url: "http://mcp-local.t3.zone/write/mcp", headers: { "X-Gateway": "write" } },
		});
		const meta = parse(fs.readFileSync(path.join(dest, ".pack-meta.yaml"), "utf-8")) as Record<string, unknown>;
		assert.equal(meta.sourceType, "mcp-gateway");
		assert.equal(meta.sourceUrl, SOURCE_URL);
		assert.equal(meta.gatewayProviderId, "jira");
		assert.match(String(meta.gatewayFingerprint), /^[a-f0-9]{64}$/);
	});
});
