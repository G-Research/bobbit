/**
 * Unit tests for the marketplace source registry (§3): add/remove/list
 * round-trips through sources.json, id assignment, and local-path validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { SourceRegistry, SourceRegistryError } =
	await import("../src/server/marketplace/source-registry.ts");

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-market-reg-"));
}

describe("marketplace source registry", () => {
	it("adds a local source, assigns an id, and persists to sources.json", () => {
		const stateDir = tmp();
		const localPath = tmp();
		const reg = new SourceRegistry(stateDir);
		const rec = reg.add({ kind: "local", path: localPath });
		assert.match(rec.id, /^[a-f0-9]{8}$/);
		assert.equal(rec.kind, "local");
		assert.equal(rec.path, localPath);
		assert.equal(rec.label, path.basename(localPath));

		// Round-trip: a fresh registry on the same stateDir sees it.
		const reg2 = new SourceRegistry(stateDir);
		assert.equal(reg2.list().length, 1);
		assert.equal(reg2.get(rec.id)?.path, localPath);

		const file = path.join(stateDir, "marketplace", "sources.json");
		assert.ok(fs.existsSync(file));
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		assert.equal(parsed.version, 1);
		assert.equal(parsed.sources.length, 1);
	});

	it("adds a git source and derives a label from the url", () => {
		const reg = new SourceRegistry(tmp());
		const rec = reg.add({ kind: "git", url: "https://github.com/acme/bobbit-packs.git", ref: "main" });
		assert.equal(rec.kind, "git");
		assert.equal(rec.url, "https://github.com/acme/bobbit-packs.git");
		assert.equal(rec.ref, "main");
		assert.equal(rec.label, "bobbit-packs");
		assert.equal(rec.path, null);
	});

	it("rejects a git source without a url", () => {
		const reg = new SourceRegistry(tmp());
		assert.throws(() => reg.add({ kind: "git" }), SourceRegistryError);
	});

	it("rejects a local source with a relative or missing path", () => {
		const reg = new SourceRegistry(tmp());
		assert.throws(() => reg.add({ kind: "local", path: "relative/dir" }), SourceRegistryError);
		assert.throws(() => reg.add({ kind: "local", path: path.join(os.tmpdir(), "does-not-exist-" + Date.now()) }), SourceRegistryError);
	});

	it("rejects an unknown kind", () => {
		const reg = new SourceRegistry(tmp());
		assert.throws(() => reg.add({ kind: "ftp" as any, url: "x" }), SourceRegistryError);
	});

	it("update() persists sync status and remove() deletes the record", () => {
		const stateDir = tmp();
		const reg = new SourceRegistry(stateDir);
		const rec = reg.add({ kind: "git", url: "https://example.com/p.git" });
		reg.update(rec.id, { lastSyncedAt: 123, lastSyncCommit: "abc123", lastSyncError: null });

		const reg2 = new SourceRegistry(stateDir);
		assert.equal(reg2.get(rec.id)?.lastSyncCommit, "abc123");
		assert.equal(reg2.get(rec.id)?.lastSyncedAt, 123);

		reg2.remove(rec.id);
		assert.equal(new SourceRegistry(stateDir).list().length, 0);
		assert.throws(() => reg2.remove(rec.id), SourceRegistryError);
	});
});
