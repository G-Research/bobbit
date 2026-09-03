import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export type E2EDistServerRuntime = typeof import("./dist-server-runtime-entry.js");

let bundledRuntimePromise: Promise<E2EDistServerRuntime> | undefined;
let observedMode: "bundle" | "raw" | undefined;
let observedBundlePath: string | undefined;

function runtimeLoadProfilePath(): string | undefined {
	const configured = process.env.BOBBIT_V2_HOOK_PROFILE_DIR?.trim();
	if (configured) return join(configured, `gateway-api-${process.pid}.jsonl`);

	// Worker preloads deliberately remove the hook directory from descendants,
	// while the Playwright profile output remains available. Reconstruct the
	// same run-owned hook stream rather than creating a second owner artifact.
	const output = process.env.BOBBIT_V2_E2E_PROFILE_OUTPUT?.trim();
	const group = process.env.BOBBIT_V2_E2E_PROFILE_GROUP?.trim();
	if (!output || !group) return undefined;
	return join(dirname(output), `group-${group}-raw`, "hooks", `gateway-api-${process.pid}.jsonl`);
}

function importBundledRuntime(bundlePath: string): Promise<E2EDistServerRuntime> {
	const profilePath = runtimeLoadProfilePath();
	if (!profilePath) {
		return import(/* @vite-ignore */ pathToFileURL(bundlePath).href) as Promise<E2EDistServerRuntime>;
	}

	const startedAt = Date.now();
	const startedPerf = performance.now();
	const finish = (outcome: "success" | "error", error?: unknown): void => {
		const endedAt = Date.now();
		const record = {
			type: "e2e_runtime_load",
			id: `${process.pid}:e2e-runtime-load`,
			ownerPid: process.pid,
			workerStartedAt: performance.timeOrigin,
			bundleIdentity: bundlePath,
			mode: "bundle",
			startedAt,
			endedAt,
			durationMs: Math.max(0, performance.now() - startedPerf),
			outcome,
			...(error instanceof Error ? { errorName: error.name } : {}),
		};
		try {
			mkdirSync(dirname(profilePath), { recursive: true });
			appendFileSync(profilePath, `${JSON.stringify(record)}\n`, "utf8");
		} catch { /* observational profiling must never change runtime behavior */ }
	};

	return (import(/* @vite-ignore */ pathToFileURL(bundlePath).href) as Promise<E2EDistServerRuntime>).then(
		(runtime) => { finish("success"); return runtime; },
		(error) => { finish("error", error); throw error; },
	);
}

/**
 * Load Group B's server graph after the worker has installed its environment
 * roots. The full runner owns the mode setting; focused runs and raw sentinels
 * continue through their existing ordered imports.
 *
 * A configured bundle never falls back after evaluation starts. Doing so would
 * create two copies of stateful server modules in one Playwright worker.
 */
export async function loadE2EDistServerRuntime<T>(loadRaw: () => Promise<T>): Promise<T> {
	const bundlePath = process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE?.trim();
	if (!bundlePath) {
		if (observedMode === "bundle") {
			throw new Error("[e2e-dist-server-runtime] runtime mode changed from bundle to raw in one worker");
		}
		observedMode = "raw";
		return loadRaw();
	}

	if (observedMode === "raw") {
		throw new Error("[e2e-dist-server-runtime] runtime mode changed from raw to bundle in one worker");
	}
	if (observedBundlePath && observedBundlePath !== bundlePath) {
		throw new Error("[e2e-dist-server-runtime] configured bundle changed in one worker");
	}
	if (!existsSync(bundlePath)) {
		throw new Error(`[e2e-dist-server-runtime] configured prebundle does not exist: ${bundlePath}`);
	}
	observedMode = "bundle";
	observedBundlePath = bundlePath;
	bundledRuntimePromise ??= importBundledRuntime(bundlePath);
	return bundledRuntimePromise as Promise<T>;
}

export function e2eDistServerRuntimeMode(): "bundle" | "raw" | "unobserved" {
	return observedMode ?? "unobserved";
}
