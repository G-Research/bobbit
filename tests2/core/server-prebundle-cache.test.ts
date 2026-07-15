import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { computeServerPrebundleKey, validateServerPrebundle } from "../../scripts/testing-v2/server-prebundle.mjs";

function fakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "bobbit-prebundle-key-"));
	mkdirSync(join(root, "src", "server"), { recursive: true });
	mkdirSync(join(root, "tests2", "harness"), { recursive: true });
	writeFileSync(join(root, "src", "server", "server.ts"), "export const value = 1;\n");
	writeFileSync(join(root, "tests2", "harness", "server-runtime-entry.ts"), "export * as server from '../../src/server/server.js';\n");
	writeFileSync(join(root, "tsconfig.server.json"), "{}\n");
	writeFileSync(join(root, "package-lock.json"), "{}\n");
	return root;
}

describe("server test prebundle cache", () => {
	it("changes the content key when server source changes", () => {
		const root = fakeRepo();
		try {
			const before = computeServerPrebundleKey(root);
			writeFileSync(join(root, "src", "server", "server.ts"), "export const value = 2;\n");
			const after = computeServerPrebundleKey(root);
			assert.notEqual(after, before);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects missing, stale, and truncated artifacts", () => {
		const root = mkdtempSync(join(tmpdir(), "bobbit-prebundle-validate-"));
		try {
			assert.equal(validateServerPrebundle(root, "key"), false);
			const bundlePath = join(root, "runtime.mjs");
			const mapPath = `${bundlePath}.map`;
			writeFileSync(bundlePath, "x");
			writeFileSync(mapPath, "{}\n");
			const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
			const writeManifest = () => writeFileSync(join(root, "manifest.json"), JSON.stringify({ schema: 2, key: "key", bundleSha256: digest(bundlePath), mapSha256: digest(mapPath) }));
			writeManifest();
			assert.equal(validateServerPrebundle(root, "key"), false, "truncated bundles must not be reused");
			writeFileSync(bundlePath, "x".repeat(2048));
			writeManifest();
			assert.equal(validateServerPrebundle(root, "other"), false, "stale keys must not be reused");
			assert.equal(validateServerPrebundle(root, "key"), true);
			writeFileSync(bundlePath, `${"x".repeat(2047)}y`);
			assert.equal(validateServerPrebundle(root, "key"), false, "corrupted bundles must not be reused");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
