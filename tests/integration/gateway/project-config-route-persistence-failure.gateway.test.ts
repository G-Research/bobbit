import fs, { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { apiFetch, registerProject } from "./_helpers/e2e/e2e-setup.js";

const testOnPosix = process.platform === "win32" ? test.skip : test;

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

type LiveSecretsStore = {
	getAll(): Record<string, string>;
};

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

/** Fault only the real secrets.json publication. Supports the store-local fs
 * seam while keeping the current production route/harness completely intact. */
function captureSecretsTempWriteOptions(store: LiveSecretsStore): { restore(): void; options(): unknown[] } {
	const target = store as any;
	const originalFs = (target.fs ?? fs) as Record<string | symbol, unknown>;
	const secretsFile = target.filePath as string;
	const usesStoreFs = "fs" in target;
	const writeOptions: unknown[] = [];
	const trackingFs = new Proxy(originalFs, {
		get(backingFs, property) {
			if (property === "writeFileSync") {
				return (candidate: unknown, _data: unknown, ...args: unknown[]) => {
					const candidatePath = String(candidate);
					if (candidatePath.startsWith(`${secretsFile}.`) && candidatePath.endsWith(".tmp")) {
						writeOptions.push(args[0]);
					}
					return (backingFs.writeFileSync as (...writeArgs: unknown[]) => unknown)(candidate, _data, ...args);
				};
			}
			const value = Reflect.get(backingFs, property);
			return typeof value === "function" ? value.bind(backingFs) : value;
		},
	});
	if (usesStoreFs) target.fs = trackingFs;
	else (fs as any).writeFileSync = trackingFs.writeFileSync;
	return {
		restore: () => {
			if (usesStoreFs) target.fs = originalFs;
			else (fs as any).writeFileSync = originalFs.writeFileSync;
		},
		options: () => writeOptions,
	};
}

function failSecretsPublish(store: LiveSecretsStore): { restore(): void; calls(): number } {
	const target = store as any;
	const originalFs = (target.fs ?? fs) as Record<string | symbol, unknown>;
	const secretsFile = target.filePath as string;
	const usesStoreFs = "fs" in target;
	let failures = 0;
	const faultingFs = new Proxy(originalFs, {
		get(backingFs, property) {
			if (property === "writeFileSync") {
				return (candidate: unknown, ...args: unknown[]) => {
					const candidatePath = String(candidate);
					if (candidatePath.startsWith(`${secretsFile}.`) && candidatePath.endsWith(".tmp")) {
						failures++;
						throw new Error("injected secrets.json publish failure — do not leak this message");
					}
					return (backingFs.writeFileSync as (...writeArgs: unknown[]) => unknown)(candidate, ...args);
				};
			}
			const value = Reflect.get(backingFs, property);
			return typeof value === "function" ? value.bind(backingFs) : value;
		},
	});
	if (usesStoreFs) target.fs = faultingFs;
	else (fs as any).writeFileSync = faultingFs.writeFileSync;
	return {
		restore: () => {
			if (usesStoreFs) target.fs = originalFs;
			else (fs as any).writeFileSync = originalFs.writeFileSync;
		},
		calls: () => failures,
	};
}

async function expectSecretPersistenceFailure(response: Response, secret: string): Promise<void> {
	expect(response.status).toBeGreaterThanOrEqual(400);
	const body = await response.json();
	expect(body).toMatchObject({ code: "SANDBOX_SECRET_PERSIST_FAILED" });
	expect(body.ok).not.toBe(true);
	expect(JSON.stringify(body)).not.toContain(secret);
	expect(JSON.stringify(body)).not.toContain("injected secrets.json publish failure");
}

test.describe("project-config persistence failures through production settings routes", () => {
	test("project settings PUT stores sandbox token values only in secrets.json on success", async ({ gateway }) => {
		const rootPath = mkdtempSync(path.join(tmpdir(), "bobbit-route-secret-success-"));
		let projectId = "";
		try {
			const project = await registerProject({
				name: `route-secret-success-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				rootPath,
				seedWorkflows: false,
			});
			projectId = project.id;
			const context = gateway.projectContextManager.getOrCreate(projectId);
			expect(context).toBeTruthy();

			const response = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({
					build_command: "echo secret-success",
					sandbox_tokens: [{ key: "ROUTE_SECRET_SUCCESS", enabled: true, value: "route-success-secret" }],
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ ok: true });
			expect(context!.secretsStore.getAll()).toMatchObject({ ROUTE_SECRET_SUCCESS: "route-success-secret" });

			const configBytes = readFileSync(path.join(rootPath, ".bobbit", "config", "project.yaml"), "utf8");
			expect(configBytes).not.toContain("route-success-secret");
			expect(readFileSync(path.join(rootPath, ".bobbit", "state", "secrets.json"), "utf8")).toContain("route-success-secret");
		} finally {
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("project settings PUT writes its owned secrets candidate with owner-only mode", async ({ gateway }) => {
		const rootPath = mkdtempSync(path.join(tmpdir(), "bobbit-route-secret-temp-mode-"));
		let projectId = "";
		let restoreTracking: (() => void) | undefined;
		try {
			const project = await registerProject({
				name: `route-secret-temp-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				rootPath,
				seedWorkflows: false,
			});
			projectId = project.id;
			const context = gateway.projectContextManager.getOrCreate(projectId);
			expect(context).toBeTruthy();
			const tracking = captureSecretsTempWriteOptions(context!.secretsStore);
			restoreTracking = tracking.restore;

			const response = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({
					sandbox_tokens: [{ key: "OWNER_ONLY_TEMP", enabled: true, value: "owner-only-temp-secret" }],
				}),
			});
			expect(response.status).toBe(200);
			expect(tracking.options()).toEqual([expect.objectContaining({ mode: 0o600 })]);
		} finally {
			restoreTracking?.();
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

	testOnPosix("project settings PUT creates and preserves owner-only secrets.json files on POSIX", async () => {
		const rootPath = mkdtempSync(path.join(tmpdir(), "bobbit-route-secret-file-mode-"));
		let projectId = "";
		try {
			const project = await registerProject({
				name: `route-secret-file-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				rootPath,
				seedWorkflows: false,
			});
			projectId = project.id;
			const secretsFile = path.join(rootPath, ".bobbit", "state", "secrets.json");

			const create = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({
					sandbox_tokens: [{ key: "NEW_OWNER_ONLY", enabled: true, value: "new-owner-only-secret" }],
				}),
			});
			expect(create.status).toBe(200);
			expect(statSync(secretsFile).mode & 0o777).toBe(0o600);

			chmodSync(secretsFile, 0o600);
			const update = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({
					sandbox_tokens: [{ key: "NEW_OWNER_ONLY", enabled: true, value: "updated-owner-only-secret" }],
				}),
			});
			expect(update.status).toBe(200);
			expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
		} finally {
			if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

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

	test("project settings PUT reports a redacted secrets.json failure after publishing the config candidate", async ({ gateway }) => {
		const rootPath = mkdtempSync(path.join(tmpdir(), "bobbit-route-secrets-fault-"));
		let projectId = "";
		let restoreFault: (() => void) | undefined;
		try {
			const project = await registerProject({
				name: `route-secrets-fault-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				rootPath,
				seedWorkflows: false,
			});
			projectId = project.id;
			const context = gateway.projectContextManager.getOrCreate(projectId);
			const store = context?.projectConfigStore as LiveConfigStore | undefined;
			expect(store, "registered project must use the production config store").toBeTruthy();

			const baseline = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({
					build_command: "echo secret-before-build",
					sandbox_tokens: [{ key: "ROUTE_SECRET_FAULT", enabled: true, value: "secret-before-write-failure" }],
				}),
			});
			expect(baseline.status).toBe(200);

			const configFile = path.join(rootPath, ".bobbit", "config", "project.yaml");
			const secretsFile = path.join(rootPath, ".bobbit", "state", "secrets.json");
			const beforeConfigBytes = readFileSync(configFile);
			const beforeSecretsBytes = readFileSync(secretsFile);
			const beforeSecrets = context!.secretsStore.getAll();
			const fault = failSecretsPublish(context!.secretsStore);
			restoreFault = fault.restore;

			const failed = await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({
					build_command: "echo secret-after-build",
					sandbox_tokens: [{ key: "ROUTE_SECRET_FAULT", enabled: true, value: "secret-after-write-failure" }],
				}),
			});
			await expectSecretPersistenceFailure(failed, "secret-after-write-failure");
			expect(fault.calls()).toBe(1);
			expect(context!.secretsStore.getAll()).toEqual(beforeSecrets);
			expect(readFileSync(secretsFile)).toEqual(beforeSecretsBytes);

			// The config candidate is already durable when secrets.json is attempted.
			// This pins the route's documented partial-state contract: descriptor/config
			// changes remain published, while the secret update is rejected transactionally.
			expect(readFileSync(configFile)).not.toEqual(beforeConfigBytes);
			expect(configSnapshot(store!).all.build_command).toBe("echo secret-after-build");
			const configText = readFileSync(configFile, "utf8");
			expect(configText).not.toContain("secret-before-write-failure");
			expect(configText).not.toContain("secret-after-write-failure");
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
