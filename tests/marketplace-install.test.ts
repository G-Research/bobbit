/**
 * Wave 2 — Marketplace backend unit tests (design §12.2 #7, #8 + §3.3).
 *
 * Covers:
 *   #7 install (copy subtree + write meta + append pack_order),
 *      uninstall (delete dir + clean order), update (replace + rewrite meta,
 *      preserve installedAt), path-traversal guards, corrupt-guard.
 *   #8 MarketplaceSourceStore CRUD + YAML persistence; local-dir vs git-url
 *      branching (no network — git via an injected runner).
 *   §3.3 scoped pack_order persistence round-trip (ProjectConfigStore).
 *
 * All fixtures are real file trees under a tmp dir (file:// fixtures).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const installMod = await import("../src/server/agent/marketplace-install.ts");
const {
	MarketplaceInstaller,
	MarketplaceError,
	isLocalDirSource,
	localSourcePath,
	copyDirVerbatim,
	isInstalledPackDir,
	packUpdateAvailable,
	readPackEntityDescriptions,
} = installMod;
const { MarketplaceSourceStore, deriveSourceId, isValidSourceId } = await import(
	"../src/server/agent/marketplace-source-store.ts"
);
const { ProjectConfigStore } = await import("../src/server/agent/project-config-store.ts");
const { readManifest, readMeta } = await import("../src/server/agent/pack-manifest.ts");
const { scopePaths } = await import("../src/server/agent/pack-types.ts");

let TMP: string;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-install-")); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

function w(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function parseFlatYamlScalars(file: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
		const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
		if (!match || line.startsWith(" ")) continue;
		out[match[1]!] = (match[2] ?? "").replace(/^['\"]|['\"]$/g, "");
	}
	return out;
}

/** Build a source-repo fixture with two packs (research = no tools, qa = tools). */
function makeSourceRepo(root: string, opts: { researcherMarker?: string; version?: string } = {}) {
	const marker = opts.researcherMarker ?? "v1";
	const version = opts.version ?? "1.0.0";
	// research-pack: roles + skills, NO tools
	w(path.join(root, "research-pack", "pack.yaml"),
		`name: research-pack\ndescription: deep research\nversion: ${version}\ncontents:\n  roles: [researcher]\n  tools: []\n  skills: [lit-review]\n`);
	w(path.join(root, "research-pack", "roles", "researcher.yaml"),
		`name: researcher\nlabel: Researcher\naccessory: none\ncreatedAt: 0\nupdatedAt: 0\npromptTemplate: ${marker}\n`);
	w(path.join(root, "research-pack", "skills", "lit-review", "SKILL.md"),
		`---\nname: lit-review\ndescription: literature review\n---\nbody\n`);
	// nested git dir that must NOT be copied
	w(path.join(root, "research-pack", ".git", "HEAD"), "ref: refs/heads/main\n");
	// qa-pack: ships tools (executable code)
	w(path.join(root, "qa-pack", "pack.yaml"),
		`name: qa-pack\ndescription: qa tools\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: [qa]\n  skills: []\n`);
	w(path.join(root, "qa-pack", "tools", "qa", "run.yaml"), "name: qa-run\ndescription: run qa\n");
	w(path.join(root, "qa-pack", "tools", "qa", "extension.ts"), "export const x = 1;\n");
	w(path.join(root, "qa-pack", "tools", "qa", "_shared", "util.ts"), "export const y = 2;\n");
	// a non-pack dir (no pack.yaml) — must be ignored on browse
	w(path.join(root, "docs", "README.md"), "# not a pack\n");
}

function makeInstaller(opts: {
	sourceStore: any;
	cacheRoot: string;
	serverBase: string;
	globalUserBase: string;
	gitRunner?: (args: string[], cwd: string) => string;
}) {
	return new MarketplaceInstaller(opts);
}

// ── #8 MarketplaceSourceStore ────────────────────────────────────

