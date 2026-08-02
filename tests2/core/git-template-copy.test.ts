import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	commitInitialFixture,
	copyGitTemplate,
	createGitTemplateEnvironment,
	prepareGitTemplate,
	type GitTemplateCommandRunner,
} from "../harness/git-template.js";

const root = mkdtempSync(join(tmpdir(), "bb-git-template-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("setup-prepared git template", () => {
	it("removes inherited Git repository state before fixture bootstrap", () => {
		const home = join(root, "isolated-home");
		const env = createGitTemplateEnvironment(home, {
			PATH: "fixture-path",
			GIT_DIR: "/shared/repository/.git",
			GIT_WORK_TREE: "/shared/repository",
			GIT_COMMON_DIR: "/shared/repository/.git",
			GIT_INDEX_FILE: "/shared/repository/.git/index",
			GIT_OBJECT_DIRECTORY: "/shared/repository/.git/objects",
			GIT_CONFIG_COUNT: "1",
			git_alternate_object_directories: "/shared/objects",
		});

		expect(env.PATH).toBe("fixture-path");
		expect(Object.keys(env).filter(name => name.toUpperCase().startsWith("GIT_"))).toEqual([
			"GIT_CONFIG_NOSYSTEM",
			"GIT_CONFIG_GLOBAL",
			"GIT_TERMINAL_PROMPT",
			"GIT_ASKPASS",
			"GIT_EDITOR",
		]);
		expect(env.GIT_CONFIG_GLOBAL).toBe(join(home, "gitconfig"));
	});

	it("reuses the configured master repository prepared before the spawn guard", async () => {
		const first = await prepareGitTemplate();
		const second = await prepareGitTemplate();
		expect(second).toBe(first);
		expect(readFileSync(join(first, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/master");
		const config = readFileSync(join(first, ".git", "config"), "utf8");
		expect(config).toMatch(/name = Bobbit Test/);
		expect(config).toMatch(/email = bobbit-test@example\.invalid/);
		expect(config).toMatch(/autocrlf = false/);
		// These local settings prevent the commit that built the template and Git
		// commands in its copies from starting automatic maintenance. In particular,
		// no background process may briefly add .git/objects/maintenance.lock after
		// the immutable tree has been hashed.
		expect(config).toMatch(/\[maintenance\][\s\S]*?auto = false/);
		expect(config).toMatch(/\[gc\][\s\S]*?auto = 0/);
		expect(readFileSync(join(first, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
	});

	it("recovers an ambiguous initial-commit failure without retrying a landed commit", async () => {
		const calls: string[][] = [];
		const runner: GitTemplateCommandRunner = async (args) => {
			calls.push(args);
			switch (args.join(" ")) {
				case "commit --quiet -m Initial fixture":
					throw new Error("Windows close reported failure after commit");
				case "rev-parse --verify HEAD^{commit}":
					return { stdout: "fixture-head\n", stderr: "", attempts: 1, exitCode: 0 };
				case "show HEAD:README.md":
					return { stdout: "# Bobbit test repository\n", stderr: "", attempts: 1, exitCode: 0 };
				case "show HEAD:.gitattributes":
					return { stdout: "* text=auto eol=lf\n", stderr: "", attempts: 1, exitCode: 0 };
				case "diff --quiet --cached HEAD --":
				case "diff --quiet HEAD --":
					return { stdout: "", stderr: "", attempts: 1, exitCode: 0 };
				case "status --porcelain --untracked-files=all":
					return { stdout: "", stderr: "", attempts: 1, exitCode: 0 };
				default:
					throw new Error(`unexpected command: ${args.join(" ")}`);
			}
		};

		await expect(commitInitialFixture(runner, "/fixture/repo")).resolves.toBeUndefined();
		expect(calls.filter(args => args[0] === "commit")).toHaveLength(1);
		expect(calls).toEqual([
			["commit", "--quiet", "-m", "Initial fixture"],
			["rev-parse", "--verify", "HEAD^{commit}"],
			["show", "HEAD:README.md"],
			["show", "HEAD:.gitattributes"],
			["diff", "--quiet", "--cached", "HEAD", "--"],
			["diff", "--quiet", "HEAD", "--"],
			["status", "--porcelain", "--untracked-files=all"],
		]);
	});

	it("retries the initial commit only when the failure probe finds no commit", async () => {
		let commitAttempts = 0;
		const runner: GitTemplateCommandRunner = async (args) => {
			if (args[0] === "commit") {
				commitAttempts++;
				if (commitAttempts === 1) throw new Error("commit did not start");
				return { stdout: "", stderr: "", attempts: 1, exitCode: 0 };
			}
			if (args.join(" ") === "rev-parse --verify HEAD^{commit}") {
				throw new Error("HEAD is unborn");
			}
			throw new Error(`unexpected command: ${args.join(" ")}`);
		};

		await expect(commitInitialFixture(runner, "/fixture/repo")).resolves.toBeUndefined();
		expect(commitAttempts).toBe(2);
	});

	it("does not retry when a failed commit already left an unexpected HEAD", async () => {
		let commitAttempts = 0;
		const runner: GitTemplateCommandRunner = async (args) => {
			if (args[0] === "commit") {
				commitAttempts++;
				throw new Error("Windows close reported failure after commit");
			}
			if (args.join(" ") === "rev-parse --verify HEAD^{commit}") {
				return { stdout: "fixture-head\\n", stderr: "", attempts: 1, exitCode: 0 };
			}
			if (args.join(" ") === "show HEAD:README.md") {
				return { stdout: "unexpected fixture\\n", stderr: "", attempts: 1, exitCode: 0 };
			}
			throw new Error(`unexpected command: ${args.join(" ")}`);
		};

		await expect(commitInitialFixture(runner, "/fixture/repo"))
			.rejects.toThrow(/unexpected repository state/);
		expect(commitAttempts).toBe(1);
	});

	it("creates independent writable copies without modifying the source", async () => {
		const source = await prepareGitTemplate();
		const copyOne = copyGitTemplate(join(root, "one"));
		writeFileSync(join(copyOne, "README.md"), "changed\n", "utf8");
		const copyTwo = copyGitTemplate(join(root, "two"));

		expect(readFileSync(join(copyOne, "README.md"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(copyTwo, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(source, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(copyTwo, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/master");
	});

	it("rejects arbitrary template mutations rather than filtering hash changes", async () => {
		const source = await prepareGitTemplate();
		const unexpected = join(source, ".git", "objects", "unexpected-template-state");
		writeFileSync(unexpected, "must not be ignored", "utf8");
		try {
			expect(() => copyGitTemplate(join(root, "rejected-mutation"))).toThrow(/immutable template was modified/);
		} finally {
			rmSync(unexpected, { force: true });
		}
		expect(() => copyGitTemplate(join(root, "restored-source"))).not.toThrow();
	});

	it("refuses to merge a template into a non-empty destination", async () => {
		await prepareGitTemplate();
		const occupied = join(root, "occupied");
		writeFileSync(occupied, "occupied", "utf8");
		expect(() => copyGitTemplate(occupied)).toThrow(/destination must be an empty directory or absent/);
	});
});
