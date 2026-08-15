import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";
import {
	ExtensionSettingsMutationError,
	ExtensionSettingsRevisionConflictError,
	ExtensionSettingsStore,
	ExtensionSettingsUnavailableError,
	extensionSettingsTargetKey,
} from "../../src/server/agent/extension-settings-store.js";
import {
	ExtensionSettingsSecretCommitMismatchError,
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
		expect(onDisk.extension_settings).toMatchObject({
			schema: 2,
			revision: 5,
			commitId: expect.any(String),
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

		secrets.update(ref, { credential: "runtime-credential-value" }, "test-owner-commit");

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
		const priorPublicState = store.getPublicState();
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
		expect(store.getPublicState()).toEqual(priorPublicState);
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
		expect(store.getPublicState()).toMatchObject({ schema: 2, revision: 1, targets: { [targetKey]: { values: {} } } });
		expect(String(thrown)).not.toContain("must-not-escape");
		expect(JSON.stringify(thrown)).not.toContain("must-not-escape");
		expect(thrown).not.toHaveProperty("cause");
		expect(() => store.getForRuntime(ref, {}, { secretFields: ["credential"] })).toThrow(ExtensionSettingsSecretCommitMismatchError);
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

	it("rejects mismatched, partial commit identities before returning secret bytes", () => {
		const memFs = createMemFs();
		const configDir = "/memfs/settings-config";
		const stateDir = "/memfs/settings-state";
		const config = new ProjectConfigStore(configDir, memFs);
		const secrets = new ExtensionSettingsSecretStore(stateDir, memFs);
		const store = new ExtensionSettingsStore(config, secrets);
		store.compareAndSwap(ref, 0, { values: { endpoint: "https://old.example" }, secrets: { credential: "old-secret" } });
		const committed = store.getPublicState();
		// The opposite partial state is unsafe as well: a versioned owner-only
		// envelope cannot be paired with an unversioned public record.
		config.setExtensionSettings({ schema: 1, revision: 0, targets: committed.targets });
		expect(() => new ExtensionSettingsStore(new ProjectConfigStore(configDir, memFs), new ExtensionSettingsSecretStore(stateDir, memFs))
			.getForRuntime(ref, {}, { secretFields: ["credential"] })).toThrow(ExtensionSettingsSecretCommitMismatchError);
		config.setExtensionSettings({ ...committed, revision: 2, commitId: "new-public-commit", targets: {
			[targetKey]: { values: { endpoint: "https://new.example" } },
		} });

		expect(() => store.getForRuntime(ref, {}, { secretFields: ["credential"] })).toThrow(ExtensionSettingsSecretCommitMismatchError);
		// A redacted secretSet projection is also unavailable; the project-wide
		// fence applies even to targets with no secret fields.
		expect(() => store.getEffective(ref, {}, { secretFields: ["credential"] })).toThrow(ExtensionSettingsSecretCommitMismatchError);
		expect(() => store.getEffective(ref, {})).toThrow(ExtensionSettingsSecretCommitMismatchError);
		expect(() => store.getForRuntime(ref, {}, { secretFields: ["credential"] })).not.toThrow(/old-secret|new\.example/);

		// A versioned public record cannot be paired with a legacy secret file.
		memFs.files.set(path.resolve(stateDir, "extension-settings-secrets.json"), JSON.stringify({ ["legacy\0provider\0one\0credential"]: "legacy-secret" }));
		const restarted = new ExtensionSettingsStore(new ProjectConfigStore(configDir, memFs), new ExtensionSettingsSecretStore(stateDir, memFs));
		expect(() => restarted.getForRuntime(ref, {}, { secretFields: ["credential"] })).toThrow(ExtensionSettingsSecretCommitMismatchError);
	});

	it("accepts only complete legacy pairs, then upgrades both records together", () => {
		const memFs = createMemFs();
		const configDir = "/memfs/settings-config";
		const stateDir = "/memfs/settings-state";
		const legacySecret = "legacy-secret";
		const legacyPublic = { schema: 1 as const, revision: 0, targets: { [targetKey]: { values: { endpoint: "https://legacy.example" } } } };
		const config = new ProjectConfigStore(configDir, memFs);
		config.setExtensionSettings(legacyPublic);
		memFs.files.set(path.resolve(stateDir, "extension-settings-secrets.json"), JSON.stringify({ [`${targetKey}\0credential`]: legacySecret }));
		const store = new ExtensionSettingsStore(config, new ExtensionSettingsSecretStore(stateDir, memFs));
		expect(store.getForRuntime(ref, {}, { secretFields: ["credential"] })).toEqual({ endpoint: "https://legacy.example", credential: legacySecret });

		store.compareAndSwap(ref, 0, { values: { endpoint: "https://upgraded.example" } });
		const publicState = store.getPublicState();
		expect(publicState.commitId).toEqual(expect.any(String));
		const envelope = JSON.parse(memFs.readFileSync(path.resolve(stateDir, "extension-settings-secrets.json"), "utf-8")) as Record<string, unknown>;
		expect(envelope).toMatchObject({ schema: 1, commitId: publicState.commitId, values: { [`${targetKey}\0credential`]: legacySecret } });
		expect(new ExtensionSettingsStore(new ProjectConfigStore(configDir, memFs), new ExtensionSettingsSecretStore(stateDir, memFs))
			.getForRuntime(ref, {}, { secretFields: ["credential"] }))
			.toEqual({ endpoint: "https://upgraded.example", credential: legacySecret });
	});

	it("advances the owner-only commit for public-only mutations", () => {
		const memFs = createMemFs();
		const configDir = "/memfs/settings-config";
		const stateDir = "/memfs/settings-state";
		const store = new ExtensionSettingsStore(new ProjectConfigStore(configDir, memFs), new ExtensionSettingsSecretStore(stateDir, memFs));
		store.compareAndSwap(ref, 0, { values: { endpoint: "https://one.example" }, secrets: { credential: "retained-secret" } });
		const firstCommit = store.getPublicState().commitId;
		store.compareAndSwap(ref, 1, { values: { endpoint: "https://two.example" } });
		const secondCommit = store.getPublicState().commitId;
		expect(secondCommit).not.toBe(firstCommit);
		expect(JSON.parse(memFs.readFileSync(path.resolve(stateDir, "extension-settings-secrets.json"), "utf-8"))).toMatchObject({ commitId: secondCommit });
		expect(store.getForRuntime(ref, {}, { secretFields: ["credential"] })).toEqual({ endpoint: "https://two.example", credential: "retained-secret" });
	});

	it("fails closed after an ambiguous secret rename and stays closed after restart", () => {
		const memFs = createMemFs();
		const configDir = "/memfs/settings-config";
		const stateDir = "/memfs/settings-state";
		const config = new ProjectConfigStore(configDir, memFs);
		const secrets = new ExtensionSettingsSecretStore(stateDir, memFs);
		const store = new ExtensionSettingsStore(config, secrets);
		store.compareAndSwap(ref, 0, { values: { endpoint: "https://old.example" }, secrets: { credential: "old-secret" } });
		const originalRename = memFs.renameSync.bind(memFs);
		let throwAfterRename = true;
		memFs.renameSync = (from, to) => {
			originalRename(from, to);
			if (throwAfterRename && String(to).includes("extension-settings-secrets.json")) {
				throwAfterRename = false;
				throw new Error("rename outcome unknown");
			}
		};

		expect(() => store.compareAndSwap(ref, 1, { values: { endpoint: "https://new.example" }, secrets: { credential: "new-secret" } }))
			.toThrow(ExtensionSettingsSecretPersistenceError);
		expect(() => store.getForRuntime(ref, {}, { secretFields: ["credential"] })).toThrow(ExtensionSettingsSecretCommitMismatchError);
		const publicBytes = memFs.readFileSync(path.resolve(configDir, "project.yaml"), "utf-8");
		const secretBytes = memFs.readFileSync(path.resolve(stateDir, "extension-settings-secrets.json"), "utf-8");
		const rolledBackPublicState = store.getPublicState();
		const restarted = new ExtensionSettingsStore(new ProjectConfigStore(configDir, memFs), new ExtensionSettingsSecretStore(stateDir, memFs));
		expect(restarted.getPublicState()).toEqual(rolledBackPublicState);
		expect(() => restarted.getForRuntime(ref, {}, { secretFields: ["credential"] })).toThrow(ExtensionSettingsSecretCommitMismatchError);
		// Preflight rejects both public-only and partial-secret attempts without
		// changing either durable byte stream or the rolled-back public revision.
		for (const mutation of [
			{ values: { endpoint: "https://laundered.example" } },
			{ secrets: { credential: "laundered-secret" } },
		]) {
			expect(() => restarted.compareAndSwap(ref, 1, mutation)).toThrow(ExtensionSettingsSecretCommitMismatchError);
			expect(restarted.getPublicState()).toEqual(rolledBackPublicState);
			expect(memFs.readFileSync(path.resolve(configDir, "project.yaml"), "utf-8")).toBe(publicBytes);
			expect(memFs.readFileSync(path.resolve(stateDir, "extension-settings-secrets.json"), "utf-8")).toBe(secretBytes);
		}
	});

	it("normalizes native schema-2 arrays and defensively clones every public boundary", () => withTmpDir(configDir => {
		const config = new ProjectConfigStore(configDir);
		const secrets = new ExtensionSettingsSecretStore(path.join(configDir, "state"));
		const store = new ExtensionSettingsStore(config, secrets);
		const raw = ["typescript", "python"];
		config.setExtensionSettings({ schema: 2, revision: 3, targets: { [targetKey]: { values: { languages: raw } } } });
		raw[0] = "mutated-after-save";

		const first = store.getPublicState();
		expect(first).toMatchObject({ schema: 2, revision: 3, targets: { [targetKey]: { values: { languages: ["python", "typescript"] } } } });
		(first.targets[targetKey].values.languages as string[])[0] = "mutated-snapshot";
		expect((store.getTarget(ref)?.values.languages as string[])).toEqual(["python", "typescript"]);
		expect(store.getEffective(ref, { languages: ["typescript", "python"] }).values.languages).toEqual(["python", "typescript"]);
		expect(yaml.parse(fs.readFileSync(path.join(configDir, "project.yaml"), "utf-8"))).toMatchObject({
			extension_settings: { schema: 2, targets: { [targetKey]: { values: { languages: ["python", "typescript"] } } } },
		});
	}));

	it("preserves schema-1 scalar state until save and rejects legacy arrays", () => withTmpDir(configDir => {
		const legacy = { schema: 1 as const, revision: 4, targets: { [targetKey]: { values: { endpoint: "https://legacy.example" } } } };
		const config = new ProjectConfigStore(configDir);
		config.setExtensionSettings(legacy);
		const store = new ExtensionSettingsStore(config, new ExtensionSettingsSecretStore(path.join(configDir, "state")));
		expect(store.getPublicState()).toEqual(legacy);
		store.compareAndSwap(ref, 4, { values: { endpoint: "https://saved.example" } });
		expect(store.getPublicState()).toMatchObject({ schema: 2, revision: 5 });

		const rejected = normalizeExtensionSettings({ schema: 1, revision: 1, targets: { [targetKey]: { values: { languages: ["python"] } } } });
		expect(rejected).toEqual({ value: { schema: 1, revision: 1, targets: {} }, ok: true });
	}));

	it("isolates malformed schema-2 arrays and target aggregate overflow", () => {
		const normal = normalizeExtensionSettings({
			schema: 2,
			revision: 1,
			targets: {
				[targetKey]: { values: { languages: ["typescript", "python"] } },
				"other\u0000provider\u0000bad": { values: { languages: ["python", "python"] } },
			},
		});
		expect(normal).toEqual({ value: { schema: 2, revision: 1, targets: { [targetKey]: { values: { languages: ["python", "typescript"] } } } }, ok: true });

		const selection = Array.from({ length: 64 }, (_, index) => `value-${index}`);
		const overflow = normalizeExtensionSettings({
			schema: 2,
			revision: 1,
			targets: { [targetKey]: { values: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`field${index}`, selection])) } },
		});
		expect(overflow).toEqual({ value: { schema: 2, revision: 1, targets: {} }, ok: true });

		const config = new ProjectConfigStore("/memfs/aggregate-settings", createMemFs());
		const store = new ExtensionSettingsStore(config, new ExtensionSettingsSecretStore("/memfs/aggregate-secrets", createMemFs()));
		expect(() => store.compareAndSwap(ref, 0, {
			values: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`field${index}`, selection])),
		})).toThrow();
		expect(store.getPublicState()).toEqual({ schema: 2, revision: 0, targets: {} });
	});

	it("rejects merged target selection overflow as an invalid mutation without changing state", () => {
		const memFs = createMemFs();
		const config = new ProjectConfigStore("/memfs/merged-aggregate-settings", memFs);
		const store = new ExtensionSettingsStore(config, new ExtensionSettingsSecretStore("/memfs/merged-aggregate-secrets", memFs));
		const selection = Array.from({ length: 64 }, (_, index) => `value-${index}`);
		store.compareAndSwap(ref, 0, {
			values: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`field${index}`, selection])),
		});
		const before = store.getPublicState();

		expect(() => store.compareAndSwap(ref, before.revision, {
			values: { field4: ["one-more"] },
		})).toThrow(ExtensionSettingsMutationError);
		expect(store.getPublicState()).toEqual(before);
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
