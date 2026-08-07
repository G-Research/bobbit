import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packRoot = path.join(root, "market-packs/hindsight");
const descriptorPath = path.join(packRoot, "providers/memory.yaml");
const settingsPath = path.join(packRoot, "src/runtime-settings.ts");
const bridgePath = path.join(root, "src/server/agent/hindsight-runtime-bridge.ts");
const implemented = fs.existsSync(settingsPath) && fs.existsSync(bridgePath);

function source(file: string): string {
	return fs.readFileSync(file, "utf8");
}

function config(): Record<string, { type?: string; values?: string[]; min?: number; default?: unknown }> {
	return (YAML.parse(source(descriptorPath)) as { config: Record<string, { type?: string; values?: string[]; min?: number; default?: unknown }> }).config;
}

describe.skipIf(!implemented)("Hindsight EP-7 runtime settings", () => {
	it("declares a mode-independent local inference configuration with safe defaults", () => {
		const fields = config();
		assert.deepEqual(fields.runtimeMode?.values, ["external", "local", "docker", "compose"]);
		for (const field of ["localProvider", "localModelId", "localBaseUrl", "localContextLimit", "localOutputLimit", "localResident", "localKeepAlive"]) {
			assert.ok(fields[field], `missing typed local setting ${field}`);
		}
		assert.equal(fields.localApiKey?.type, "secret", "the optional local model key must be owner-only");
		assert.ok((fields.localContextLimit?.min ?? 0) > 0, "context limit must be positive");
		assert.ok((fields.localOutputLimit?.min ?? 0) > 0, "output limit must be positive");
	});

	it("keeps OCI and database credentials write-only while permitting offline references", () => {
		const fields = config();
		assert.ok(fields.ociImage, "OCI reference must be configurable without discovery");
		assert.equal(fields.registryCredential?.type, "secret");
		assert.equal(fields.externalDatabaseUrl?.type, "secret");

		const text = source(settingsPath);
		assert.match(text, /sha256/i, "OCI validation must support immutable digest references");
		assert.match(text, /mutable|warning/i, "mutable tags must warn rather than be rejected");
		assert.match(text, /private|registry/i, "private registry paths and ports must be accepted");
		assert.match(text, /whitespace|control|scheme|traversal/i, "unsafe OCI syntax must be rejected before it can reach a shell");
		assert.doesNotMatch(text, /(?:child_process|execa|docker(?:\s|\.))[^\n]*(?:pull|run|compose)/i,
			"saving settings must not start, pull, probe, or discover a runtime");
	});

	it("projects only safe local diagnostics and never falls back to a paid endpoint", () => {
		const text = `${source(settingsPath)}\n${source(bridgePath)}`;
		assert.match(text, /localhost|127\.0\.0\.1|loopback/i, "a loopback local endpoint must not require a fake secret");
		assert.match(text, /resident|keepAlive/i, "the runtime projection must retain residency intent");
		assert.match(text, /model/i, "safe diagnostics must identify the configured model");
		assert.match(text, /unavailable|degraded|blocked/i, "local inference failures must degrade promptly");
		assert.doesNotMatch(text, /fallback[^\n]*(?:external|paid)|(?:external|paid)[^\n]*fallback/i,
			"an unhealthy local provider must never fall back to an external or paid model");
		assert.doesNotMatch(text, /(?:apiKey|credential|password)[^\n]*(?:diagnostic|log)/i,
			"diagnostics and logs must not project raw credential fields");
	});

	it("uses EP-7 revisioned redacted settings rather than a private owner", () => {
		const text = `${source(settingsPath)}\n${source(bridgePath)}`;
		assert.match(text, /ExtensionSettingsStore|settings/i);
		assert.match(text, /revision|conflict/i, "stale writes must be surfaced as EP-7 revision conflicts");
		assert.match(text, /secretSet/i, "public settings results may disclose only write-only secret presence");
		assert.doesNotMatch(text, /new\s+(?:Map|Secret|Settings).*hindsight/i,
			"the pack must not invent a second Hindsight settings or secret owner");
	});
});
