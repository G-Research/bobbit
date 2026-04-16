/**
 * Global setup for E2E tests: ensures both server and UI are built.
 *
 * The gateway harness serves the UI from dist/ui/ (static files) and runs
 * the server from dist/server/cli.js. Without this build step, fullstack
 * browser tests fail because the UI assets don't exist.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function globalSetup() {
	const projectRoot = join(import.meta.dirname, "..", "..");
	const serverEntry = join(projectRoot, "dist", "server", "cli.js");
	const uiDir = join(projectRoot, "dist", "ui");

	// Share V8 compile cache across all Playwright workers and any child
	// processes they spawn (gateway-harness spawns dist/server/cli.js per
	// worker). Without this, every worker re-parses megabytes of
	// dist/server/ JS on cold start. Requires Node ≥22.8 (stable).
	// See: https://nodejs.org/api/module.html#module-compile-cache
	if (!process.env.NODE_COMPILE_CACHE) {
		const cacheDir = join(tmpdir(), "bobbit-e2e-v8cache");
		try { mkdirSync(cacheDir, { recursive: true }); } catch { /* best-effort */ }
		process.env.NODE_COMPILE_CACHE = cacheDir;
	}

	// Only build what's missing to keep repeated runs fast
	const needServer = !existsSync(serverEntry);
	const needUI = !existsSync(uiDir);

	if (needServer && needUI) {
		console.log("[e2e-setup] Building server and UI...");
		execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
	} else if (needServer) {
		console.log("[e2e-setup] Building server...");
		execSync("npm run build:server", { cwd: projectRoot, stdio: "inherit" });
	} else if (needUI) {
		console.log("[e2e-setup] Building UI...");
		execSync("npm run build:ui", { cwd: projectRoot, stdio: "inherit" });
	}
}
