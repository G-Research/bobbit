import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import YAML from "yaml";

import {
	DEFAULT_HINDSIGHT_OCI_IMAGE,
	isLoopbackHttpEndpoint,
	localModelDiagnostic,
	parseOciReference,
	redactEndpointHost,
	validateHindsightRuntimeSettings,
} from "../../market-packs/hindsight/src/runtime-settings.ts";
import { hindsightStorageContinuity, hindsightStorageIdentity } from "../../src/server/agent/hindsight-runtime-bridge.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const descriptorPath = path.join(root, "market-packs/hindsight/providers/memory.yaml");

function config(): Record<string, { type?: string; values?: string[]; min?: number; default?: unknown }> {
	return (YAML.parse(fs.readFileSync(descriptorPath, "utf8")) as { config: Record<string, { type?: string; values?: string[]; min?: number; default?: unknown }> }).config;
}

describe("Hindsight EP-7 runtime settings", () => {
	it("declares the provider-generic local inference schema with write-only keys", () => {
		const fields = config();
		assert.deepEqual(fields.runtimeMode?.values, ["external", "local", "docker", "compose"]);
		for (const field of ["localLlmProvider", "localLlmModelId", "localLlmBaseUrl", "localLlmContextTokens", "localLlmMaxOutputTokens", "localLlmResidency", "localLlmKeepAlive"])
			assert.ok(fields[field], `missing typed local setting ${field}`);
		assert.equal(fields.localLlmApiKey?.type, "secret");
		assert.equal(fields.registryCredentials?.type, "secret");
		assert.equal(fields.externalDatabaseUrl?.type, "secret");
		assert.deepEqual(fields.localLlmResidency?.values, ["resident"], "request-scoped residency is not a supported setting");
		assert.ok((fields.localLlmContextTokens?.min ?? 0) > 0);
		assert.ok((fields.localLlmMaxOutputTokens?.min ?? 0) > 0);
	});

	it("syntax-validates offline OCI references without contacting a registry", () => {
		const mutable = parseOciReference("registry.internal:5000/team/hindsight:0.8.6");
		assert.deepEqual(mutable, { ok: true, value: { reference: "registry.internal:5000/team/hindsight:0.8.6", pinned: false, warning: "OCI_REFERENCE_MUTABLE_TAG" } });
		assert.deepEqual(parseOciReference(DEFAULT_HINDSIGHT_OCI_IMAGE), {
			ok: true,
			value: { reference: DEFAULT_HINDSIGHT_OCI_IMAGE, pinned: true },
		});
		for (const invalid of ["https://registry/hindsight", "registry/hindsight latest", "registry/../hindsight", "registry/hindsight;pull"])
			assert.deepEqual(parseOciReference(invalid), { ok: false, code: "HINDSIGHT_OCI_REFERENCE_INVALID" });

		const saved = validateHindsightRuntimeSettings({ runtimeMode: "docker", ociImage: "registry.internal:5000/team/hindsight:0.8.6" });
		assert.equal(saved.ok, true);
		if (saved.ok) assert.deepEqual(saved.warnings, ["OCI_REFERENCE_MUTABLE_TAG"]);
	});

	it("binds continuity to the actual mode backing and redacts external credentials", () => {
		const compose = hindsightStorageContinuity("compose", "managed-volume");
		assert.equal(compose.continuity, "verified");
		assert.match(compose.identity, /^hindsight-compose-volume:[a-f0-9]{64}$/);
		assert.equal(compose.identity, hindsightStorageIdentity("compose", "managed-volume"));

		const local = hindsightStorageContinuity("local", "managed-volume");
		const docker = hindsightStorageContinuity("docker", "managed-volume");
		assert.deepEqual(local, { identity: "hindsight-unverified-managed:local", continuity: "unsupported" });
		assert.deepEqual(docker, { identity: "hindsight-unverified-managed:docker", continuity: "unsupported" });

		const secretUrl = "postgresql://alice:super-secret@DB.example:5432/hindsight?application_name=bobbit&sslmode=require&password=query-secret";
		const external = hindsightStorageIdentity("compose", "external", secretUrl);
		assert.match(external, /^hindsight-external:[a-f0-9]{64}$/);
		assert.equal(external, hindsightStorageIdentity("docker", "external", "postgresql://alice:rotated-secret@db.example/hindsight?sslmode=require&application_name=bobbit&password=rotated-query-secret"), "password-only rotation preserves continuity");
		assert.notEqual(external, hindsightStorageIdentity("docker", "external", "postgresql://other-user:rotated-secret@db.example/hindsight?application_name=bobbit&sslmode=require"), "a database username selects a different backing");
		assert.notEqual(external, hindsightStorageIdentity("docker", "external", "postgresql://alice:rotated-secret@db.example/other?application_name=bobbit&sslmode=require"), "a database name selects a different backing");
		assert.notEqual(external, hindsightStorageIdentity("docker", "external", "postgresql://alice:rotated-secret@db.example/hindsight?application_name=bobbit&sslmode=disable"), "behaviorally meaningful options select a different backing");
		assert.ok(!external.includes("alice") && !external.includes("secret") && !external.includes("db.example"));
		assert.throws(() => hindsightStorageIdentity("compose", "external", "not a database URL"), { code: "SERVICE_SETTING_UNAVAILABLE" });
		try {
			hindsightStorageIdentity("compose", "external", "mysql://alice:super-secret@db.example/hindsight");
			assert.fail("an unsupported external database URL must fail closed");
		} catch (error) {
			assert.equal((error as { code?: unknown }).code, "SERVICE_SETTING_UNAVAILABLE");
			assert.ok(!String(error).includes("alice") && !String(error).includes("super-secret") && !String(error).includes("db.example"));
		}
	});

	it("allows a loopback local endpoint without a fake key and projects only safe diagnostics", () => {
		assert.equal(isLoopbackHttpEndpoint("http://127.0.0.1:11434/v1"), true);
		assert.equal(isLoopbackHttpEndpoint("http://localhost:8080"), true);
		assert.equal(isLoopbackHttpEndpoint("https://localhost:8080"), false);
		assert.equal(isLoopbackHttpEndpoint("http://model.example.test"), false);
		assert.equal(redactEndpointHost("http://model.example.test:8080/v1?token=secret"), undefined);
		assert.equal(redactEndpointHost("http://model.example.test:8080/v1"), "model.example.test:8080");

		const settings = {
			runtimeMode: "local" as const, localLlmProvider: "openai-compatible" as const, localLlmModelId: "qwen3-coder",
			localLlmBaseUrl: "http://127.0.0.1:11434/v1", localLlmContextTokens: 32768,
			localLlmMaxOutputTokens: 4096, localLlmResidency: "resident" as const, localLlmKeepAlive: 3600,
			ociImage: DEFAULT_HINDSIGHT_OCI_IMAGE, databaseMode: "managed-volume" as const,
		};
		const diagnostic = localModelDiagnostic(settings, "mlx-load-1");
		assert.deepEqual(diagnostic, {
			provider: "openai-compatible", modelId: "qwen3-coder", endpointHost: "127.0.0.1:11434",
			contextTokens: 32768, maxOutputTokens: 4096, residency: "resident", keepAliveSeconds: 3600,
			fallback: "disabled", observedLoadId: "mlx-load-1",
		});
		const loopbackStart = validateHindsightRuntimeSettings(settings, {}, true);
		assert.equal(loopbackStart.ok, true);
		const remoteWithoutKey = validateHindsightRuntimeSettings({ ...settings, localLlmBaseUrl: "http://model.example.test:11434/v1" }, {}, true);
		assert.deepEqual(remoteWithoutKey, { ok: false, code: "HINDSIGHT_LOCAL_API_KEY_REQUIRED" });
		const legacyRequestResidency = validateHindsightRuntimeSettings({ ...settings, localLlmResidency: "request" }, {}, true);
		assert.equal(legacyRequestResidency.ok, true, "legacy request residency normalizes to the only supported resident mode");
		if (legacyRequestResidency.ok) assert.equal(legacyRequestResidency.settings.localLlmResidency, "resident");
	});
});
