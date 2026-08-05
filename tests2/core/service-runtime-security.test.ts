import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { parseServiceManifest } from "../../src/server/service-runtime/service-manifest.js";
import { ComposeServiceRunner, LocalServiceRunner, type ServiceRunner, type ServiceRunnerStartInput } from "../../src/server/service-runtime/service-runners.js";
import { ServiceRuntimeSupervisor } from "../../src/server/service-runtime/service-supervisor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const manifest: any = {
	apiVersion: 1, id: "fixture", title: "Fixture",
	endpoint: { protocol: "http", servicePort: 8080, health: { path: "/health", expectedStatus: 200, requestTimeoutMs: 100, intervalMs: 100, startupTimeoutMs: 1_000 } },
	lifecycle: { startPolicy: "manual", restart: { policy: "never", maxAttempts: 0, windowMs: 1_000, initialBackoffMs: 100, maxBackoffMs: 100 } },
	environment: { PORT: { endpointPort: true } },
	modes: {
		local: { command: "fixture", args: ["serve"], cwd: ".", portEnv: "PORT" },
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
	return root;
}

function input(root: string, mode: ServiceRunnerStartInput["mode"]): ServiceRunnerStartInput {
	return { manifest, mode, packRoot: root, descriptorDir: root, serverIdentity: "server", serviceIdentity: "pack\0fixture", packId: "pack", environment: { PORT: "8080" } };
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

	it("removes a scoped Compose service when publication discovery fails after up", async () => {
		const root = rootWithCompose("services:\n  api:\n    image: fixture\n    restart: 'no'\n    ports: [\"127.0.0.1::8080\"]\n");
		const execute = vi.fn()
			.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "0.0.0.0:8080", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
		await assert.rejects(new ComposeServiceRunner({ execute }).start(input(root, "compose")), { code: "SERVICE_LAUNCH_FAILED" });
		assert.deepEqual(execute.mock.calls[2]![1].slice(-4), ["rm", "--stop", "--force", "api"]);
		assert.equal(execute.mock.calls[0]![2].extendEnv, false);
	});

	it("serializes stop and purge behind a start, removes purged runner resources, and omits stale endpoints", async () => {
		let release!: () => void;
		const started = new Promise<void>((resolve) => { release = resolve; });
		const runner: ServiceRunner = {
			mode: "local",
			start: async () => { await started; return { endpoint: "http://127.0.0.1:4444", runnerIdentity: { kind: "local", id: "child" }, services: [] }; },
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
		assert.equal((runner.remove as any).mock.calls.length, 1);

		records.set("pack/fixture", { version: 1, serverIdentity: "server", desired: "running", selectedMode: "local", settingsRevision: "1", endpoint: "http://127.0.0.1:4444", restartAttempts: [] });
		const status = await supervisor.status(identity("pack", "fixture"));
		assert.equal(Object.hasOwn(status, "endpoint"), false);
	});
});