describe("#8 MarketplaceSourceStore CRUD + YAML persistence", () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(TMP, "src-store-")); });

	it("derives a unique slug id and rejects duplicate url", () => {
		const store = new MarketplaceSourceStore(dir);
		const s1 = store.add({ url: "https://github.com/acme/bobbit-packs.git", ref: "main" });
		assert.equal(s1.id, "bobbit-packs");
		assert.equal(s1.ref, "main");
		assert.ok(isValidSourceId(s1.id));
		// duplicate url throws
		assert.throws(() => store.add({ url: "https://github.com/acme/bobbit-packs.git" }), /already registered/);
		// a second different url whose slug collides gets a numeric suffix
		const s2 = store.add({ url: "https://gitlab.com/other/bobbit-packs.git" });
		assert.equal(s2.id, "bobbit-packs-2");
	});

	it("persists to YAML and reloads from disk", () => {
		const store = new MarketplaceSourceStore(dir);
		store.add({ url: "/abs/local/packs", ref: "dev" });
		const file = path.join(dir, "marketplace-sources.yaml");
		assert.ok(fs.existsSync(file));
		assert.match(fs.readFileSync(file, "utf-8"), /sources:/);
		// fresh store reads the same data
		const store2 = new MarketplaceSourceStore(dir);
		const all = store2.list();
		assert.equal(all.length, 1);
		assert.equal(all[0].url, "/abs/local/packs");
		assert.equal(all[0].ref, "dev");
	});

	it("update patches sync metadata; remove deletes", () => {
		const store = new MarketplaceSourceStore(dir);
		const s = store.add({ url: "https://example.com/repo.git" });
		store.update(s.id, { lastCommit: "deadbeef", lastSyncedAt: "2026-01-01T00:00:00Z" });
		assert.equal(store.get(s.id)!.lastCommit, "deadbeef");
		assert.equal(store.remove(s.id), true);
		assert.equal(store.get(s.id), undefined);
		assert.equal(store.remove(s.id), false);
	});

	it("persists mcp-gateway sources and rejects refs", () => {
		const store = new MarketplaceSourceStore(dir);
		const s = store.add({ url: "https://gateway.example.com/readonly/mcp", type: "mcp-gateway" });
		assert.equal(s.type, "mcp-gateway");
		assert.equal(s.ref, undefined);
		assert.throws(() => store.add({ url: "https://gateway.example.com/other/mcp", type: "mcp-gateway", ref: "main" }), /mcp-gateway sources do not support ref/);
		const reloaded = new MarketplaceSourceStore(dir).get(s.id)!;
		assert.equal(reloaded.type, "mcp-gateway");
	});

	it("deriveSourceId sanitizes and disambiguates", () => {
		const taken = new Set<string>(["repo"]);
		assert.equal(deriveSourceId("https://x/Repo.git", taken), "repo-2");
		assert.equal(deriveSourceId("/home/u/My Packs/", new Set()), "my-packs");
	});
});

async function withStreamableMcpGateway(tools: unknown[], fn: (url: string, setTools: (next: unknown[]) => void) => Promise<void>): Promise<void> {
	let currentTools = tools;
	const server = http.createServer(async (req, res) => {
		const requestPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (requestPath === "/signin/aigateway") {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		if (requestPath !== "/readonly/mcp") {
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
			res.writeHead(202, { "content-type": "application/json" });
			res.end();
			return;
		}
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
			res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: currentTools } }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		await fn(`http://127.0.0.1:${address.port}/readonly/mcp`, (next) => { currentTools = next; });
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
	}
}

function gatewayTools(opts: { description?: string; includeUnsupported?: boolean } = {}): unknown[] {
	return [
		{
			name: "jira__jira_search",
			description: "Search issues",
			providerLabel: "Jira",
			providerDescription: opts.description ?? "Jira issue tools",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "confluence__confluence_search",
			description: "Search docs",
			providerLabel: "Confluence",
			providerDescription: "Confluence docs tools",
			inputSchema: { type: "object", properties: {} },
		},
		...(opts.includeUnsupported ? [{ name: "bad/id__bad_search", providerLabel: "Bad Provider", providerDescription: "Unsafe id" }] : []),
	];
}

