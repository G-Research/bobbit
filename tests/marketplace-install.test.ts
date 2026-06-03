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

	it("deriveSourceId sanitizes and disambiguates", () => {
		const taken = new Set<string>(["repo"]);
		assert.equal(deriveSourceId("https://x/Repo.git", taken), "repo-2");
		assert.equal(deriveSourceId("/home/u/My Packs/", new Set()), "my-packs");
	});
});

// ── local-dir vs git-url branching ───────────────────────────────

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
		const res = inst.installPack({ sourceId: sourceId(), packName: "qa-pack", scope: "server", packOrderStore: packOrder });
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
		inst.installPack({ sourceId: sourceId(), packName: "research-pack", scope: "server", packOrderStore: packOrder });
		assert.throws(
			() => inst.installPack({ sourceId: sourceId(), packName: "research-pack", scope: "server", packOrderStore: packOrder }),
			(e: any) => e instanceof MarketplaceError && e.code === "already_installed",
		);
	});

	it("install rejects unknown pack name", () => {
		assert.throws(
			() => inst.installPack({ sourceId: sourceId(), packName: "nope", scope: "server", packOrderStore: packOrder }),
			(e: any) => e instanceof MarketplaceError && e.code === "unknown_pack",
		);
	});

	it("path-traversal guards reject unsafe names", () => {
		for (const bad of ["../evil", ".hidden", "a/b", "..", "C:foo"]) {
			assert.throws(
				() => inst.installPack({ sourceId: sourceId(), packName: bad, scope: "server", packOrderStore: packOrder }),
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
		inst.installPack({ sourceId: sourceId(), packName: "research-pack", scope: "server", packOrderStore: packOrder });
		inst.installPack({ sourceId: sourceId(), packName: "qa-pack", scope: "server", packOrderStore: packOrder });
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
		const res = inst.installPack({ sourceId: sourceId(), packName: "research-pack", scope: "server", packOrderStore: packOrder });
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
