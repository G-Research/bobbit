/**
 * Global setup for E2E tests: ensures both server and UI are built.
 *
 * The gateway harness serves the UI from dist/ui/ (static files) and runs
 * the server from dist/server/cli.js. Without this build step, fullstack
 * browser tests fail because the UI assets don't exist.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function globalSetup() {
	// On macOS, os.tmpdir() returns /var/folders/... which is a symlink to
	// /private/var/folders/... The project registry rejects symlinked rootPaths
	// unless acceptCanonical:true is passed. Canonicalize TMPDIR here (global
	// setup runs before any worker) so all test files that call os.tmpdir()
	// receive the real path and project registration succeeds without needing
	// per-call acceptCanonical.
	if (process.platform !== "win32") {
		try {
			const canonical = realpathSync(tmpdir());
			if (canonical !== tmpdir()) process.env.TMPDIR = canonical;
		} catch { /* ignore — tmpdir() is always readable */ }
	}

	// Run the no-new-sleeps guard FIRST so a CI run blocks the moment a new
	// hardcoded sleep is introduced. Cheap (<200ms) and bypasses the build
	// step on guard failure. See tests/e2e/test-utils/no-new-sleeps.mjs.
	const guardScript = join(import.meta.dirname, "test-utils", "no-new-sleeps.mjs");
	if (existsSync(guardScript) && !process.env.BOBBIT_E2E_SKIP_GUARDS) {
		try {
			execFileSync(process.execPath, [guardScript], {
				cwd: join(import.meta.dirname, "..", ".."),
				stdio: "inherit",
			});
		} catch {
			process.exit(1);
		}
	}
	const projectRoot = join(import.meta.dirname, "..", "..");
	const serverEntry = join(projectRoot, "dist", "server", "cli.js");
	const uiDir = join(projectRoot, "dist", "ui");

	// V8 compile cache root — each Playwright run gets a fresh parent, and
	// each worker enables its own subdir below it (see gateway-harness.ts /
	// in-process-harness.ts). A shared cache dir across concurrent workers —
	// or across rebuilds when Windows reuses a worker pid — produced spurious
	// "SyntaxError: module X does not provide an export Y" on first import.
	const cacheRoot = join(tmpdir(), "bobbit-e2e-v8cache", `run-${process.pid}-${Date.now()}`);
	try { mkdirSync(cacheRoot, { recursive: true }); } catch { /* best-effort */ }
	process.env.BOBBIT_E2E_V8CACHE_ROOT = cacheRoot;
	// Explicitly DO NOT set NODE_COMPILE_CACHE here — workers set their own
	// per-worker subdir via module.enableCompileCache() before any dist/ import.
	delete process.env.NODE_COMPILE_CACHE;

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