describe("Marketplace MCP gateway integration", () => {
	it("browses gateway providers and surfaces skipped-provider diagnostics", async () => {
		const root = fs.mkdtempSync(path.join(TMP, "mcp-diag-"));
		await withStreamableMcpGateway(gatewayTools({ includeUnsupported: true }), async (url) => {
			const store = new MarketplaceSourceStore(path.join(root, "cfg"));
			const source = store.add({ url, type: "mcp-gateway" });
			const inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });

			const packs = await inst.browseSourcePacks(source.id);
			assert.deepEqual(packs.map((p: any) => p.name).sort(), ["mcp-confluence", "mcp-jira"]);
			const jira = packs.find((p: any) => p.gatewayProviderId === "jira")!;
			assert.equal(jira.virtual, true);
			assert.equal(jira.sourceType, "mcp-gateway");
			assert.equal(jira.name, "mcp-jira");
			assert.deepEqual(jira.contents.mcp, ["jira"]);
			assert.equal(jira.serverName, "gr");
			assert.deepEqual(jira.mcp[0], { ref: "jira", listName: "jira", serverName: "gr", subNamespace: "jira", label: "Jira", description: "Jira issue tools", transport: "http", url });
			assert.deepEqual(jira.mcpGatewayDiagnostics?.skippedEntries.map((entry: any) => entry.id), ["bad/id"]);
			assert.match(jira.mcpGatewayDiagnostics!.skippedEntries[0]!.reason, /unsafe gateway provider id/i);

			const synced = await inst.syncMarketplaceSource(source.id);
			assert.deepEqual(synced.mcpGatewayDiagnostics?.skippedEntries.map((entry: any) => entry.id), ["bad/id"]);
		});
	});

	it("tolerates legacy mcp-registry source rows but rejects their use", async () => {
		const root = fs.mkdtempSync(path.join(TMP, "mcp-legacy-source-"));
		const cfg = path.join(root, "cfg");
		fs.mkdirSync(cfg, { recursive: true });
		w(path.join(cfg, "marketplace-sources.yaml"), [
			"sources:",
			"  - id: old-registry",
			"    type: mcp-registry",
			"    url: https://registry.example.com/v0/servers",
			"    ref: ignored",
			"    addedAt: 2026-01-01T00:00:00.000Z",
			"",
		].join("\n"));
		const store = new MarketplaceSourceStore(cfg);
		const source = store.get("old-registry")!;
		assert.equal(source.type, "mcp-registry");
		assert.equal(source.ref, undefined);
		assert.match(source.unsupportedReason, /mcp-registry sources are no longer supported/i);
		assert.throws(() => store.add({ url: "https://registry.example.com/v1", type: "mcp-registry" as any }), /use type mcp-gateway/);

		const inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });
		await assert.rejects(
			() => inst.browseSourcePacks(source.id),
			(e: any) => e instanceof MarketplaceError && e.code === "invalid_pack" && /re-add this source as an MCP Gateway source/i.test(e.message),
		);
	});

	it("installs and updates gateway provider packs while preserving materialized metadata", async () => {
		const root = fs.mkdtempSync(path.join(TMP, "mcp-gateway-list-"));
		await withStreamableMcpGateway(gatewayTools(), async (url, setTools) => {
			const store = new MarketplaceSourceStore(path.join(root, "cfg"));
			const source = store.add({ url, type: "mcp-gateway" });
			const inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });

			const pack = (await inst.browseSourcePacks(source.id)).find((p: any) => p.gatewayProviderId === "jira")!;
			assert.ok(pack);
			const installed = await inst.installMarketplacePack({ sourceId: source.id, dirName: pack.dirName, scope: "server" });
			assert.equal(installed.packName, "mcp-jira");
			assert.deepEqual(installed.manifest.contents.mcp, ["jira"]);
			let row = inst.listInstalled([{ scope: "server" }]).find((p: any) => p.packName === pack.name);
			assert.equal(row?.sourceStatus, "ok");
			assert.equal(row?.updateAvailable, false);

			const { marketPacksRoot } = scopePaths("server", root);
			const dest = path.join(marketPacksRoot, pack.name);
			let rawMeta = parseFlatYamlScalars(path.join(dest, ".pack-meta.yaml"));
			assert.equal(rawMeta.sourceType, "mcp-gateway");
			assert.equal(rawMeta.gatewayProviderId, "jira");
			assert.equal(rawMeta.packName, pack.name);
			assert.equal(rawMeta.commit, installed.meta.commit);
			const mcp = parseFlatYamlScalars(path.join(dest, "mcp", "jira.yaml"));
			assert.equal(mcp.server, "gr");
			assert.equal(mcp.subNamespace, "jira");

			setTools(gatewayTools({ description: "Jira issue tools v2" }));
			await inst.syncMarketplaceSource(source.id);
			row = inst.listInstalled([{ scope: "server" }]).find((p: any) => p.packName === pack.name);
			assert.equal(row?.sourceStatus, "ok");
			assert.equal(row?.updateAvailable, true);

			const updated = await inst.updateMarketplacePack({ packName: pack.name, scope: "server" });
			assert.equal(updated.packName, pack.name);
			assert.notEqual(updated.meta.commit, installed.meta.commit);
			rawMeta = parseFlatYamlScalars(path.join(dest, ".pack-meta.yaml"));
			assert.equal(rawMeta.gatewayProviderId, "jira");
			assert.equal(rawMeta.description, "Jira issue tools v2");
		});
	});

	it("rejects installing the same provider pack name from two gateway sources", async () => {
		const root = fs.mkdtempSync(path.join(TMP, "mcp-cross-source-"));
		await withStreamableMcpGateway(gatewayTools(), async (url1) => {
			await withStreamableMcpGateway(gatewayTools(), async (url2) => {
				const store = new MarketplaceSourceStore(path.join(root, "cfg"));
				const source1 = store.add({ url: url1, type: "mcp-gateway" });
				const source2 = store.add({ url: url2, type: "mcp-gateway" });
				const inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });

				const pack1 = (await inst.browseSourcePacks(source1.id)).find((p: any) => p.gatewayProviderId === "jira")!;
				const pack2 = (await inst.browseSourcePacks(source2.id)).find((p: any) => p.gatewayProviderId === "jira")!;
				assert.equal(pack1.name, "mcp-jira");
				assert.equal(pack2.name, "mcp-jira");

				const installed1 = await inst.installMarketplacePack({ sourceId: source1.id, dirName: pack1.dirName, scope: "server" });
				assert.equal(installed1.packName, "mcp-jira");
				await assert.rejects(
					() => inst.installMarketplacePack({ sourceId: source2.id, dirName: pack2.dirName, scope: "server" }),
					(e: any) => e instanceof MarketplaceError && e.code === "already_installed",
				);
			});
		});
	});
});

