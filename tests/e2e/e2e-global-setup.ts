/**
 * Global setup for E2E tests: ensures both server and UI are built.
 *
 * The gateway harness serves the UI from dist/ui/ (static files) and runs
 * the server from dist/server/cli.js. Without this build step, fullstack
 * browser tests fail because the UI assets don't exist.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * True if `referenceFile` is missing, or any file under `watchPaths` (files
 * or directories, walked recursively) has a newer mtime than it.
 *
 * Same "find -newer" staleness pattern the `run` launcher uses (run:33-42,
 * run.cmd:57-87) to skip no-op rebuilds — reused here so repeated
 * `npm run test:e2e` invocations on an unchanged tree don't pay a full
 * rebuild (see docs/testing-strategy.md and FINDINGS TEST-03).
 */
export function isStale(referenceFile: string, watchPaths: string[]): boolean {
	if (!existsSync(referenceFile)) return true;
	const refMtime = statSync(referenceFile).mtimeMs;
	for (const watchPath of watchPaths) {
		if (!existsSync(watchPath)) continue;
		const stat = statSync(watchPath);
		if (!stat.isDirectory()) {
			if (stat.mtimeMs > refMtime) return true;
			continue;
		}
		for (const entry of readdirSync(watchPath, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const full = join(entry.parentPath ?? watchPath, entry.name);
			if (statSync(full).mtimeMs > refMtime) return true;
		}
	}
	return false;
}

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

	// Rebuild only what's missing or stale, so repeated runs on an unchanged
	// tree skip the build entirely instead of paying a full cold rebuild.
	// `market-packs/` is included in the server watch set because
	// build:server's copy-builtin-packs step ships whatever is committed
	// there (see scripts/copy-builtin-packs.mjs) — a pack source edit must
	// still trigger build:packs, not just build:server.
	const needServer = isStale(serverEntry, [
		join(projectRoot, "src", "server"),
		join(projectRoot, "src", "shared"),
		join(projectRoot, "market-packs"),
		join(projectRoot, "package.json"),
		join(projectRoot, "tsconfig.server.json"),
	]);
	const needUI = isStale(join(uiDir, "index.html"), [
		join(projectRoot, "src", "ui"),
		join(projectRoot, "src", "app"),
	]);

	if (needServer && needUI) {
		console.log("[e2e-setup] Building server and UI...");
		execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
	} else if (needServer) {
		console.log("[e2e-setup] Building packs and server...");
		execSync("npm run build:packs && npm run build:server", { cwd: projectRoot, stdio: "inherit" });
	} else if (needUI) {
		console.log("[e2e-setup] Building UI...");
		execSync("npm run build:ui", { cwd: projectRoot, stdio: "inherit" });
	} else {
		console.log("[e2e-setup] Build is up to date, skipping.");
	}
}
