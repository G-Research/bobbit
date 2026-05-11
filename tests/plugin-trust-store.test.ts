/**
 * Unit tests for PluginTrustStore.
 *
 * Trust is keyed by (absolute path, sha256 of plugin.yaml). Mutating the
 * manifest invalidates trust — re-prompts the user. We exercise:
 *   - empty store loads cleanly
 *   - trust → isTrusted = true; revoke → isTrusted = false
 *   - hash drift invalidates trust without removing the entry
 *   - persistence: a fresh store instance reads back trust written by another
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { PluginTrustStore, hashManifest } from "../src/server/plugins/plugin-trust-store.ts";

function makePlugin(root: string, name: string, yaml: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "plugin.yaml"), yaml);
	return dir;
}

describe("PluginTrustStore", () => {
	let tmpRoot: string;
	let storePath: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-trust-test-"));
		storePath = path.join(tmpRoot, "trusted-plugins.json");
	});

	it("isTrusted is false for unknown plugins", () => {
		const store = new PluginTrustStore(storePath);
		const plugin = makePlugin(tmpRoot, "p1", "name: p1\nversion: 1.0.0\n");
		assert.equal(store.isTrusted(plugin), false);
	});

	it("trust → isTrusted = true with matching hash", () => {
		const store = new PluginTrustStore(storePath);
		const plugin = makePlugin(tmpRoot, "p1", "name: p1\nversion: 1.0.0\n");
		store.trust("p1", plugin);
		assert.equal(store.isTrusted(plugin), true);
	});

	it("revoke removes trust idempotently", () => {
		const store = new PluginTrustStore(storePath);
		const plugin = makePlugin(tmpRoot, "p1", "name: p1\nversion: 1.0.0\n");
		store.trust("p1", plugin);
		assert.equal(store.revoke(plugin), true);
		assert.equal(store.revoke(plugin), false);   // already gone
		assert.equal(store.isTrusted(plugin), false);
	});

	it("hash drift invalidates trust (manifest mutated after approval)", () => {
		const store = new PluginTrustStore(storePath);
		const plugin = makePlugin(tmpRoot, "p1", "name: p1\nversion: 1.0.0\n");
		store.trust("p1", plugin);
		assert.equal(store.isTrusted(plugin), true);

		// Tamper with the manifest — same path, different bytes.
		fs.writeFileSync(path.join(plugin, "plugin.yaml"), "name: p1\nversion: 2.0.0\n");
		assert.equal(store.isTrusted(plugin), false,
			"trust must invalidate when manifest hash changes — otherwise an attacker who replaces the file keeps the prior approval");

		// The entry is still there (so the UI can show 'needs re-approval').
		assert.ok(store.getEntry(plugin));
	});

	it("persists to disk and another instance can read trust back", () => {
		const plugin = makePlugin(tmpRoot, "p1", "name: p1\nversion: 1.0.0\n");
		const a = new PluginTrustStore(storePath);
		a.trust("p1", plugin);

		const b = new PluginTrustStore(storePath);
		assert.equal(b.isTrusted(plugin), true);
	});

	it("listTrusted returns all entries with hashes and timestamps", () => {
		const store = new PluginTrustStore(storePath);
		const p1 = makePlugin(tmpRoot, "p1", "name: p1\nversion: 1.0.0\n");
		const p2 = makePlugin(tmpRoot, "p2", "name: p2\nversion: 1.0.0\n");
		store.trust("p1", p1);
		store.trust("p2", p2);
		const list = store.listTrusted();
		assert.equal(list.length, 2);
		for (const e of list) {
			assert.match(e.manifestHash, /^sha256:[0-9a-f]{64}$/);
			assert.ok(e.trustedAt > 0);
		}
	});

	it("recovers from a corrupt trust file by treating it as empty", () => {
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, "{not json");
		const store = new PluginTrustStore(storePath);
		assert.deepEqual(store.listTrusted(), []);
	});
});

describe("hashManifest", () => {
	it("produces sha256:<64 hex>", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashm-"));
		fs.writeFileSync(path.join(dir, "plugin.yaml"), "name: x\nversion: 1.0.0\n");
		const h = hashManifest(dir);
		assert.match(h, /^sha256:[0-9a-f]{64}$/);
	});
	it("changes when the manifest changes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hashm-"));
		fs.writeFileSync(path.join(dir, "plugin.yaml"), "name: x\nversion: 1.0.0\n");
		const a = hashManifest(dir);
		fs.writeFileSync(path.join(dir, "plugin.yaml"), "name: x\nversion: 1.0.1\n");
		const b = hashManifest(dir);
		assert.notEqual(a, b);
	});
});
