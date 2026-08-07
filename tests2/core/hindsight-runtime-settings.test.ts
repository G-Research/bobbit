import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
import { HindsightRuntimeBridge, HindsightRuntimeSettingsResolver, hindsightStorageContinuity, hindsightStorageIdentity } from "../../src/server/agent/hindsight-runtime-bridge.ts";
import { ExtensionSettingsStore } from "../../src/server/agent/extension-settings-store.ts";
import { ExtensionSettingsSecretStore } from "../../src/server/agent/extension-settings-secret-store.ts";
import { ProjectConfigStore } from "../../src/server/agent/project-config-store.ts";

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

		const secretUrl = "postgresql://alice:super-secret@DB.example:5432/hindsight?application_name=bobbit&sslmode=require&password=query-secret&sslpassword=ssl-secret&access_token=access-secret&credential=credential-secret&auth_secret=auth-secret";
		const external = hindsightStorageIdentity("compose", "external", secretUrl);
		assert.match(external, /^hindsight-external:[a-f0-9]{64}$/);
		assert.equal(external, hindsightStorageIdentity("docker", "external", "postgresql://alice:rotated-secret@db.example/hindsight?sslmode=require&application_name=bobbit&password=rotated-query-secret&sslpassword=rotated-ssl-secret&access_token=rotated-access-secret&credential=rotated-credential-secret&auth_secret=rotated-auth-secret"), "password and credential-query rotation preserves continuity");
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
		const dormantManaged = validateHindsightRuntimeSettings(settings);
		assert.equal(dormantManaged.ok, true, "EP-7 saves a dormant local managed-volume selection without starting it");
		const managedStart = validateHindsightRuntimeSettings(settings, {}, true);
		assert.deepEqual(managedStart, { ok: false, code: "HINDSIGHT_EXTERNAL_DATABASE_SETTING_REQUIRED" });

		const composeManagedStart = validateHindsightRuntimeSettings({ ...settings, runtimeMode: "compose" }, {}, true);
		assert.equal(composeManagedStart.ok, true, "Compose owns its declared durable named volume");
		const localExternalStart = validateHindsightRuntimeSettings(
			{ ...settings, databaseMode: "external" },
			{ externalDatabaseUrl: "postgresql://hindsight:database-secret@db.example/hindsight" },
			true,
		);
		assert.equal(localExternalStart.ok, true, "local external storage is materializable only at explicit start");
		const dockerExternalStart = validateHindsightRuntimeSettings(
			{ ...settings, runtimeMode: "docker", databaseMode: "external" },
			{ externalDatabaseUrl: "postgresql://hindsight:database-secret@db.example/hindsight" },
			true,
		);
		assert.equal(dockerExternalStart.ok, true, "Docker external storage is materializable only at explicit start");

		const remoteWithoutKey = validateHindsightRuntimeSettings({ ...settings, localLlmBaseUrl: "http://model.example.test:11434/v1", databaseMode: "external" }, {}, true);
		assert.deepEqual(remoteWithoutKey, { ok: false, code: "HINDSIGHT_LOCAL_API_KEY_REQUIRED" });
		const legacyRequestResidency = validateHindsightRuntimeSettings(
			{ ...settings, localLlmResidency: "request", databaseMode: "external" },
			{ externalDatabaseUrl: "postgresql://hindsight:database-secret@db.example/hindsight" },
			true,
		);
		assert.deepEqual(legacyRequestResidency, { ok: false, code: "HINDSIGHT_RESIDENCY_REQUIRED" });
	});

	it("returns the supervisor-applied revision rather than a concurrent EP-7 save", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-control-revision-"));
		try {
			const settingsStore = new ExtensionSettingsStore(
				new ProjectConfigStore(directory),
				new ExtensionSettingsSecretStore(path.join(directory, "state")),
			);
			let entered!: () => void;
			const snapshotRead = new Promise<void>((resolve) => { entered = resolve; });
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const bridge = new HindsightRuntimeBridge({
				contributions: { getPack: () => undefined },
				contextForProject: () => ({ stateDir: path.join(directory, "state"), extensionSettingsStore: settingsStore }),
				grants: () => ({ allowed: true }) as never,
				supervisorForProject: () => ({
					restartWithResult: async () => {
						entered();
						await gate;
						return {
							settingsRevision: "0",
							status: { identity: { packId: "hindsight", runtimeId: "hindsight" }, desired: "running", mode: "local", state: "ready", endpoint: "http://127.0.0.1:48123" },
						};
					},
				}) as never,
			});

			const control = bridge.control("project", "restart");
			await snapshotRead;
			settingsStore.compareAndSwap({ packId: "hindsight", kind: "provider", id: "memory" }, 0, { values: { runtimeMode: "docker" } });
			release();

			assert.deepEqual(await control, {
				settingsRevision: 0,
				runtime: { identity: { packId: "hindsight", runtimeId: "hindsight" }, desired: "running", mode: "local", state: "ready", endpoint: "http://127.0.0.1:48123" },
			});
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses the production EP-7 resolver for external continuity and rejects unsupported starts before a runtime is selected", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-settings-resolver-"));
		try {
			const settingsStore = new ExtensionSettingsStore(
				new ProjectConfigStore(directory),
				new ExtensionSettingsSecretStore(path.join(directory, "state")),
			);
			const ref = { packId: "hindsight", kind: "provider" as const, id: "memory" };
			const externalDatabaseUrl = "postgresql://hindsight:resolver-secret@db.example/hindsight";
			const config = {
				runtimeMode: "external", localLlmProvider: "openai-compatible", localLlmContextTokens: 32768,
				localLlmMaxOutputTokens: 4096, localLlmResidency: "resident", localLlmKeepAlive: 3600,
				ociImage: DEFAULT_HINDSIGHT_OCI_IMAGE, databaseMode: "managed-volume",
			};
			const resolver = new HindsightRuntimeSettingsResolver("project", { stateDir: path.join(directory, "state"), extensionSettingsStore: settingsStore }, {
				getPack: () => ({ providers: [{ id: "memory", runtime: "hindsight", config, configSchema: {
					apiKey: { type: "secret" }, localLlmApiKey: { type: "secret" }, registryCredentials: { type: "secret" }, externalDatabaseUrl: { type: "secret" },
				} }] }),
			} as never);
			const request = { packId: "hindsight", runtimeId: "hindsight", contribution: { id: "hindsight" } } as never;
			const values = {
				runtimeMode: "local", databaseMode: "external", localLlmProvider: "openai-compatible",
				localLlmModelId: "qwen3-coder", localLlmBaseUrl: "http://127.0.0.1:11434/v1",
				localLlmContextTokens: 32768, localLlmMaxOutputTokens: 4096, localLlmResidency: "resident", localLlmKeepAlive: 3600,
			};
			settingsStore.compareAndSwap(ref, 0, { values, secrets: { externalDatabaseUrl } });
			const local = resolver.resolve(request);
			assert.equal(local.storageContinuity, "verified");
			assert.equal(local.storageIdentity, hindsightStorageIdentity("local", "external", externalDatabaseUrl));
			assert.ok(!JSON.stringify(settingsStore.getPublicState()).includes("resolver-secret"));

			settingsStore.compareAndSwap(ref, 1, { values: { runtimeMode: "docker" } });
			const docker = resolver.resolve(request);
			assert.equal(docker.storageContinuity, "verified");
			assert.equal(docker.storageIdentity, local.storageIdentity, "external storage survives a local-to-Docker control transition");

			settingsStore.compareAndSwap(ref, 2, { values: { runtimeMode: "local", databaseMode: "managed-volume" }, secrets: { externalDatabaseUrl: undefined } });
			assert.throws(() => resolver.resolve(request), { code: "HINDSIGHT_EXTERNAL_DATABASE_SETTING_REQUIRED" });
			assert.ok(!JSON.stringify(settingsStore.getPublicState()).includes("resolver-secret"));
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
