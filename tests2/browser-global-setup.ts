/**
 * Global setup for v2 browser tests.
 *
 * Mirrors tests/e2e/e2e-global-setup.ts but:
 *   - Skips the no-new-sleeps guard (run separately by the e2e suite)
 *   - Skips BOBBIT_E2E_SKIP_GUARDS logic (not needed here)
 *   - Builds dist/server and dist/ui if either is missing
 */
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
	const serverEntry = join(projectRoot, "dist", "server", "cli.js");
	const uiDir = join(projectRoot, "dist", "ui");

	// Disable external services in browser tests.
	process.env.NODE_ENV = "test";
	process.env.BOBBIT_TEST_NO_EXTERNAL = process.env.BOBBIT_TEST_NO_EXTERNAL || "1";
	process.env.BOBBIT_TEST_NO_REMOTE = process.env.BOBBIT_TEST_NO_REMOTE || "1";
	process.env.NODE_DISABLE_COMPILE_CACHE = "1";
	delete process.env.NODE_COMPILE_CACHE;

	const needServer = !existsSync(serverEntry);
	const needUI = !existsSync(uiDir);

	if (needServer && needUI) {
		console.log("[v2-browser-setup] Building server and UI...");
		execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
	} else if (needServer) {
		console.log("[v2-browser-setup] Building server...");
		execSync("npm run build:server", { cwd: projectRoot, stdio: "inherit" });
	} else if (needUI) {
		console.log("[v2-browser-setup] Building UI...");
		execSync("npm run build:ui", { cwd: projectRoot, stdio: "inherit" });
	}
}
