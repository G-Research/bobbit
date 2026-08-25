#!/usr/bin/env node
/**
 * Legacy combined unit coordinator retained for direct callers.
 *
 * Canonical discovery belongs to vitest.config.ts and playwright-v2.config.ts;
 * this wrapper only runs the complete unit and normal-browser lanes in parallel.
 * Public lane commands remain `npm run test:unit` and `npm run test:browser`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failureTailLines = Math.max(20, Number.parseInt(process.env.BOBBIT_UNIT_FAILURE_TAIL_LINES || "240", 10) || 240);
const exitCloseGraceMs = Math.max(1000, Number.parseInt(process.env.BOBBIT_UNIT_EXIT_CLOSE_GRACE_MS || "5000", 10) || 5000);
const runnerTimeoutMs = Math.max(60_000, Number.parseInt(process.env.BOBBIT_UNIT_RUNNER_TIMEOUT_MS || "1050000", 10) || 1_050_000);
const runnerKillGraceMs = Math.max(1000, Number.parseInt(process.env.BOBBIT_UNIT_RUNNER_KILL_GRACE_MS || "10000", 10) || 10_000);
const testEnv = {
	...process.env,
	NODE_ENV: "test",
	BOBBIT_TEST_NO_EXTERNAL: process.env.BOBBIT_TEST_NO_EXTERNAL || "1",
	BOBBIT_TEST_NO_REMOTE: process.env.BOBBIT_TEST_NO_REMOTE || "1",
	BOBBIT_V2_RETRY_FREE: process.env.BOBBIT_V2_RETRY_FREE || "1",
};

const runners = [
	{
		label: "unit",
		script: join(projectRoot, "node_modules", "vitest", "vitest.mjs"),
		args: ["run", "--config", "vitest.config.ts", "--retry=0", "--silent=passed-only"],
	},
	{
		label: "browser",
		script: join(projectRoot, "scripts", "testing-v2", "run-browser-v2.mjs"),
		args: ["--retry=0"],
	},
];

function appendTail(tail, chunk) {
	for (const line of String(chunk).split(/\r?\n/)) {
		if (!line) continue;
		tail.push(line);
		if (tail.length > failureTailLines) tail.shift();
	}
}

function run({ label, script, args }) {
	return new Promise((resolveRun) => {
		if (!existsSync(script)) {
			resolveRun({ label, code: 1, tail: [`Missing runner: ${script}`] });
			return;
		}
		const startedAt = Date.now();
		const tail = [];
		let settled = false;
		let timedOut = false;
		let exitCode = null;
		let exitSignal = null;
		let closeGraceTimer;
		let killGraceTimer;
		const child = spawn(process.execPath, [script, ...args], {
			cwd: projectRoot,
			env: testEnv,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});

		const settle = (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (closeGraceTimer) clearTimeout(closeGraceTimer);
			if (killGraceTimer) clearTimeout(killGraceTimer);
			const resultCode = timedOut ? 1 : (code ?? (signal ? 1 : 0));
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
			console.log(`\n[run-unit] ${label} finished in ${elapsed}s (exit ${resultCode})`);
			resolveRun({ label, code: resultCode, tail });
		};

		const terminate = () => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
				catch { try { child.kill("SIGTERM"); } catch { /* best effort */ } }
			} else {
				try { child.kill("SIGTERM"); } catch { /* best effort */ }
			}
		};

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			const warning = `[run-unit] ${label} timed out after ${runnerTimeoutMs}ms; terminating it before the outer gate timeout.`;
			console.error(warning);
			appendTail(tail, warning);
			terminate();
			killGraceTimer = setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				settle(1, null);
			}, runnerKillGraceMs);
		}, runnerTimeoutMs);

		child.stdout?.on("data", (chunk) => { process.stdout.write(chunk); appendTail(tail, chunk); });
		child.stderr?.on("data", (chunk) => { process.stderr.write(chunk); appendTail(tail, chunk); });
		child.once("error", (error) => { appendTail(tail, error.stack || error); settle(1, null); });
		child.once("exit", (code, signal) => {
			exitCode = code;
			exitSignal = signal;
			closeGraceTimer = setTimeout(() => {
				const warning = `[run-unit] ${label} process exited but stdio did not close within ${exitCloseGraceMs}ms; using the process exit.`;
				console.warn(warning);
				appendTail(tail, warning);
				child.stdout?.destroy();
				child.stderr?.destroy();
				settle(exitCode, exitSignal);
			}, exitCloseGraceMs);
		});
		child.once("close", (code, signal) => settle(code ?? exitCode, signal ?? exitSignal));
	});
}

const startedAt = Date.now();
const results = await Promise.all(runners.map(run));
const failures = results.filter((result) => result.code !== 0);
console.log(`\n[run-unit] total wall time ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`[run-unit] result summary: ${results.map((result) => `${result.label}=${result.code === 0 ? "pass" : `fail(${result.code})`}`).join(", ")}`);
for (const result of failures) {
	console.error(`\n[run-unit] ---- ${result.label} failure output tail ----`);
	console.error(result.tail.length ? result.tail.join("\n") : "(no output captured)");
}
process.exitCode = failures.length ? 1 : 0;
