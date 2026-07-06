/**
 * vite.config.ts path-resolution mirror — pinning test.
 *
 * `vite.config.ts` must resolve the Headquarters state dir (for `gateway-url`)
 * and the OS-level server secrets dir (for TLS material) the SAME way the server
 * does in `src/server/bobbit-dir.ts`. The two are intentionally duplicated:
 * vite.config must stay lightweight and cannot import the server module graph
 * (agent-dir-config, etc.), so we cannot share the code. This test is the guard
 * that keeps the copy honest — if the resolution logic changes in one file, the
 * shared "signatures" below must change in both or this test fails.
 *
 * See the sync note at the top of vite.config.ts::headquartersDir().
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteConfig = fs.readFileSync(path.join(projectRoot, "vite.config.ts"), "utf-8");
const bobbitDir = fs.readFileSync(path.join(projectRoot, "src", "server", "bobbit-dir.ts"), "utf-8");

// Resolution signatures that MUST appear (identically) in both files. These are
// the load-bearing expressions of the Headquarters + secrets dir resolution.
const SHARED_SIGNATURES: Array<{ label: string; needle: string }> = [
	// Headquarters dir resolution
	{ label: "BOBBIT_DIR env override", needle: "process.env.BOBBIT_DIR" },
	{ label: "BOBBIT_PI_DIR legacy override", needle: "process.env.BOBBIT_PI_DIR" },
	{ label: "headquarters dir segment", needle: '".bobbit", "headquarters"' },
	// Secrets dir resolution
	{ label: "BOBBIT_SECRETS_DIR override", needle: "process.env.BOBBIT_SECRETS_DIR" },
	{ label: "secrets dir hash", needle: 'createHash("sha256").update(headquartersDir()).digest("hex").slice(0, 16)' },
	{ label: "secrets path segment", needle: '"bobbit", "secrets", hash' },
	{ label: "win32 APPDATA base", needle: 'process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")' },
	{ label: "darwin Application Support base", needle: 'path.join(os.homedir(), "Library", "Application Support", "bobbit", "secrets", hash)' },
	{ label: "linux XDG_STATE_HOME base", needle: 'process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")' },
];

test("vite.config.ts mirrors bobbit-dir.ts Headquarters + secrets resolution", () => {
	for (const { label, needle } of SHARED_SIGNATURES) {
		assert.ok(
			bobbitDir.includes(needle),
			`bobbit-dir.ts must contain the ${label} signature: ${needle}`,
		);
		assert.ok(
			viteConfig.includes(needle),
			`vite.config.ts drifted from bobbit-dir.ts — missing the ${label} signature: ${needle}. `
				+ "Update vite.config.ts to match src/server/bobbit-dir.ts.",
		);
	}
});

test("vite.config.ts reads gateway-url from the Headquarters state dir", () => {
	// The dev proxy must read <headquartersDir>/state/gateway-url, not the legacy
	// <cwd>/.bobbit/state/gateway-url that predates the Headquarters split.
	assert.ok(
		viteConfig.includes("headquartersStateDir()") && viteConfig.includes('"gateway-url"'),
		"vite.config.ts must resolve gateway-url via headquartersStateDir()",
	);
});
