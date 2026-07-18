/**
 * Global setup for v2 browser tests.
 *
 * Mirrors tests/e2e/e2e-global-setup.ts but:
 *   - Skips the no-new-sleeps guard (run separately by the e2e suite)
 *   - Skips BOBBIT_E2E_SKIP_GUARDS logic (not needed here)
 *   - Ensures dist/server and dist/ui match the current build inputs via the
 *     content-addressed manifest (scripts/testing-v2/ensure-dist.mjs) — a
 *     stale dist is rebuilt, a fresh one is reused
 */
import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function globalSetup() {
	// Canonicalize TMPDIR on macOS (same reason as e2e-global-setup.ts).
	if (process.platform !== "win32") {
		try {
			const canonical = realpathSync(tmpdir());
			if (canonical !== tmpdir()) process.env.TMPDIR = canonical;
		} catch { /* ignore */ }
	}

	const projectRoot = join(import.meta.dirname, "..");

	// Disable external services in browser tests.
	process.env.NODE_ENV = "test";
	process.env.BOBBIT_TEST_NO_EXTERNAL = process.env.BOBBIT_TEST_NO_EXTERNAL || "1";
	process.env.BOBBIT_TEST_NO_REMOTE = process.env.BOBBIT_TEST_NO_REMOTE || "1";
	process.env.NODE_DISABLE_COMPILE_CACHE = "1";
	delete process.env.NODE_COMPILE_CACHE;

	// Content-addressed build skip: rebuilds when any build input changed,
	// reuses dist when the manifest key matches (fail-closed on any error).
	execSync(`node "${join(projectRoot, "scripts", "testing-v2", "ensure-dist.mjs")}"`, {
		cwd: projectRoot,
		stdio: "inherit",
	});
}
