import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, registerProject } from "./_e2e/e2e-setup.js";

type LiveConfigStore = {
	getAll(): Record<string, string>;
	getComponents(): unknown[];
	getWorkflows(): unknown;
	getConfigDirectories(): unknown[];
	getSandboxTokens(): unknown[];
};

function configSnapshot(store: LiveConfigStore) {
	return {
		all: store.getAll(),
		components: store.getComponents(),
		workflows: store.getWorkflows(),
		directories: store.getConfigDirectories(),
		tokens: store.getSandboxTokens(),
	};
}

/**
 * Fault the real store's injected filesystem only for its owned atomic temp
 * candidate. The HTTP request still travels through the production router.
 */
function failOwnedTempPublish(store: LiveConfigStore): { restore(): void; calls(): number } {
	const target = store as any;
	const originalFs = target.fs as Record<string | symbol, unknown>;
	const configFile = target.configFile as string;
	let failures = 0;
	const faultingFs = new Proxy(originalFs, {
		get(fs, property) {
			if (property === "writeFileSync") {
				return (candidate: unknown, ...args: unknown[]) => {
					const candidatePath = String(candidate);
					if (candidatePath.startsWith(`${configFile}.`) && candidatePath.endsWith(".tmp")) {
						failures++;
						throw new Error("injected route project.yaml temp publication failure");
					}
					return (fs.writeFileSync as (...writeArgs: unknown[]) => unknown)(candidate, ...args);
				};
			}
			const value = Reflect.get(fs, property);
			return typeof value === "function" ? value.bind(fs) : value;
		},
	});
	target.fs = faultingFs;
	return {
		restore: () => { target.fs = originalFs; },
		calls: () => failures,
	};
}

async function expectPersistenceFailure(response: Response): Promise<void> {
	expect(response.status).toBeGreaterThanOrEqual(400);
	const body = await response.json();
	expect(body).toMatchObject({ code: "PROJECT_CONFIG_PERSIST_FAILED" });
	expect(body.ok).not.toBe(true);
}

test.describe("project-config persistence failures through production settings routes", () => {
	test("project settings PUT preserves disk, config, and sandbox secrets when atomic temp publication fails", async ({ gateway }) => {
		const rootPath = mkdtempSync(path.join(tmpdir(), "bobbit-route-config-fault-"));
		let projectId = "";
		let restoreFault: (() => void) | undefined;
		try {
			const project = await registerProject({
				name: `route-config-fault-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				rootPath,
				seedWorkflows: false,
			});
			projectId = project.id;
			const context = gateway.projectContextManager.getOrCreate(projectId);
			const store = context?.projectConfigStore as LiveConfigStore | undefined;
			expect(store, "registered project must use the production project config store").toBeTruthy();

			const baseline = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({
					build_command: "echo before-build",
					test_command: "echo before-test",
					config_directories: [{ path: "/before/skills", types: ["skills"] }],
					sandbox_tokens: [{ key: "ROUTE_FAULT_TOKEN", enabled: true, value: "before-route-secret" }],
				}),
			});
			expect(baseline.status).toBe(200);

			const configFile = path.join(rootPath, ".bobbit", "config", "project.yaml");
			const beforeBytes = readFileSync(configFile);
			const beforeConfig = configSnapshot(store!);
			const beforeSecrets = context!.secretsStore.getAll();
			const fault = failOwnedTempPublish(store!);
			restoreFault = fault.restore;

			const failed = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({
					build_command: "echo after-build",
					test_command: "echo after-test",
					config_directories: [{ path: "/after/tools", types: ["tools"] }],
					sandbox_tokens: [{ key: "ROUTE_FAULT_TOKEN", enabled: true, value: "after-route-secret" }],
				}),
			});
			await expectPersistenceFailure(failed);
			expect(fault.calls()).toBe(1);
			expect(readFileSync(configFile)).toEqual(beforeBytes);
			expect(configSnapshot(store!)).toEqual(beforeConfig);
			expect(context!.secretsStore.getAll()).toEqual(beforeSecrets);
		} finally {
			restoreFault?.();
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("server settings PUT preserves disk, config, and secrets when atomic temp publication fails", async ({ gateway }) => {
		const context = gateway.projectContextManager.getOrCreate("headquarters");
		const store = context?.projectConfigStore as LiveConfigStore | undefined;
		expect(store, "Headquarters must resolve to the production server config store").toBeTruthy();
		const configFile = path.join(gateway.bobbitDir, "config", "project.yaml");
		const originalBytes = readFileSync(configFile);
		let restoreFault: (() => void) | undefined;
		try {
			const baseline = await apiFetch("/api/project-config", {
				method: "PUT",
				body: JSON.stringify({
					build_command: "echo server-before-build",
					test_command: "echo server-before-test",
					config_directories: [{ path: "/server/before", types: ["skills"] }],
				}),
			});
			expect(baseline.status).toBe(200);

			const beforeBytes = readFileSync(configFile);
			const beforeConfig = configSnapshot(store!);
			const beforeSecrets = context!.secretsStore.getAll();
			const fault = failOwnedTempPublish(store!);
			restoreFault = fault.restore;

			const failed = await apiFetch("/api/project-config", {
				method: "PUT",
				body: JSON.stringify({
					build_command: "echo server-after-build",
					test_command: "echo server-after-test",
					config_directories: [{ path: "/server/after", types: ["tools"] }],
					sandbox_tokens: [{ key: "SERVER_ROUTE_FAULT_TOKEN", enabled: true, value: "server-after-secret" }],
				}),
			});
			await expectPersistenceFailure(failed);
			expect(fault.calls()).toBe(1);
			expect(readFileSync(configFile)).toEqual(beforeBytes);
			expect(configSnapshot(store!)).toEqual(beforeConfig);
			expect(context!.secretsStore.getAll()).toEqual(beforeSecrets);
		} finally {
			restoreFault?.();
			writeFileSync(configFile, originalBytes);
			(store as any)?.reload();
		}
	});
});
