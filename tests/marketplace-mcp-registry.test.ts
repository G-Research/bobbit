import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

const { MarketplaceSourceStore } = await import("../src/server/agent/marketplace-source-store.ts");
const {
	fetchMcpRegistryWithDiagnostics,
	isMcpRegistrySource,
	parseMcpRegistryDocument,
	registryPackNameForId,
	registryServerToVirtualPack,
	materializeRegistryPack,
	officialRegistryInstallId,
	officialRegistryRuntimeName,
	officialRegistrySourceKey,
	McpRegistryError,
} = await import("../src/server/agent/mcp-registry-source.ts");

let TMP: string;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-registry-")); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

const SOURCE_URL = "https://registry.modelcontextprotocol.io/v0/servers";

describe("Marketplace MCP registry source primitives", () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(TMP, "case-")); });

	it("persists source type only for mcp-registry and rejects refs", () => {
		const store = new MarketplaceSourceStore(dir);
		const pack = store.add({ url: "https://example.com/packs.git", ref: "v1" });
		assert.equal(pack.type, undefined);
		assert.equal(pack.ref, "v1");
		const registry = store.add({ url: SOURCE_URL, type: "mcp-registry" });
		assert.equal(registry.type, "mcp-registry");
		assert.equal(registry.ref, undefined);
		assert.equal(isMcpRegistrySource(registry), true);
		assert.throws(
			() => store.add({ url: "https://registry.example.com/other.json", type: "mcp-registry", ref: "main" }),
			/mcp-registry sources do not support ref/,
		);
		assert.throws(() => store.update(registry.id, { ref: "main" }), /mcp-registry sources do not support ref/);

		const raw = parse(fs.readFileSync(path.join(dir, "marketplace-sources.yaml"), "utf-8")) as { sources: Array<Record<string, unknown>> };
		assert.equal(raw.sources.find((s) => s.id === pack.id)?.type, undefined);
		assert.equal(raw.sources.find((s) => s.id === registry.id)?.type, "mcp-registry");
	});

	it("loads legacy registry source rows while dropping malformed ref metadata", () => {
		fs.writeFileSync(
			path.join(dir, "marketplace-sources.yaml"),
			stringify({
				sources: [
					{ id: "reg", type: "mcp-registry", url: SOURCE_URL, ref: "ignored", addedAt: "2026-01-01T00:00:00.000Z" },
					{ id: "bad", type: "wat", url: "https://example.com", addedAt: "2026-01-01T00:00:00.000Z" },
				],
			}),
			"utf-8",
		);
		const store = new MarketplaceSourceStore(dir);
		assert.deepEqual(store.list(), [{ id: "reg", type: "mcp-registry", url: SOURCE_URL, addedAt: "2026-01-01T00:00:00.000Z" }]);
	});

	it("fetches registries with timeout and bounded body checks before parsing official JSON", async () => {
		const source = { id: "reg", type: "mcp-registry" as const, url: SOURCE_URL, addedAt: "2026-01-01T00:00:00.000Z" };
		await assert.rejects(
			() => fetchMcpRegistryWithDiagnostics(source, {
				maxBodyBytes: 10,
				fetchFn: async () => new Response("{}", { headers: { "content-length": "11" } }),
			}),
			/Content-Length 11 exceeds limit 10/,
		);
		await assert.rejects(
			() => fetchMcpRegistryWithDiagnostics(source, {
				maxBodyBytes: 20,
				fetchFn: async () => new Response(JSON.stringify({ servers: [] }).repeat(3)),
			}),
			/body exceeds limit 20/,
		);
		await assert.rejects(
			() => fetchMcpRegistryWithDiagnostics(source, {
				timeoutMs: 1,
				fetchFn: (_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
			}),
			/timed out after 1ms/,
		);
		const parsed = await fetchMcpRegistryWithDiagnostics(source, {
			fetchFn: async () => new Response(JSON.stringify({
				servers: [{ server: { name: "io.modelcontextprotocol/fetch", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }] } }],
			})),
		});
		assert.deepEqual(parsed.servers.map((s) => s.officialName), ["io.modelcontextprotocol/fetch"]);
	});

	it("parses official streamable-http remotes into virtual packs and schema-2 materialized packs", () => {
		const parsed = parseMcpRegistryDocument({
			servers: [{
				_meta: { registryVersion: "2026-06-23" },
				server: {
					name: "ai.adeu/adeu",
					title: "Adeu",
					description: "Remote Adeu MCP",
					version: "1.7.1",
					websiteUrl: "https://adeu.example.com",
					license: "MIT",
					repository: { url: "https://github.com/adeu/adeu", source: "github" },
					_meta: { official: true },
					remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { "X-Static": "ok" } }],
				},
			}],
		}, SOURCE_URL);
		assert.equal(parsed.skipped.length, 0);
		assert.equal(parsed.servers.length, 1);
		const [server] = parsed.servers;
		const expectedId = officialRegistryInstallId({ officialName: "ai.adeu/adeu", version: "1.7.1", sourceUrl: SOURCE_URL, variant: "remote-1" });
		assert.equal(server.id, expectedId);
		assert.equal(server.sourceKey, officialRegistrySourceKey(SOURCE_URL));
		assert.equal(server.officialName, "ai.adeu/adeu");
		assert.equal(server.label, "Adeu");
		assert.equal(server.homepage, "https://adeu.example.com");
		assert.equal(server.license, "MIT");
		assert.deepEqual(server.config, { url: "https://mcp.example.com/mcp", headers: { "X-Static": "ok" } });
		assert.match(server.name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/);
		assert.equal(server.name, officialRegistryRuntimeName({ officialName: "ai.adeu/adeu", version: "1.7.1", sourceUrl: SOURCE_URL, installId: server.id }));

		const pack = registryServerToVirtualPack(server);
		assert.equal(pack.virtual, true);
		assert.equal(pack.sourceType, "mcp-registry");
		assert.equal(pack.dirName, registryPackNameForId(server.id));
		assert.equal(pack.name, registryPackNameForId(server.id));
		assert.equal(pack.schema, 2);
		assert.deepEqual(pack.contents, { roles: [], tools: [], skills: [], entrypoints: [], mcp: [server.id] });
		assert.deepEqual(pack.mcp, [{ ref: server.id, listName: server.id, serverName: server.name, label: "Adeu", description: "Remote Adeu MCP", transport: "http", url: "https://mcp.example.com/mcp", headers: ["X-Static"] }]);

		const dest = path.join(dir, pack.name);
		const manifest = materializeRegistryPack(server, dest, { sourceUrl: SOURCE_URL, materializedAt: "2026-06-23T00:00:00.000Z" });
		assert.equal(manifest.name, pack.name);
		assert.deepEqual(parse(fs.readFileSync(path.join(dest, "pack.yaml"), "utf-8")), {
			schema: 2,
			name: pack.name,
			description: "Remote Adeu MCP",
			version: "1.7.1",
			homepage: "https://adeu.example.com",
			contents: { roles: [], tools: [], skills: [], entrypoints: [], mcp: [server.id] },
		});
		assert.deepEqual(parse(fs.readFileSync(path.join(dest, "mcp", `${server.id}.yaml`), "utf-8")), {
			server: server.name,
			label: "Adeu",
			description: "Remote Adeu MCP",
			transport: { type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Static": "ok" } },
		});
		const meta = parse(fs.readFileSync(path.join(dest, ".pack-meta.yaml"), "utf-8")) as Record<string, unknown>;
		assert.equal(meta.sourceType, "mcp-registry");
		assert.equal(meta.sourceUrl, SOURCE_URL);
		assert.equal(meta.sourceKey, server.sourceKey);
		assert.equal(meta.registryId, server.id);
		assert.equal(meta.registryName, server.name);
		assert.equal(meta.officialName, "ai.adeu/adeu");
		assert.deepEqual(meta.repository, { url: "https://github.com/adeu/adeu", source: "github" });
		assert.deepEqual(meta.registryMeta, { registryVersion: "2026-06-23" });
		assert.deepEqual(meta.serverMeta, { official: true });
		assert.match(String(meta.registryFingerprint), /^[a-f0-9]{64}$/);
	});

	it("derives deterministic source-keyed safe identities without cross-source collisions", () => {
		const sourceA = "https://registry-a.example.com/v0/servers#ignored";
		const sourceB = "https://registry-b.example.com/v0/servers";
		assert.equal(officialRegistrySourceKey(sourceA), officialRegistrySourceKey("https://registry-a.example.com/v0/servers"));
		const doc = { servers: [{ server: { name: "ai.adeu/adeu", version: "1.7.1", remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }] } }] };
		const [a] = parseMcpRegistryDocument(doc, sourceA).servers;
		const [b] = parseMcpRegistryDocument(doc, sourceB).servers;
		assert.notEqual(a.sourceKey, b.sourceKey);
		assert.notEqual(a.id, b.id);
		assert.notEqual(registryPackNameForId(a.id), registryPackNameForId(b.id));
		assert.notEqual(a.name, b.name);
		assert.notEqual(a.fingerprint, b.fingerprint);
		assert.match(a.id, /^ai-adeu-adeu-1-7-1-remote-1-[a-f0-9]{9}$/);
		assert.equal(a.id, officialRegistryInstallId({ officialName: "ai.adeu/adeu", version: "1.7.1", sourceUrl: sourceA, variant: "remote-1" }));

		const longId = officialRegistryInstallId({ officialName: "@scope/" + "very.".repeat(30) + "server", version: "2026.06.23", sourceUrl: sourceA, variant: "remote-1" });
		assert.match(longId, /^[a-z0-9][a-z0-9-]*$/);
		assert.ok(longId.length <= 64, `registry install id must fit contents.mcp list-name limit: ${longId}`);
		assert.equal(registryPackNameForId(longId).startsWith("mcp-"), true);

		const [longServer] = parseMcpRegistryDocument({
			servers: [{ server: { name: "io." + "long-segment.".repeat(18) + "server", version: "2026.06.23-build.abcdef", remotes: [{ type: "streamable-http", url: "https://mcp.example.com/long" }] } }],
		}, sourceA).servers;
		assert.ok(longServer.id.length <= 64, `materialized registry id must fit contents.mcp list-name limit: ${longServer.id}`);
		assert.deepEqual(registryServerToVirtualPack(longServer).contents.mcp, [longServer.id]);
	});

	it("rejects the old Bobbit schemaVersion 1 registry format", () => {
		assert.throws(
			() => parseMcpRegistryDocument({ schemaVersion: 1, servers: [{ id: "old", name: "old", transport: { type: "stdio", command: "node" } }] }, SOURCE_URL),
			/unsupported MCP registry format: expected official MCP Registry API response with servers\[\]\.server/,
		);
		assert.throws(() => parseMcpRegistryDocument({ servers: [{ id: "old" }] }, SOURCE_URL), /servers\[\]\.server/);
		assert.ok(McpRegistryError);
	});

	it("skips unsupported official candidates with actionable diagnostics while keeping valid candidates", () => {
		const parsed = parseMcpRegistryDocument({
			servers: [{
				server: {
					name: "diagnostics/server",
					version: "2.0.0",
					remotes: [
						{ type: "sse", url: "https://mcp.example.com/sse" },
						{ type: "streamable-http", url: "https://mcp.example.com/needs-auth", headers: [{ name: "Authorization", description: "token", isSecret: true, isRequired: true }] },
						{ type: "streamable-http", url: "https://mcp.example.com/mcp" },
					],
					packages: [
						{ registryType: "pypi", identifier: "mcp-server", transport: { type: "stdio" } },
						{ registryType: "npm", identifier: "@example/runtime", runtimeArguments: ["--runtime"], transport: { type: "stdio" } },
						{ registryType: "npm", identifier: "@example/vars", packageArguments: [{ name: "--token", variables: [{ name: "TOKEN" }] }], transport: { type: "stdio" } },
					],
				},
			}],
		}, SOURCE_URL);
		assert.equal(parsed.servers.length, 1);
		assert.equal(parsed.servers[0].transport.type, "http");
		assert.equal(parsed.skipped.length, 5);
		assert.ok(parsed.skipped.some((s) => /unsupported remote transport: sse/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /remote Authorization header requires a user-supplied value/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /unsupported package registryType: pypi \(supported: npm\)/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /runtimeArguments are not supported/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /packageArguments contain variables\/prompts/.test(s.reason)));
	});

	it("skips remote variables and template URLs while keeping valid candidates", () => {
		const parsed = parseMcpRegistryDocument({
			servers: [{
				server: {
					name: "diagnostics/remotes",
					version: "1.0.0",
					remotes: [
						{ type: "streamable-http", url: "https://{tenant}.example.com/mcp" },
						{ type: "streamable-http", url: "https://mcp.example.com/${TENANT}/mcp" },
						{ type: "streamable-http", url: "https://mcp.example.com/mcp", variables: [{ name: "TENANT" }] },
						{ type: "streamable-http", url: "https://mcp.example.com/valid" },
					],
				},
			}],
		}, SOURCE_URL);
		assert.equal(parsed.servers.length, 1);
		assert.equal(parsed.servers[0].transport.type, "http");
		assert.equal(parsed.servers[0].transport.url, "https://mcp.example.com/valid");
		assert.equal(parsed.skipped.length, 3);
		assert.equal(parsed.skipped.filter((s) => /remote url contains variables\/templates/.test(s.reason)).length, 2);
		assert.ok(parsed.skipped.some((s) => /remote variables\/prompts are not supported/.test(s.reason)));
	});

	it("skips package environment variable descriptors and templates while keeping valid candidates", () => {
		const parsed = parseMcpRegistryDocument({
			servers: [{
				server: {
					name: "diagnostics/env",
					version: "1.0.0",
					remotes: [{ type: "streamable-http", url: "https://mcp.example.com/valid" }],
					packages: [
						{ registryType: "npm", identifier: "env-vars-mcp", transport: { type: "stdio" }, environmentVariables: [{ name: "TOKEN", variables: [{ name: "TOKEN" }] }] },
						{ registryType: "npm", identifier: "env-curly-mcp", transport: { type: "stdio" }, environmentVariables: [{ name: "TENANT_URL", default: "https://{tenant}.example.com" }] },
						{ registryType: "npm", identifier: "env-template-mcp", transport: { type: "stdio" }, environmentVariables: { TOKEN_URL: "https://mcp.example.com/${TOKEN}" } },
						{ registryType: "npm", identifier: "env-safe-mcp", transport: { type: "stdio" }, environmentVariables: [{ name: "TOKEN", default: "${TOKEN}", isSecret: true }] },
					],
				},
			}],
		}, SOURCE_URL);
		assert.equal(parsed.servers.length, 2);
		assert.deepEqual(parsed.servers.map((server) => server.transport.type), ["http", "stdio"]);
		assert.deepEqual(parsed.servers[1].config, { command: "npx", args: ["-y", "env-safe-mcp"], env: { TOKEN: "${TOKEN}" } });
		assert.equal(parsed.skipped.length, 3);
		assert.ok(parsed.skipped.some((s) => /environment variable TOKEN contains variables\/prompts/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /environment variable TENANT_URL contains variables\/templates/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /environment variable TOKEN_URL contains variables\/templates/.test(s.reason)));
	});

	it("skips npm package versions and fixed args with Windows shell metacharacters", () => {
		const parsed = parseMcpRegistryDocument({
			servers: [{
				server: {
					name: "security/packages",
					version: "1.0.0",
					remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
					packages: [
						{ registryType: "npm", identifier: "safe-mcp", version: "1.0.0&calc", transport: { type: "stdio" } },
						{ registryType: "npm", identifier: "safe-args-mcp", version: "1.0.0", packageArguments: ["ok&calc"], transport: { type: "stdio" } },
					],
				},
			}],
		}, SOURCE_URL);
		assert.equal(parsed.servers.length, 1);
		assert.equal(parsed.servers[0].transport.type, "http");
		assert.equal(parsed.skipped.length, 2);
		assert.ok(parsed.skipped.some((s) => /npm package version is invalid: only safe npm versions, dist-tags, or specs without Windows shell metacharacters are supported/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /packageArguments value contains unsafe Windows shell metacharacters/.test(s.reason)));
	});

	it("translates safe npm stdio packages to npx configs with fixed args and env placeholders", () => {
		const parsed = parseMcpRegistryDocument({
			servers: [{
				server: {
					name: "tools/context7",
					title: "Context7",
					description: "Fetch library docs",
					version: "3.0.0",
					packages: [{
						registryType: "npm",
						identifier: "@upstash/context7-mcp",
						version: "1.2.3",
						runtimeHint: "npx",
						transport: { type: "stdio" },
						packageArguments: [
							"--readonly",
							{ name: "--project", value: "bobbit" },
							{ name: "--verbose", value: true },
							{ value: "docs" },
						],
						environmentVariables: [
							{ name: "CONTEXT7_API_KEY", default: "${CONTEXT7_API_KEY}", isSecret: true },
							{ name: "CONTEXT7_MODE", default: "docs" },
						],
					}],
				},
			}],
		}, SOURCE_URL);
		assert.equal(parsed.skipped.length, 0);
		const [server] = parsed.servers;
		assert.equal(server.transport.type, "stdio");
		assert.deepEqual(server.config, {
			command: "npx",
			args: ["-y", "@upstash/context7-mcp@1.2.3", "--readonly", "--project", "bobbit", "--verbose", "docs"],
			env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}", CONTEXT7_MODE: "docs" },
		});
		const pack = registryServerToVirtualPack(server);
		assert.deepEqual(pack.mcp, [{
			ref: server.id,
			listName: server.id,
			serverName: server.name,
			label: "Context7",
			description: "Fetch library docs",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@upstash/context7-mcp@1.2.3", "--readonly", "--project", "bobbit", "--verbose", "docs"],
			env: ["CONTEXT7_API_KEY", "CONTEXT7_MODE"],
		}]);
	});

	it("keeps remote install IDs stable when package candidates are added later", () => {
		const remoteOnly = parseMcpRegistryDocument({
			servers: [{ server: {
				name: "multi/server",
				version: "1.0.0",
				remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
			} }],
		}, SOURCE_URL);
		const remoteAndPackage = parseMcpRegistryDocument({
			servers: [{ server: {
				name: "multi/server",
				version: "1.0.0",
				remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
				packages: [{ registryType: "npm", identifier: "multi-mcp", version: "1.0.0", transport: { type: "stdio" } }],
			} }],
		}, SOURCE_URL);
		assert.equal(remoteOnly.servers.length, 1);
		assert.equal(remoteAndPackage.servers.length, 2);
		assert.deepEqual(remoteAndPackage.servers.map((s) => s.id), [
			officialRegistryInstallId({ officialName: "multi/server", version: "1.0.0", sourceUrl: SOURCE_URL, variant: "remote-1" }),
			officialRegistryInstallId({ officialName: "multi/server", version: "1.0.0", sourceUrl: SOURCE_URL, variant: "npm-multi-mcp" }),
		]);
		assert.equal(remoteOnly.servers[0].id, remoteAndPackage.servers[0].id);
		assert.notEqual(remoteAndPackage.servers[0].name, remoteAndPackage.servers[1].name);
	});
});
