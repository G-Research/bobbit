/**
 * Unit — S1 (extension-seam audit): Hindsight deployment-policy hoist.
 *
 * Pins two things:
 *
 *  1. The BUILT-IN Hindsight runtime manifest (market-packs/hindsight/runtimes/
 *     hindsight.yaml) carries the exact `deploymentModes`/`configRemap` policy
 *     that used to be hard-coded directly in `resolveRuntimeStartPlan`
 *     (src/server/server.ts) — byte-level values, not just "some mapping
 *     exists". A drift here (e.g. someone renames `managed-postgres` in the
 *     yaml but not in a consumer, or removes a configRemap entry) fails loudly
 *     rather than silently breaking Hindsight's managed-mode start.
 *
 *  2. `resolveRuntimeStartPlan` + `mapDeploymentModeToRuntimeMode`, driven by
 *     that REAL manifest, reproduce byte-identical `{start, mode, config}` /
 *     runtime-mode-string output to what the OLD hard-coded function body
 *     (switch on `managed`/`managed-external-postgres`, if-chain remap of
 *     `externalDatabaseUrl`/`llmApiKey`) produced — for every mode and every
 *     env-precedence case ("a value already set under the env key wins").
 *
 * Both server functions are policy-free now: with no runtime manifest (or one
 * declaring neither field) they always answer the pack-agnostic default
 * (`start: false`, config passed through unchanged / mode passed through
 * unchanged) regardless of what `mode` string a pack's deployment config
 * carries — the generic fallback every pack without a Hindsight-style
 * manifest had before this policy became declarative.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseRuntimeManifest, type RuntimeManifest } from "../src/server/runtime/manifest.ts";
import { resolveRuntimeStartPlan, mapDeploymentModeToRuntimeMode } from "../src/server/server.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_ROOT = path.join(REPO_ROOT, "market-packs", "hindsight");
const MANIFEST_FILE = path.join(PACK_ROOT, "runtimes", "hindsight.yaml");

/** Parse the REAL shipped Hindsight runtime manifest (fails loudly on drift). */
function loadManifest(): RuntimeManifest {
	const raw = fs.readFileSync(MANIFEST_FILE, "utf-8");
	const problems: string[] = [];
	const manifest = parseRuntimeManifest(raw, MANIFEST_FILE, PACK_ROOT, problems);
	assert.ok(manifest, `hindsight runtime manifest failed to validate: ${problems.join("; ")}`);
	return manifest!;
}

describe("S1 — Hindsight built-in manifest carries the exact former hard-coded policy", () => {
	it("declares deploymentModes exactly {managed→managed-postgres, managed-external-postgres→external-postgres}", () => {
		const manifest = loadManifest();
		assert.deepEqual(manifest.deploymentModes, {
			managed: { runtimeMode: "managed-postgres" },
			"managed-external-postgres": { runtimeMode: "external-postgres" },
		});
	});

	it("declares configRemap exactly {externalDatabaseUrl→HINDSIGHT_API_DATABASE_URL, llmApiKey→HINDSIGHT_API_LLM_API_KEY}", () => {
		const manifest = loadManifest();
		assert.deepEqual(manifest.configRemap, {
			externalDatabaseUrl: "HINDSIGHT_API_DATABASE_URL",
			llmApiKey: "HINDSIGHT_API_LLM_API_KEY",
		});
	});
});

