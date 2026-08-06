/**
 * Pinning test for the market-pack scan cache (pack-list.ts).
 *
 * REGRESSION THIS PINS: `scopeMarketPackEntries` → `scanMarketPacks` used to
 * read + YAML-parse every `pack.yaml` / `.pack-meta.yaml` under a scope's
 * `market-packs/` on EVERY call. The roles/tools cascade calls it during every
 * resolution, and resolution runs per session / per connected client — so a
 * busy gateway did hundreds of full disk re-scans + manifest parses per second
 * for an immutable-between-mutations manifest set, pegging a core (observed live
 * as ~155 parseManifest/sec via `marketEntries`). The fix caches the scan and
 * only drops it on a pack mutation via `invalidateMarketPackScanCache()` (fanned
 * out from the host's `invalidateResolverCaches()`).
 *
 * We prove the cache WITHOUT spying on `fs` (ESM namespace exports aren't
 * spy-able here) by mutating the filesystem behind the scan and asserting the
 * result does NOT change until the cache is invalidated — a stale read is only
 * possible if disk was not re-read.
 *
 * Invariants pinned:
 *   1. After the first scan, deleting the pack on disk does NOT change the
 *      result (served from cache ⇒ no re-read).
 *   2. invalidateMarketPackScanCache() forces the next call to re-scan disk
 *      (so a real install/update/uninstall is picked up).
 *   3. A distinct orderHint is a distinct cache key (no stale ordering served).
 *   4. A missing market-packs dir returns [] and is cached (no crash on re-read).
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scopeMarketPackEntries, invalidateMarketPackScanCache } from "../../src/server/agent/pack-list.ts";

let tmpRoot: string;
let marketPacksRoot: string;

/** Write a valid installed pack (pack.yaml + .pack-meta.yaml) under market-packs/. */
function installPack(name: string): void {
	const dir = path.join(marketPacksRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "pack.yaml"),
		`name: ${name}\ndescription: test pack ${name}\nversion: 0.0.1\nschema: 2\ncontents:\n  roles: []\n  tools: []\n  skills: []\n  entrypoints: []\n`,
		"utf-8",
	);
	fs.writeFileSync(
		path.join(dir, ".pack-meta.yaml"),
		`packName: ${name}\nversion: 0.0.1\nscope: project\n`,
		"utf-8",
	);
}

const names = (entries: ReturnType<typeof scopeMarketPackEntries>): string[] =>
	entries.map((e) => e.manifest?.name ?? "").filter(Boolean);

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pack-scan-cache-"));
	// project scope ⇒ marketPacksRoot = <base>/.bobbit/config/market-packs
	marketPacksRoot = path.join(tmpRoot, ".bobbit", "config", "market-packs");
	fs.mkdirSync(marketPacksRoot, { recursive: true });
	invalidateMarketPackScanCache(); // isolate from any prior test's cache
});

afterEach(() => {
	invalidateMarketPackScanCache();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("second call is served from cache (disk mutation not observed until invalidation)", () => {
	installPack("notes");

	// First call scans disk and finds the pack.
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);

	// Delete the pack ON DISK. A non-caching scan would now return []; the cache
	// must still return the previously-scanned result (proving no re-read).
	fs.rmSync(path.join(marketPacksRoot, "notes"), { recursive: true, force: true });
	for (let i = 0; i < 50; i++) {
		expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);
	}
});

test("invalidateMarketPackScanCache forces a re-scan (picks up install AND uninstall)", () => {
	installPack("notes");
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);

	// Install a second pack on disk; cache still serves the stale single result…
	installPack("terminal");
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);

	// …invalidate ⇒ next call re-scans and sees both (sorted for stability).
	invalidateMarketPackScanCache();
	expect(names(scopeMarketPackEntries("project", tmpRoot, [])).sort()).toEqual(["notes", "terminal"]);

	// Uninstall on disk + invalidate ⇒ re-scan reflects the removal.
	fs.rmSync(path.join(marketPacksRoot, "terminal"), { recursive: true, force: true });
	invalidateMarketPackScanCache();
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["notes"]);
});

test("distinct orderHint is a distinct cache key (no stale ordering served)", () => {
	installPack("a");
	installPack("b");
	// orderHint lists highest-priority LAST in the returned array.
	expect(names(scopeMarketPackEntries("project", tmpRoot, ["a", "b"]))).toEqual(["a", "b"]);
	expect(names(scopeMarketPackEntries("project", tmpRoot, ["b", "a"]))).toEqual(["b", "a"]);
});

test("a missing market-packs dir returns [] and re-reads safely after invalidation", () => {
	fs.rmSync(marketPacksRoot, { recursive: true, force: true }); // no dir at all
	expect(scopeMarketPackEntries("project", tmpRoot, [])).toEqual([]);
	// Repeated calls stay empty and do not throw (cached empty result).
	for (let i = 0; i < 10; i++) expect(scopeMarketPackEntries("project", tmpRoot, [])).toEqual([]);

	// Create the dir + a pack, invalidate ⇒ now found.
	fs.mkdirSync(marketPacksRoot, { recursive: true });
	installPack("late");
	invalidateMarketPackScanCache();
	expect(names(scopeMarketPackEntries("project", tmpRoot, []))).toEqual(["late"]);
});
