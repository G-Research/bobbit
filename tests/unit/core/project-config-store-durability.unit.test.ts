import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ProjectConfigStore,
	type InlineWorkflowDef,
} from "../../../src/server/agent/project-config-store.js";
import { createMemFs, type MemFs } from "../../../tests/support/harnesses/shared/mem-fs.js";

const CONFIG_DIR = path.resolve("/memfs/project-config-durability");
const CONFIG_FILE = path.join(CONFIG_DIR, "project.yaml");

type MutableMemFs = {
	writeFileSync: (...args: any[]) => unknown;
	readFileSync: (...args: any[]) => unknown;
	statSync: (...args: any[]) => unknown;
	lstatSync: (...args: any[]) => unknown;
	renameSync: (...args: any[]) => unknown;
};

function writeConfig(fs: MemFs, contents: string): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, contents, "utf-8");
}

function siblingTemp(pathname: string): boolean {
	return path.dirname(pathname) === CONFIG_DIR
		&& pathname !== CONFIG_FILE
		&& path.basename(pathname).startsWith("project.yaml.");
}

function readConfig(fs: MemFs): string {
	return fs.readFileSync(CONFIG_FILE, "utf-8") as unknown as string;
}

function snapshot(store: ProjectConfigStore) {
	return {
		all: store.getAll(),
		components: store.getComponents(),
		workflows: store.getWorkflows(),
		directories: store.getConfigDirectories(),
		tokens: store.getSandboxTokens(),
		packOrder: store.getPackOrderMap(),
		packActivation: store.getPackActivationMap(),
		dirty: store.isDirty(),
	};
}

function thrownMessage(action: () => void): string {
	let error: unknown;
	try {
		action();
	} catch (caught) {
		error = caught;
	}
	expect(error, "a failed project-config publication must reject the public mutation").toBeDefined();
	return String(error);
}

function expectRedactedPersistenceFailure(message: string, secret: string): void {
	expect(message).toMatch(/project config|project\.yaml|persist|publish/i);
	expect(message).not.toContain(secret);
}

function injectedFsError(code: string, secret: string): Error & { code: string } {
	return Object.assign(new Error(secret), { code });
}

function complexYaml(): string {
	return [
		"build_command: npm run old-build",
		"components:",
		"  - name: web",
		"    repo: .",
		"    commands:",
		"      build: npm run old-build",
		"    config:",
		"      qa_start_command: npm run qa",
		"workflows:",
		"  release:",
		"    id: release",
		"    name: Release",
		"    gates: []",
		"config_directories: '[{\"path\":\"/legacy/skills\",\"types\":[\"skills\"]}]'",
		"sandbox_tokens: '[{\"key\":\"LEGACY_TOKEN\",\"enabled\":true}]'",
		"pack_order: '{\"project\":[\"legacy-pack\"]}'",
		"pack_activation: '{\"project\":{\"legacy-pack\":{\"tools\":[\"legacy_tool\"]}}}'",
		"",
	].join("\n");
}

function seedStore(): { fs: MemFs; store: ProjectConfigStore } {
	const fs = createMemFs();
	writeConfig(fs, complexYaml());
	return { fs, store: new ProjectConfigStore(CONFIG_DIR, fs) };
}

