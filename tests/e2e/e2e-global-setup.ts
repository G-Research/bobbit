/**
 * Global setup for E2E tests: ensures both server and UI are built.
 *
 * The gateway harness serves the UI from dist/ui/ (static files) and runs
 * the server from dist/server/cli.js. Without this build step, fullstack
 * browser tests fail because the UI assets don't exist.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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

	// Keep the standard E2E suite off external services; individual specs may
	// still exercise local mock servers and local bare git remotes.
	process.env.NODE_ENV = "test";
	process.env.BOBBIT_TEST_NO_EXTERNAL = process.env.BOBBIT_TEST_NO_EXTERNAL || "1";
	process.env.BOBBIT_TEST_NO_REMOTE = process.env.BOBBIT_TEST_NO_REMOTE || "1";

	// Do not let a host-level Node compile cache leak into E2E workers. Stale or
	// partial cache entries produced false ESM startup errors such as "module X
	// does not provide an export Y" under concurrent Windows runs.
	process.env.NODE_DISABLE_COMPILE_CACHE = "1";
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