describe("#8 local-dir vs git-url branching (no network)", () => {
	it("classifies source urls", () => {
		assert.equal(isLocalDirSource("/abs/path"), true);
		assert.equal(isLocalDirSource("C:\\abs\\path") || process.platform !== "win32", true);
		assert.equal(isLocalDirSource("file:///abs/path"), true);
		assert.equal(isLocalDirSource("https://github.com/a/b.git"), false);
		assert.equal(isLocalDirSource("git@github.com:a/b.git"), false);
		assert.equal(isLocalDirSource("ssh://git@host/repo"), false);
		assert.equal(isLocalDirSource("relative/path"), false);
		assert.match(localSourcePath("file:///x/y"), /[\\/]x[\\/]y$/);
	});

	// finding #4 — `file:///C:/repo` must convert via fileURLToPath, NOT
	// `new URL(u).pathname` (which yields `/C:/repo` → path.resolve →
	// `C:\C:\repo` on Windows, a doubled drive letter).
	it("resolves a Windows-style file:///C:/... url without doubling the drive", () => {
		const resolved = localSourcePath("file:///C:/repo/packs");
		// Never a doubled drive letter (the old new URL().pathname bug).
		assert.ok(!/C:[\\/]+C:/i.test(resolved), `drive must not be doubled; got: ${resolved}`);
		if (process.platform === "win32") {
			assert.equal(resolved, path.resolve("C:\\repo\\packs"));
			assert.match(resolved, /^C:\\repo\\packs$/i);
		} else {
			// On POSIX fileURLToPath keeps the leading slash form; the point is
			// only that there is no doubled-drive corruption.
			assert.match(resolved, /repo[\\/]packs$/);
		}
	});

	it("local-dir source reads in place (no clone, empty commit)", () => {
		const root = fs.mkdtempSync(path.join(TMP, "ldir-"));
		const repo = path.join(root, "repo");
		makeSourceRepo(repo);
		const store = new MarketplaceSourceStore(path.join(root, "cfg"));
		const s = store.add({ url: repo });
		const inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });
		const synced = inst.syncSource(s.id);
		assert.equal(synced.root, path.resolve(repo)); // read in place
		assert.equal(synced.commit, "");
		assert.equal(fs.existsSync(path.join(root, "cache")), false); // no clone happened
	});

	it("git-url source clones into the cache via the injected runner", () => {
		const root = fs.mkdtempSync(path.join(TMP, "git-"));
		const fixtureRepo = path.join(root, "remote");
		makeSourceRepo(fixtureRepo);
		const calls: string[][] = [];
		const gitRunner = (args: string[], _cwd: string): string => {
			calls.push(args);
			if (args[0] === "clone") {
				const cacheDir = args[args.length - 1];
				copyDirVerbatim(fixtureRepo, cacheDir);
				return "";
			}
			if (args[0] === "rev-parse") return "abc1234567\n";
			return "";
		};
		const store = new MarketplaceSourceStore(path.join(root, "cfg"));
		const s = store.add({ url: "https://example.com/repo.git", ref: "main" });
		const inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root, gitRunner });
		const synced = inst.syncSource(s.id);
		assert.equal(synced.commit, "abc1234567");
		assert.ok(calls.some((c) => c[0] === "clone" && c.includes("--depth")));
		// browse the cached packs; .git was skipped by the copy
		const packs = inst.browsePacks(s.id);
		const names = packs.map((p) => p.dirName).sort();
		assert.deepEqual(names, ["qa-pack", "research-pack"]);
		assert.equal(packs.find((p) => p.dirName === "qa-pack")!.hasTools, true);
		assert.equal(packs.find((p) => p.dirName === "research-pack")!.hasTools, false);
		assert.equal(store.get(s.id)!.lastCommit, "abc1234567");
	});
});

// ── #7 install / uninstall / update file ops ─────────────────────

