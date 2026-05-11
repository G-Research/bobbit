/**
 * Unit tests for plugin manifest parsing & validation.
 *
 * Validates the schema gates on plugin.yaml — name/version regex, path
 * traversal guards on entryPoints and contributes paths, and the
 * data-only-plugin shape (no entryPoints).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { readManifest, validateManifest, insidePluginRoot } from "../src/server/plugins/plugin-manifest.ts";

let tmpRoot: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-manifest-test-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writePlugin(name: string, manifestYaml: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "plugin.yaml"), manifestYaml);
	return dir;
}

describe("validateManifest", () => {
	it("rejects missing name and version", () => {
		const { errors } = validateManifest({}, "/tmp");
		const fields = errors.map(e => e.field);
		assert.ok(fields.includes("name"));
		assert.ok(fields.includes("version"));
	});

	it("rejects malformed name (uppercase, leading number)", () => {
		const r1 = validateManifest({ name: "MyPlugin", version: "1.0.0" }, "/tmp");
		assert.ok(r1.errors.some(e => e.field === "name"));
		const r2 = validateManifest({ name: "1foo", version: "1.0.0" }, "/tmp");
		assert.ok(r2.errors.some(e => e.field === "name"));
	});

	it("rejects malformed version (non-semver)", () => {
		const r = validateManifest({ name: "ok", version: "v1" }, "/tmp");
		assert.ok(r.errors.some(e => e.field === "version"));
	});

	it("accepts a minimal valid manifest with no entry points", () => {
		const { manifest, errors } = validateManifest({ name: "autoresearch", version: "0.1.0" }, "/tmp");
		assert.equal(errors.length, 0);
		assert.equal(manifest.name, "autoresearch");
		assert.equal(manifest.entryPoints, undefined);
	});

	it("rejects entry point paths that escape the plugin root", () => {
		const { errors } = validateManifest({
			name: "bad", version: "1.0.0",
			entryPoints: { gateway: "../../../etc/passwd" },
		}, "/tmp/plugin-root");
		assert.ok(errors.some(e => e.field === "entryPoints.gateway" && /escapes/.test(e.message)));
	});

	it("rejects contributed paths that escape the plugin root", () => {
		const { errors } = validateManifest({
			name: "bad", version: "1.0.0",
			contributes: { workflows: ["../outside.yaml"] },
		}, "/tmp/plugin-root");
		assert.ok(errors.some(e => e.field === "contributes.workflows" && /escapes/.test(e.message)));
	});

	it("rejects malformed contributes arrays", () => {
		const { errors } = validateManifest({
			name: "x", version: "1.0.0",
			contributes: { roles: "not-an-array" as any },
		}, "/tmp/plugin-root");
		assert.ok(errors.some(e => e.field === "contributes.roles"));
	});

	it("rejects verifyStepTypes that isn't an array of strings", () => {
		const { errors } = validateManifest({
			name: "x", version: "1.0.0", verifyStepTypes: "external-job" as any,
		}, "/tmp");
		assert.ok(errors.some(e => e.field === "verifyStepTypes"));
	});
});

describe("readManifest", () => {
	it("reads and validates a real plugin.yaml from disk", () => {
		const dir = writePlugin("good", [
			"name: good-plugin",
			"version: 1.2.3",
			"description: A test plugin.",
			"contributes:",
			"  workflows: [workflows/main.yaml]",
		].join("\n"));
		const { manifest, errors } = readManifest(dir);
		assert.equal(errors.length, 0);
		assert.equal(manifest.name, "good-plugin");
		assert.equal(manifest.version, "1.2.3");
		assert.deepEqual(manifest.contributes?.workflows, ["workflows/main.yaml"]);
	});

	it("throws on missing plugin.yaml", () => {
		const dir = path.join(tmpRoot, "no-manifest");
		fs.mkdirSync(dir, { recursive: true });
		assert.throws(() => readManifest(dir));
	});

	it("throws on non-object YAML", () => {
		const dir = writePlugin("bad-yaml", "- just an array");
		assert.throws(() => readManifest(dir), /did not parse as an object/);
	});
});

describe("insidePluginRoot", () => {
	it("accepts paths inside the root", () => {
		assert.equal(insidePluginRoot("/a/b", "c.txt"), true);
		assert.equal(insidePluginRoot("/a/b", "sub/c.txt"), true);
	});
	it("rejects parent-relative escapes", () => {
		assert.equal(insidePluginRoot("/a/b", "../c"), false);
		assert.equal(insidePluginRoot("/a/b", "../../etc/passwd"), false);
	});
	it("rejects absolute paths outside the root", () => {
		assert.equal(insidePluginRoot("/a/b", "/etc/passwd"), false);
	});
});