describe("ProjectConfigStore durability", () => {
	it("creates its owned temp file with the existing target's POSIX mode", () => {
		const { fs, store } = seedStore();
		const mutable = fs as MutableMemFs;
		const originalLstat = mutable.lstatSync.bind(fs);
		const originalStat = mutable.statSync.bind(fs);
		const originalWrite = mutable.writeFileSync.bind(fs);
		let tempWriteOptions: unknown;
		const withPrivateMode = (stat: unknown) => ({ ...(stat as object), mode: 0o100600 });
		mutable.lstatSync = (pathname: string, ...args: any[]) => String(pathname) === CONFIG_FILE
			? withPrivateMode(originalLstat(pathname, ...args))
			: originalLstat(pathname, ...args);
		mutable.statSync = (pathname: string, ...args: any[]) => String(pathname) === CONFIG_FILE
			? withPrivateMode(originalStat(pathname, ...args))
			: originalStat(pathname, ...args);
		mutable.writeFileSync = (pathname: string, data: unknown, ...args: any[]) => {
			if (siblingTemp(String(pathname))) tempWriteOptions = args[0];
			return originalWrite(pathname, data, ...args);
		};

		store.set("build_command", "npm run private-replacement");

		expect(tempWriteOptions).toEqual(expect.objectContaining({ mode: 0o600 }));
	});

	it("preserves an existing project.yaml mode across a successful POSIX atomic replacement", { skip: process.platform === "win32" }, () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-project-config-mode-"));
		const configFile = path.join(configDir, "project.yaml");
		try {
			fs.writeFileSync(configFile, "build_command: npm run old-build\n", "utf-8");
			fs.chmodSync(configFile, 0o600);
			const store = new ProjectConfigStore(configDir);

			store.set("build_command", "npm run replacement-build");

			expect(fs.readFileSync(configFile, "utf-8")).toContain("build_command: npm run replacement-build");
			expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("publishes through one owned sibling temp file, preserves target bytes on temp-write failure, and never cleans unrelated siblings", () => {
		const { fs, store } = seedStore();
		const originalBytes = readConfig(fs);
		const unrelated = path.join(CONFIG_DIR, "project.yaml.unrelated.tmp");
		fs.writeFileSync(unrelated, "leave-this-alone", "utf-8");
		const before = snapshot(store);
		const mutable = fs as MutableMemFs;
		const originalWrite = mutable.writeFileSync.bind(fs);
		const tempWrites: string[] = [];
		mutable.writeFileSync = (pathname: string, ...args: any[]) => {
			if (siblingTemp(String(pathname))) {
				tempWrites.push(String(pathname));
				throw new Error("INJECTED_TEMP_WRITE_SECRET=must-not-leak");
			}
			return originalWrite(pathname, ...args);
		};

		const message = thrownMessage(() => store.set("build_command", "npm run replacement"));
		expectRedactedPersistenceFailure(message, "INJECTED_TEMP_WRITE_SECRET=must-not-leak");
		expect(tempWrites).toHaveLength(1);
		expect(readConfig(fs)).toBe(originalBytes);
		expect(snapshot(store)).toEqual(before);
		expect(fs.files.has(path.resolve(unrelated))).toBe(true);
		for (const ownedTemp of tempWrites) expect(fs.files.has(path.resolve(ownedTemp))).toBe(false);
	});

	it("cleans only its owned temp file when rename fails, retaining target bytes and committed getters", () => {
		const { fs, store } = seedStore();
		const originalBytes = readConfig(fs);
		const unrelated = path.join(CONFIG_DIR, "project.yaml.other-writer.tmp");
		fs.writeFileSync(unrelated, "other writer", "utf-8");
		const before = snapshot(store);
		const mutable = fs as MutableMemFs;
		const originalRename = mutable.renameSync.bind(fs);
		const renameSources: string[] = [];
		mutable.renameSync = (from: string, to: string, ...args: any[]) => {
			if (siblingTemp(String(from)) && String(to) === CONFIG_FILE) {
				renameSources.push(String(from));
				throw new Error("INJECTED_RENAME_SECRET=must-not-leak");
			}
			return originalRename(from, to, ...args);
		};

		const message = thrownMessage(() => store.setPackOrder("project", ["replacement-pack"]));
		expectRedactedPersistenceFailure(message, "INJECTED_RENAME_SECRET=must-not-leak");
		expect(renameSources).toHaveLength(1);
		expect(readConfig(fs)).toBe(originalBytes);
		expect(snapshot(store)).toEqual(before);
		expect(fs.files.has(path.resolve(unrelated))).toBe(true);
		for (const ownedTemp of renameSources) expect(fs.files.has(path.resolve(ownedTemp))).toBe(false);
	});

	it("allows a missing project.yaml to load healthy and publish normally", () => {
		const fs = createMemFs();
		const store = new ProjectConfigStore(CONFIG_DIR, fs);

		expect(store.getAll()).toEqual({});
		expect(store.getComponents()).toEqual([]);
		expect(store.getWorkflows()).toBeUndefined();
		expect(store.isDirty()).toBe(false);
		store.set("build_command", "npm run build");
		expect(readConfig(fs)).toContain("build_command: npm run build");
	});

	it.each([
		["malformed YAML", "build_command: [unterminated\n"],
		["a scalar YAML document", "just-a-scalar\n"],
		["an array YAML document", "- not\n- a mapping\n"],
	] as const)("latches %s and preserves it for repair rather than publishing defaults", (_case, brokenContents) => {
		const fs = createMemFs();
		writeConfig(fs, brokenContents);
		const store = new ProjectConfigStore(CONFIG_DIR, fs);

		expect(snapshot(store)).toEqual({
			all: {}, components: [], workflows: undefined, directories: [], tokens: [],
			packOrder: {}, packActivation: {}, dirty: false,
		});
		const message = thrownMessage(() => store.set("build_command", "must-not-overwrite"));
		expectRedactedPersistenceFailure(message, brokenContents);
		expect(readConfig(fs)).toBe(brokenContents);
	});

	it("latches an EACCES config lstat failure until an explicit successful reload permits publication", () => {
		const { fs, store } = seedStore();
		const originalBytes = readConfig(fs);
		const mutable = fs as MutableMemFs;
		const originalLstat = mutable.lstatSync.bind(fs);
		const secret = "INJECTED_LSTAT_EACCES_SECRET=must-not-leak";
		let denyConfigProbe = true;
		mutable.lstatSync = (pathname: string, ...args: any[]) => {
			if (denyConfigProbe && String(pathname) === CONFIG_FILE) {
				throw injectedFsError("EACCES", secret);
			}
			return originalLstat(pathname, ...args);
		};

		store.reload();
		expect(snapshot(store)).toEqual({
			all: {}, components: [], workflows: undefined, directories: [], tokens: [],
			packOrder: {}, packActivation: {}, dirty: false,
		});
		const firstFailure = thrownMessage(() => store.set("build_command", "must-not-overwrite"));
		expectRedactedPersistenceFailure(firstFailure, secret);
		expect(readConfig(fs)).toBe(originalBytes);

		denyConfigProbe = false;
		const stillLatched = thrownMessage(() => store.set("build_command", "still-must-not-overwrite"));
		expectRedactedPersistenceFailure(stillLatched, secret);
		expect(readConfig(fs)).toBe(originalBytes);

		store.reload();
		store.set("build_command", "published-after-explicit-reload");
		expect(store.get("build_command")).toBe("published-after-explicit-reload");
		expect(readConfig(fs)).toContain("build_command: published-after-explicit-reload");
	});

	it("latches a read ENOENT after a successful existing-file probe rather than treating the config as absent", () => {
		const { fs, store } = seedStore();
		const originalBytes = readConfig(fs);
		const mutable = fs as MutableMemFs;
		const originalLstat = mutable.lstatSync.bind(fs);
		const originalRead = mutable.readFileSync.bind(fs);
		const secret = "INJECTED_POST_PROBE_ENOENT_SECRET=must-not-leak";
		let configProbes = 0;
		let disappearAfterProbe = true;
		mutable.lstatSync = (pathname: string, ...args: any[]) => {
			if (String(pathname) === CONFIG_FILE) configProbes++;
			return originalLstat(pathname, ...args);
		};
		mutable.readFileSync = (pathname: string, ...args: any[]) => {
			if (disappearAfterProbe && String(pathname) === CONFIG_FILE) {
				throw injectedFsError("ENOENT", secret);
			}
			return originalRead(pathname, ...args);
		};

		store.reload();
		expect(configProbes).toBeGreaterThan(0);
		expect(snapshot(store)).toEqual({
			all: {}, components: [], workflows: undefined, directories: [], tokens: [],
			packOrder: {}, packActivation: {}, dirty: false,
		});
		const firstFailure = thrownMessage(() => store.set("build_command", "must-not-overwrite"));
		expectRedactedPersistenceFailure(firstFailure, secret);
		expect(String(originalRead(CONFIG_FILE, "utf-8"))).toBe(originalBytes);

		disappearAfterProbe = false;
		const stillLatched = thrownMessage(() => store.set("build_command", "still-must-not-overwrite"));
		expectRedactedPersistenceFailure(stillLatched, secret);
		expect(readConfig(fs)).toBe(originalBytes);

		store.reload();
		store.set("build_command", "published-after-race-reload");
		expect(store.get("build_command")).toBe("published-after-race-reload");
		expect(readConfig(fs)).toContain("build_command: published-after-race-reload");
	});

	it("clears every state table on an unreadable reload, refuses writes while latched, then permits repair and reload", () => {
		const { fs, store } = seedStore();
		expect(store.isDirty(), "legacy shapes establish migration state before the failed reload").toBe(true);
		const mutable = fs as MutableMemFs;
		const originalRead = mutable.readFileSync.bind(fs);
		mutable.readFileSync = (pathname: string, ...args: any[]) => {
			if (String(pathname) === CONFIG_FILE) throw new Error("INJECTED_READ_SECRET=must-not-leak");
			return originalRead(pathname, ...args);
		};

		store.reload();
		expect(snapshot(store)).toEqual({
			all: {}, components: [], workflows: undefined, directories: [], tokens: [],
			packOrder: {}, packActivation: {}, dirty: false,
		});
		const message = thrownMessage(() => store.set("build_command", "must-not-overwrite"));
		expectRedactedPersistenceFailure(message, "INJECTED_READ_SECRET=must-not-leak");
		expect(String(originalRead(CONFIG_FILE, "utf-8"))).toBe(complexYaml());

		mutable.readFileSync = originalRead;
		writeConfig(fs, "build_command: repaired\n");
		store.reload();
		store.set("test_command", "npm test");
		expect(store.getAll()).toEqual({ build_command: "repaired", test_command: "npm test" });
		expect(store.isDirty()).toBe(false);
		expect(readConfig(fs)).toContain("test_command: npm test");
	});

	it("keeps legacy migration dirty after a failed publish and clears it only after successful rename", () => {
		const { fs, store } = seedStore();
		const mutable = fs as MutableMemFs;
		const originalWrite = mutable.writeFileSync.bind(fs);
		mutable.writeFileSync = (pathname: string, ...args: any[]) => {
			if (siblingTemp(String(pathname))) throw new Error("INJECTED_MIGRATION_WRITE_FAILURE");
			return originalWrite(pathname, ...args);
		};

		expect(store.isDirty()).toBe(true);
		thrownMessage(() => store.set("build_command", "npm run native-build"));
		expect(store.isDirty()).toBe(true);
		expect(store.get("build_command")).toBe("npm run old-build");

		mutable.writeFileSync = originalWrite;
		store.set("build_command", "npm run native-build");
		expect(store.isDirty()).toBe(false);
		const reloaded = new ProjectConfigStore(CONFIG_DIR, fs);
		expect(reloaded.isDirty()).toBe(false);
		expect(reloaded.get("build_command")).toBe("npm run native-build");
		expect(reloaded.getConfigDirectories()).toEqual([{ path: "/legacy/skills", types: ["skills"] }]);
	});

	it("never places sandbox token values in either the published target or a temp candidate", () => {
		const fs = createMemFs();
		const mutable = fs as MutableMemFs;
		const originalWrite = mutable.writeFileSync.bind(fs);
		const publicationBodies: string[] = [];
		mutable.writeFileSync = (pathname: string, data: unknown, ...args: any[]) => {
			if (String(pathname) === CONFIG_FILE || siblingTemp(String(pathname))) publicationBodies.push(String(data));
			return originalWrite(pathname, data, ...args);
		};
		const store = new ProjectConfigStore(CONFIG_DIR, fs);
		const secret = "top-secret-value-never-in-project-yaml";
		store.setSandboxTokens([{ key: "DEPLOY_TOKEN", enabled: true, value: secret }]);

		expect(publicationBodies).toHaveLength(1);
		for (const body of publicationBodies) expect(body).not.toContain(secret);
		expect(readConfig(fs)).not.toContain(secret);
		expect(store.getSandboxTokens()).toEqual([{ key: "DEPLOY_TOKEN", enabled: true }]);
	});

	it("round-trips all structured side tables after durable publication", () => {
		const fs = createMemFs();
		const store = new ProjectConfigStore(CONFIG_DIR, fs);
		const workflows = {
			release: { id: "release", name: "Release", description: "publish", gates: [] },
		} as Record<string, InlineWorkflowDef>;
		store.set("custom_key", "custom value");
		store.setComponents([{
			name: "web", repo: "apps/web", relativePath: "client", worktreeSetupCommand: "npm ci",
			commands: { build: "npm run build" }, config: { qa_start_command: "npm run qa" },
		}]);
		store.setWorkflows(workflows);
		store.setConfigDirectories([{ path: "/team/packs", types: ["skills", "tools"] }]);
		store.setSandboxTokens([{ key: "DEPLOY_TOKEN", enabled: false, value: "must-not-persist" }]);
		store.setPackOrder("project", ["first-pack", "last-pack"]);
		store.setPackActivation("project", "last-pack", {
			enabled: true, tools: ["tool-a"], mcpOperations: { "mcp:last-pack": ["search"] },
		});

		const reloaded = new ProjectConfigStore(CONFIG_DIR, fs);
		expect(reloaded.get("custom_key")).toBe("custom value");
		expect(reloaded.getComponents()).toEqual(store.getComponents());
		expect(reloaded.getWorkflows()).toEqual(workflows);
		expect(reloaded.getConfigDirectories()).toEqual([{ path: "/team/packs", types: ["skills", "tools"] }]);
		expect(reloaded.getSandboxTokens()).toEqual([{ key: "DEPLOY_TOKEN", enabled: false }]);
		expect(reloaded.getPackOrderMap()).toEqual({ project: ["first-pack", "last-pack"] });
		expect(reloaded.getPackActivationMap()).toEqual({
			project: { "last-pack": { enabled: true, tools: ["tool-a"], mcpOperations: { "mcp:last-pack": ["search"] } } },
		});
		expect(readConfig(fs)).not.toContain("must-not-persist");
	});

	it("does not partially commit any public structured mutation when publication fails", () => {
		const mutations: Array<[string, (store: ProjectConfigStore) => void]> = [
			["flat set", store => store.set("build_command", "replacement")],
			["flat remove", store => store.remove("build_command")],
			["components", store => store.setComponents([{ name: "replacement", repo: "." }])],
			["workflows", store => store.setWorkflows({ next: { id: "next", name: "Next", gates: [] } })],
			["config directories", store => store.setConfigDirectories([{ path: "/replacement", types: ["tools"] }])],
			["sandbox tokens", store => store.setSandboxTokens([{ key: "REPLACEMENT", enabled: true }])],
			["pack order", store => store.setPackOrder("project", ["replacement-pack"])],
			["pack activation", store => store.setPackActivation("project", "replacement-pack", { roles: ["role"] })],
		];

		for (const [name, mutate] of mutations) {
			const { fs, store } = seedStore();
			const before = snapshot(store);
			const mutable = fs as MutableMemFs;
			const originalRename = mutable.renameSync.bind(fs);
			mutable.renameSync = (from: string, to: string, ...args: any[]) => {
				if (siblingTemp(String(from)) && String(to) === CONFIG_FILE) throw new Error(`INJECTED_RENAME_${name}`);
				return originalRename(from, to, ...args);
			};
			thrownMessage(() => mutate(store));
			expect(snapshot(store), name).toEqual(before);
		}
	});
});
