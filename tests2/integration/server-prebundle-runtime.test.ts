import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import {
	loadServerTestRuntime,
	resetServerTestRuntimeForTests,
	serverRuntimeMode,
} from "../harness/server-runtime.js";

interface PrebundleManifest {
	entries: Record<string, string>;
}

async function loadDirectServerEntry(): Promise<typeof import("../../src/server/server.js")> {
	const bundlePath = process.env.BOBBIT_V2_SERVER_PREBUNDLE;
	if (!bundlePath) return import("../../src/server/server.js");

	// The configured umbrella lives at <cache>/entries/tests2/harness/*.mjs.
	// Resolve its sibling direct entry from the manifest instead of relying on a
	// source import collected before Vitest's resolver has established bundle mode.
	const cacheDir = resolve(dirname(bundlePath), "..", "..", "..");
	const manifest = JSON.parse(readFileSync(join(cacheDir, "manifest.json"), "utf8")) as PrebundleManifest;
	const emittedServer = manifest.entries["src/server/server.ts"];
	if (!emittedServer) throw new Error("server prebundle manifest is missing src/server/server.ts");
	return import(pathToFileURL(join(cacheDir, ...emittedServer.split("/"))).href);
}

test("content-addressed server prebundle boots the real integration gateway", async () => {
	// A fork may have loaded the runtime while collecting an earlier file. Reset
	// only the promise cache; ESM still guarantees one namespace for the emitted
	// umbrella and direct entries.
	resetServerTestRuntimeForTests();
	const runtimePromise = loadServerTestRuntime();
	const [runtime, directlyImportedServer] = await Promise.all([runtimePromise, loadDirectServerEntry()]);
	expect(loadServerTestRuntime()).toBe(runtimePromise);
	expect(typeof runtime.server.createGateway).toBe("function");
	expect(typeof runtime.gatewayDeps.realCommandRunner.execFile).toBe("function");
	expect(runtime.gatewayDeps.realCommandRunner).toBe(runtime.server.realCommandRunner);
	expect(directlyImportedServer.realCommandRunner).toBe(runtime.server.realCommandRunner);
	expect(typeof runtime.aigwManager.configureAigwRuntimeFlags).toBe("function");
	expect(typeof runtime.bobbitDir.setProjectRoot).toBe("function");
	if (process.env.BOBBIT_V2_SERVER_PREBUNDLE) expect(serverRuntimeMode()).toBe("bundle");

	const response = await apiFetch("/api/projects");
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(Array.isArray(body.projects ?? body)).toBe(true);
});
