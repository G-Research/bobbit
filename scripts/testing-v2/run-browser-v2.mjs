#!/usr/bin/env node
/**
 * Coordinator for the v2 Playwright browser lane.
 *
 * Playwright gets a report/result path inside a unique, owned system-temp root.
 * The coordinator waits for the runner (and therefore its reporters), runs the
 * budget assertion against that exact report, then removes successful-run
 * artifacts. Failed runs retain their temp root for diagnostic collection;
 * nothing is written into or shared through the checkout.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { coordinatorTempDirectory, createE2ERunPaths, createIsolatedE2EEnvironment } from "../run-playwright-e2e.mjs";
import { copyEnvironment } from "./environment-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * Allocate the only writable root for one browser coordinator. The shared
 * allocator also creates its `tmp/bobbit-e2e` compatibility parent, which
 * legacy E2E helpers use for their import lock.
 */
export function createBrowserRunPaths(tempDir = coordinatorTempDirectory(tmpdir())) {
	const paths = createE2ERunPaths(tempDir);
	return {
		...paths,
		report: join(paths.root, "playwright-v2", "playwright-report.json"),
	};
}

/** Build a fully owned browser-worker environment before Playwright loads. */
export function createBrowserRunEnvironment(paths, inheritedEnv = process.env, platform = process.platform) {
	const env = createIsolatedE2EEnvironment(paths, inheritedEnv, platform);
	return copyEnvironment(env, {
		BOBBIT_V2_RUN_ROOT: paths.root,
		BOBBIT_V2_RUN_ROOT_OWNER_PID: String(process.pid),
		BOBBIT_V2_PLAYWRIGHT_REPORT_PATH: paths.report,
		BOBBIT_E2E_RUN_ID: paths.runId,
		// Keep old helpers that construct join(tmpdir(), "bobbit-e2e") inside
		// this coordinator's root. No coordinator shares or removes this parent.
		BOBBIT_E2E_TMP_ROOT: paths.legacyTempParent,
		BOBBIT_E2E_PWTEST_CACHE_ROOT: paths.cacheRoot,
		BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT: paths.cacheRoot,
		PWTEST_CACHE_DIR: paths.cacheRoot,
		BOBBIT_E2E_PWTEST_CACHE_DIR: paths.cacheRoot,
		BOBBIT_E2E_PWTEST_CACHE_OWNED: "1",
		BOBBIT_E2E_V8CACHE_ROOT: paths.v8CacheRoot,
		NODE_DISABLE_COMPILE_CACHE: "1",
	}, platform);
}

/**
 * Preserve caller arguments ahead of the configured project. Playwright's
 * `--project` option is variadic, so positional filters after it are parsed as
 * additional project names instead of test-file filters.
 */
export function playwrightCommandArgs(forwardedArgs = []) {
	return [
		join(REPO_ROOT, "node_modules", "playwright", "cli.js"),
		"test",
		"--config", "playwright-v2.config.ts",
		...forwardedArgs,
		"--project", "browser-canonical",
	];
}

function run(command, args, env) {
	return new Promise((resolveRun) => {
		const child = spawn(command, args, {
			cwd: REPO_ROOT,
			env,
			stdio: "inherit",
			shell: false,
		});
		child.once("error", (error) => resolveRun({ code: 1, error }));
		child.once("close", (code, signal) => resolveRun({ code: code ?? (signal ? 1 : 0) }));
	});
}

function cleanup(root) {
	try {
		// Windows can briefly retain Playwright output handles after its child
		// exits. Keep retries bounded while tolerating transient EPERM/ENOTEMPTY.
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		return true;
	} catch {
		return false;
	}
}

export async function runBrowserV2(forwardedArgs = process.argv.slice(2)) {
	const paths = createBrowserRunPaths();
	const env = createBrowserRunEnvironment(paths);
	const playwrightCli = playwrightCommandArgs(forwardedArgs)[0];
	if (!existsSync(playwrightCli)) {
		console.error(`[browser-v2] Playwright CLI is unavailable at ${playwrightCli}`);
		cleanup(paths.root);
		return 1;
	}

	const playwright = await run(process.execPath, playwrightCommandArgs(forwardedArgs), env);
	// The reporter is complete once the Playwright process has closed. Always
	// evaluate a produced report, even when tests fail, so the budget record has
	// the exact run's data rather than a shared latest file.
	const budget = existsSync(paths.report)
		? await run(process.execPath, [join(REPO_ROOT, "scripts", "testing-v2", "assert-budget.mjs"), "browser", "--report", paths.report], env)
		: { code: 1, error: new Error("Playwright did not produce its JSON report") };
	if (budget.error) console.error(`[browser-v2] ${budget.error.message}`);

	if (playwright.code === 0 && budget.code === 0) {
		if (!cleanup(paths.root)) {
			console.error(`[browser-v2] could not remove successful run artifacts: ${paths.root}`);
			return 1;
		}
		return 0;
	}

	console.error(`[browser-v2] retained failure diagnostics: ${paths.root}`);
	return playwright.code || budget.code || 1;
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
	runBrowserV2().then((code) => { process.exitCode = code; });
}
