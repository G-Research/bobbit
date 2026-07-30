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
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

function canonicalTempDir(tempDir = tmpdir()) {
	try { return realpathSync(tempDir); } catch { return resolve(tempDir); }
}

/** Allocate the only writable root for one browser coordinator. */
export function createBrowserRunPaths(tempDir = tmpdir()) {
	const root = mkdtempSync(join(canonicalTempDir(tempDir), "bobbit-v2-run-"));
	return {
		root,
		report: join(root, "playwright-v2", "playwright-report.json"),
	};
}

/** Preserve every caller-provided Playwright flag, including npm's `--retry=0`. */
export function playwrightCommandArgs(forwardedArgs = []) {
	return [
		join(REPO_ROOT, "node_modules", "playwright", "cli.js"),
		"test",
		"--config", "playwright-v2.config.ts",
		"--project", "browser-v2",
		...forwardedArgs,
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
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		return true;
	} catch {
		return false;
	}
}

export async function runBrowserV2(forwardedArgs = process.argv.slice(2)) {
	const paths = createBrowserRunPaths();
	const env = {
		...process.env,
		BOBBIT_V2_RUN_ROOT: paths.root,
		BOBBIT_V2_RUN_ROOT_OWNER_PID: String(process.pid),
		BOBBIT_V2_PLAYWRIGHT_REPORT_PATH: paths.report,
	};
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
