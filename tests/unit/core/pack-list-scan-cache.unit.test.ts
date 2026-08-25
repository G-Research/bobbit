/**
 * Pinning tests for the marketplace and shipped built-in pack scan caches.
 *
 * These prove caching without spying on `fs` (ESM namespace exports are not
 * spy-able here): mutate the filesystem after a scan and assert the result stays
 * stale until the corresponding central invalidator is called.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { builtinFirstPartyPackEntries, invalidateBuiltinPackScanCache } from "../../../src/server/agent/builtin-packs.ts";
import { scopeMarketPackEntries, invalidateMarketPackScanCache } from "../../../src/server/agent/pack-list.ts";

let tmpRoot: string;
let marketPacksRoot: string;
let builtinPacksRoot: string;

function manifest(name: string): string {
	return `name: ${name}\ndescription: test pack ${name}\nversion: 0.0.1\nschema: 2\ncontents:\n  roles: []\n  tools: []\n  skills: []\n  entrypoints: []\n`;
}

/** Write a valid installed pack (pack.yaml + .pack-meta.yaml) under market-packs/. */
function installPack(name: string): void {
	const dir = path.join(marketPacksRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "pack.yaml"), manifest(name), "utf-8");
	fs.writeFileSync(
		path.join(dir, ".pack-meta.yaml"),
		`packName: ${name}\nversion: 0.0.1\nscope: project\n`,
		"utf-8",
	);
}

/** Write a valid shipped pack; built-ins intentionally require no metadata. */
function installBuiltinPack(name: string): void {
	const dir = path.join(builtinPacksRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "pack.yaml"), manifest(name), "utf-8");
}

const names = (entries: { manifest?: { name: string } }[]): string[] =>
	entries.map((entry) => entry.manifest?.name ?? "").filter(Boolean);

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pack-scan-cache-"));
	// project scope ⇒ marketPacksRoot = <base>/.bobbit/config/market-packs
	marketPacksRoot = path.join(tmpRoot, ".bobbit", "config", "market-packs");
	builtinPacksRoot = path.join(tmpRoot, "builtin-packs", "market-packs");
	fs.mkdirSync(marketPacksRoot, { recursive: true });
	fs.mkdirSync(builtinPacksRoot, { recursive: true });
	invalidateMarketPackScanCache();
	invalidateBuiltinPackScanCache();
});

afterEach(() => {
	invalidateMarketPackScanCache();
	invalidateBuiltinPackScanCache();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("marketplace scans stay cached until invalidation", () => {
	installPack("notes");
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);

	fs.rmSync(path.join(marketPacksRoot, "notes"), { recursive: true, force: true });
	for (let i = 0; i < 50; i++) {
		expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);
	}

	invalidateMarketPackScanCache();
	expect(scopeMarketPackEntries("project", tmpRoot, [])).toEqual([]);
});

test("marketplace invalidation picks up installs and uninstalls", () => {
	installPack("notes");
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);

	installPack("terminal");
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);

	invalidateMarketPackScanCache();
	expect(names(scopeMarketPackEntries("project", tmpRoot, [])).sort()).toEqual(["notes", "terminal"]);

	fs.rmSync(path.join(marketPacksRoot, "terminal"), { recursive: true, force: true });
	invalidateMarketPackScanCache();
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);
});

test("marketplace cache keys include orderHint", () => {
	installPack("a");
	installPack("b");
	expect(names(scopeMarketPackEntries("project", tmpRoot, ["a", "b"]))).toEqual(["a", "b"]);
	expect(names(scopeMarketPackEntries("project", tmpRoot, ["b", "a"]))).toEqual(["b", "a"]);
});

test("missing marketplace directories are cached and safely invalidated", () => {
	fs.rmSync(marketPacksRoot, { recursive: true, force: true });
	expect(scopeMarketPackEntries("project", tmpRoot, [])).toEqual([]);
	for (let i = 0; i < 10; i++) expect(scopeMarketPackEntries("project", tmpRoot, [])).toEqual([]);

	fs.mkdirSync(marketPacksRoot, { recursive: true });
	installPack("late");
	// A newly-created directory remains hidden until a real mutation invalidates.
	expect(scopeMarketPackEntries("project", tmpRoot, [])).toEqual([]);
	invalidateMarketPackScanCache();
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["late"]);
});

test("built-in scans stay cached per directory until invalidation", () => {
	installBuiltinPack("alpha");
	expect(names(builtinFirstPartyPackEntries(builtinPacksRoot))).toEqual(["alpha"]);

	fs.rmSync(path.join(builtinPacksRoot, "alpha"), { recursive: true, force: true });
	installBuiltinPack("beta");
	for (let i = 0; i < 50; i++) {
		expect(names(builtinFirstPartyPackEntries(builtinPacksRoot))).toEqual(["alpha"]);
	}

	invalidateBuiltinPackScanCache();
	expect(names(builtinFirstPartyPackEntries(builtinPacksRoot))).toEqual(["beta"]);
});

test("missing built-in directories are cached and safely invalidated", () => {
	fs.rmSync(builtinPacksRoot, { recursive: true, force: true });
	expect(builtinFirstPartyPackEntries(builtinPacksRoot)).toEqual([]);

	installBuiltinPack("late");
	expect(builtinFirstPartyPackEntries(builtinPacksRoot)).toEqual([]);
	invalidateBuiltinPackScanCache();
	expect(names(builtinFirstPartyPackEntries(builtinPacksRoot))).toEqual(["late"]);
});