describe("#7 install / uninstall / update", () => {
	let root: string;
	let repo: string;
	let store: any;
	let inst: any;
	let packOrder: any;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(TMP, "ops-"));
		repo = path.join(root, "repo");
		makeSourceRepo(repo);
		store = new MarketplaceSourceStore(path.join(root, "cfg"));
		store.add({ url: repo });
		inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });
		packOrder = new ProjectConfigStore(path.join(root, ".bobbit", "config"));
	});

	function sourceId() { return store.list()[0].id; }

	it("install copies the subtree verbatim, writes meta, appends pack_order", () => {
		const res = inst.installPack({ sourceId: sourceId(), dirName: "qa-pack", scope: "server", packOrderStore: packOrder });
		assert.equal(res.status, "ok");
		const { marketPacksRoot } = scopePaths("server", root);
		const dest = path.join(marketPacksRoot, "qa-pack");
		// tool code + _shared travelled with the dir
		assert.ok(fs.existsSync(path.join(dest, "tools", "qa", "run.yaml")));
		assert.ok(fs.existsSync(path.join(dest, "tools", "qa", "extension.ts")));
		assert.ok(fs.existsSync(path.join(dest, "tools", "qa", "_shared", "util.ts")));
		// pack.yaml preserved, .pack-meta.yaml generated
		assert.ok(readManifest(dest));
		const meta = readMeta(dest)!;
		assert.equal(meta.packName, "qa-pack");
		assert.equal(meta.scope, "server");
		assert.equal(meta.installedAt, meta.updatedAt);
		assert.equal(meta.sourceUrl, repo);
		// no .git copied, no leftover staging dir
		assert.equal(fs.existsSync(path.join(dest, ".git")), false);
		assert.equal(fs.readdirSync(marketPacksRoot).some((n) => n.startsWith(".tmp-")), false);
		// pack_order appended for the server scope
		assert.deepEqual(packOrder.getPackOrder("server"), ["qa-pack"]);
	});

	it("install rejects an already-installed pack (409)", () => {
		inst.installPack({ sourceId: sourceId(), dirName: "research-pack", scope: "server", packOrderStore: packOrder });
		assert.throws(
			() => inst.installPack({ sourceId: sourceId(), dirName: "research-pack", scope: "server", packOrderStore: packOrder }),
			(e: any) => e instanceof MarketplaceError && e.code === "already_installed",
		);
	});

	it("install rejects unknown pack name", () => {
		assert.throws(
			() => inst.installPack({ sourceId: sourceId(), dirName: "nope", scope: "server", packOrderStore: packOrder }),
			(e: any) => e instanceof MarketplaceError && e.code === "unknown_pack",
		);
	});

	it("path-traversal guards reject unsafe names", () => {
		for (const bad of ["../evil", ".hidden", "a/b", "..", "C:foo"]) {
			assert.throws(
				() => inst.installPack({ sourceId: sourceId(), dirName: bad, scope: "server", packOrderStore: packOrder }),
				(e: any) => e instanceof MarketplaceError && e.code === "unsafe_name",
				`install should reject ${bad}`,
			);
			assert.throws(
				() => inst.uninstallPack({ packName: bad, scope: "server", packOrderStore: packOrder }),
				(e: any) => e instanceof MarketplaceError && e.code === "unsafe_name",
				`uninstall should reject ${bad}`,
			);
		}
	});

	it("uninstall deletes exactly the added dir and cleans pack_order", () => {
		inst.installPack({ sourceId: sourceId(), dirName: "research-pack", scope: "server", packOrderStore: packOrder });
		inst.installPack({ sourceId: sourceId(), dirName: "qa-pack", scope: "server", packOrderStore: packOrder });
		const { marketPacksRoot } = scopePaths("server", root);
		assert.deepEqual(fs.readdirSync(marketPacksRoot).sort(), ["qa-pack", "research-pack"]);
		assert.deepEqual(packOrder.getPackOrder("server"), ["research-pack", "qa-pack"]);

		inst.uninstallPack({ packName: "research-pack", scope: "server", packOrderStore: packOrder });
		assert.deepEqual(fs.readdirSync(marketPacksRoot), ["qa-pack"]); // only research-pack removed
		assert.deepEqual(packOrder.getPackOrder("server"), ["qa-pack"]);
	});

	it("uninstall rejects a pack that is not installed", () => {
		assert.throws(
			() => inst.uninstallPack({ packName: "qa-pack", scope: "server", packOrderStore: packOrder }),
			(e: any) => e instanceof MarketplaceError && e.code === "not_installed",
		);
	});

	it("update replaces contents + rewrites meta, preserving installedAt", async () => {
		const res = inst.installPack({ sourceId: sourceId(), dirName: "research-pack", scope: "server", packOrderStore: packOrder });
		const installedAt = res.meta.installedAt;
		const { marketPacksRoot } = scopePaths("server", root);
		const dest = path.join(marketPacksRoot, "research-pack");
		const roleFile = path.join(dest, "roles", "researcher.yaml");
		assert.match(fs.readFileSync(roleFile, "utf-8"), /promptTemplate: v1/);

		// Upstream change: bump the role marker + version in the source repo.
		await new Promise((r) => setTimeout(r, 5)); // ensure a distinct updatedAt
		makeSourceRepo(repo, { researcherMarker: "v2", version: "2.0.0" });

		const upd = inst.updatePack({ packName: "research-pack", scope: "server", packOrderStore: packOrder });
		assert.match(fs.readFileSync(roleFile, "utf-8"), /promptTemplate: v2/); // contents replaced
		assert.equal(upd.meta.installedAt, installedAt); // preserved
		assert.notEqual(upd.meta.updatedAt, installedAt); // bumped
		assert.equal(upd.meta.version, "2.0.0");
		assert.equal(readMeta(dest)!.version, "2.0.0");
		// no leftover staging/backup dirs
		assert.equal(fs.readdirSync(marketPacksRoot).some((n) => n.startsWith(".tmp")), false);
	});

	it("update rejects a pack that is not installed", () => {
		assert.throws(
			() => inst.updatePack({ packName: "qa-pack", scope: "server", packOrderStore: packOrder }),
			(e: any) => e instanceof MarketplaceError && e.code === "not_installed",
		);
	});

	it("installs by source dirName but the installed identity is manifest.name (§1.4)", () => {
		// Source subdir name (weird-dir) differs from its manifest name (cool-pack).
		w(path.join(repo, "weird-dir", "pack.yaml"),
			"name: cool-pack\ndescription: renamed pack\nversion: 1.0.0\ncontents:\n  roles: [cooler]\n  tools: []\n  skills: []\n");
		w(path.join(repo, "weird-dir", "roles", "cooler.yaml"),
			"name: cooler\nlabel: Cooler\naccessory: none\ncreatedAt: 0\nupdatedAt: 0\npromptTemplate: c1\n");

		const res = inst.installPack({ sourceId: sourceId(), dirName: "weird-dir", scope: "server", packOrderStore: packOrder });
		const { marketPacksRoot } = scopePaths("server", root);
		// Installed under manifest.name, NOT the source dir name.
		assert.equal(res.packName, "cool-pack");
		assert.ok(fs.existsSync(path.join(marketPacksRoot, "cool-pack")), "installed under manifest.name");
		assert.equal(fs.existsSync(path.join(marketPacksRoot, "weird-dir")), false, "never under source dir name");
		assert.equal(readMeta(path.join(marketPacksRoot, "cool-pack"))!.packName, "cool-pack");
		// pack_order keyed by manifest.name
		assert.deepEqual(packOrder.getPackOrder("server"), ["cool-pack"]);

		// Update resolves the source by manifest.name even though the source dir
		// name (weird-dir) differs from the installed name (cool-pack).
		const upd = inst.updatePack({ packName: "cool-pack", scope: "server", packOrderStore: packOrder });
		assert.equal(upd.packName, "cool-pack");
		assert.equal(readMeta(path.join(marketPacksRoot, "cool-pack"))!.packName, "cool-pack");

		// Uninstall by manifest.name removes exactly the installed dir.
		inst.uninstallPack({ packName: "cool-pack", scope: "server", packOrderStore: packOrder });
		assert.equal(fs.existsSync(path.join(marketPacksRoot, "cool-pack")), false);
		assert.deepEqual(packOrder.getPackOrder("server"), []);
	});
});

