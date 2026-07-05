import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createFencedCommandRunner } from "../harness/fenced-command-runner.js";

function git(args: string[], cwd: string): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("fenced command runner", () => {
	it("rejects network and host-control commands", async () => {
		const runner = createFencedCommandRunner();
		await expect(runner.execFile("git", ["push", "https://github.com/example/repo.git", "HEAD"])).rejects.toThrow(/blocked git push/);
		await expect(runner.execFile("gh", ["pr", "list"])).rejects.toThrow(/blocked gh/);
		await expect(runner.execFile("docker", ["ps"])).rejects.toThrow(/blocked docker/);
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

		const runner = createFencedCommandRunner();
		const rev = await runner.execFile("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" });
		expect(String(rev.stdout).trim()).toMatch(/^[0-9a-f]{40}$/);
		await expect(runner.execFile("git", ["push", pathToFileURL(bare).href, "HEAD:refs/heads/test"], { cwd: repo, encoding: "utf-8" })).resolves.toBeTruthy();
	});
});
