import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type AgentDirResolution = {
	dir: string;
	source: string;
	raw?: string;
	projectRoot?: string;
	defaultDir?: string;
};

async function loadAgentDirConfigModule(): Promise<Record<string, any>> {
	for (const specifier of ["../src/server/agent-dir-config.ts", "../src/server/bobbit-dir.ts"]) {
		try {
			return await import(specifier) as Record<string, any>;
		} catch (err: any) {
			if (err?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module/.test(String(err?.message))) continue;
			throw err;
		}
	}
	throw new Error("Could not load agent-dir config module");
}

function tempProjectRoot(name: string): string {
	return path.join(os.tmpdir(), `bobbit-agent-dir-${name}`);
}

function assertSamePath(actual: string, expected: string, message?: string): void {
	assert.equal(path.normalize(actual), path.normalize(expected), message);
}

describe("agent directory resolver", () => {
	it("defaults to <projectRoot>/.bobbit/agent", async () => {
		const mod = await loadAgentDirConfigModule();
		assert.equal(typeof mod.resolveAgentDir, "function", "resolveAgentDir must be exported");
		const projectRoot = tempProjectRoot("default");
		const resolved = mod.resolveAgentDir({ env: {}, projectRoot }) as AgentDirResolution;
		assert.equal(resolved.source, "default");
		assertSamePath(resolved.dir, path.join(projectRoot, ".bobbit", "agent"));
		assertSamePath(resolved.defaultDir!, path.join(projectRoot, ".bobbit", "agent"));
	});

	it("uses exact precedence BOBBIT_AGENT_DIR > persisted > default and ignores PI_CODING_AGENT_DIR", async () => {
		const mod = await loadAgentDirConfigModule();
		assert.equal(typeof mod.resolveAgentDir, "function", "resolveAgentDir must be exported");
		const projectRoot = tempProjectRoot("precedence");
		const bobbit = path.join(os.tmpdir(), "bobbit-agent-dir-bobbit");
		const pi = path.join(os.tmpdir(), "bobbit-agent-dir-pi");
		const persisted = path.join(os.tmpdir(), "bobbit-agent-dir-persisted");

		assert.deepEqual(
			pick(mod.resolveAgentDir({ env: { BOBBIT_AGENT_DIR: bobbit, PI_CODING_AGENT_DIR: pi }, projectRoot, persisted })),
			{ source: "BOBBIT_AGENT_DIR", dir: path.normalize(bobbit), raw: bobbit },
		);
		assert.deepEqual(
			pick(mod.resolveAgentDir({ env: { PI_CODING_AGENT_DIR: pi }, projectRoot, persisted })),
			{ source: "persisted", dir: path.normalize(persisted), raw: persisted },
		);
		assert.deepEqual(
			pick(mod.resolveAgentDir({ env: { PI_CODING_AGENT_DIR: pi }, projectRoot })),
			{ source: "default", dir: path.normalize(path.join(projectRoot, ".bobbit", "agent")), raw: undefined },
		);
		assert.deepEqual(
			pick(mod.resolveAgentDir({ env: {}, projectRoot, persisted })),
			{ source: "persisted", dir: path.normalize(persisted), raw: persisted },
		);
		assert.deepEqual(
			pick(mod.resolveAgentDir({ env: {}, projectRoot })),
			{ source: "default", dir: path.normalize(path.join(projectRoot, ".bobbit", "agent")), raw: undefined },
		);
	});

	it("normalizes ~ and relative inputs against the project root", async () => {
		const mod = await loadAgentDirConfigModule();
		assert.equal(typeof mod.normalizeAgentDirInput, "function", "normalizeAgentDirInput must be exported");
		const projectRoot = tempProjectRoot("normalize");

		assertSamePath(
			mod.normalizeAgentDirInput("~/custom-agent", projectRoot),
			path.join(os.homedir(), "custom-agent"),
			"tilde paths expand through os.homedir()",
		);
		assertSamePath(
			mod.normalizeAgentDirInput("relative-agent", projectRoot),
			path.join(projectRoot, "relative-agent"),
			"relative paths resolve against project root",
		);
	});

	it("globalAgentDir stays pinned to startup resolution after env changes", async (t) => {
		const mod = await loadAgentDirConfigModule();
		const startupDir = path.join(os.tmpdir(), "bobbit-agent-dir-startup");
		const laterDir = path.join(os.tmpdir(), "bobbit-agent-dir-later");
		const projectRoot = tempProjectRoot("startup-pinned");
		const oldBobbit = process.env.BOBBIT_AGENT_DIR;
		const oldPi = process.env.PI_CODING_AGENT_DIR;
		t.after(() => {
			if (oldBobbit === undefined) delete process.env.BOBBIT_AGENT_DIR; else process.env.BOBBIT_AGENT_DIR = oldBobbit;
			if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
		});

		assert.equal(typeof mod.globalAgentDir, "function", "globalAgentDir must be exported");
		const reset = mod.resetAgentDirStateForTests || mod.resetAgentDirRuntimeForTests;
		if (typeof reset === "function") reset();
		if (typeof mod.setProjectRoot === "function") mod.setProjectRoot(projectRoot);
		process.env.BOBBIT_AGENT_DIR = startupDir;
		delete process.env.PI_CODING_AGENT_DIR;
		if (typeof mod.initializeAgentDirState === "function") {
			mod.initializeAgentDirState({ env: { BOBBIT_AGENT_DIR: startupDir }, projectRoot });
		} else if (typeof mod.initializeAgentDirRuntimeState === "function") {
			mod.initializeAgentDirRuntimeState({ env: { BOBBIT_AGENT_DIR: startupDir }, projectRoot });
		}
		assertSamePath(mod.globalAgentDir(), startupDir, "startup value is active");

		process.env.BOBBIT_AGENT_DIR = laterDir;
		assertSamePath(
			mod.globalAgentDir(),
			startupDir,
			"globalAgentDir must not recompute from env after startup initialization",
		);
	});

	it("scaffold and agent-dir runtime leave existing ~/.pi/agent untouched", async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-agent-untouched-"));
		const projectRoot = path.join(root, "project");
		const tempHome = path.join(root, "home");
		const legacyAgentDir = path.join(tempHome, ".pi", "agent");
		const bobbitAgentDir = path.join(projectRoot, ".bobbit", "agent");
		fs.mkdirSync(path.join(legacyAgentDir, "sessions", "--legacy-project--"), { recursive: true });
		fs.mkdirSync(projectRoot, { recursive: true });
		fs.writeFileSync(path.join(legacyAgentDir, "auth.json"), JSON.stringify({ token: "raw-pi-auth" }), "utf-8");
		fs.writeFileSync(path.join(legacyAgentDir, "models.json"), JSON.stringify({ models: ["raw-pi-model"] }), "utf-8");
		fs.writeFileSync(path.join(legacyAgentDir, "settings.json"), JSON.stringify({ setting: "raw-pi-setting" }), "utf-8");
		fs.writeFileSync(
			path.join(legacyAgentDir, "sessions", "--legacy-project--", "2026-06-27T00-00-00.000Z_session.jsonl"),
			'{"message":"raw pi session"}\n',
			"utf-8",
		);
		const before = snapshotTree(legacyAgentDir);

		const envKeys = ["BOBBIT_DIR", "BOBBIT_AGENT_DIR", "PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
		const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
		t.after(() => {
			for (const key of envKeys) {
				const value = oldEnv.get(key);
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			fs.rmSync(root, { recursive: true, force: true });
		});

		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.HOMEDRIVE;
		delete process.env.HOMEPATH;
		process.env.BOBBIT_DIR = path.join(projectRoot, ".bobbit");
		delete process.env.BOBBIT_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = legacyAgentDir;

		const bobbitDirMod = await import("../src/server/bobbit-dir.ts") as Record<string, any>;
		const scaffoldMod = await import("../src/server/scaffold.ts") as Record<string, any>;
		assert.equal(bobbitDirMod.migrateFromLegacyPiDir, undefined, "Bobbit must not export or call automatic ~/.pi/agent migration");
		assert.equal(typeof scaffoldMod.scaffoldBobbitDir, "function", "scaffoldBobbitDir must be exported");
		assert.equal(typeof bobbitDirMod.initializeAgentDirRuntime, "function", "initializeAgentDirRuntime must be exported");
		assert.equal(typeof bobbitDirMod.globalAgentDir, "function", "globalAgentDir must be exported");

		bobbitDirMod.resetAgentDirStateForTests?.();
		bobbitDirMod.setProjectRoot?.(projectRoot);
		scaffoldMod.scaffoldBobbitDir(projectRoot);
		const state = bobbitDirMod.initializeAgentDirRuntime({
			env: { PI_CODING_AGENT_DIR: legacyAgentDir },
			projectRoot,
			stateDir: path.join(projectRoot, ".bobbit", "state"),
		});

		assert.deepEqual(snapshotTree(legacyAgentDir), before, "raw pi-owned ~/.pi/agent tree must remain byte-for-byte unchanged");
		assert.ok(!fs.existsSync(path.join(tempHome, ".pi", "agent.pre-bobbit")), "startup must not write a ~/.pi/agent.pre-bobbit marker");
		assert.ok(!fs.existsSync(path.join(tempHome, ".bobbit", "agent", "auth.json")), "startup must not copy auth.json out of ~/.pi/agent");
		assertSamePath(state.startup.dir, bobbitAgentDir, "PI_CODING_AGENT_DIR must not become Bobbit's active agent dir");
		assert.equal(state.startup.source, "default");
		assert.ok(
			!state.history.some((entry: string) => path.normalize(entry) === path.normalize(legacyAgentDir)),
			"~/.pi/agent must not be seeded into agent-dir history as an implicit migration source",
		);
		assertSamePath(bobbitDirMod.globalAgentDir(), bobbitAgentDir, "runtime global agent dir stays on Bobbit's resolved directory");
	});

	it("filters stale persisted ~/.pi/agent history but preserves explicit config", async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-history-filter-"));
		const projectRoot = path.join(root, "project");
		const tempHome = path.join(root, "home");
		const legacyAgentDir = path.join(tempHome, ".pi", "agent");
		const stateDir = path.join(projectRoot, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(legacyAgentDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "preferences.json"), JSON.stringify({ agentDirHistory: [legacyAgentDir, "~/.pi/agent"] }, null, 2), "utf-8");

		const envKeys = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "BOBBIT_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const;
		const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
		t.after(() => {
			for (const key of envKeys) {
				const value = oldEnv.get(key);
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			fs.rmSync(root, { recursive: true, force: true });
		});

		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.HOMEDRIVE;
		delete process.env.HOMEPATH;
		delete process.env.BOBBIT_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;

		const mod = await loadAgentDirConfigModule();
		mod.resetAgentDirStateForTests?.();
		const state = mod.initializeAgentDirRuntime({ env: {}, projectRoot, stateDir });
		const rewrittenPrefs = JSON.parse(fs.readFileSync(path.join(stateDir, "preferences.json"), "utf-8"));
		assert.ok(
			!state.history.some((entry: string) => path.normalize(entry) === path.normalize(legacyAgentDir)),
			"stale ~/.pi/agent history must not remain known after runtime init",
		);
		assert.ok(
			!rewrittenPrefs.agentDirHistory.some((entry: string) => path.normalize(entry) === path.normalize(legacyAgentDir)),
			"rewritten preferences must drop stale ~/.pi/agent history",
		);

		const persistedStateDir = path.join(projectRoot, ".bobbit", "state-persisted");
		fs.mkdirSync(persistedStateDir, { recursive: true });
		fs.writeFileSync(
			path.join(persistedStateDir, "preferences.json"),
			JSON.stringify({ agentDir: "~/.pi/agent", agentDirHistory: ["~/.pi/agent"] }, null, 2),
			"utf-8",
		);
		mod.resetAgentDirStateForTests?.();
		const persistedState = mod.initializeAgentDirRuntime({ env: {}, projectRoot, stateDir: persistedStateDir });
		assert.ok(
			persistedState.history.some((entry: string) => path.normalize(entry) === path.normalize(legacyAgentDir)),
			"~/.pi/agent remains known when explicitly configured as persisted agent dir",
		);

		const envStateDir = path.join(projectRoot, ".bobbit", "state-env");
		fs.mkdirSync(envStateDir, { recursive: true });
		fs.writeFileSync(path.join(envStateDir, "preferences.json"), JSON.stringify({ agentDirHistory: ["~/.pi/agent"] }, null, 2), "utf-8");
		mod.resetAgentDirStateForTests?.();
		const envState = mod.initializeAgentDirRuntime({ env: { BOBBIT_AGENT_DIR: "~/.pi/agent" }, projectRoot, stateDir: envStateDir });
		assert.ok(
			envState.history.some((entry: string) => path.normalize(entry) === path.normalize(legacyAgentDir)),
			"~/.pi/agent remains known when explicitly configured via BOBBIT_AGENT_DIR",
		);
	});
});

function pick(value: AgentDirResolution): { source: string; dir: string; raw?: string } {
	return { source: value.source, dir: path.normalize(value.dir), raw: value.raw };
}

type TreeSnapshot = Record<string, { type: "dir" } | { type: "file"; content: string }>;

function snapshotTree(root: string): TreeSnapshot {
	const snapshot: TreeSnapshot = {};
	function walk(dir: string, rel: string): void {
		snapshot[rel || "."] = { type: "dir" };
		const entries = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
		for (const entry of entries) {
			const abs = path.join(dir, entry);
			const childRel = rel ? path.join(rel, entry) : entry;
			const stat = fs.statSync(abs);
			if (stat.isDirectory()) {
				walk(abs, childRel);
			} else if (stat.isFile()) {
				snapshot[childRel] = { type: "file", content: fs.readFileSync(abs, "utf-8") };
			}
		}
	}
	walk(root, "");
	return snapshot;
}
