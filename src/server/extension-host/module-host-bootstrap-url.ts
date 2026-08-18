// Resolve the module-host worker entry across production builds and Vitest's
// source-prebundled runtime. The latter rewrites import.meta.url to the source
// file, so a sibling URL would incorrectly point at a non-existent source .js.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BOOTSTRAP_ENTRY = "src/server/extension-host/module-host-bootstrap.ts";

/**
 * Resolve the emitted bootstrap entry when the V2 source prebundle is active;
 * otherwise resolve the compiled/source sibling matching the caller extension.
 */
export function moduleHostBootstrapUrl(sourceUrl: string, runtimeBundle = process.env.BOBBIT_V2_SERVER_PREBUNDLE): URL {
	const prebundled = testPrebundledBootstrapUrl(runtimeBundle);
	if (prebundled) return prebundled;
	const ext = sourceUrl.endsWith(".ts") ? ".ts" : ".js";
	return new URL(`./module-host-bootstrap${ext}`, sourceUrl);
}

/** Locate the separately bundled bootstrap emitted by the V2 server prebundle. */
function testPrebundledBootstrapUrl(runtimeBundle: string | undefined): URL | null {
	if (!runtimeBundle) return null;
	try {
		// `runtimeBundle` is `<cache>/entries/tests2/harness/<runtime>.mjs`.
		const cacheDir = path.resolve(path.dirname(runtimeBundle), "../../..");
		const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "manifest.json"), "utf8")) as {
			entries?: Record<string, string>;
		};
		const output = manifest.entries?.[BOOTSTRAP_ENTRY];
		return typeof output === "string"
			? pathToFileURL(path.join(cacheDir, ...output.split("/")))
			: null;
	} catch {
		// Production and non-Vitest runtimes must never depend on test artifacts.
		return null;
	}
}
