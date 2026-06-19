/**
 * Unit — schema-v2 provider contribution loader.
 *
 * Providers are pack-scoped contribution files listed by contents.providers[];
 * they are loaded inertly (no dispatch), tolerate malformed individual files,
 * and preserve hard duplicate-id failures within a pack.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifest } from "../src/server/agent/pack-manifest.ts";
import { loadPackContributions, loadProviders, PackContributionError } from "../src/server/agent/pack-contributions.ts";
import type { PackManifest } from "../src/server/agent/pack-types.ts";

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pack-providers-loader-")); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function packRoot(caseName: string): string {
	return path.join(tmp, caseName, "market-packs", "provider-pack");
}

function manifest(providers: string[]): PackManifest {
	return {
		name: "provider-pack",
		description: "d",
		version: "1",
		schema: 2,
		contents: {
			roles: [],
			tools: [],
			skills: [],
			entrypoints: [],
			providers,
			hooks: [],
			mcp: [],
			piExtensions: [],
			runtimes: [],
			workflows: [],
		},
	};
}

function validProviderYaml(id = "memory", extras = ""): string {
	return [
		`id: ${id}`,
		"kind: memory",
		"module: ../lib/provider.js",
		"hooks: [beforePrompt]",
		extras.trim(),
	].filter(Boolean).join("\n") + "\n";
}

describe("loadProviders (schema v2)", () => {
	it("loads a valid listed provider and clamps its budget", () => {
		const root = packRoot("valid");
		w(path.join(root, "providers", "memory.yaml"), validProviderYaml("memory", "budget:\n  maxTokens: 99999\n  timeoutMs: 5"));
		w(path.join(root, "lib", "provider.js"), "export default {};\n");

		const providers = loadProviders(root, manifest(["memory"]));
		assert.equal(providers.length, 1);
		assert.deepEqual(providers[0], {
			id: "memory",
			kind: "memory",
			module: "../lib/provider.js",
			hooks: ["beforePrompt"],
			budget: { maxTokens: 8192, timeoutMs: 100 },
			listName: "memory",
			sourceFile: path.join(root, "providers", "memory.yaml"),
			packRoot: root,
		});
	});

	it("drops only the provider with an unknown hook name", () => {
		const root = packRoot("bad-hook");
		w(path.join(root, "providers", "good.yaml"), validProviderYaml("good"));
		w(path.join(root, "providers", "bad.yaml"), "id: bad\nmodule: ../lib/provider.js\nhooks: [nope]\n");
		w(path.join(root, "lib", "provider.js"), "export default {};\n");

		const providers = loadProviders(root, manifest(["bad", "good"]));
		assert.deepEqual(providers.map((p) => p.id), ["good"]);
	});

	it("drops a provider whose module resolves outside the pack root", () => {
		const root = packRoot("outside-module");
		w(path.join(root, "providers", "bad.yaml"), "id: bad\nmodule: ../../escape.js\nhooks: [beforePrompt]\n");
		w(path.join(root, "providers", "good.yml"), validProviderYaml("good"));
		w(path.join(root, "lib", "provider.js"), "export default {};\n");

		const providers = loadProviders(root, manifest(["bad", "good"]));
		assert.deepEqual(providers.map((p) => p.id), ["good"]);
	});

	it("duplicate provider id within a pack throws PackContributionError", () => {
		const root = packRoot("duplicate");
		w(path.join(root, "providers", "a.yaml"), validProviderYaml("dup"));
		w(path.join(root, "providers", "b.yaml"), validProviderYaml("dup"));
		w(path.join(root, "lib", "provider.js"), "export default {};\n");

		assert.throws(
			() => loadPackContributions(root, manifest(["a", "b"])),
			(e) => e instanceof PackContributionError && /provider id "dup"/.test(e.message),
		);
	});

	it("does not load listed providers from a schema-1 manifest", () => {
		const root = packRoot("schema-1-gate");
		w(path.join(root, "providers", "memory.yaml"), validProviderYaml("memory"));
		w(path.join(root, "lib", "provider.js"), "export default {};\n");
		const schema1 = validateManifest({
			name: "provider-pack",
			description: "d",
			version: "1",
			contents: { roles: [], tools: [], skills: [], providers: ["memory"] },
		});
		assert.ok(schema1);
		assert.deepEqual(loadPackContributions(root, schema1).providers, []);

		const schema2 = validateManifest({
			name: "provider-pack",
			description: "d",
			version: "1",
			schema: 2,
			contents: { roles: [], tools: [], skills: [], providers: ["memory"] },
		});
		assert.ok(schema2);
		assert.deepEqual(loadPackContributions(root, schema2).providers.map((p) => p.id), ["memory"]);
	});

	it("ignores provider files that are not listed in contents.providers", () => {
		const root = packRoot("unlisted");
		w(path.join(root, "providers", "listed.yaml"), validProviderYaml("listed"));
		w(path.join(root, "providers", "unlisted.yaml"), validProviderYaml("unlisted"));
		w(path.join(root, "lib", "provider.js"), "export default {};\n");

		const providers = loadPackContributions(root, manifest(["listed"])).providers;
		assert.deepEqual(providers.map((p) => p.id), ["listed"]);
	});
});
