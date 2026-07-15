import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { realCommandRunner, type CommandRunner } from "../../src/server/gateway-deps.js";
import { resolveWorktreeSupport } from "../../src/server/agent/worktree-support.js";
import { VerificationHarness } from "../../src/server/agent/verification-harness.js";
import { createFencedCommandRunner } from "../harness/fenced-command-runner.js";

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

describe("fenced command runner", () => {
	it("rejects network and host-control commands", async () => {
		const runner = createFencedCommandRunner(realCommandRunner);
		await expect(runner.execFile("git", ["push", "https://github.com/example/repo.git", "HEAD"])).rejects.toThrow(/blocked git push/);
		await expect(runner.execFile("gh", ["pr", "list"])).rejects.toThrow(/blocked gh/);
		await expect(runner.execFile("docker", ["ps"])).rejects.toThrow(/blocked docker/);
	});

	it("short-circuits read-only discovery outside repositories without delegating or mutating git", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-fenced-nonrepo-"));
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
		expect(fs.existsSync(path.join(cwd, ".git"))).toBe(false);

		await expect(runner.execFile("git", ["init"], { cwd })).rejects.toThrow("delegated async command");
		expect(asyncDelegations).toBe(1);
		expect(fs.existsSync(path.join(cwd, ".git"))).toBe(false);
	});

	it("threads injected runners through worktree and verification branch discovery", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-runner-threading-"));
		const stateDir = path.join(cwd, "state");
		fs.mkdirSync(stateDir);
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
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-fenced-git-"));
		const repo = path.join(root, "repo");
		const bare = path.join(root, "bare.git");
		fs.mkdirSync(repo);
		git(["init"], repo);
		git(["config", "user.email", "test@example.invalid"], repo);
		git(["config", "user.name", "Test"], repo);
		git(["commit", "--allow-empty", "-m", "initial"], repo);
		execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });

		const runner = createFencedCommandRunner(realCommandRunner);
		const rev = await runner.execFile("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" });
		expect(String(rev.stdout).trim()).toMatch(/^[0-9a-f]{40}$/);
		await expect(runner.execFile("git", ["push", pathToFileURL(bare).href, "HEAD:refs/heads/test"], { cwd: repo, encoding: "utf-8" })).resolves.toBeTruthy();
	});

	it("applies remote fencing to sync and spawn paths", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-fenced-sync-spawn-"));
		const repo = path.join(root, "repo");
		const bare = path.join(root, "bare.git");
		fs.mkdirSync(repo);
		git(["init"], repo);
		git(["config", "user.email", "test@example.invalid"], repo);
		git(["config", "user.name", "Test"], repo);
		git(["commit", "--allow-empty", "-m", "initial"], repo);
		execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });

		const runner = createFencedCommandRunner(realCommandRunner);
		for (const args of [
			["fetch", "https://github.com/example/repo.git"],
			["clone", "https://github.com/example/repo.git", path.join(root, "clone")],
			["push", "https://github.com/example/repo.git", "HEAD"],
		]) {
			expect(() => runner.execFileSync!("git", args, { cwd: repo })).toThrow(/blocked git/);
			expect(() => runner.spawn!("git", args, { cwd: repo })).toThrow(/blocked git/);
		}

		const fileRemote = pathToFileURL(bare).href;
		expect(() => runner.execFileSync!("git", ["ls-remote", fileRemote], { cwd: repo, encoding: "utf-8" })).not.toThrow();
		const child = runner.spawn!("git", ["ls-remote", fileRemote], { cwd: repo, stdio: "ignore" });
		await expect(waitForExit(child)).resolves.toBe(0);
	});
});
