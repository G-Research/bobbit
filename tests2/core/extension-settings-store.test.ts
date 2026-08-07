import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";
import {
	ExtensionSettingsRevisionConflictError,
	ExtensionSettingsStore,
	ExtensionSettingsUnavailableError,
	extensionSettingsTargetKey,
} from "../../src/server/agent/extension-settings-store.js";
import {
	ExtensionSettingsSecretPersistenceError,
	ExtensionSettingsSecretStore,
} from "../../src/server/agent/extension-settings-secret-store.js";
import {
	normalizeExtensionSettings,
	ProjectConfigStore,
} from "../../src/server/agent/project-config-store.js";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { createMemFs } from "../harness/mem-fs.js";

const ref = { packId: "observability", kind: "provider" as const, id: "insights" };
const targetKey = extensionSettingsTargetKey(ref);

function withTmpDir(run: (dir: string) => void): void {
	const dir = makeTmpDir("extension-settings-");
	try {
		run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("extension settings store", () => {
	it("persists revisioned public overlays as native YAML and isolates malformed rows", () => withTmpDir(configDir => {
		const config = new ProjectConfigStore(configDir);
		const secrets = new ExtensionSettingsSecretStore(path.join(configDir, "state"));
		const store = new ExtensionSettingsStore(config, secrets);

		config.setExtensionSettings({
			schema: 1,
			revision: 4,
			targets: { [targetKey]: { enabled: false, values: { endpoint: "https://one.example", enabled: true, limit: 3 } } },
		});
		const update = store.compareAndSwap(ref, 4, { enabled: true, values: { limit: 7 } });
		expect(update).toMatchObject({ outcome: "updated", revision: 5, targets: { [targetKey]: { enabled: true, values: { endpoint: "https://one.example", enabled: true, limit: 7 } } } });
		expect(() => store.compareAndSwap(ref, 4, { enabled: false })).toThrow(ExtensionSettingsRevisionConflictError);

		const publicState = store.getPublicState();
		publicState.targets[targetKey].values.endpoint = "changed-only-in-test";
		expect(store.getPublicState().targets[targetKey].values.endpoint).toBe("https://one.example");
		const onDisk = yaml.parse(fs.readFileSync(path.join(configDir, "project.yaml"), "utf-8")) as Record<string, unknown>;
		expect(onDisk.extension_settings).toEqual({
			schema: 1,
			revision: 5,
			targets: { [targetKey]: { enabled: true, values: { endpoint: "https://one.example", enabled: true, limit: 7 } } },
		});

		const defensive = normalizeExtensionSettings({
			schema: 1,
			revision: 2,
			targets: {
				[targetKey]: { values: { endpoint: "https://healthy.example" } },
				"bad\u0000kind\u0000target": { values: { endpoint: { nested: true } } },
			},
		});
		expect(defensive.ok).toBe(true);
		expect(defensive.value).toEqual({ schema: 1, revision: 2, targets: { [targetKey]: { values: { endpoint: "https://healthy.example" } } } });
	}));

	it("keeps credential bytes in the owner-only file and exposes only redacted public state", () => withTmpDir(configDir => {
		const stateDir = path.join(configDir, "runtime-state");
		const config = new ProjectConfigStore(configDir);
		const secrets = new ExtensionSettingsSecretStore(stateDir);
		const store = new ExtensionSettingsStore(config, secrets);
		const privateValue = "runtime-credential-value";

		const result = store.compareAndSwap(ref, 0, {
			values: { endpoint: "https://private.example" },
			secrets: { credential: privateValue },
		});
		const publicYaml = fs.readFileSync(path.join(configDir, "project.yaml"), "utf-8");
		const projection = store.getEffective(ref, { endpoint: "https://default.example" }, { secretFields: ["credential"] });

		expect(result).toEqual({ outcome: "updated", revision: 1, targets: { [targetKey]: { values: { endpoint: "https://private.example" } } } });
		expect(publicYaml).not.toContain(privateValue);
		expect(JSON.stringify(projection)).not.toContain(privateValue);
		expect(projection).toMatchObject({ secretSet: { credential: true }, values: { endpoint: "https://private.example" } });
		expect(secrets.getForRuntime(ref, "credential")).toBe(privateValue);
		// Windows reports 0666 even when Node receives a 0600 mode request.
		if (process.platform !== "win32") {
			expect(fs.statSync(path.join(stateDir, "extension-settings-secrets.json")).mode & 0o777).toBe(0o600);
		}
	}));

	it("requests an owner-only mode through its injected filesystem seam", () => {
		const memFs = createMemFs();
		const stateDir = "/memfs/settings-state";
		const secrets = new ExtensionSettingsSecretStore(stateDir, memFs);
		const originalWrite = memFs.writeFileSync.bind(memFs);
		const writes: Array<{ file: string; options: unknown }> = [];
		memFs.writeFileSync = (file, ...args) => {
			writes.push({ file: String(file), options: args[1] });
			return originalWrite(file, ...args);
		};

		secrets.update(ref, { credential: "runtime-credential-value" });

		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			file: expect.stringContaining("extension-settings-secrets.json."),
			options: { encoding: "utf-8", mode: 0o600 },
		});
		expect(secrets.getForRuntime(ref, "credential")).toBe("runtime-credential-value");
	});

	it("rolls back public state after an owner-only write failure so the original revision can retry", () => {
		const memFs = createMemFs();
		const configDir = "/memfs/settings-config";
		const stateDir = "/memfs/settings-state";
		const config = new ProjectConfigStore(configDir, memFs);
		const secrets = new ExtensionSettingsSecretStore(stateDir, memFs);
		const store = new ExtensionSettingsStore(config, secrets);
		const oldSecret = "previous-runtime-value";
		const unpublishedSecret = "unpublished-runtime-value";
		store.compareAndSwap(ref, 0, {
			values: { endpoint: "https://previous.example" },
			secrets: { credential: oldSecret },
		});
		const originalWrite = memFs.writeFileSync.bind(memFs);
		memFs.writeFileSync = (file, ...args) => {
			if (String(file).includes("extension-settings-secrets.json")) throw new Error("injected failure");
			return originalWrite(file, ...args);
		};

		let thrown: unknown;
		try {
			store.compareAndSwap(ref, 1, {
				values: { endpoint: "https://unpublished.example" },
				secrets: { credential: unpublishedSecret },
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ExtensionSettingsSecretPersistenceError);
		expect(thrown).not.toHaveProperty("committedRevision");
		expect(store.getPublicState()).toEqual({ schema: 1, revision: 1, targets: { [targetKey]: { values: { endpoint: "https://previous.example" } } } });
		expect(store.getForRuntime(ref, {}, { secretFields: ["credential"] })).toEqual({ endpoint: "https://previous.example", credential: oldSecret });

		memFs.writeFileSync = originalWrite;
		expect(store.compareAndSwap(ref, 1, {
			values: { endpoint: "https://retried.example" },
			secrets: { credential: unpublishedSecret },
		})).toMatchObject({ outcome: "updated", revision: 2 });
		expect(store.getForRuntime(ref, {}, { secretFields: ["credential"] })).toEqual({ endpoint: "https://retried.example", credential: unpublishedSecret });
	});

	it("reports an unavailable failure if public rollback cannot be persisted", () => {
		const memFs = createMemFs();
		const configDir = "/memfs/settings-config";
		const stateDir = "/memfs/settings-state";
		const config = new ProjectConfigStore(configDir, memFs);
		const secrets = new ExtensionSettingsSecretStore(stateDir, memFs);
		const store = new ExtensionSettingsStore(config, secrets);
		const originalWrite = memFs.writeFileSync.bind(memFs);
		let secretSaveFailed = false;
		memFs.writeFileSync = (file, ...args) => {
			if (String(file).includes("extension-settings-secrets.json")) {
				secretSaveFailed = true;
				throw new Error("injected secret failure");
			}
			if (secretSaveFailed && String(file).includes("project.yaml")) throw new Error("injected rollback failure");
			return originalWrite(file, ...args);
		};

		let thrown: unknown;
		try {
			store.compareAndSwap(ref, 0, { secrets: { credential: "must-not-escape" } });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ExtensionSettingsUnavailableError);
		expect(thrown).toMatchObject({ code: "EXTENSION_SETTINGS_UNAVAILABLE", committedRevision: 1 });
		expect(store.getPublicState()).toEqual({ schema: 1, revision: 1, targets: { [targetKey]: { values: {} } } });
		expect(String(thrown)).not.toContain("must-not-escape");
		expect(JSON.stringify(thrown)).not.toContain("must-not-escape");
		expect(thrown).not.toHaveProperty("cause");
	});

	it("publishes multiple target secrets all-or-nothing in one owner-only replacement", () => {
		const memFs = createMemFs();
		const configDir = "/memfs/settings-config";
		const stateDir = "/memfs/settings-state";
		const config = new ProjectConfigStore(configDir, memFs);
		const secrets = new ExtensionSettingsSecretStore(stateDir, memFs);
		const store = new ExtensionSettingsStore(config, secrets);
		const secondRef = { packId: "observability", kind: "hook" as const, id: "audit" };
		const originalWrite = memFs.writeFileSync.bind(memFs);
		const initialSecretWrites: string[] = [];
		memFs.writeFileSync = (file, ...args) => {
			if (String(file).includes("extension-settings-secrets.json")) initialSecretWrites.push(String(file));
			return originalWrite(file, ...args);
		};
		store.compareAndSwapMany([
			{ ref, secrets: { credential: "previous-provider-secret" } },
			{ ref: secondRef, secrets: { credential: "previous-hook-secret" } },
		], 0);
		expect(initialSecretWrites).toHaveLength(1);
		const before = store.getPublicState();
		const secretWrites: string[] = [];
		memFs.writeFileSync = (file, ...args) => {
			if (String(file).includes("extension-settings-secrets.json")) {
				secretWrites.push(String(file));
				throw new Error("injected failure");
			}
			return originalWrite(file, ...args);
		};

		expect(() => store.compareAndSwapMany([
			{ ref, values: { endpoint: "https://new-provider.example" }, secrets: { credential: "new-provider-secret" } },
			{ ref: secondRef, values: { endpoint: "https://new-hook.example" }, secrets: { credential: "new-hook-secret" } },
		], 1)).toThrow(ExtensionSettingsSecretPersistenceError);
		expect(secretWrites).toHaveLength(1);
		expect(store.getPublicState()).toEqual(before);
		expect(store.getForRuntime(ref, {}, { secretFields: ["credential"] }).credential).toBe("previous-provider-secret");
		expect(store.getForRuntime(secondRef, {}, { secretFields: ["credential"] }).credential).toBe("previous-hook-secret");
	});

	it("resolves public and owner-only values independently for each project", () => withTmpDir(root => {
		const projectA = path.join(root, "a");
		const projectB = path.join(root, "b");
		const first = new ExtensionSettingsStore(
			new ProjectConfigStore(projectA),
			new ExtensionSettingsSecretStore(path.join(projectA, "state")),
		);
		const second = new ExtensionSettingsStore(
			new ProjectConfigStore(projectB),
			new ExtensionSettingsSecretStore(path.join(projectB, "state")),
		);
		const privateValue = "project-a-runtime-value";

		first.compareAndSwap(ref, 0, { enabled: false, values: { endpoint: "https://a.example" }, secrets: { credential: privateValue } });
		expect(first.getEffective(ref, { endpoint: "https://default.example" }, { secretFields: ["credential"] })).toMatchObject({
			enabled: false, hasProjectRecord: true, values: { endpoint: "https://a.example" }, secretSet: { credential: true },
		});
		expect(second.getEffective(ref, { endpoint: "https://default.example" }, { secretFields: ["credential"] })).toEqual({
			hasProjectRecord: false,
			values: { endpoint: "https://default.example" },
			sources: { endpoint: "default" },
			secretSet: { credential: false },
		});
		expect(second.getForRuntime(ref, { endpoint: "https://default.example" }, { secretFields: ["credential"] })).toEqual({ endpoint: "https://default.example" });
	}));
});
