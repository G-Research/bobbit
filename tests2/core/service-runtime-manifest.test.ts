import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { validateManifest } from "../../src/server/agent/pack-manifest.ts";
import { loadPackContributions } from "../../src/server/agent/pack-contributions.ts";
import { parseServiceManifest } from "../../src/server/service-runtime/service-manifest.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): { root: string; sourceFile: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-service-runtime-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, "runtimes"));
	fs.mkdirSync(path.join(root, "runtime"));
	fs.writeFileSync(path.join(root, "runtime", "compose.yaml"), "services: {}\n");
	fs.writeFileSync(path.join(root, "runtimes", "service.yaml"), "# descriptor\n");
	return { root, sourceFile: path.join(root, "runtimes", "service.yaml") };
}

function validDescriptor(): Record<string, unknown> {
	return {
		apiVersion: 1,
		id: "example-service",
		title: "Example service",
		endpoint: {
			protocol: "http",
			servicePort: 8080,
			health: { path: "/health", expectedStatus: 200, requestTimeoutMs: 1_000, intervalMs: 500, startupTimeoutMs: 10_000 },
		},
		lifecycle: { startPolicy: "manual", restart: { policy: "on-failure", maxAttempts: 3, windowMs: 30_000, initialBackoffMs: 500, maxBackoffMs: 5_000 } },
		environment: {
			SERVICE_PORT: { endpointPort: true },
			SERVICE_HOST: { value: "127.0.0.1" },
			PUBLIC_SETTING: { setting: "publicSetting" },
			API_TOKEN: { secret: "apiToken" },
			INTERNAL_PASSWORD: { generatedSecret: "internalPassword" },
			LOG_LEVEL: { value: "info" },
		},
		storage: { setting: "dataDir", target: "/var/lib/example", survival: "preserve" },
		modes: {
			local: { command: "node", args: ["./runtime/service.mjs"], cwd: ".", portEnv: "SERVICE_PORT", hostEnv: "SERVICE_HOST" },
			docker: { image: "ghcr.io/example/service:1.2.3", command: ["node", "service.mjs"] },
			compose: { file: "../runtime/compose.yaml", service: "api", projectName: "bobbit-${packId}-${runtimeId}-${serverIdentity}" },
		},
	};
}

function parseValid(): ReturnType<typeof parseServiceManifest> {
	const { root, sourceFile } = fixtureRoot();
	return parseServiceManifest(validDescriptor(), { packRoot: root, sourceFile });
}

