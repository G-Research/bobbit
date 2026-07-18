#!/usr/bin/env node
/**
 * run-bundle-check.mjs — the build-first bundle-size guard lane (`npm run test:bundle`).
 *
 * `tests2/core/bundle-size.test.ts` asserts the UI chunk budgets but does NOT
 * build (building on every unit run would double CI time). It reads `dist/ui`,
 * so it is only meaningful immediately after a fresh `vite build` — and it is
 * gated on `BOBBIT_ASSERT_BUNDLE=1` so it can never assert against a STALE dist
 * in the broad `test:unit`/lane run.
 *
 * This wrapper is the one place that satisfies both preconditions: it runs
 * `build:ui` to produce a fresh `dist/ui`, then runs the bundle-size spec with
 * the flag set. Cross-platform (no cross-env dependency; env is set on the child
 * via spawn options, not shell syntax).
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(cmd, args, env = {}) {
	return new Promise((resolveRun) => {
		const child = spawn(cmd, args, {
			cwd: REPO_ROOT,
			env: { ...process.env, ...env },
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("close", (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
		child.on("error", () => resolveRun(1));
	});
}

const buildCode = await run(npm, ["run", "build:ui"]);
if (buildCode !== 0) {
	console.error(`[bundle-check] build:ui failed (exit ${buildCode})`);
	process.exit(buildCode);
}
const testCode = await run(
	npx,
	["vitest", "run", "--config", "vitest.config.ts", "--silent=passed-only", "tests2/core/bundle-size.test.ts", "tests2/core/support-packaging.test.ts"],
	{ BOBBIT_ASSERT_BUNDLE: "1" },
);
process.exit(testCode);