// ── corrupt-guard + listInstalled ────────────────────────────────

describe("#7 corrupt-guard + listInstalled", () => {
	it("ignores meta-less dirs for resolution; reports them as corrupt", () => {
		const root = fs.mkdtempSync(path.join(TMP, "corrupt-"));
		const { marketPacksRoot } = scopePaths("server", root);
		// valid pack (pack.yaml + meta)
		w(path.join(marketPacksRoot, "ok-pack", "pack.yaml"),
			"name: ok-pack\ndescription: ok\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: []\n  skills: []\n");
		w(path.join(marketPacksRoot, "ok-pack", ".pack-meta.yaml"),
			"packName: ok-pack\nversion: 1.0.0\nscope: server\nsourceUrl: x\nsourceRef: main\ncommit: c\ninstalledAt: t\nupdatedAt: t\n");
		// corrupt pack: pack.yaml but NO meta
		w(path.join(marketPacksRoot, "bad-pack", "pack.yaml"),
			"name: bad-pack\ndescription: bad\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: []\n  skills: []\n");
		// staging dir must never be treated as a pack
		w(path.join(marketPacksRoot, ".tmp-x-123", "pack.yaml"),
			"name: x\ndescription: x\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: []\n  skills: []\n");

		assert.equal(isInstalledPackDir(path.join(marketPacksRoot, "ok-pack"), "ok-pack"), true);
		assert.equal(isInstalledPackDir(path.join(marketPacksRoot, "bad-pack"), "bad-pack"), false);
		assert.equal(isInstalledPackDir(path.join(marketPacksRoot, ".tmp-x-123"), ".tmp-x-123"), false);

		const store = new MarketplaceSourceStore(path.join(root, "cfg"));
		const inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });
		const listed = inst.listInstalled([{ scope: "server" }]);
		const byName = new Map(listed.map((p: any) => [p.packName, p]));
		assert.equal(byName.get("ok-pack").status, "ok");
		assert.equal(byName.get("bad-pack").status, "corrupt");
		assert.equal(byName.has(".tmp-x-123"), false); // staging never listed
	});

	// finding #2 — listInstalled must order rows per the scope's pack_order
	// (unlisted-on-disk first, then listed names in order) so the UI's displayed
	// order matches actual precedence after a reload.
	it("orders rows per pack_order (unlisted first, then listed in order)", () => {
		const root = fs.mkdtempSync(path.join(TMP, "order-"));
		const { marketPacksRoot } = scopePaths("server", root);
		for (const n of ["alpha", "beta", "gamma"]) {
			w(path.join(marketPacksRoot, n, "pack.yaml"),
				`name: ${n}\ndescription: ${n}\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: []\n  skills: []\n`);
			w(path.join(marketPacksRoot, n, ".pack-meta.yaml"),
				`packName: ${n}\nversion: 1.0.0\nscope: server\nsourceUrl: x\nsourceRef: main\ncommit: c\ninstalledAt: t\nupdatedAt: t\n`);
		}
		const store = new MarketplaceSourceStore(path.join(root, "cfg"));
		const inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });

		// pack_order lists gamma then alpha (highest last); beta is unlisted ⇒ first.
		const ordered = inst.listInstalled([{ scope: "server", packOrder: ["gamma", "alpha"] }]);
		assert.deepEqual(ordered.map((p: any) => p.packName), ["beta", "gamma", "alpha"]);

		// Without a packOrder, raw readdir order is preserved (no crash, all rows).
		const raw = inst.listInstalled([{ scope: "server" }]);
		assert.deepEqual(raw.map((p: any) => p.packName).sort(), ["alpha", "beta", "gamma"]);

		// A pack_order naming an absent pack drops it; on-disk-but-unlisted appended first.
		const partial = inst.listInstalled([{ scope: "server", packOrder: ["ghost", "alpha"] }]);
		assert.deepEqual(partial.map((p: any) => p.packName), ["beta", "gamma", "alpha"]);
	});
});

// ── R2 update-available signals (version-based) ──────────────────