describe("parseServiceManifest", () => {
	it("accepts the generic local/docker/compose descriptor and canonicalises its contract", () => {
		const parsed = parseValid();
		assert.ok(parsed);
		assert.equal(parsed.id, "example-service");
		assert.equal(parsed.modes.local.cwd, ".");
		assert.equal(parsed.modes.local.portEnv, "SERVICE_PORT");
		assert.equal(parsed.modes.local.hostEnv, "SERVICE_HOST");
		assert.equal(parsed.modes.compose.service, "api");
		assert.deepEqual(parsed.environment.SERVICE_PORT, { endpointPort: true });
	});

	it("rejects unknown keys, invalid ranges, and non-argv command fields", () => {
		const { root, sourceFile } = fixtureRoot();
		for (const mutate of [
			(raw: any) => { raw.unknown = true; },
			(raw: any) => { delete raw.modes.local.hostEnv; },
			(raw: any) => { raw.modes.local.hostEnv = "MISSING_HOST"; },
			(raw: any) => { raw.environment.SERVICE_HOST.value = "0.0.0.0"; },
			(raw: any) => { raw.endpoint.health.expectedStatus = 99; },
			(raw: any) => { raw.lifecycle.restart.maxBackoffMs = 1; },
			(raw: any) => { raw.modes.local.args = "--unsafe"; },
			(raw: any) => { raw.modes.local.command = "bash"; raw.modes.local.args = ["-c", "echo nope"]; },
			(raw: any) => { raw.modes.docker.command = ["sh", "-c", "echo nope"]; },
			(raw: any) => { raw.modes.docker.command = ["cmd.exe", "/c", "echo nope"]; },
			(raw: any) => { raw.modes.docker.command = ["pwsh", "-Command", "echo nope"]; },
		]) {
			const descriptor = validDescriptor();
			mutate(descriptor);
			const problems: string[] = [];
			assert.equal(parseServiceManifest(descriptor, { packRoot: root, sourceFile }, problems), null);
			assert.ok(problems.length > 0);
		}
	});

	it("allows only explicit environment provenance and never a likely literal secret", () => {
		const { root, sourceFile } = fixtureRoot();
		for (const environment of [
			{ SERVICE_PORT: { endpointPort: true }, TOKEN: { fromProcess: "TOKEN" } },
			{ SERVICE_PORT: { endpointPort: true }, API_TOKEN: { value: "not-a-secret" } },
			{ SERVICE_PORT: { endpointPort: false } },
		]) {
			const descriptor = validDescriptor();
			(descriptor as any).environment = environment;
			assert.equal(parseServiceManifest(descriptor, { packRoot: root, sourceFile }), null);
		}
	});

	it("rejects unsafe compose/local paths including an in-pack symlink escape", () => {
		const { root, sourceFile } = fixtureRoot();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-service-outside-"));
		roots.push(outside);
		fs.writeFileSync(path.join(outside, "compose.yaml"), "services: {}\n");
		fs.symlinkSync(path.join(outside, "compose.yaml"), path.join(root, "runtime", "escape.yaml"));
		for (const mutate of [
			(raw: any) => { raw.modes.compose.file = "/etc/hosts"; },
			(raw: any) => { raw.modes.local.cwd = "../../outside"; },
			(raw: any) => { raw.modes.compose.file = "../runtime/escape.yaml"; },
		]) {
			const descriptor = validDescriptor();
			mutate(descriptor);
			assert.equal(parseServiceManifest(descriptor, { packRoot: root, sourceFile }), null);
		}
	});
});

describe("schema-2 runtime contributions", () => {
	it("rejects duplicate descriptor basenames in pack.yaml", () => {
		const problems: string[] = [];
		const manifest = validateManifest({
			name: "runtime-pack", description: "x", version: "1", schema: 2,
			contents: { roles: [], tools: [], skills: [], entrypoints: [], runtimes: ["service", "service"] },
		}, problems);
		assert.equal(manifest, null);
		assert.match(problems.join(" "), /duplicate basename/);
	});

	it("loads only listed, contained, strict descriptors and normalises the runtime id", () => {
		const { root } = fixtureRoot();
		fs.writeFileSync(path.join(root, "runtimes", "service.yaml"), [
			"apiVersion: 1", "id: Example-Service", "title: Example service",
			"endpoint:", "  protocol: http", "  servicePort: 8080", "  health: { path: /health, expectedStatus: 200, requestTimeoutMs: 1000, intervalMs: 500, startupTimeoutMs: 10000 }",
			"lifecycle:", "  startPolicy: manual", "  restart: { policy: never, maxAttempts: 0, windowMs: 1000, initialBackoffMs: 100, maxBackoffMs: 100 }",
			"environment: { SERVICE_PORT: { endpointPort: true }, SERVICE_HOST: { value: 127.0.0.1 } }",
			"modes:", "  local: { command: node, args: [service.mjs], cwd: '.', portEnv: SERVICE_PORT, hostEnv: SERVICE_HOST }",
			"  docker: { image: ghcr.io/example/service:1.2.3 }",
			"  compose: { file: ../runtime/compose.yaml, service: api, projectName: 'bobbit-${packId}-${serverIdentity}' }",
		].join("\n"));
		const manifest = validateManifest({
			name: "runtime-pack", description: "x", version: "1", schema: 2,
			contents: { roles: [], tools: [], skills: [], entrypoints: [], runtimes: ["service"] },
		})!;
		const loaded = loadPackContributions(root, manifest);
		assert.equal(loaded.runtimes.length, 1);
		assert.equal(loaded.runtimes[0]!.id, "example-service");
		assert.equal(loaded.runtimes[0]!.manifest.modes.compose.file, "../runtime/compose.yaml");
	});
});
