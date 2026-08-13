import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServiceManifest } from "../../src/server/service-runtime/service-manifest.js";
import { ComposeServiceRunner, LocalServiceRunner, type ServiceRunner, type ServiceRunnerStartInput } from "../../src/server/service-runtime/service-runners.js";
import { ServiceRuntimeSupervisor } from "../../src/server/service-runtime/service-supervisor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const manifest: any = {
	apiVersion: 1, id: "fixture", title: "Fixture",
	endpoint: { protocol: "http", servicePort: 8080, health: { path: "/health", expectedStatus: 200, requestTimeoutMs: 100, intervalMs: 100, startupTimeoutMs: 1_000 } },
	lifecycle: { startPolicy: "manual", restart: { policy: "never", maxAttempts: 0, windowMs: 1_000, initialBackoffMs: 100, maxBackoffMs: 100 } },
	environment: { PORT: { endpointPort: true }, HOST: { value: "127.0.0.1" } },
	modes: {
		local: { command: "fixture", args: ["serve"], cwd: ".", portEnv: "PORT", hostEnv: "HOST" },
		docker: { image: "fixture:latest" },
		compose: { file: "compose.yaml", service: "api", projectName: "bobbit-${packId}-${runtimeId}-${serverIdentity}" },
	},
};

function child() {
	const result = new Promise<any>(() => {}) as any;
	result.pid = 1; result.exitCode = null; result.kill = vi.fn(() => { result.exitCode = 0; return true; });
	return result;
}

function rootWithCompose(source: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-runtime-security-"));
	roots.push(root);
	fs.writeFileSync(path.join(root, "runtime.yaml"), "# runtime descriptor\n");
	fs.writeFileSync(path.join(root, "compose.yaml"), source);
	fs.writeFileSync(path.join(root, "runtime.env"), "PORT=8080\n", { mode: 0o600 });
	fs.chmodSync(path.join(root, "runtime.env"), 0o600);
	return root;
}

function input(root: string, mode: ServiceRunnerStartInput["mode"]): ServiceRunnerStartInput {
	return { manifest, mode, packRoot: root, descriptorDir: root, serverIdentity: "server", serviceIdentity: "pack\0fixture", packId: "pack", environment: { PORT: "8080" }, envFile: path.join(root, "runtime.env") };
}

async function withPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	if (!original) throw new Error("process.platform descriptor is unavailable");
	Object.defineProperty(process, "platform", { ...original, value: platform });
	try {
		return await action();
	} finally {
		Object.defineProperty(process, "platform", original);
	}
}