describe("R2 packUpdateAvailable (pure version comparison)", () => {
	it("returns true only when source version differs and is non-empty", () => {
		assert.equal(packUpdateAvailable("1.0.0", "2.0.0"), true);
		assert.equal(packUpdateAvailable("1.0.0", "1.0.0"), false);
		// String inequality — any difference counts (not semver-aware).
		assert.equal(packUpdateAvailable("2.0.0", "1.0.0"), true);
		assert.equal(packUpdateAvailable("1.0.0", "1.0.1-beta"), true);
		// Empty/absent source version ⇒ no update (treated as unknown upstream).
		assert.equal(packUpdateAvailable("1.0.0", ""), false);
	});
});

describe("R2 listInstalled computes updateAvailable + sourceStatus (no network sync)", () => {
	let root: string;
	let repo: string;
	let store: any;
	let inst: any;
	let packOrder: any;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(TMP, "srcstate-"));
		repo = path.join(root, "repo");
		makeSourceRepo(repo, { version: "1.0.0" });
		store = new MarketplaceSourceStore(path.join(root, "cfg"));
		store.add({ url: repo });
		inst = makeInstaller({ sourceStore: store, cacheRoot: path.join(root, "cache"), serverBase: root, globalUserBase: root });
		packOrder = new ProjectConfigStore(path.join(root, ".bobbit", "config"));
	});

	function sourceId() { return store.list()[0].id; }
	function row() {
		return inst.listInstalled([{ scope: "server" }]).find((p: any) => p.packName === "research-pack");
	}

	it("freshly installed pack is up-to-date (sourceStatus ok, no update)", () => {
		inst.installPack({ sourceId: sourceId(), dirName: "research-pack", scope: "server", packOrderStore: packOrder });
		const r = row();
		assert.equal(r.sourceStatus, "ok");
		assert.equal(r.updateAvailable, false);
	});

	it("flags updateAvailable when the source's manifest version is bumped", () => {
		inst.installPack({ sourceId: sourceId(), dirName: "research-pack", scope: "server", packOrderStore: packOrder });
		// Bump the upstream version WITHOUT updating the installed copy.
		makeSourceRepo(repo, { version: "2.0.0" });
		const r = row();
		assert.equal(r.sourceStatus, "ok");
		assert.equal(r.updateAvailable, true);
	});

	it("reports sourceStatus unknown when the source is no longer registered", () => {
		inst.installPack({ sourceId: sourceId(), dirName: "research-pack", scope: "server", packOrderStore: packOrder });
		store.remove(sourceId());
		const r = row();
		assert.equal(r.sourceStatus, "unknown");
		assert.equal(r.updateAvailable, false);
	});

	it("reports sourceStatus unknown when the local source dir no longer exists", () => {
		inst.installPack({ sourceId: sourceId(), dirName: "research-pack", scope: "server", packOrderStore: packOrder });
		fs.rmSync(repo, { recursive: true, force: true });
		const r = row();
		assert.equal(r.sourceStatus, "unknown");
		assert.equal(r.updateAvailable, false);
	});
});

// ── R3 per-entity descriptions sourced from the pack dir ─────────

