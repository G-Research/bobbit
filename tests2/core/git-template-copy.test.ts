import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
	commitInitialFixture,
	copyGitTemplate,
	GIT_TEMPLATE_NORMAL_PROCESS_PLAN,
	prepareGitTemplate,
	type GitTemplateCommandRunner,
} from "../harness/git-template.js";

const root = mkdtempSync(join(tmpdir(), "bb-git-template-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface GitObject {
	type: string;
	content: Buffer;
}

function headCommit(repository: string): string {
	const commit = readFileSync(join(repository, ".git", "refs", "heads", "master"), "utf8").trim();
	expect(commit).toMatch(/^[0-9a-f]{40}$/);
	return commit;
}

function readLooseObject(repository: string, oid: string): GitObject {
	const objectPath = join(repository, ".git", "objects", oid.slice(0, 2), oid.slice(2));
	expect(existsSync(objectPath), `expected loose Git object ${oid}`).toBe(true);
	const raw = inflateSync(readFileSync(objectPath));
	expect(createHash("sha1").update(raw).digest("hex")).toBe(oid);
	const separator = raw.indexOf(0);
	expect(separator).toBeGreaterThan(0);
	const [type, size] = raw.subarray(0, separator).toString("utf8").split(" ");
	const content = raw.subarray(separator + 1);
	expect(Number(size)).toBe(content.length);
	return { type: type!, content };
}

function readTree(repository: string, oid: string): Array<{ mode: string; name: string; oid: string }> {
	const tree = readLooseObject(repository, oid);
	expect(tree.type).toBe("tree");
	const entries: Array<{ mode: string; name: string; oid: string }> = [];
	let cursor = 0;
	while (cursor < tree.content.length) {
		const modeEnd = tree.content.indexOf(0x20, cursor);
		const nameEnd = tree.content.indexOf(0, modeEnd + 1);
		expect(modeEnd).toBeGreaterThan(cursor);
		expect(nameEnd).toBeGreaterThan(modeEnd);
		entries.push({
			mode: tree.content.subarray(cursor, modeEnd).toString("utf8"),
			name: tree.content.subarray(modeEnd + 1, nameEnd).toString("utf8"),
			oid: tree.content.subarray(nameEnd + 1, nameEnd + 21).toString("hex"),
		});
		cursor = nameEnd + 21;
	}
	return entries;
}

function assertValidIndex(repository: string): Buffer {
	const index = readFileSync(join(repository, ".git", "index"));
	expect(index.subarray(0, 4).toString("ascii")).toBe("DIRC");
	expect(index.readUInt32BE(4)).toBe(2);
	expect(index.readUInt32BE(8)).toBe(2);
	expect(index.includes(Buffer.from(".gitattributes\0"))).toBe(true);
	expect(index.includes(Buffer.from("README.md\0"))).toBe(true);
	const body = index.subarray(0, -20);
	expect(index.subarray(-20).toString("hex")).toBe(createHash("sha1").update(body).digest("hex"));
	return index;
}

describe("setup-prepared git template", () => {
	it("uses a three-process normal bootstrap with no git add/config/commit subprocess", () => {
		expect(GIT_TEMPLATE_NORMAL_PROCESS_PLAN.map(command => command.phase)).toEqual(["initialize", "import", "index"]);
		expect(GIT_TEMPLATE_NORMAL_PROCESS_PLAN).toHaveLength(3);
		expect(GIT_TEMPLATE_NORMAL_PROCESS_PLAN.every(command => command.file === "git")).toBe(true);
		const subcommands = GIT_TEMPLATE_NORMAL_PROCESS_PLAN.flatMap(command => [...command.args]);
		expect(subcommands).not.toContain("add");
		expect(subcommands).not.toContain("config");
		expect(subcommands).not.toContain("commit");
	});

	it("reuses the configured master repository prepared before the spawn guard", async () => {
		const first = await prepareGitTemplate();
		const second = await prepareGitTemplate();
		expect(second).toBe(first);
		expect(readFileSync(join(first, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/master\n");

		const config = readFileSync(join(first, ".git", "config"), "utf8");
		expect(config).toMatch(/repositoryformatversion = 0/);
		expect(config).toMatch(/bare = false/);
		expect(config).toMatch(/logallrefupdates = true/);
		expect(config).toMatch(/name = Bobbit Test/);
		expect(config).toMatch(/email = bobbit-test@example\.invalid/);
		expect(config).toMatch(/autocrlf = false/);
		expect(config).toMatch(/gpgsign = false/);
		const hooksValue = config.match(/^\s*hooksPath = (.+)$/m)?.[1];
		expect(hooksValue).toBeDefined();
		const hooksPath = JSON.parse(hooksValue!) as string;
		expect(realpathSync(hooksPath)).toBe(realpathSync(join(first, ".git", "hooks-disabled")));
		expect(readdirSync(hooksPath)).toEqual([]);

		// These local settings prevent both bootstrap and copied repositories from
		// starting automatic maintenance after the immutable tree has been hashed.
		expect(config).toMatch(/\[maintenance\][\s\S]*?auto = false/);
		expect(config).toMatch(/\[gc\][\s\S]*?auto = 0/);
		expect(readFileSync(join(first, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(first, ".gitattributes"), "utf8")).toBe("* text=auto eol=lf\n");

		const commit = readLooseObject(first, headCommit(first));
		expect(commit.type).toBe("commit");
		const commitText = commit.content.toString("utf8");
		expect(commitText).toMatch(/^tree [0-9a-f]{40}$/m);
		expect(commitText).toContain("author Bobbit Test <bobbit-test@example.invalid> 946684800 +0000\n");
		expect(commitText).toContain("committer Bobbit Test <bobbit-test@example.invalid> 946684800 +0000\n");
		expect(commitText).toMatch(/\n\nInitial fixture\n$/);
		const treeOid = commitText.match(/^tree ([0-9a-f]{40})$/m)![1]!;
		const tree = readTree(first, treeOid);
		expect(tree.map(({ mode, name }) => ({ mode, name }))).toEqual([
			{ mode: "100644", name: ".gitattributes" },
			{ mode: "100644", name: "README.md" },
		]);
		expect(readLooseObject(first, tree[0]!.oid)).toMatchObject({ type: "blob", content: Buffer.from("* text=auto eol=lf\n") });
		expect(readLooseObject(first, tree[1]!.oid)).toMatchObject({ type: "blob", content: Buffer.from("# Bobbit test repository\n") });
		assertValidIndex(first);
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
		const sourceCommit = headCommit(source);
		const sourceIndex = assertValidIndex(source);
		const copyOne = copyGitTemplate(join(root, "one"));
		writeFileSync(join(copyOne, "README.md"), "changed\n", "utf8");
		const copyTwo = copyGitTemplate(join(root, "two"));

		expect(readFileSync(join(copyOne, "README.md"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(copyTwo, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(source, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(copyTwo, ".gitattributes"), "utf8")).toBe("* text=auto eol=lf\n");
		expect(readFileSync(join(copyTwo, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/master\n");
		expect(headCommit(copyOne)).toBe(sourceCommit);
		expect(headCommit(copyTwo)).toBe(sourceCommit);
		expect(assertValidIndex(copyTwo)).toEqual(sourceIndex);
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