describe("service runtime security boundaries", () => {
	it("requires gateway identity in a safe Compose project template", () => {
		const root = rootWithCompose("services: {}\n");
		const raw = structuredClone(manifest);
		raw.modes.compose.projectName = "bobbit-${packId}-${runtimeId}";
		assert.equal(parseServiceManifest(raw, { packRoot: root, sourceFile: path.join(root, "runtime.yaml") }), null);
		assert.ok(parseServiceManifest(manifest, { packRoot: root, sourceFile: path.join(root, "runtime.yaml") }));
	});

	it("does not inherit gateway variables and rejects invalid Compose before up", async () => {
		const root = rootWithCompose("services:\n  api:\n    image: fixture\n    ports: [\"0.0.0.0:8080:8080\"]\n");
		const localExecute = vi.fn(() => child());
		const local = new LocalServiceRunner({ execute: localExecute, getPort: async () => 43123 });
		const saved = process.env.GATEWAY_SECRET;
		process.env.GATEWAY_SECRET = "must-not-leak";
		try {
			await local.start(input(root, "local"));
			const options: any = (localExecute.mock.calls as any)[0]![2];
			assert.equal(options.extendEnv, false);
			assert.equal(options.env.GATEWAY_SECRET, undefined);
			assert.equal(options.env.PORT, "43123");
		} finally {
			if (saved === undefined) delete process.env.GATEWAY_SECRET; else process.env.GATEWAY_SECRET = saved;
		}
		const execute = vi.fn();
		await assert.rejects(new ComposeServiceRunner({ execute }).start(input(root, "compose")), { code: "SERVICE_LAUNCH_FAILED" });
		assert.equal(execute.mock.calls.length, 0, "unsafe Compose must be rejected before up");
	});

	it("rejects unsupported Compose host features and any storage mount not sourced from its exact setting", async () => {
		const safeData = "/owned/runtime-data";
		const storageManifest = {
			...manifest,
			environment: {
				...manifest.environment,
				SAFE_DATA: { setting: "safeData" },
				OTHER_SETTING: { setting: "otherSetting" },
			},
			storage: { setting: "safeData", target: "/data", survival: "preserve" },
		};
		const sources = [
			"include: ./untrusted.yaml\nservices:\n  api:\n    image: fixture\n    ports: ['127.0.0.1::8080']\n    volumes: ['${SAFE_DATA}:/data']\n",
			"configs: {}\nservices:\n  api:\n    image: fixture\n    ports: ['127.0.0.1::8080']\n    volumes: ['${SAFE_DATA}:/data']\n",
			"secrets: {}\nservices:\n  api:\n    image: fixture\n    ports: ['127.0.0.1::8080']\n    volumes: ['${SAFE_DATA}:/data']\n",
			"services:\n  api:\n    image: fixture\n    ports: ['127.0.0.1::8080']\n    volumes: ['${SAFE_DATA}:/data']\n    volumes_from: ['other']\n",
			"services:\n  api:\n    image: fixture\n    ports: ['127.0.0.1::8080']\n    volumes: ['${SAFE_DATA}:/data']\n    use_api_socket: true\n",
			"services:\n  api:\n    image: fixture\n    ports: ['127.0.0.1::8080']\n    volumes: ['${OTHER_SETTING}:/data']\n",
		];
		for (const source of sources) {
			const root = rootWithCompose(source);
			const execute = vi.fn();
			const runnerInput = {
				...input(root, "compose"), manifest: storageManifest,
				environment: { PORT: "8080", SAFE_DATA: safeData, OTHER_SETTING: "/etc" },
				storage: { hostPath: safeData, target: "/data" },
			};
			await assert.rejects(new ComposeServiceRunner({ execute }).start(runnerInput), { code: "SERVICE_LAUNCH_FAILED" });
			assert.equal(execute.mock.calls.length, 0, "unsafe Compose must be rejected before up");
		}
	});

	it("allows only declared optional Compose fallbacks, including nested declared names", async () => {
		const interpolationManifest = {
			...manifest,
			environment: {
				...manifest.environment,
				OPTIONAL_DATABASE_URL: { secret: "databaseUrl", optional: true as const },
				DATABASE_PASSWORD: { generatedSecret: "databasePassword" },
			},
		};
		const valid = "services:\n  api:\n    image: fixture\n    restart: 'no'\n    environment:\n      DATABASE_URL: \"\${OPTIONAL_DATABASE_URL:-postgresql://fixture:\${DATABASE_PASSWORD}@db/fixture}\"\n    ports: ['127.0.0.1::8080']\n";
		const execute = vi.fn()
			.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "127.0.0.1:43123", stderr: "", exitCode: 0 });
		const root = rootWithCompose(valid);
		const runnerInput = {
			...input(root, "compose"), manifest: interpolationManifest,
			environment: { PORT: "8080", HOST: "127.0.0.1", DATABASE_PASSWORD: "generated" },
		};
		await expect(new ComposeServiceRunner({ execute }).start(runnerInput)).resolves.toMatchObject({ endpoint: "http://127.0.0.1:43123" });

		for (const source of [
			"services:\n  api:\n    image: fixture\n    restart: 'no'\n    environment: { DATABASE_URL: '${OPTIONAL_DATABASE_URL}' }\n    ports: ['127.0.0.1::8080']\n",
			"services:\n  api:\n    image: fixture\n    restart: 'no'\n    environment: { DATABASE_URL: '${OPTIONAL_DATABASE_URL:-postgresql://${UNDECLARED}@db}' }\n    ports: ['127.0.0.1::8080']\n",
			"services:\n  api:\n    image: fixture\n    restart: 'no'\n    environment: { DATABASE_URL: '${UNDECLARED:-fallback}' }\n    ports: ['127.0.0.1::8080']\n",
		]) {
			const unsafeRoot = rootWithCompose(source);
			const unsafeInput = { ...runnerInput, packRoot: unsafeRoot, descriptorDir: unsafeRoot, envFile: path.join(unsafeRoot, "runtime.env") };
			const unsafeExecute = vi.fn();
			await assert.rejects(new ComposeServiceRunner({ execute: unsafeExecute }).start(unsafeInput), { code: "SERVICE_LAUNCH_FAILED" });
			assert.equal(unsafeExecute.mock.calls.length, 0, "invalid interpolation must fail before Compose up");
		}
	});

	it("refuses a non-owner-only Compose env artifact before invoking Docker on POSIX", async () => {
		if (process.platform === "win32") return;
		const root = rootWithCompose("services:\n  api:\n    image: fixture\n    restart: 'no'\n    ports: [\"127.0.0.1::8080\"]\n");
		fs.chmodSync(path.join(root, "runtime.env"), 0o644);
		const execute = vi.fn();
		await assert.rejects(new ComposeServiceRunner({ execute }).start(input(root, "compose")), { code: "SERVICE_LAUNCH_FAILED" });
		assert.equal(execute.mock.calls.length, 0);
	});

	it("accepts regular Compose env files but rejects symlinks on Windows", async () => {
		const root = rootWithCompose("services:\n  api:\n    image: fixture\n    restart: 'no'\n    ports: [\"127.0.0.1::8080\"]\n");
		const envFile = path.join(root, "runtime.env");
		fs.chmodSync(envFile, 0o644);

		await withPlatform("win32", async () => {
			const execute = vi.fn()
				.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
				.mockResolvedValueOnce({ stdout: "127.0.0.1:43123", stderr: "", exitCode: 0 });
			await expect(new ComposeServiceRunner({ execute }).start(input(root, "compose"))).resolves.toMatchObject({ endpoint: "http://127.0.0.1:43123" });
			assert.equal(execute.mock.calls.length, 2, "a regular Windows artifact reaches Compose");

			const target = path.join(root, "untrusted.env");
			fs.writeFileSync(target, "PORT=untrusted\n");
			fs.rmSync(envFile);
			fs.symlinkSync(target, envFile);
			const unsafeExecute = vi.fn();
			await assert.rejects(new ComposeServiceRunner({ execute: unsafeExecute }).start(input(root, "compose")), { code: "SERVICE_LAUNCH_FAILED" });
			assert.equal(unsafeExecute.mock.calls.length, 0, "symlink artifacts are rejected before Compose");
		});
	});

	it("tears down the scoped Compose project without deleting volumes when publication discovery fails after up", async () => {
		const root = rootWithCompose("services:\n  api:\n    image: fixture\n    restart: 'no'\n    ports: [\"127.0.0.1::8080\"]\n");
		const execute = vi.fn()
			.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "0.0.0.0:8080", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
		await assert.rejects(new ComposeServiceRunner({ execute }).start(input(root, "compose")), { code: "SERVICE_LAUNCH_FAILED" });
		assert.deepEqual(execute.mock.calls[2]![1].slice(-4), ["down", "--remove-orphans", "--timeout", "10"]);
		assert.ok(!execute.mock.calls[2]![1].includes("-v"), "project cleanup must preserve declared bind storage");
		assert.ok(!execute.mock.calls[2]![1].includes("api"), "cleanup is project-scoped so dependencies cannot survive");
		assert.equal(execute.mock.calls[0]![2].extendEnv, false);
	});

	it("serializes stop and purge behind a start, cleans the stopped child before replacement, and omits stale endpoints", async () => {
		let release!: () => void;
		const started = new Promise<void>((resolve) => { release = resolve; });
		let childNumber = 0;
		const runner: ServiceRunner = {
			mode: "local",
			start: async () => {
				await started;
				childNumber++;
				return { endpoint: "http://127.0.0.1:4444", runnerIdentity: { kind: "local", id: `child-${childNumber}` }, services: [] };
			},
			inspect: async () => undefined,
			stop: vi.fn(async () => {}),
			remove: vi.fn(async () => {}),
		};
		const records = new Map<string, any>();
		const identity = (packId: string, runtimeId: string) => ({ packId, runtimeId, serverIdentity: "server" });
		const store: any = {
			identity, load: async (id: any) => records.get(`${id.packId}/${id.runtimeId}`),
			replace: async (id: any, value: any) => { records.set(`${id.packId}/${id.runtimeId}`, value); },
			writeEnvironment: async () => {}, readLog: async () => undefined,
			purge: async (id: any, request: any) => { await request.stop(); records.delete(`${id.packId}/${id.runtimeId}`); },
		};
		const root = rootWithCompose("services: {}\n");
		const contribution: any = { id: "fixture", listName: "fixture", sourceFile: path.join(root, "runtime.yaml"), packRoot: root, manifest };
		const supervisor = new ServiceRuntimeSupervisor({
			registry: { getRuntime: () => contribution }, store, runners: [runner], serverIdentity: "server",
			authorizer: { authorize: async () => true }, settings: { resolve: async () => ({ mode: "local", revision: "1", values: {} }) }, probe: async () => true,
		});
		const request = { packId: "pack", runtimeId: "fixture" };
		const start = supervisor.start(request);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const stop = supervisor.stop(request);
		release();
		await Promise.all([start, stop]);
		assert.equal(records.get("pack/fixture").desired, "stopped");
		assert.equal((runner.stop as any).mock.calls.length, 1);

		const second = supervisor.start(request);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const purge = supervisor.purge({ ...request, confirmation: identity("pack", "fixture") });
		await second;
		await purge;
		assert.equal(records.has("pack/fixture"), false);
		assert.deepEqual(
			(runner.remove as any).mock.calls.map((call: any[]) => call[0].runnerIdentity.id),
			["child-1", "child-2"],
			"starting after a durable stop removes the retained old child; purge removes the replacement child",
		);

		records.set("pack/fixture", { version: 1, serverIdentity: "server", desired: "running", selectedMode: "local", settingsRevision: "1", endpoint: "http://127.0.0.1:4444", restartAttempts: [] });
		const status = await supervisor.status(identity("pack", "fixture"));
		assert.equal(Object.hasOwn(status, "endpoint"), false);
	});
});
