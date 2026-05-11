/**
 * Unit tests for plugin discovery + lazy loading + activate lifecycle.
 *
 * Builds tiny throwaway plugins in a tmpdir, points the loader at them, and
 * verifies:
 *   - cascade resolution (builtin → server → user → project; later sources win)
 *   - data-only plugin loads without needing approval (no gateway entry)
 *   - plugin with code requires trust before its activate() runs
 *   - activate() can register handlers via the host API
 *   - unload() calls deactivate() and unregisters handlers
 *   - manifest errors surface as a load status (not a throw)
 *   - throwing plugin code surfaces as load status: error
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { VerifyHandlerRegistry } from "../src/server/agent/verify-handlers/registry.ts";
import {
	discoverPlugins,
	PluginLoader,
	type DiscoveryPaths,
} from "../src/server/plugins/plugin-loader.ts";
import { PluginTrustStore } from "../src/server/plugins/plugin-trust-store.ts";

let tmpRoot: string;
let trustPath: string;

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-loader-test-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
	// Fresh trust store per test so prior approvals don't leak.
	trustPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-trust-")), "trusted.json");
});

function writePlugin(parent: string, name: string, opts: {
	manifest: string;
	gatewayEntry?: { relPath: string; jsBody: string };
}): string {
	const dir = path.join(parent, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "plugin.yaml"), opts.manifest);
	if (opts.gatewayEntry) {
		const entryAbs = path.join(dir, opts.gatewayEntry.relPath);
		fs.mkdirSync(path.dirname(entryAbs), { recursive: true });
		fs.writeFileSync(entryAbs, opts.gatewayEntry.jsBody);
	}
	return dir;
}

function paths(opts: Partial<DiscoveryPaths>): DiscoveryPaths {
	return { ...opts };
}

describe("discoverPlugins", () => {
	it("returns [] when none of the cascade paths exist", () => {
		assert.deepEqual(discoverPlugins(paths({ builtin: "/no/such/path" })), []);
	});

	it("scans plugin.yaml in subdirectories of each path", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "scan-"));
		writePlugin(dir, "alpha", { manifest: "name: alpha\nversion: 1.0.0\n" });
		writePlugin(dir, "beta", { manifest: "name: beta\nversion: 0.5.0\n" });
		fs.mkdirSync(path.join(dir, "no-manifest")); // dir without plugin.yaml — skip
		const found = discoverPlugins(paths({ builtin: dir }));
		const names = found.map(p => p.name).sort();
		assert.deepEqual(names, ["alpha", "beta"]);
	});

	it("later cascade levels override earlier ones by name", () => {
		const builtinDir = fs.mkdtempSync(path.join(tmpRoot, "builtin-"));
		const userDir = fs.mkdtempSync(path.join(tmpRoot, "user-"));
		writePlugin(builtinDir, "shared", { manifest: "name: shared\nversion: 1.0.0\n" });
		writePlugin(userDir, "shared", { manifest: "name: shared\nversion: 9.9.9\n" });
		const [p] = discoverPlugins(paths({ builtin: builtinDir, userHome: userDir }));
		assert.equal(p.source, "user");
		assert.equal(p.manifest.version, "9.9.9");
	});

	it("captures manifest errors without dropping the plugin from discovery", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "bad-"));
		writePlugin(dir, "broken", { manifest: "name: BAD-Name\nversion: 1.0.0\n" });
		const found = discoverPlugins(paths({ builtin: dir }));
		assert.equal(found.length, 1);
		assert.ok(found[0].manifestErrors.some(e => e.field === "name"),
			"discovery must still surface the plugin so the UI can show 'manifest invalid' instead of silently hiding it");
	});

	it("captures throwing YAML parse without crashing discovery", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "parse-fail-"));
		writePlugin(dir, "x", { manifest: ": : : : not yaml" });
		const found = discoverPlugins(paths({ builtin: dir }));
		assert.equal(found.length, 1);
		assert.ok(found[0].manifestErrors.length > 0);
	});
});

describe("PluginLoader — data-only plugin", () => {
	it("loads without trust when there's no gateway entry", async () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "dataonly-"));
		writePlugin(dir, "data-only", {
			manifest: "name: data-only\nversion: 1.0.0\ncontributes:\n  workflows: [w.yaml]\n",
		});
		// data-only plugin in a non-builtin location requires trust to run code,
		// but since there's no code to run, it loads fine.
		// Mark as builtin so trust isn't even consulted.
		const found = discoverPlugins(paths({ builtin: dir }));
		const reg = new VerifyHandlerRegistry();
		const loader = new PluginLoader({ registry: reg, trustStore: new PluginTrustStore(trustPath) });
		const r = await loader.loadOne(found[0]);
		assert.equal(r.load.status, "loaded");
		assert.deepEqual(r.load.status === "loaded" ? r.load.registeredTypes : null, []);
	});
});

describe("PluginLoader — gateway entry with code", () => {
	function makeCodePlugin(parent: string, name: string, jsBody: string, sourceDir: "builtin" | "user" = "user"): string {
		const dir = writePlugin(parent, name, {
			manifest: [
				`name: ${name}`,
				"version: 1.0.0",
				"entryPoints:",
				"  gateway: index.mjs",
			].join("\n"),
			gatewayEntry: { relPath: "index.mjs", jsBody },
		});
		return dir;
	}

	it("blocks load with needs-approval when plugin is not in trust store and not builtin", async () => {
		const userDir = fs.mkdtempSync(path.join(tmpRoot, "user-untrusted-"));
		makeCodePlugin(userDir, "untrusted", `export default () => {};`, "user");
		const found = discoverPlugins(paths({ userHome: userDir }));
		const reg = new VerifyHandlerRegistry();
		const loader = new PluginLoader({ registry: reg, trustStore: new PluginTrustStore(trustPath) });
		const r = await loader.loadOne(found[0]);
		assert.equal(r.load.status, "needs-approval");
		assert.equal(reg.has("anything"), false);
	});

	it("loads and runs activate() once trusted, registering verify handlers", async () => {
		const userDir = fs.mkdtempSync(path.join(tmpRoot, "user-trusted-"));
		makeCodePlugin(userDir, "trusted", `
			export default function activate(api) {
				api.registerVerifyHandler({
					type: "noop-from-plugin",
					async execute() { return { passed: true, output: "plugin ran" }; },
				});
			}
		`, "user");
		const found = discoverPlugins(paths({ userHome: userDir }));
		const reg = new VerifyHandlerRegistry();
		const trust = new PluginTrustStore(trustPath);
		trust.trust("trusted", found[0].path);

		const loader = new PluginLoader({ registry: reg, trustStore: trust });
		const r = await loader.loadOne(found[0]);
		assert.equal(r.load.status, "loaded");
		assert.deepEqual(r.load.status === "loaded" ? r.load.registeredTypes : null, ["noop-from-plugin"]);
		assert.equal(reg.has("noop-from-plugin"), true);
	});

	it("auto-trusts builtin plugins (no approval needed)", async () => {
		const builtinDir = fs.mkdtempSync(path.join(tmpRoot, "builtin-trusted-"));
		makeCodePlugin(builtinDir, "ships-with-bobbit", `
			export default function (api) {
				api.registerVerifyHandler({ type: "builtin-handler", async execute() { return { passed: true, output: "" }; } });
			}
		`);
		const found = discoverPlugins(paths({ builtin: builtinDir }));
		const reg = new VerifyHandlerRegistry();
		const loader = new PluginLoader({
			registry: reg,
			trustStore: new PluginTrustStore(trustPath), // no entries — should not matter for builtin
		});
		const r = await loader.loadOne(found[0]);
		assert.equal(r.load.status, "loaded");
		assert.equal(reg.has("builtin-handler"), true);
	});

	it("captures activate() throws as load status: error (does not bubble)", async () => {
		const builtinDir = fs.mkdtempSync(path.join(tmpRoot, "builtin-throws-"));
		makeCodePlugin(builtinDir, "throws", `
			export default function activate() { throw new Error("boom"); }
		`);
		const found = discoverPlugins(paths({ builtin: builtinDir }));
		const reg = new VerifyHandlerRegistry();
		const loader = new PluginLoader({ registry: reg, trustStore: new PluginTrustStore(trustPath) });
		const r = await loader.loadOne(found[0]);
		assert.equal(r.load.status, "error");
		assert.match(r.load.status === "error" ? r.load.error : "", /boom/);
	});

	it("unload calls deactivate and unregisters the plugin's handlers", async () => {
		const builtinDir = fs.mkdtempSync(path.join(tmpRoot, "builtin-unload-"));
		makeCodePlugin(builtinDir, "unloadable", `
			let calls = 0;
			export default function (api) {
				api.registerVerifyHandler({ type: "u-type", async execute() { return { passed: true, output: "" }; } });
				return { deactivate() { calls++; globalThis.__deactivateCalls = calls; } };
			}
		`);
		const found = discoverPlugins(paths({ builtin: builtinDir }));
		const reg = new VerifyHandlerRegistry();
		const loader = new PluginLoader({ registry: reg, trustStore: new PluginTrustStore(trustPath) });
		const r = await loader.loadOne(found[0]);
		assert.equal(r.load.status, "loaded", `load failed: ${JSON.stringify(r.load)}`);
		assert.equal(reg.has("u-type"), true);

		await loader.unload("unloadable");
		assert.equal(reg.has("u-type"), false);
		assert.equal((globalThis as any).__deactivateCalls, 1);
	});

	it("surfaces manifest-invalid as a load status when discovery already flagged errors", async () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "invalid-manifest-"));
		writePlugin(dir, "bad", { manifest: "name: BAD\nversion: nope\n" });
		const found = discoverPlugins(paths({ builtin: dir }));
		const reg = new VerifyHandlerRegistry();
		const loader = new PluginLoader({ registry: reg, trustStore: new PluginTrustStore(trustPath) });
		const r = await loader.loadOne(found[0]);
		assert.equal(r.load.status, "manifest-invalid");
	});

	it("loadOne is idempotent — repeated calls return the cached LoadedPlugin", async () => {
		const builtinDir = fs.mkdtempSync(path.join(tmpRoot, "idem-"));
		makeCodePlugin(builtinDir, "idem", `
			let n = 0;
			export default function (api) {
				n++;
				api.registerVerifyHandler({ type: \`x-\${n}\`, async execute() { return { passed: true, output: "" }; } });
			}
		`);
		const found = discoverPlugins(paths({ builtin: builtinDir }));
		const reg = new VerifyHandlerRegistry();
		const loader = new PluginLoader({ registry: reg, trustStore: new PluginTrustStore(trustPath) });
		await loader.loadOne(found[0]);
		await loader.loadOne(found[0]);
		await loader.loadOne(found[0]);
		// Only one of the x-N types should exist; activate() must run exactly once.
		const xTypes = reg.types().filter(t => t.startsWith("x-"));
		assert.equal(xTypes.length, 1);
	});
});
