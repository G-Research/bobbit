import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";
import {
	ExtensionSettingsRevisionConflictError,
	ExtensionSettingsStore,
	extensionSettingsTargetKey,
} from "../../src/server/agent/extension-settings-store.js";
import { ExtensionSettingsSecretStore } from "../../src/server/agent/extension-settings-secret-store.js";
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
		expect(fs.statSync(path.join(stateDir, "extension-settings-secrets.json")).mode & 0o777).toBe(0o600);
	}));

	it("reports a redacted partial result when the owner-only write fails", () => {
		const memFs = createMemFs();
		const configDir = "/memfs/settings-config";
		const stateDir = "/memfs/settings-state";
		const config = new ProjectConfigStore(configDir, memFs);
		const secrets = new ExtensionSettingsSecretStore(stateDir, memFs);
		const store = new ExtensionSettingsStore(config, secrets);
		const privateValue = "unpublished-runtime-value";
		const originalWrite = memFs.writeFileSync.bind(memFs);
		memFs.writeFileSync = (file, ...args) => {
			if (String(file).includes("extension-settings-secrets.json")) throw new Error("injected failure");
			return originalWrite(file, ...args);
		};

		const result = store.compareAndSwap(ref, 0, {
			values: { endpoint: "https://published.example" },
			secrets: { credential: privateValue },
		});

		expect(result).toEqual({ outcome: "secret-persist-failed", revision: 1, targets: { [targetKey]: { values: { endpoint: "https://published.example" } } } });
		expect(JSON.stringify(result)).not.toContain(privateValue);
		expect(store.getPublicState()).toEqual({ schema: 1, revision: 1, targets: { [targetKey]: { values: { endpoint: "https://published.example" } } } });
		expect(store.getEffective(ref, {}, { secretFields: ["credential"] }).secretSet.credential).toBe(false);
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
