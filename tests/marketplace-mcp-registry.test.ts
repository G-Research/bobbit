import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

const { MarketplaceSourceStore } = await import("../src/server/agent/marketplace-source-store.ts");
const {
	isMcpRegistrySource,
	parseMcpRegistryDocument,
	registryServerToVirtualPack,
	materializeRegistryPack,
	McpRegistryError,
} = await import("../src/server/agent/mcp-registry-source.ts");

let TMP: string;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-registry-")); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("Marketplace MCP registry source primitives", () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(TMP, "case-")); });

	it("persists source type only for mcp-registry and rejects refs", () => {
		const store = new MarketplaceSourceStore(dir);
		const pack = store.add({ url: "https://example.com/packs.git", ref: "v1" });
		assert.equal(pack.type, undefined);
		assert.equal(pack.ref, "v1");
		const registry = store.add({ url: "https://registry.example.com/mcp.json", type: "mcp-registry" });
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

	it("loads legacy registry rows while dropping malformed ref metadata", () => {
		fs.writeFileSync(
			path.join(dir, "marketplace-sources.yaml"),
			stringify({
				sources: [
					{ id: "reg", type: "mcp-registry", url: "https://registry.example.com/mcp.json", ref: "ignored", addedAt: "2026-01-01T00:00:00.000Z" },
					{ id: "bad", type: "wat", url: "https://example.com", addedAt: "2026-01-01T00:00:00.000Z" },
				],
			}),
			"utf-8",
		);
		const store = new MarketplaceSourceStore(dir);
		assert.deepEqual(store.list(), [{ id: "reg", type: "mcp-registry", url: "https://registry.example.com/mcp.json", addedAt: "2026-01-01T00:00:00.000Z" }]);
	});

	it("parses schemaVersion 1 registries and normalizes exact MCP runtime configs", () => {
		const parsed = parseMcpRegistryDocument({
			schemaVersion: 1,
			generatedAt: "2026-06-23T00:00:00.000Z",
			servers: [
				{
					id: "context7",
					name: "context7_runtime",
					label: "Context7",
					description: "Fetch library docs",
					version: "1.0.0",
					homepage: "https://example.com/context7",
					transport: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" }, cwd: "fixtures" },
				},
				{
					id: "docs-remote",
					name: "docs-remote",
					transport: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_MCP_TOKEN}" } },
				},
			],
		});
		assert.equal(parsed.skipped.length, 0);
		assert.deepEqual(parsed.servers.map((s) => s.id), ["context7", "docs-remote"]);
		assert.deepEqual(parsed.servers[0].config, {
			command: "npx",
			args: ["-y", "@upstash/context7-mcp"],
			env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
			cwd: "fixtures",
		});
		assert.deepEqual(parsed.servers[1].config, {
			url: "https://mcp.example.com/mcp",
			headers: { Authorization: "Bearer ${DOCS_MCP_TOKEN}" },
		});
	});

	it("fails unsupported registry documents and skips invalid individual entries", () => {
		assert.throws(() => parseMcpRegistryDocument({ schemaVersion: 2, servers: [] }), /schemaVersion: 1/);
		assert.throws(() => parseMcpRegistryDocument({ schemaVersion: 1, servers: [], extra: true }), /unknown key: extra/);
		const parsed = parseMcpRegistryDocument({
			schemaVersion: 1,
			servers: [
				{ id: "ok", name: "ok", transport: { type: "stdio", command: "node" } },
				{ id: "../escape", name: "bad", transport: { type: "stdio", command: "node" } },
				{ id: "CON", name: "bad", transport: { type: "stdio", command: "node" } },
				{ id: "bad_name", name: "bad__name", transport: { type: "stdio", command: "node" } },
				{ id: "bad-cwd", name: "bad-cwd", transport: { type: "stdio", command: "node", cwd: "../outside" } },
				{ id: "bad-url", name: "bad-url", transport: { type: "http", url: "https://user:pass@example.com/mcp#frag" } },
				{ id: "bad-args", name: "bad-args", transport: { type: "stdio", command: "node", args: [1] } },
				{ id: "bad-env", name: "bad-env", transport: { type: "stdio", command: "node", env: { KEY: 1 } } },
				{ id: "bad-header", name: "bad-header", transport: { type: "http", url: "https://example.com/mcp", headers: { Auth: 1 } } },
			],
		});
		assert.deepEqual(parsed.servers.map((s) => s.id), ["ok"]);
		assert.equal(parsed.skipped.length, 8);
		assert.ok(parsed.skipped.some((s) => /safe basename/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /Windows device/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /unsafe/.test(s.reason)));
		assert.ok(parsed.skipped.some((s) => /credentials/.test(s.reason)));
	});

	it("maps registry servers to virtual browse packs", () => {
		const [server] = parseMcpRegistryDocument({
			schemaVersion: 1,
			servers: [{ id: "context7", name: "runtime.context7", description: "Fetch docs", version: "1.2.3", transport: { type: "stdio", command: "npx" } }],
		}).servers;
		const pack = registryServerToVirtualPack(server);
		assert.equal(pack.virtual, true);
		assert.equal(pack.sourceType, "mcp-registry");
		assert.equal(pack.dirName, "mcp-context7");
		assert.equal(pack.name, "mcp-context7");
		assert.equal(pack.schema, 2);
		assert.equal(pack.hasTools, false);
		assert.deepEqual(pack.contents, { roles: [], tools: [], skills: [], entrypoints: [], mcp: ["context7"] });
	});

	it("materializes a registry server into a safe schema-2 pack directory", () => {
		const [server] = parseMcpRegistryDocument({
			schemaVersion: 1,
			servers: [{ id: "docs-remote", name: "docs_runtime", label: "Docs", description: "Remote docs", version: "2.0.0", transport: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } }],
		}).servers;
		const dest = path.join(dir, "mcp-docs-remote");
		const manifest = materializeRegistryPack(server, dest, { sourceUrl: "https://registry.example.com/mcp.json", materializedAt: "2026-06-23T00:00:00.000Z" });
		assert.equal(manifest.name, "mcp-docs-remote");
		assert.deepEqual(fs.readdirSync(dest).sort(), [".pack-meta.yaml", "mcp", "pack.yaml"]);
		assert.deepEqual(parse(fs.readFileSync(path.join(dest, "pack.yaml"), "utf-8")), {
			schema: 2,
			name: "mcp-docs-remote",
			description: "Remote docs",
			version: "2.0.0",
			contents: { roles: [], tools: [], skills: [], entrypoints: [], mcp: ["docs-remote"] },
		});
		assert.deepEqual(parse(fs.readFileSync(path.join(dest, "mcp", "docs-remote.yaml"), "utf-8")), {
			server: "docs_runtime",
			label: "Docs",
			description: "Remote docs",
			transport: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
		});
		const meta = parse(fs.readFileSync(path.join(dest, ".pack-meta.yaml"), "utf-8")) as Record<string, unknown>;
		assert.equal(meta.sourceType, "mcp-registry");
		assert.equal(meta.sourceUrl, "https://registry.example.com/mcp.json");
		assert.equal(meta.registryId, "docs-remote");
		assert.equal(meta.registryName, "docs_runtime");
		assert.equal(meta.registryVersion, "2.0.0");
		assert.equal(meta.materializedAt, "2026-06-23T00:00:00.000Z");
		assert.match(String(meta.registryFingerprint), /^[a-f0-9]{64}$/);
	});

	it("rejects registry ids whose generated pack name cannot be installed safely", () => {
		const parsed = parseMcpRegistryDocument({
			schemaVersion: 1,
			servers: [{ id: "bad_name", name: "ok", transport: { type: "stdio", command: "node" } }],
		});
		assert.equal(parsed.servers.length, 0);
		assert.equal(parsed.skipped.length, 1);
		assert.match(parsed.skipped[0].reason, /generated pack name is unsafe/);
		assert.ok(McpRegistryError);
	});
});
