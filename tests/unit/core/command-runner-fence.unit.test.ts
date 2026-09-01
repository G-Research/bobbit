import type { ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realClock, type CommandRunner } from "../../../src/server/gateway-deps.js";
import {
	createCommandSpawnAdapter,
	hasOwnedTreeSpawnRequest,
	ownedTreeSpawnOptions,
	type OwnedTreeControl,
} from "../../../src/server/owned-tree-command-spawn.js";
import { resolveWorktreeSupport } from "../../../src/server/agent/worktree-support.js";
import { VerificationHarness } from "../../../src/server/agent/verification-harness.js";
import { createFencedCommandRunner } from "../../../tests/support/harnesses/shared/fenced-command-runner.js";
import { installMemoryFs } from "../../../tests/support/helpers/unit/memory-fs-spies.js";
import type { MemFs } from "../../../tests/support/harnesses/shared/mem-fs.js";

const nativeExistsSync = fs.existsSync.bind(fs);
const nativeMkdtempSync = fs.mkdtempSync.bind(fs);
const nativeRmSync = fs.rmSync.bind(fs);
const nativeUnlinkSync = fs.unlinkSync.bind(fs);
const nativeWriteFileSync = fs.writeFileSync.bind(fs);

type NativeExecFile = typeof import("node:child_process").execFile;
type NativeExecFileSync = typeof import("node:child_process").execFileSync;
type NativeSpawn = typeof import("node:child_process").spawn;
type SpawnGuardState = { originals?: { execFile?: NativeExecFile; execFileSync?: NativeExecFileSync; spawn?: NativeSpawn } };
const SPAWN_GUARD_STATE = Symbol.for("bobbit.tests.tier1-spawn-guard-state");

/** Narrow real-process delegate for this fence's own end-to-end containment regression. */
function preservedNativeCommandRunner(): CommandRunner {
	const originals = (process as NodeJS.Process & { [SPAWN_GUARD_STATE]?: SpawnGuardState })[SPAWN_GUARD_STATE]?.originals;
	if (!originals?.execFile || !originals.execFileSync || !originals.spawn) throw new Error("tier-1 spawn guard originals unavailable");
	return {
		execFile: (file, args, options) => new Promise((resolve, reject) => {
			originals.execFile!(file, [...args], options as any, (error, stdout, stderr) => {
				if (error) return reject(Object.assign(error, { stdout, stderr }));
				resolve({ stdout, stderr });
			});
		}),
		execFileSync: (file, args, options) => originals.execFileSync!(file, [...args], options),
		spawn: (file, args, options) => originals.spawn!(file, [...args], options as any),
	};
}

let memoryFs: MemFs;
let restoreFs: () => void;
let fixtureSequence = 0;

beforeEach(() => {
	({ fs: memoryFs, restore: restoreFs } = installMemoryFs());
});

afterEach(() => restoreFs());

function unexpectedDelegate(): CommandRunner {
	return {
		execFile: async (file, args) => { throw new Error(`unexpected async delegation: ${file} ${args.join(" ")}`); },
		execFileSync: (file, args) => { throw new Error(`unexpected sync delegation: ${file} ${args.join(" ")}`); },
		spawn: (file, args) => { throw new Error(`unexpected spawn delegation: ${file} ${args.join(" ")}`); },
	};
}

function makeFixtureRoot(prefix: string): string {
	const root = path.resolve("/memfs/command-runner-fence", `${prefix}${fixtureSequence++}`);
	memoryFs.mkdirSync(root, { recursive: true });
	return root;
}

function makeRepositoryMetadata(root: string): { repo: string; bare: string } {
	const repo = path.join(root, "repo");
	const bare = path.join(root, "bare.git");
	memoryFs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	memoryFs.mkdirSync(path.join(bare, "objects"), { recursive: true });
	memoryFs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/master\n");
	return { repo, bare };
}

