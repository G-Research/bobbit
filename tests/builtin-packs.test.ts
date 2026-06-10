/**
 * Built-in first-party packs — resolution core (Task A) unit tests.
 *
 * Covers design `docs/design/built-in-first-party-packs.md` §11.1:
 *   - resolveBuiltinPacksDir() honours the `override` param + BOBBIT_BUILTIN_PACKS_DIR.
 *   - builtinFirstPartyPackEntries() returns one stable entry per shipped pack
 *     (id "builtin-pack:<name>", scope "server", `market-packs` path segment,
 *     synthetic meta, manifest populated).
 *   - packId stability: packIdFromRoot(entry.path) === manifest.name and
 *     isMarketPackBaseDir(entry.path) === true.
 *   - idempotency across calls.
 *   - precedence in buildPackList(): the band sits AFTER the `builtin` defaults
 *     entry and BEFORE the server band; a same-name server-installed pack wins
 *     (appears later in the list).
 *
 * The band is pointed at the repo `market-packs/` dir (which already carries
 * the built `lib/` bundles) via the `override` param — no dist required.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_MARKET_PACKS = path.join(__dirname, "..", "market-packs");

const builtinPacksMod = await import("../src/server/agent/builtin-packs.ts");
const { resolveBuiltinPacksDir, builtinFirstPartyPackEntries, BUILTIN_PACK_SCOPE } = builtinPacksMod;
const { packIdFromRoot } = await import("../src/server/agent/pack-contributions.ts");
const { isMarketPackBaseDir } = await import("../src/server/agent/tool-contributions.ts");
const { buildPackList } = await import("../src/server/agent/pack-list.ts");

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

describe("resolveBuiltinPacksDir", () => {
	it("honours the override param (highest precedence)", () => {
		assert.equal(resolveBuiltinPacksDir("/some/override"), "/some/override");
	});

	it("falls back to BOBBIT_BUILTIN_PACKS_DIR when no override", () => {
		const prev = process.env.BOBBIT_BUILTIN_PACKS_DIR;
		process.env.BOBBIT_BUILTIN_PACKS_DIR = "/from/env";
		try {
			assert.equal(resolveBuiltinPacksDir(), "/from/env");
			// override still beats env
			assert.equal(resolveBuiltinPacksDir("/wins"), "/wins");
		} finally {
			if (prev === undefined) delete process.env.BOBBIT_BUILTIN_PACKS_DIR;
			else process.env.BOBBIT_BUILTIN_PACKS_DIR = prev;
		}
	});

	it("defaults to a __dirname-relative builtin-packs/market-packs path", () => {
		const prev = process.env.BOBBIT_BUILTIN_PACKS_DIR;
		delete process.env.BOBBIT_BUILTIN_PACKS_DIR;
		try {
			const resolved = resolveBuiltinPacksDir();
			assert.ok(
				resolved.split(/[\\/]+/).includes("builtin-packs"),
				`expected a builtin-packs segment in ${resolved}`,
			);
			assert.ok(resolved.endsWith(path.join("builtin-packs", "market-packs")));
		} finally {
			if (prev !== undefined) process.env.BOBBIT_BUILTIN_PACKS_DIR = prev;
		}
	});
});

describe("builtinFirstPartyPackEntries", () => {
	it("returns [] gracefully when the dir does not exist", () => {
		assert.deepEqual(builtinFirstPartyPackEntries(path.join(os.tmpdir(), "no-such-dir-xyz")), []);
	});

	it("returns one stable entry per shipped pack with synthetic provenance", () => {
		const entries = builtinFirstPartyPackEntries(REPO_MARKET_PACKS);
		assert.ok(entries.length >= 1, "expected at least one first-party pack");
		const pw = entries.find((e) => e.manifest?.name === "pr-walkthrough");
		assert.ok(pw, "expected the pr-walkthrough pack to resolve");

		// Stable id + scope + provenance (§5.1).
		assert.equal(pw.id, "builtin-pack:pr-walkthrough");
		assert.equal(pw.kind, "market");
		assert.equal(pw.scope, BUILTIN_PACK_SCOPE);
		assert.equal(pw.scope, "server");
		assert.equal(pw.readOnly, true);
		assert.equal(pw.layout, "defaults-tree");
		assert.equal(pw.skillSource, "project");
		assert.ok(pw.manifest, "manifest populated");
		assert.equal(pw.manifest.name, "pr-walkthrough");
		assert.ok(pw.manifest.version.length > 0);

		// Synthetic meta — NOT read from disk.
		assert.equal(pw.meta?.sourceUrl, "builtin:");
		assert.equal(pw.meta?.commit, "");
		assert.equal(pw.meta?.installedAt, "");
		assert.equal(pw.meta?.scope, "server");
		assert.equal(pw.meta?.packName, "pr-walkthrough");

		// Path contains a `market-packs` segment (§6.1).
		assert.ok(pw.path.split(/[\\/]+/).includes("market-packs"));
	});

	it("entries are sorted by dir name (stable order)", () => {
		const names = builtinFirstPartyPackEntries(REPO_MARKET_PACKS).map((e) => e.manifest!.name);
		assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
	});

	it("packId derivation is stable and identity code recognises the path", () => {
		const pw = builtinFirstPartyPackEntries(REPO_MARKET_PACKS).find((e) => e.manifest?.name === "pr-walkthrough");
		assert.ok(pw);
		assert.equal(packIdFromRoot(pw.path), pw.manifest!.name);
		assert.equal(isMarketPackBaseDir(pw.path), true);
	});

	it("is idempotent across calls (two calls produce identical entries)", () => {
		const a = builtinFirstPartyPackEntries(REPO_MARKET_PACKS);
		const b = builtinFirstPartyPackEntries(REPO_MARKET_PACKS);
		assert.deepEqual(a, b);
	});
});

describe("buildPackList precedence with the built-in band", () => {
	let TMP: string;
	before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-band-")); });
	after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

	function idsOf(opts: Record<string, unknown>): string[] {
		return buildPackList(opts as any).map((e: { id: string }) => e.id);
	}

	it("inserts the band AFTER `builtin` defaults and BEFORE the server band", () => {
		const ids = idsOf({
			builtinsDir: path.join(TMP, "defaults"),
			builtinPacksDir: REPO_MARKET_PACKS,
			serverBase: path.join(TMP, "server"),
			globalUserBase: path.join(TMP, "home"),
			cwd: path.join(TMP, "server"),
		});
		const builtinIdx = ids.indexOf("builtin");
		const bandIdx = ids.indexOf("builtin-pack:pr-walkthrough");
		const serverUserIdx = ids.indexOf("user:server");
		assert.ok(builtinIdx >= 0 && bandIdx >= 0 && serverUserIdx >= 0);
		assert.ok(builtinIdx < bandIdx, "band must sit after the builtin defaults entry");
		assert.ok(bandIdx < serverUserIdx, "band must sit before the server user pack");
	});

	it("omitting builtinPacksDir yields no band (byte-identical legacy list)", () => {
		const ids = idsOf({
			builtinsDir: path.join(TMP, "defaults"),
			serverBase: path.join(TMP, "server"),
			globalUserBase: path.join(TMP, "home"),
			cwd: path.join(TMP, "server"),
		});
		assert.ok(!ids.some((id) => id.startsWith("builtin-pack:")), "no built-in band when dir omitted");
	});

	it("a same-name server-installed pack appears later (wins resolution)", () => {
		// Install a user market pack named pr-walkthrough at server scope.
		const serverBase = path.join(TMP, "srv2");
		const packDir = path.join(serverBase, ".bobbit", "config", "market-packs", "pr-walkthrough");
		w(path.join(packDir, "pack.yaml"),
			"name: pr-walkthrough\ndescription: user override\nversion: 9.9.9\n" +
			"contents:\n  roles: []\n  tools: []\n  skills: []\n  entrypoints: []\n");
		w(path.join(packDir, ".pack-meta.yaml"),
			"packName: pr-walkthrough\nversion: 9.9.9\nscope: server\n" +
			"sourceUrl: https://example/x\nsourceRef: main\ncommit: abc\n" +
			"installedAt: 2024-01-01T00:00:00Z\nupdatedAt: 2024-01-01T00:00:00Z\n");

		const ids = idsOf({
			builtinsDir: path.join(TMP, "defaults"),
			builtinPacksDir: REPO_MARKET_PACKS,
			serverBase,
			globalUserBase: path.join(TMP, "home"),
			cwd: serverBase,
		});
		const bandIdx = ids.indexOf("builtin-pack:pr-walkthrough");
		const userInstallIdx = ids.indexOf("market:server:pr-walkthrough");
		assert.ok(bandIdx >= 0, "built-in band entry present");
		assert.ok(userInstallIdx >= 0, "server-installed same-name pack present");
		assert.ok(bandIdx < userInstallIdx, "the user-installed pack must come later (wins)");
	});
});
