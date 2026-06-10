/**
 * Built-in first-party packs — source-store guards (§11.1).
 *
 * The synthetic `builtin` source is composed only at the API layer; it is NEVER
 * persisted to `marketplace-sources.yaml`. These tests pin:
 *   - `add()` rejects the reserved url `builtin:` and any `builtin:`-scheme url.
 *   - `add()` rejects a url that would slug to the reserved id `builtin`.
 *   - A re-instantiated store (simulated restart) never contains a `builtin`
 *     source (never written to disk).
 *   - `serializeSource`/`parseSource` strip a disk-authored `builtin` flag.
 *
 * file:// fixtures only (real tmp dir, no server).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

const { MarketplaceSourceStore, BUILTIN_SOURCE_ID, BUILTIN_SOURCE_URL } = await import(
	"../src/server/agent/marketplace-source-store.ts"
);

let TMP: string;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-builtin-")); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("built-in source guards (§11.1)", () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(TMP, "src-store-")); });

	it("exposes the reserved built-in id/url constants", () => {
		assert.equal(BUILTIN_SOURCE_ID, "builtin");
		assert.equal(BUILTIN_SOURCE_URL, "builtin:");
	});

	it("rejects the reserved built-in url", () => {
		const store = new MarketplaceSourceStore(dir);
		assert.throws(() => store.add({ url: "builtin:" }), /built-in source cannot be added/);
		// any builtin:-scheme url is rejected too (case-insensitive)
		assert.throws(() => store.add({ url: "Builtin:foo" }), /built-in source cannot be added/);
	});

	it("rejects a url that slugs to the reserved id 'builtin'", () => {
		const store = new MarketplaceSourceStore(dir);
		// `/abs/path/builtin` would derive the slug id "builtin" → rejected.
		assert.throws(() => store.add({ url: "/abs/path/builtin" }), /built-in source cannot be added/);
	});

	it("does NOT persist a builtin source across a simulated restart", () => {
		const store = new MarketplaceSourceStore(dir);
		// A normal source persists fine.
		store.add({ url: "https://example.com/repo.git" });
		const file = path.join(dir, "marketplace-sources.yaml");
		assert.ok(fs.existsSync(file));
		// Re-instantiate (simulated restart): no synthetic builtin source appears.
		const store2 = new MarketplaceSourceStore(dir);
		const all = store2.list();
		assert.ok(!all.some((s) => s.id === BUILTIN_SOURCE_ID), "no builtin source in store");
		assert.ok(!all.some((s) => s.url === BUILTIN_SOURCE_URL), "no builtin url in store");
		// The persisted YAML never carries a builtin entry either.
		const raw = parse(fs.readFileSync(file, "utf-8")) as { sources: Array<Record<string, unknown>> };
		assert.ok(!raw.sources.some((s) => s.id === "builtin" || s.url === "builtin:"));
	});

	it("rejects a disk-authored row whose id is the reserved 'builtin'", () => {
		// A hand-edited/legacy sources.yaml must never be able to register a row that
		// duplicates or shadows the synthetic built-in source (§4.1/§4.4): parseSource
		// drops any row with id "builtin" OR url "builtin:".
		const file = path.join(dir, "marketplace-sources.yaml");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			file,
			stringify({
				sources: [
					{ id: "builtin", url: "/some/local/dir", addedAt: "2026-01-01T00:00:00Z" },
					{ id: "sneaky", url: "builtin:", addedAt: "2026-01-01T00:00:00Z" },
					{ id: "repo", url: "https://example.com/repo.git", addedAt: "2026-01-01T00:00:00Z" },
				],
			}),
			"utf-8",
		);
		const store = new MarketplaceSourceStore(dir);
		const all = store.list();
		// Only the legitimate row survives; both reserved-id/url rows are dropped.
		assert.deepEqual(all.map((s) => s.id), ["repo"]);
		assert.ok(!all.some((s) => s.id === BUILTIN_SOURCE_ID), "no builtin id row loaded");
		assert.ok(!all.some((s) => s.url === BUILTIN_SOURCE_URL), "no builtin: url row loaded");
	});

	it("strips a disk-authored `builtin` flag on load", () => {
		// Author a sources.yaml by hand with a builtin flag smuggled onto a row.
		const file = path.join(dir, "marketplace-sources.yaml");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			file,
			stringify({ sources: [{ id: "repo", url: "https://example.com/repo.git", addedAt: "2026-01-01T00:00:00Z", builtin: true }] }),
			"utf-8",
		);
		const store = new MarketplaceSourceStore(dir);
		const all = store.list();
		assert.equal(all.length, 1);
		assert.equal(all[0].id, "repo");
		// The disk-authored builtin flag is stripped (parseSource never reads it).
		assert.equal(all[0].builtin, undefined);
		// And it is not re-serialized to disk.
		store.update("repo", { lastCommit: "abc" });
		const raw = parse(fs.readFileSync(file, "utf-8")) as { sources: Array<Record<string, unknown>> };
		assert.equal(raw.sources[0].builtin, undefined);
	});
});
