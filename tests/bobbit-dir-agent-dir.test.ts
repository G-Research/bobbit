import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

	it("uses exact precedence BOBBIT_AGENT_DIR > PI_CODING_AGENT_DIR > persisted > default", async () => {
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
			{ source: "PI_CODING_AGENT_DIR", dir: path.normalize(pi), raw: pi },
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
});

function pick(value: AgentDirResolution): { source: string; dir: string; raw?: string } {
	return { source: value.source, dir: path.normalize(value.dir), raw: value.raw };
}
