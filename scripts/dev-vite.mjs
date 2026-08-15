#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
export const VITE_ENTRY = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
export const RAPID_FAILURE_WINDOW_MS = 30_000;
export const MAX_RAPID_RESTARTS = 5;

export function restartPlan({ code, signal, stopping, runtimeMs, rapidFailures }) {
	if (stopping || code === 0) return { restart: false, rapidFailures, delayMs: 0 };
	const nextRapidFailures = runtimeMs >= RAPID_FAILURE_WINDOW_MS ? 1 : rapidFailures + 1;
	if (nextRapidFailures > MAX_RAPID_RESTARTS) {
		return { restart: false, rapidFailures: nextRapidFailures, delayMs: 0 };
	}
	return {
		restart: true,
		rapidFailures: nextRapidFailures,
		delayMs: Math.min(500 * 2 ** (nextRapidFailures - 1), 5_000),
		reason: signal ? `signal ${signal}` : `code ${code ?? "unknown"}`,
	};
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
	let child = null;
	let stopping = false;
	let rapidFailures = 0;

	const stop = (signal) => {
		if (stopping) return;
		stopping = true;
		if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
	};
	process.once("SIGINT", () => stop("SIGINT"));
	process.once("SIGTERM", () => stop("SIGTERM"));

	while (!stopping) {
		const startedAt = Date.now();
		child = spawn(process.execPath, [VITE_ENTRY, ...process.argv.slice(2)], {
			cwd: REPO_ROOT,
			env: process.env,
			stdio: "inherit",
		});
		const result = await new Promise((resolve) => {
			child.once("error", (error) => resolve({ code: null, signal: null, error }));
			child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
		});
		const plan = restartPlan({
			code: result.code,
			signal: result.signal,
			stopping,
			runtimeMs: Date.now() - startedAt,
			rapidFailures,
		});
		rapidFailures = plan.rapidFailures;

		if (!plan.restart) {
			if (result.error) console.error(`[vite-supervisor] Unable to launch Vite: ${result.error.message}`);
			if (!stopping && result.code !== 0 && rapidFailures > MAX_RAPID_RESTARTS) {
				console.error(`[vite-supervisor] Vite failed ${rapidFailures} times within ${RAPID_FAILURE_WINDOW_MS / 1000}s; giving up.`);
			}
			process.exitCode = stopping ? 0 : result.code ?? 1;
			return;
		}

		console.warn(`[vite-supervisor] Vite exited with ${plan.reason}; restarting in ${plan.delayMs}ms.`);
		await wait(plan.delayMs);
	}
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await run();