describe("fenced command runner", () => {
	it("rejects network and host-control commands", async () => {
		const runner = createFencedCommandRunner(unexpectedDelegate());
		await expect(runner.execFile("git", ["push", "https://github.com/example/repo.git", "HEAD"])).rejects.toThrow(/blocked git push/);
		await expect(runner.execFile("git.cmd", ["--no-pager", "push", "https://github.com/example/repo.git", "HEAD"])).rejects.toThrow(/blocked git push/);
		await expect(runner.execFile("gh.cmd", ["pr", "list"])).rejects.toThrow(/blocked gh/);
		await expect(runner.execFile("docker.bat", ["ps"])).rejects.toThrow(/blocked docker/);
	});

	it("blocks credential subcommands behind Git global options on every runner path", async () => {
		const delegations: string[] = [];
		const delegate: CommandRunner = {
			execFile: async (file, args) => {
				delegations.push(`async ${file} ${args.join(" ")}`);
				return { stdout: "", stderr: "" };
			},
			execFileSync: (file, args) => {
				delegations.push(`sync ${file} ${args.join(" ")}`);
				return "";
			},
			spawn: (file, args) => {
				delegations.push(`spawn ${file} ${args.join(" ")}`);
				return {} as any;
			},
		};
		const runner = createFencedCommandRunner(delegate);
		const expected = new Error("[fenced-command-runner] blocked git credential invocation");
		const fixture = makeFixtureRoot("bobbit-fenced-credential-options-");
		const bypasses = [
			{ file: "git", args: ["credential", "fill"] },
			{ file: "git.exe", args: ["--no-pager", "credential", "fill"] },
			{ file: "git.cmd", args: ["-C", fixture, "credential", "fill"] },
			{ file: "git.bat", args: [`-C${fixture}`, "credential", "fill"] },
			{ file: "git", args: ["-c", "credential.helper=fixture", "credential", "fill"] },
			{ file: "git.exe", args: ["-ccredential.helper=fixture", "credential", "fill"] },
			{ file: "git.cmd", args: ["--config-env", "credential.helper=FIXTURE_HELPER", "credential", "fill"] },
			{ file: "git.bat", args: ["--config-env=credential.helper=FIXTURE_HELPER", "credential", "fill"] },
			{ file: "git", args: [`--git-dir=${fixture}`, "credential", "fill"] },
			{ file: "git.exe", args: ["--", "credential", "fill"] },
		];

		for (const { file, args } of bypasses) {
			await expect(runner.execFile(file, args)).rejects.toThrow(expected);
			expect(() => runner.execFileSync!(file, args)).toThrow(expected);
			expect(() => runner.spawn!(file, args)).toThrow(expected);
		}
		expect(delegations).toEqual([]);

		const runnerWithoutSpawn = createFencedCommandRunner({
			execFile: async () => ({ stdout: "", stderr: "" }),
		});
		expect(() => runnerWithoutSpawn.spawn!("git.cmd", ["--no-pager", "credential", "fill"])).toThrow(expected);
	});

	it("forwards owned-tree capability and branded safe Git spawns through the fence", () => {
		const { repo } = makeRepositoryMetadata(makeFixtureRoot("bobbit-fenced-owned-tree-"));
		const child = new EventEmitter() as ChildProcess;
		const control: OwnedTreeControl & { child: ChildProcess } = {
			child,
			ownershipReady: Promise.resolve(),
			killTree: vi.fn(),
			waitForTreeExit: vi.fn(async () => true),
			killed: () => false,
			timedOut: () => false,
		};
		const directSpawn = vi.fn();
		const ownedSpawn = vi.fn(() => control);
		const capableSpawn = createCommandSpawnAdapter(directSpawn as any, ownedSpawn as any);
		let delegatedOptions: Parameters<typeof capableSpawn>[2];
		const delegate: CommandRunner = {
			execFile: async () => ({ stdout: "", stderr: "" }),
			spawn: (file, args, options) => {
				delegatedOptions = options;
				return capableSpawn(file, args, options);
			},
			supportsOwnedTreeSpawn: true,
		};
		const runner = createFencedCommandRunner(delegate);
		let bound: OwnedTreeControl | undefined;
		const options = ownedTreeSpawnOptions({
			cwd: repo,
			env: {
				GIT_CONFIG_GLOBAL: "/developer/.gitconfig",
				GIT_CONFIG_SYSTEM: "/etc/gitconfig",
			},
			stdio: "ignore",
		}, realClock, value => { bound = value; });

		expect(runner.supportsOwnedTreeSpawn).toBe(true);
		expect(runner.spawn!("git", ["status", "--short"], options)).toBe(child);
		expect(hasOwnedTreeSpawnRequest(delegatedOptions)).toBe(true);
		expect(delegatedOptions).not.toBe(options);
		expect(delegatedOptions?.env).toMatchObject({
			GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
			GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : os.devNull,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "credential.helper",
			GIT_CONFIG_VALUE_0: "",
		});
		expect(bound).toBe(control);
		expect(directSpawn).not.toHaveBeenCalled();
		expect(ownedSpawn).toHaveBeenCalledTimes(1);
	});

	it("does not advertise owned-tree spawning when its delegate lacks the capability", () => {
		const runner = createFencedCommandRunner({
			execFile: async () => ({ stdout: "", stderr: "" }),
			spawn: () => new EventEmitter() as ChildProcess,
		});

		expect(runner.supportsOwnedTreeSpawn).toBeUndefined();
		expect(Object.hasOwn(runner, "supportsOwnedTreeSpawn")).toBe(false);
	});

	it("blocks branded Git credential requests before capable delegate activity", () => {
		const delegateSpawn = vi.fn(() => new EventEmitter() as ChildProcess);
		const delegate: CommandRunner = {
			execFile: async () => ({ stdout: "", stderr: "" }),
			spawn: delegateSpawn,
			supportsOwnedTreeSpawn: true,
		};
		const runner = createFencedCommandRunner(delegate);
		const bind = vi.fn();
		const options = ownedTreeSpawnOptions({ cwd: makeFixtureRoot("bobbit-fenced-owned-credential-") }, realClock, bind);

		expect(runner.supportsOwnedTreeSpawn).toBe(true);
		expect(() => runner.spawn!("git.cmd", ["--no-pager", "credential", "fill"], options))
			.toThrow("[fenced-command-runner] blocked git credential invocation");
		expect(delegateSpawn).not.toHaveBeenCalled();
		expect(bind).not.toHaveBeenCalled();
	});

	it("blocks alias and config-include injection on every runner path without delegation", async () => {
		const delegations: string[] = [];
		const delegate: CommandRunner = {
			execFile: async () => { delegations.push("async"); return { stdout: "", stderr: "" }; },
			execFileSync: () => { delegations.push("sync"); return ""; },
			spawn: () => { delegations.push("spawn"); return {} as any; },
		};
		const runner = createFencedCommandRunner(delegate);
		const expected = new Error("[fenced-command-runner] blocked unsafe git configuration");
		const bypasses: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [
			{ args: ["-c", "alias.readcreds=!git credential fill", "readcreds"] },
			{ args: ["-cALIAS.readcreds=!git credential fill", "readcreds"] },
			{ args: ["--config-env", "alias.readcreds=FIXTURE_ALIAS", "readcreds"], env: { FIXTURE_ALIAS: "!git credential fill" } },
			{ args: ["--config-env=Alias.readcreds=FIXTURE_ALIAS", "readcreds"], env: { FIXTURE_ALIAS: "!git credential fill" } },
			{ args: ["-c", "include.path=/developer/.gitconfig", "status"] },
			{ args: ["-cIncludeIf.gitdir:/fixture/.path=/developer/.gitconfig", "status"] },
			{ args: ["--config-env=includeIf.onbranch:main.path=INCLUDE_FILE", "status"], env: { INCLUDE_FILE: "/developer/.gitconfig" } },
			{
				args: ["readcreds"],
				env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "alias.readcreds", GIT_CONFIG_VALUE_0: "!git credential fill" },
			},
			{
				args: ["status"],
				env: { git_config_count: "1", git_config_key_0: "INCLUDE.path", git_config_value_0: "/developer/.gitconfig" },
			},
			{ args: ["status"], env: { GIT_CONFIG_PARAMETERS: "'alias.readcreds'='!git credential fill'" } },
		];

		for (const { args, env } of bypasses) {
			await expect(runner.execFile("git", args, { env })).rejects.toThrow(expected);
			expect(() => runner.execFileSync!("git.cmd", args, { env })).toThrow(expected);
			expect(() => runner.spawn!("git.exe", args, { env })).toThrow(expected);
		}
		expect(delegations).toEqual([]);
	});

	it("fails closed on unknown or malformed Git global options before delegation", async () => {
		const delegations: string[] = [];
		const delegate: CommandRunner = {
			execFile: async () => { delegations.push("async"); return { stdout: "", stderr: "" }; },
			execFileSync: () => { delegations.push("sync"); return ""; },
			spawn: () => { delegations.push("spawn"); return {} as any; },
		};
		const runner = createFencedCommandRunner(delegate);
		const expected = new Error("[fenced-command-runner] blocked unclassified git invocation");
		for (const { args, env } of [
			{ args: [] },
			{ args: ["--unknown-global", "credential", "fill"] },
			{ args: ["-C"] },
			{ args: ["--config-env"] },
			{ args: ["--config-env=core.filemode="] },
			{ args: ["--config-env=core.filemode=INVALID-NAME", "status"] },
			{ args: ["--git-dir=", "status"] },
			{ args: ["--", "--not-a-command"] },
			{ args: ["status"], env: { GIT_CONFIG_COUNT: "one" } },
			{ args: ["status"], env: { GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Fixture" } },
			{ args: ["status"], env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name" } },
			{ args: ["status"], env: { GIT_CONFIG_COUNT: "0", GIT_CONFIG_KEY_extra: "user.name" } },
		] as Array<{ args: string[]; env?: NodeJS.ProcessEnv }>) {
			await expect(runner.execFile("git", args, { env })).rejects.toThrow(expected);
			expect(() => runner.execFileSync!("git.cmd", args, { env })).toThrow(expected);
			expect(() => runner.spawn!("git.bat", args, { env })).toThrow(expected);
		}
		expect(delegations).toEqual([]);
	});

	it("delegates safe config while isolating global and system Git configuration", async () => {
		const { repo } = makeRepositoryMetadata(makeFixtureRoot("bobbit-fenced-global-options-"));
		const calls: string[] = [];
		const environments: NodeJS.ProcessEnv[] = [];
		const fakeChild = { pid: 4321 };
		const delegate: CommandRunner = {
			execFile: async (file, args, options) => {
				calls.push(`async ${file} ${args.join(" ")}`);
				environments.push(options?.env ?? {});
				return { stdout: "clean", stderr: "" };
			},
			execFileSync: (file, args, options) => {
				calls.push(`sync ${file} ${args.join(" ")}`);
				environments.push(options?.env ?? {});
				return "clean";
			},
			spawn: (file, args, options) => {
				calls.push(`spawn ${file} ${args.join(" ")}`);
				environments.push(options?.env ?? {});
				return fakeChild as any;
			},
		};
		const runner = createFencedCommandRunner(delegate);
		const developerConfig = {
			GIT_CONFIG: "/developer/selected.gitconfig",
			GIT_CONFIG_GLOBAL: "/developer/.gitconfig",
			GIT_CONFIG_SYSTEM: "/etc/gitconfig",
			GIT_CONFIG_NOSYSTEM: "0",
		};

		await expect(runner.execFile("git.cmd", ["-c", "user.name=Fixture", "status", "--short"], { cwd: repo, env: developerConfig })).resolves.toEqual({ stdout: "clean", stderr: "" });
		expect(runner.execFileSync!("git.bat", ["-ccore.filemode=false", "status", "--short"], {
			cwd: repo,
			env: { ...developerConfig, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.email", GIT_CONFIG_VALUE_0: "fixture@example.test" },
		})).toBe("clean");
		expect(runner.spawn!("git.exe", ["--config-env=core.filemode=FIXTURE_FILEMODE", "status", "--short"], {
			cwd: repo,
			env: { ...developerConfig, FIXTURE_FILEMODE: "false" },
		})).toBe(fakeChild);
		expect(calls).toEqual([
			"async git.cmd -c user.name=Fixture status --short",
			"sync git.bat -ccore.filemode=false status --short",
			"spawn git.exe --config-env=core.filemode=FIXTURE_FILEMODE status --short",
		]);
		const expectedNullConfig = process.platform === "win32" ? "NUL" : os.devNull;
		for (const env of environments) {
			expect(env.GIT_CONFIG).toBeUndefined();
			expect(env.GIT_CONFIG_GLOBAL).toBe(expectedNullConfig);
			expect(env.GIT_CONFIG_SYSTEM).toBe(expectedNullConfig);
			expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
			expect(env[`GIT_CONFIG_KEY_${Number(env.GIT_CONFIG_COUNT) - 1}`]).toBe("credential.helper");
			expect(env[`GIT_CONFIG_VALUE_${Number(env.GIT_CONFIG_COUNT) - 1}`]).toBe("");
		}
		expect(environments[1]).toMatchObject({
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "user.email",
			GIT_CONFIG_VALUE_0: "fixture@example.test",
			GIT_CONFIG_KEY_1: "credential.helper",
			GIT_CONFIG_VALUE_1: "",
		});
		expect(environments[2]?.FIXTURE_FILEMODE).toBe("false");
	});

	it("keeps repository alias/include credential helpers inert through every real delegate path", async () => {
		const root = nativeMkdtempSync(path.join(os.tmpdir(), "bobbit-fenced-real-helper-"));
		const repo = path.join(root, "repo");
		const includePath = path.join(root, "included.gitconfig");
		const helperPath = path.join(root, "marker-helper.cjs");
		const markerPath = path.join(root, "helper-called");
		const nullConfig = process.platform === "win32" ? "NUL" : os.devNull;
		const env = { ...process.env };
		for (const name of Object.keys(env)) {
			if (name.toUpperCase().startsWith("GIT_CONFIG")) delete env[name];
		}
		Object.assign(env, {
			GIT_CONFIG_GLOBAL: nullConfig,
			GIT_CONFIG_SYSTEM: nullConfig,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		});

		const realDelegate = preservedNativeCommandRunner();
		const gitSync = (args: string[]) => realDelegate.execFileSync!("git", args, { cwd: root, env, encoding: "utf8" });
		const slash = (value: string) => value.replaceAll("\\", "/");
		try {
			nativeWriteFileSync(helperPath, [
				'const fs = require("node:fs");',
				'fs.writeFileSync(process.argv[2], "called");',
				"process.stdin.resume();",
			].join("\n"));
			gitSync(["init", repo]);
			gitSync(["config", "--file", includePath, "credential.helper", `!node "${slash(helperPath)}" "${slash(markerPath)}"`]);
			realDelegate.execFileSync!("git", ["config", "include.path", slash(includePath)], { cwd: repo, env, encoding: "utf8" });
			realDelegate.execFileSync!("git", ["config", "alias.nested-creds", "!printf 'protocol=https\\nhost=marker.invalid\\n\\n' | git credential fill"], { cwd: repo, env, encoding: "utf8" });

			// Prove the controlled fixture is live without exposing or returning a credential.
			try { realDelegate.execFileSync!("git", ["nested-creds"], { cwd: repo, env, encoding: "utf8" }); } catch { /* expected: marker helper returns no password */ }
			expect(nativeExistsSync(markerPath)).toBe(true);
			nativeUnlinkSync(markerPath);

			const runner = createFencedCommandRunner(realDelegate);
			await runner.execFile("git", ["nested-creds"], { cwd: repo, env, encoding: "utf8" }).catch(() => undefined);
			expect(nativeExistsSync(markerPath)).toBe(false);

			try { runner.execFileSync!("git", ["nested-creds"], { cwd: repo, env, encoding: "utf8" }); } catch { /* expected: no helper can answer */ }
			expect(nativeExistsSync(markerPath)).toBe(false);

			const child = runner.spawn!("git", ["nested-creds"], { cwd: repo, env, stdio: "ignore" });
			await once(child, "close");
			expect(nativeExistsSync(markerPath)).toBe(false);
		} finally {
			nativeRmSync(root, { recursive: true, force: true });
		}
	});

	it("allows explicit async fakes to stand in for fenced Git credential forms", async () => {
		const response = { stdout: "protocol=https\nhost=git.example.test\n\n" };
		const runner = createFencedCommandRunner(unexpectedDelegate(), {
			fakes: {
				"git credential fill": response,
				"git --no-pager credential fill": response,
				"git -c alias.readcreds=!git credential fill readcreds": response,
			},
		});

		for (const [file, args] of [
			["git", ["credential", "fill"]],
			["git.cmd", ["--no-pager", "credential", "fill"]],
			["git.exe", ["-c", "alias.readcreds=!git credential fill", "readcreds"]],
		] as const) {
			await expect(runner.execFile(file, args)).resolves.toEqual({
				stdout: response.stdout,
				stderr: "",
			});
		}
	});

	it("short-circuits read-only discovery outside repositories without delegating or mutating git", async () => {
		const cwd = makeFixtureRoot("bobbit-fenced-nonrepo-");
		let asyncDelegations = 0;
		let syncDelegations = 0;
		const delegate: CommandRunner = {
			execFile: async () => {
				asyncDelegations++;
				throw new Error("delegated async command");
			},
			execFileSync: () => {
				syncDelegations++;
				throw new Error("delegated sync command");
			},
		};
		const runner = createFencedCommandRunner(delegate);

		for (const args of [
			["rev-parse", "--is-inside-work-tree"],
			["symbolic-ref", "refs/remotes/origin/HEAD"],
			["remote", "get-url", "origin"],
			["for-each-ref", "--format=%(refname)", "refs/heads"],
		]) {
			await expect(runner.execFile("git", args, { cwd })).rejects.toThrow(/skipped read-only git .* non-repository cwd/);
		}
		expect(() => runner.execFileSync!("git", ["status", "--short"], { cwd })).toThrow(/skipped read-only git status/);
		expect(asyncDelegations).toBe(0);
		expect(syncDelegations).toBe(0);
		expect(memoryFs.existsSync(path.join(cwd, ".git"))).toBe(false);

		await expect(runner.execFile("git", ["init"], { cwd })).rejects.toThrow("delegated async command");
		expect(asyncDelegations).toBe(1);
		expect(memoryFs.existsSync(path.join(cwd, ".git"))).toBe(false);
	});

	it("threads injected runners through worktree and verification branch discovery", async () => {
		const cwd = makeFixtureRoot("bobbit-runner-threading-");
		const stateDir = path.join(cwd, "state");
		memoryFs.mkdirSync(stateDir);
		const calls: string[] = [];
		const runner: CommandRunner = {
			execFile: async (file, args) => {
				expect(file).toBe("git");
				calls.push(args.join(" "));
				if (args[0] === "symbolic-ref") return { stdout: "refs/remotes/origin/trunk\n", stderr: "" };
				if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "" };
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${cwd}\n`, stderr: "" };
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return { stdout: "a".repeat(40), stderr: "" };
				throw new Error(`unexpected git call: ${args.join(" ")}`);
			},
		};

		const support = await resolveWorktreeSupport([], cwd, cwd, undefined, { commandRunner: runner });
		expect(support).toEqual({ supported: true, repoPath: cwd, multiRepo: false });
		expect(calls).toContain("rev-parse --is-inside-work-tree");
		expect(calls).toContain("rev-parse --show-toplevel");
		expect(calls).toContain("rev-parse --verify HEAD");

		const projectConfigStore = { get: () => "", getWithDefaults: () => ({}), getComponents: () => [] };
		const harness = new VerificationHarness(
			stateDir,
			undefined,
			() => {},
			{ get: () => undefined, getAll: () => [] } as any,
			undefined,
			undefined,
			undefined,
			projectConfigStore as any,
			undefined,
			undefined,
			{ commandRunner: runner },
		) as any;
		expect(await harness.resolveVerificationBaseBranch("goal", cwd)).toBe("trunk");
		expect(await harness.resolveLegacyMasterBranch(cwd)).toBe("trunk");
		expect(calls.filter(call => call === "symbolic-ref refs/remotes/origin/HEAD")).toHaveLength(2);
	});

	it("allows local git and local bare remotes", async () => {
		const { repo, bare } = makeRepositoryMetadata(makeFixtureRoot("bobbit-fenced-git-"));
		const calls: string[] = [];
		const delegate: CommandRunner = {
			execFile: async (file, args) => {
				calls.push(`${file} ${args.join(" ")}`);
				if (args[0] === "rev-parse") return { stdout: "a".repeat(40), stderr: "" };
				if (args[0] === "push") return { stdout: "pushed", stderr: "" };
				throw new Error(`unexpected delegation: ${file} ${args.join(" ")}`);
			},
		};
		const runner = createFencedCommandRunner(delegate);
		const rev = await runner.execFile("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" });
		expect(String(rev.stdout).trim()).toMatch(/^[0-9a-f]{40}$/);

		const fileRemote = pathToFileURL(bare).href;
		await expect(runner.execFile("git", ["push", fileRemote, "HEAD:refs/heads/test"], { cwd: repo, encoding: "utf-8" })).resolves.toEqual({ stdout: "pushed", stderr: "" });
		expect(calls).toEqual([
			"git rev-parse HEAD",
			`git push ${fileRemote} HEAD:refs/heads/test`,
		]);
	});

	it("applies remote fencing to sync and spawn paths", () => {
		const { repo, bare } = makeRepositoryMetadata(makeFixtureRoot("bobbit-fenced-sync-spawn-"));
		const fakeChild = { pid: 1234 };
		const syncCalls: string[] = [];
		const spawnCalls: string[] = [];
		const delegate: CommandRunner = {
			execFile: async () => ({ stdout: "", stderr: "" }),
			execFileSync: (file, args) => {
				syncCalls.push(`${file} ${args.join(" ")}`);
				return "local-ref\n";
			},
			spawn: (file, args) => {
				spawnCalls.push(`${file} ${args.join(" ")}`);
				return fakeChild as any;
			},
		};
		const runner = createFencedCommandRunner(delegate);
		for (const args of [
			["fetch", "https://github.com/example/repo.git"],
			["clone", "https://github.com/example/repo.git", path.join(repo, "clone")],
			["push", "https://github.com/example/repo.git", "HEAD"],
			["--no-pager", "push", "https://github.com/example/repo.git", "HEAD"],
		]) {
			expect(() => runner.execFileSync!("git", args, { cwd: repo })).toThrow(/blocked git/);
			expect(() => runner.spawn!("git", args, { cwd: repo })).toThrow(/blocked git/);
		}
		expect(syncCalls).toEqual([]);
		expect(spawnCalls).toEqual([]);

		const fileRemote = pathToFileURL(bare).href;
		expect(runner.execFileSync!("git", ["ls-remote", fileRemote], { cwd: repo, encoding: "utf-8" })).toBe("local-ref\n");
		expect(runner.spawn!("git", ["ls-remote", fileRemote], { cwd: repo, stdio: "ignore" })).toBe(fakeChild);
		expect(syncCalls).toEqual([`git ls-remote ${fileRemote}`]);
		expect(spawnCalls).toEqual([`git ls-remote ${fileRemote}`]);
	});
});