describe("S1 — resolveRuntimeStartPlan parity: manifest-driven ≡ former hard-coded switch", () => {
	it("mode absent (default) ⇒ start:false, config unchanged — same as the old default case", () => {
		const manifest = loadManifest();
		const input = { foo: "bar" };
		assert.deepEqual(resolveRuntimeStartPlan(input, manifest), { start: false, config: { foo: "bar" } });
	});

	it("mode: external ⇒ start:false, config unchanged — same as the old default case", () => {
		const manifest = loadManifest();
		const input = { mode: "external", externalUrl: "https://hindsight.example" };
		assert.deepEqual(resolveRuntimeStartPlan(input, manifest), { start: false, config: { ...input } });
	});

	it("mode: managed ⇒ start:true, mode:managed-postgres — same as the old `case \"managed\"`", () => {
		const manifest = loadManifest();
		const input = { mode: "managed", dataDir: "/srv/hindsight-data" };
		assert.deepEqual(resolveRuntimeStartPlan(input, manifest), {
			start: true,
			mode: "managed-postgres",
			config: { mode: "managed", dataDir: "/srv/hindsight-data" },
		});
	});

	it("mode: managed-external-postgres ⇒ start:true, mode:external-postgres — same as the old `case \"managed-external-postgres\"`", () => {
		const manifest = loadManifest();
		const input = { mode: "managed-external-postgres" };
		assert.deepEqual(resolveRuntimeStartPlan(input, manifest), {
			start: true,
			mode: "external-postgres",
			config: { mode: "managed-external-postgres" },
		});
	});

	it("an unrecognized mode string ⇒ start:false — same as the old default case (never throws on garbage)", () => {
		const manifest = loadManifest();
		const input = { mode: "totally-not-a-mode" };
		assert.deepEqual(resolveRuntimeStartPlan(input, manifest), { start: false, config: { mode: "totally-not-a-mode" } });
	});

	it("managed-external-postgres remaps externalDatabaseUrl onto HINDSIGHT_API_DATABASE_URL — same as the old if-chain", () => {
		const manifest = loadManifest();
		const input = { mode: "managed-external-postgres", externalDatabaseUrl: "postgres://ext-host/hindsight" };
		const plan = resolveRuntimeStartPlan(input, manifest);
		assert.equal(plan.start, true);
		assert.equal(plan.mode, "external-postgres");
		assert.equal(plan.config.HINDSIGHT_API_DATABASE_URL, "postgres://ext-host/hindsight");
		// The raw provider field is still carried through unchanged (overlay, not rename).
		assert.equal(plan.config.externalDatabaseUrl, "postgres://ext-host/hindsight");
	});

	it("managed remaps llmApiKey onto HINDSIGHT_API_LLM_API_KEY — same as the old if-chain", () => {
		const manifest = loadManifest();
		const input = { mode: "managed", llmApiKey: "sk-test-llm-key" };
		const plan = resolveRuntimeStartPlan(input, manifest);
		assert.equal(plan.start, true);
		assert.equal(plan.mode, "managed-postgres");
		assert.equal(plan.config.HINDSIGHT_API_LLM_API_KEY, "sk-test-llm-key");
	});

	it("a value ALREADY set under HINDSIGHT_API_DATABASE_URL wins over externalDatabaseUrl — env-precedence parity", () => {
		const manifest = loadManifest();
		const input = {
			mode: "managed-external-postgres",
			externalDatabaseUrl: "postgres://from-provider-field/db",
			HINDSIGHT_API_DATABASE_URL: "postgres://already-set/db",
		};
		const plan = resolveRuntimeStartPlan(input, manifest);
		assert.equal(plan.config.HINDSIGHT_API_DATABASE_URL, "postgres://already-set/db");
	});

	it("a value ALREADY set under HINDSIGHT_API_LLM_API_KEY wins over llmApiKey — env-precedence parity", () => {
		const manifest = loadManifest();
		const input = {
			mode: "managed",
			llmApiKey: "sk-from-provider-field",
			HINDSIGHT_API_LLM_API_KEY: "sk-already-set",
		};
		const plan = resolveRuntimeStartPlan(input, manifest);
		assert.equal(plan.config.HINDSIGHT_API_LLM_API_KEY, "sk-already-set");
	});

	it("an empty-string externalDatabaseUrl/llmApiKey never overwrites — same as the old length>0 guard", () => {
		const manifest = loadManifest();
		const input = { mode: "managed", llmApiKey: "" };
		const plan = resolveRuntimeStartPlan(input, manifest);
		assert.equal(plan.config.HINDSIGHT_API_LLM_API_KEY, undefined);
	});
});

describe("S1 — resolveRuntimeStartPlan generic fallback (no manifest / no policy declared)", () => {
	it("with NO runtime manifest, mode:managed never starts — the pack-agnostic default", () => {
		const input = { mode: "managed", llmApiKey: "sk-test" };
		assert.deepEqual(resolveRuntimeStartPlan(input), { start: false, config: { ...input } });
	});

	it("with a runtime manifest that declares neither field, mode:managed never starts", () => {
		const input = { mode: "managed" };
		assert.deepEqual(resolveRuntimeStartPlan(input, { id: "other-runtime" }), { start: false, config: { ...input } });
	});
});

describe("S1 — mapDeploymentModeToRuntimeMode parity: manifest-driven ≡ former hard-coded lookup table", () => {
	it("managed ⇒ managed-postgres — same as the old RUNTIME_MODE_FOR_DEPLOYMENT table", () => {
		const manifest = loadManifest();
		assert.equal(mapDeploymentModeToRuntimeMode("managed", manifest), "managed-postgres");
	});

	it("managed-external-postgres ⇒ external-postgres — same as the old RUNTIME_MODE_FOR_DEPLOYMENT table", () => {
		const manifest = loadManifest();
		assert.equal(mapDeploymentModeToRuntimeMode("managed-external-postgres", manifest), "external-postgres");
	});

	it("an already-runtime-mode value (e.g. an explicit ?mode=managed-postgres override) passes through unchanged — identity fallback parity", () => {
		const manifest = loadManifest();
		assert.equal(mapDeploymentModeToRuntimeMode("managed-postgres", manifest), "managed-postgres");
		assert.equal(mapDeploymentModeToRuntimeMode("external-postgres", manifest), "external-postgres");
	});

	it("with no manifest, any value passes through unchanged (identity fallback)", () => {
		assert.equal(mapDeploymentModeToRuntimeMode("managed"), "managed");
	});
});
