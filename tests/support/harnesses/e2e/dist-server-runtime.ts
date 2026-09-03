import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type E2EDistServerRuntime = typeof import("./dist-server-runtime-entry.js");

let bundledRuntimePromise: Promise<E2EDistServerRuntime> | undefined;
let observedMode: "bundle" | "raw" | undefined;
let observedBundlePath: string | undefined;

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
	bundledRuntimePromise ??= import(/* @vite-ignore */ pathToFileURL(bundlePath).href) as Promise<E2EDistServerRuntime>;
	return bundledRuntimePromise as Promise<T>;
}

export function e2eDistServerRuntimeMode(): "bundle" | "raw" | "unobserved" {
	return observedMode ?? "unobserved";
}
