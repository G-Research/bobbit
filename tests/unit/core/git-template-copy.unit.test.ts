import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	commitInitialFixture,
	copyGitTemplate,
	createGitTemplateEnvironment,
	GIT_TEMPLATE_DIGEST_ENV,
	GIT_TEMPLATE_PATH_ENV,
	prepareGitTemplate,
	readGitTemplateBootstrapAudit,
	type GitTemplateCommandRunner,
} from "../../../tests/support/harnesses/shared/git-template.js";
import {
	cleanupOwnedRunRoot,
	getRunRoot,
	isRunRootOwner,
	RUN_ROOT_OWNER_ENV,
} from "../../../tests/support/harnesses/shared/run-isolation.js";

const root = mkdtempSync(join(tmpdir(), "bb-git-template-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function inheritedDescriptor() {
	return {
		mode: "adopt" as const,
		path: process.env[GIT_TEMPLATE_PATH_ENV],
		expectedDigest: process.env[GIT_TEMPLATE_DIGEST_ENV],
	};
}

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

	it("reuses the coordinator repository and digest prepared before the spawn guard", async () => {
		const first = await prepareGitTemplate(inheritedDescriptor());
		const second = await prepareGitTemplate(inheritedDescriptor());
		expect(second).toEqual(first);
		expect(first.path).toBe(process.env[GIT_TEMPLATE_PATH_ENV]);
		expect(first.digest).toBe(process.env[GIT_TEMPLATE_DIGEST_ENV]);
		expect(readFileSync(join(first.path, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/master");
		const config = readFileSync(join(first.path, ".git", "config"), "utf8");
		expect(config).toMatch(/name = Bobbit Test/);
		expect(config).toMatch(/email = bobbit-test@example\.invalid/);
		expect(config).toMatch(/autocrlf = false/);
		// These local settings prevent the commit that built the template and Git
		// commands in its copies from starting automatic maintenance. In particular,
		// no background process may briefly add .git/objects/maintenance.lock after
		// the immutable tree has been hashed.
		expect(config).toMatch(/\[maintenance\][\s\S]*?auto = false/);
		expect(config).toMatch(/\[gc\][\s\S]*?auto = 0/);
		expect(readFileSync(join(first.path, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
	});

	it("records exactly one ten-command coordinator bootstrap and denies worker cleanup ownership", async () => {
		const descriptor = await prepareGitTemplate(inheritedDescriptor());
		const audit = readGitTemplateBootstrapAudit(descriptor);

		expect(audit.ownerPid).toBe(Number(process.env[RUN_ROOT_OWNER_ENV]));
		expect(audit.ownerPid).not.toBe(process.pid);
		expect(audit.commands).toEqual([
			["-c", "init.defaultBranch=master", "init", "--quiet", descriptor.path],
			["config", "user.name", "Bobbit Test"],
			["config", "user.email", "bobbit-test@example.invalid"],
			["config", "core.autocrlf", "false"],
			["config", "commit.gpgsign", "false"],
			["config", "maintenance.auto", "false"],
			["config", "gc.auto", "0"],
			["config", "core.hooksPath", join(descriptor.path, ".git", "hooks-disabled")],
			["add", "--", "README.md", ".gitattributes"],
			["commit", "--quiet", "-m", "Initial fixture"],
		]);
		expect(isRunRootOwner()).toBe(false);
		expect(cleanupOwnedRunRoot()).toBe(false);
		expect(existsSync(getRunRoot())).toBe(true);
		expect(existsSync(descriptor.path)).toBe(true);
	});

	it("fails closed on worker creation and missing, mismatched, escaped, or partial handoff", async () => {
		const inherited = inheritedDescriptor();
		await expect(prepareGitTemplate({ mode: "create" }))
			.rejects.toThrow(/creation is coordinator-only/);
		await expect(prepareGitTemplate({ ...inherited, path: undefined }))
			.rejects.toThrow(new RegExp(`missing ${GIT_TEMPLATE_PATH_ENV}`));
		await expect(prepareGitTemplate({ ...inherited, expectedDigest: undefined }))
			.rejects.toThrow(new RegExp(`missing ${GIT_TEMPLATE_DIGEST_ENV}`));
		await expect(prepareGitTemplate({ ...inherited, expectedDigest: "0".repeat(64) }))
			.rejects.toThrow(/digest does not match/);
		await expect(prepareGitTemplate({
			...inherited,
			path: join(root, "..", "..", "..", `escaped-git-template-${process.pid}`),
		}))
			.rejects.toThrow(/owned descendant of the run root/);
		const invalidRoot = join(getRunRoot(), `git-template-invalid-${process.pid}`);
		await expect(prepareGitTemplate({ ...inherited, path: join(invalidRoot, "missing") }))
			.rejects.toThrow(/missing or incomplete/);

		const partial = join(invalidRoot, "partial");
		mkdirSync(join(partial, ".git"), { recursive: true });
		writeFileSync(join(partial, "README.md"), "# Bobbit test repository\n", "utf8");
		await expect(prepareGitTemplate({ ...inherited, path: partial }))
			.rejects.toThrow(/missing or incomplete|missing or invalid/);
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
		const source = await prepareGitTemplate(inheritedDescriptor());
		const copies = ["one", "two", "three"].map(name => copyGitTemplate(join(root, name)));
		writeFileSync(join(copies[0], "README.md"), "changed\n", "utf8");
		writeFileSync(join(copies[1], ".git", "copy-is-writable"), "worker-local\n", "utf8");

		expect(readFileSync(join(copies[0], "README.md"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(copies[1], "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(copies[2], "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(source.path, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(copies[2], ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/master");
	});

	it("rejects arbitrary template mutations rather than filtering hash changes", async () => {
		const source = await prepareGitTemplate(inheritedDescriptor());
		const unexpected = join(source.path, ".git", "objects", "unexpected-template-state");
		writeFileSync(unexpected, "must not be ignored", "utf8");
		try {
			expect(() => copyGitTemplate(join(root, "rejected-mutation"))).toThrow(/immutable template was modified/);
		} finally {
			rmSync(unexpected, { force: true });
		}
		expect(() => copyGitTemplate(join(root, "restored-source"))).not.toThrow();
	});

	it("refuses to merge a template into a non-empty destination", async () => {
		await prepareGitTemplate(inheritedDescriptor());
		const occupied = join(root, "occupied");
		writeFileSync(occupied, "occupied", "utf8");
		expect(() => copyGitTemplate(occupied)).toThrow(/destination must be an empty directory or absent/);
	});
});