describe("R3 readPackEntityDescriptions (roles/tools/skills/entrypoints)", () => {
	it("sources one-line descriptions for all four kinds from the pack dir", () => {
		const root = fs.mkdtempSync(path.join(TMP, "descr-"));
		const dir = path.join(root, "kit");
		w(path.join(dir, "pack.yaml"),
			"name: kit\ndescription: kit\nversion: 1.0.0\ncontents:\n" +
			"  roles: [r-desc, r-label, r-bare]\n" +
			"  tools: [grp]\n" +
			"  skills: [sk]\n" +
			"  entrypoints: [ep]\n");
		// role with explicit description
		w(path.join(dir, "roles", "r-desc.yaml"), "name: r-desc\nlabel: R Desc\ndescription: explicit role description\n");
		// role with only a (differing) label → label is used
		w(path.join(dir, "roles", "r-label.yaml"), "name: r-label\nlabel: Friendly Label\n");
		// role whose label equals its name → omitted (no row)
		w(path.join(dir, "roles", "r-bare.yaml"), "name: r-bare\nlabel: r-bare\n");
		// representative tool yaml in the group dir
		w(path.join(dir, "tools", "grp", "thing.yaml"), "name: thing\ndescription: a grouped tool\ngroup: grp\n");
		// skill frontmatter
		w(path.join(dir, "skills", "sk", "SKILL.md"), "---\ndescription: skill one-liner\n---\n# sk\nbody\n");
		// entrypoint with a description
		w(path.join(dir, "entrypoints", "ep.yaml"),
			"id: ep-id\nkind: session-menu\nlabel: EP Label\ndescription: entry point desc\ntarget:\n  panelId: some-panel\n");

		const manifest = readManifest(dir)!;
		const d = readPackEntityDescriptions(dir, manifest);
		assert.equal(d.roles!["r-desc"], "explicit role description");
		assert.equal(d.roles!["r-label"], "Friendly Label");
		assert.equal(d.roles!["r-bare"], undefined); // label == name ⇒ omitted
		assert.equal(d.tools!["grp"], "a grouped tool");
		assert.equal(d.skills!["sk"], "skill one-liner");
		assert.equal(d.entrypoints!["ep"], "entry point desc");
	});

	// SECURITY — manifest-declared entity names are path-joined into the pack dir,
	// but validateManifest does NOT guard roles/tools/skills against `..` or path
	// separators. A traversal name must NOT cause a read/readdir OUTSIDE the pack
	// dir (exploitable on Browse alone). Each unsafe name simply yields no row.
	it("does NOT read outside the pack dir for traversal names (roles/tools/skills)", () => {
		const root = fs.mkdtempSync(path.join(TMP, "descr-evil-"));
		// A secret file OUTSIDE the pack dir whose contents must never leak.
		w(path.join(root, "secret.yaml"), "description: TOP SECRET should never appear\nlabel: SECRET\n");
		w(path.join(root, "secret", "SKILL.md"), "---\ndescription: TOP SECRET skill leak\n---\nbody\n");
		const dir = path.join(root, "pack");
		// Manifest declares traversal names for all three kinds. These bypass
		// validateManifest (which only basename-guards entrypoints), so the helper
		// itself must reject them. The `.yaml`/SKILL.md targets are crafted so a
		// naive path.join would resolve onto the external secret files above.
		w(path.join(dir, "pack.yaml"),
			"name: evilpack\ndescription: evil\nversion: 1.0.0\ncontents:\n" +
			"  roles: ['../secret']\n" +
			"  tools: ['../../x', '..']\n" +
			"  skills: ['../secret']\n");
		const manifest = readManifest(dir)!;
		// Sanity: the manifest parsed and kept the traversal names verbatim.
		assert.deepEqual(manifest.contents.roles, ["../secret"]);

		let d: any;
		assert.doesNotThrow(() => { d = readPackEntityDescriptions(dir, manifest); });
		// No description rows for any traversal name; nothing leaked from outside.
		assert.equal(d.roles, undefined);
		assert.equal(d.tools, undefined);
		assert.equal(d.skills, undefined);
		const serialized = JSON.stringify(d);
		assert.ok(!serialized.includes("TOP SECRET"), `must not leak external file contents; got ${serialized}`);
	});

	it("collapses whitespace and omits kinds with no usable descriptions", () => {
		const root = fs.mkdtempSync(path.join(TMP, "descr2-"));
		const dir = path.join(root, "kit2");
		w(path.join(dir, "pack.yaml"),
			"name: kit2\ndescription: kit2\nversion: 1.0.0\ncontents:\n  roles: [r]\n  tools: []\n  skills: []\n");
		w(path.join(dir, "roles", "r.yaml"), "name: r\nlabel: r\ndescription: \"line one\\n  line two\"\n");
		const manifest = readManifest(dir)!;
		const d = readPackEntityDescriptions(dir, manifest);
		assert.equal(d.roles!["r"], "line one line two");
		assert.equal(d.tools, undefined);
		assert.equal(d.skills, undefined);
		assert.equal(d.entrypoints, undefined);
	});
});

// ── §3.3 scoped pack_order persistence ───────────────────────────

describe("§3.3 scoped pack_order persistence (ProjectConfigStore)", () => {
	it("round-trips per-scope order independently and survives reload", () => {
		const dir = fs.mkdtempSync(path.join(TMP, "porder-"));
		const cfg = path.join(dir, ".bobbit", "config");
		const store = new ProjectConfigStore(cfg);
		assert.deepEqual(store.getPackOrder("server"), []);
		store.setPackOrder("server", ["shared-pack"]);
		store.setPackOrder("global-user", ["research-pack", "qa-pack"]);
		store.setPackOrder("project", ["research-pack"]);

		// independent scopes
		assert.deepEqual(store.getPackOrder("server"), ["shared-pack"]);
		assert.deepEqual(store.getPackOrder("global-user"), ["research-pack", "qa-pack"]);
		assert.deepEqual(store.getPackOrder("project"), ["research-pack"]);

		// persisted to YAML and reloaded
		const store2 = new ProjectConfigStore(cfg);
		assert.deepEqual(store2.getPackOrder("global-user"), ["research-pack", "qa-pack"]);
		assert.deepEqual(store2.getPackOrder("project"), ["research-pack"]);

		// flat get() exposes the JSON-stringified scoped map (consumed by pack-list.ts)
		const raw = store2.get("pack_order");
		assert.ok(raw);
		const parsed = JSON.parse(raw!);
		assert.deepEqual(parsed["global-user"], ["research-pack", "qa-pack"]);
		assert.deepEqual(parsed.project, ["research-pack"]);
	});

	it("setPackOrder replaces a scope's order without touching others", () => {
		const dir = fs.mkdtempSync(path.join(TMP, "porder2-"));
		const store = new ProjectConfigStore(path.join(dir, ".bobbit", "config"));
		store.setPackOrder("server", ["a", "b"]);
		store.setPackOrder("project", ["p"]);
		store.setPackOrder("server", ["b", "a", "c"]); // reorder + add
		assert.deepEqual(store.getPackOrder("server"), ["b", "a", "c"]);
		assert.deepEqual(store.getPackOrder("project"), ["p"]);
	});
});
