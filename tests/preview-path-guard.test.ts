/**
 * Unit tests for the path-traversal defence used by `/api/preview/asset`.
 * Covers the algorithm spec'd in design doc §3.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAssetPath, MAX_ASSET_SIZE } from "../src/server/preview/path-guard.ts";

let baseDir: string;
let outsideFile: string;
let workspaceRoot: string;
let supportsSymlink = true;

before(() => {
	workspaceRoot = mkdtempSync(path.join(tmpdir(), "bobbit-pg-"));
	baseDir = path.join(workspaceRoot, "preview");
	mkdirSync(baseDir, { recursive: true });
	mkdirSync(path.join(baseDir, "gifs"), { recursive: true });
	writeFileSync(path.join(baseDir, "report.html"), "<html></html>", "utf-8");
	writeFileSync(path.join(baseDir, "gifs", "01.gif"), "GIF89a-stub", "utf-8");
	outsideFile = path.join(workspaceRoot, "secret.txt");
	writeFileSync(outsideFile, "TOPSECRET", "utf-8");
	try {
		symlinkSync(outsideFile, path.join(baseDir, "evil-symlink"));
	} catch {
		supportsSymlink = false;
	}
});

after(() => {
	rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("resolveAssetPath", () => {
	it("returns ok for a sibling file", () => {
		const r = resolveAssetPath(baseDir, "report.html");
		assert.strictEqual(r.ok, true);
		if (r.ok) assert.ok(r.size > 0);
	});

	it("returns ok for a nested asset", () => {
		const r = resolveAssetPath(baseDir, "gifs/01.gif");
		assert.strictEqual(r.ok, true);
	});

	it("400 on missing path", () => {
		const r = resolveAssetPath(baseDir, null);
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("400 on empty path", () => {
		const r = resolveAssetPath(baseDir, "");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("400 on embedded NUL", () => {
		const r = resolveAssetPath(baseDir, "report.html\0extra");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("400 on absolute path", () => {
		const r = resolveAssetPath(baseDir, "/etc/passwd");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("400 on Windows-style absolute path", () => {
		const r = resolveAssetPath(baseDir, "C:/Windows/System32/foo.txt");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("400 on backslash anywhere in path", () => {
		const r = resolveAssetPath(baseDir, "foo\\bar");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("400 on ../ traversal", () => {
		const r = resolveAssetPath(baseDir, "../secret.txt");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("400 on deeply nested traversal", () => {
		const r = resolveAssetPath(baseDir, "../../../../../etc/passwd");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("400 on symlink that escapes baseDir (skipped on Windows without privilege)", () => {
		if (!supportsSymlink) return;
		const r = resolveAssetPath(baseDir, "evil-symlink");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 400);
	});

	it("404 when the file doesn't exist (within baseDir)", () => {
		const r = resolveAssetPath(baseDir, "missing.html");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 404);
	});

	it("404 when target is a directory", () => {
		const r = resolveAssetPath(baseDir, "gifs");
		assert.strictEqual(r.ok, false);
		if (!r.ok) assert.strictEqual(r.status, 404);
	});

	it("MAX_ASSET_SIZE is 25 MiB", () => {
		assert.strictEqual(MAX_ASSET_SIZE, 25 * 1024 * 1024);
	});
});
