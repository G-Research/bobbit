/**
 * enableTsWorkerResolver() — make worker_threads spawned during a test able to
 * resolve `.js` import specifiers to their `.ts` source (tier-1 has no build).
 *
 * It appends `--import <ts-worker-register.mjs>` to process.env.NODE_OPTIONS.
 * NODE_OPTIONS is read at process/worker START, so this only affects workers
 * spawned AFTER the call (never the already-running vitest main process). Call
 * it AFTER guardProcessEnv() at the top of a worker-spawning test file; the env
 * guard restores NODE_OPTIONS after the file so nothing bleeds across the fork.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export function enableTsWorkerResolver(): void {
	const here = dirname(fileURLToPath(import.meta.url));
	const registerUrl = pathToFileURL(join(here, "ts-worker-register.mjs")).href;
	const flag = `--import ${JSON.stringify(registerUrl)}`;
	const current = process.env.NODE_OPTIONS ?? "";
	if (current.includes("ts-worker-register.mjs")) return;
	process.env.NODE_OPTIONS = current ? `${current} ${flag}` : flag;
}
