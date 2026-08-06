import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { astGrepAvailable, createAstGrepExtension } from "../../market-packs/code-intelligence/tools/ast/extension.ts";
import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.ts";
import { createRunChild, removeOwnedRunChild } from "../harness/run-isolation.ts";
import { runFixtureCommand } from "../harness/spawn-with-retry.ts";

interface RegisteredTool {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<any>;
}

let root = "";
let repository = "";
let worktree = "";
let registered: RegisteredTool | undefined;
const previousCwd = process.env.BOBBIT_CWD;
const previousAstGrepPath = process.env.BOBBIT_AST_GREP_PATH;
const AST_GREP_VERSION = "0.39.5";
const STATIC_AST_GREP_BINARY = path.resolve(
	import.meta.dirname,
	"..",
	"..",
	"node_modules",
	".bin",
	process.platform === "win32" ? "ast-grep.cmd" : "ast-grep",
);
let verifiedAstGrepPath = "";

async function git(args: string[], cwd: string): Promise<string> {
	return (await runFixtureCommand("git", args, { cwd })).stdout;
}

beforeAll(async () => {
	expect(existsSync(STATIC_AST_GREP_BINARY), "the pinned @ast-grep/cli devDependency must provide its static test binary").toBe(true);
	const version = spawnSync(STATIC_AST_GREP_BINARY, ["--version"], { encoding: "utf8", shell: false });
	expect(version.status, "the pinned @ast-grep/cli test binary must execute").toBe(0);
	expect(`${version.stdout}${version.stderr}`).toContain(AST_GREP_VERSION);
	verifiedAstGrepPath = STATIC_AST_GREP_BINARY;
	process.env.BOBBIT_AST_GREP_PATH = verifiedAstGrepPath;

	await prepareGitTemplate();
	root = createRunChild("ast-grep-worktree");
	repository = copyGitTemplate(path.join(root, "source"));
	mkdirSync(path.join(repository, "src"), { recursive: true });
	writeFileSync(path.join(repository, "src", "app.ts"), 'console.log("typescript");\n');
	writeFileSync(path.join(repository, "src", "tool.py"), 'print("python")\n');
	await git(["add", "--", "src"], repository);
	await git(["commit", "--quiet", "-m", "Add structural-search fixture"], repository);
	worktree = path.join(root, "linked-worktree");
	await git(["worktree", "add", "--quiet", "-b", "test/ast-grep", worktree, "master"], repository);

	process.env.BOBBIT_CWD = worktree;
	const tools: RegisteredTool[] = [];
	createAstGrepExtension()({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as any);
	registered = tools.find(tool => tool.name === "ast_grep");
});

afterAll(async () => {
	try {
		if (repository && worktree) await git(["worktree", "remove", "--force", worktree], repository);
	} finally {
		if (previousCwd === undefined) delete process.env.BOBBIT_CWD;
		else process.env.BOBBIT_CWD = previousCwd;
		if (previousAstGrepPath === undefined) delete process.env.BOBBIT_AST_GREP_PATH;
		else process.env.BOBBIT_AST_GREP_PATH = previousAstGrepPath;
		if (root) removeOwnedRunChild(root);
	}
});

describe("code-intelligence ast_grep pack in a real linked worktree", () => {
	it("treats a --follow path as data and never discloses an external symlink target", async () => {
		const optionNamedPath = path.join(worktree, "--follow");
		const externalDirectory = path.join(root, "external-secret");
		try {
			mkdirSync(optionNamedPath);
			writeFileSync(path.join(optionNamedPath, "fixture.ts"), 'console.log("in-worktree");\n');
			mkdirSync(externalDirectory);
			writeFileSync(path.join(externalDirectory, "secret.ts"), 'console.log("outside-only-secret");\n');
			symlinkSync(externalDirectory, path.join(optionNamedPath, "leak"), process.platform === "win32" ? "junction" : "dir");

			const result = await registered!.execute("ast-option-boundary", {
				paths: ["--follow"],
				pattern: "console.log($$$ARGS)",
				language: "typescript",
			}, new AbortController().signal);
			expect(result.isError).not.toBe(true);
			expect(result.details.matches).toEqual(expect.arrayContaining([
				expect.objectContaining({ file: "--follow/fixture.ts", text: 'console.log("in-worktree")' }),
			]));
			expect(JSON.stringify(result.details)).not.toContain("outside-only-secret");
			expect(JSON.stringify(result.details)).not.toContain(externalDirectory);
		} finally {
			rmSync(optionNamedPath, { recursive: true, force: true });
			rmSync(externalDirectory, { recursive: true, force: true });
		}
		expect((await git(["status", "--porcelain", "--untracked-files=all"], worktree)).trim()).toBe("");
	});

	it("registers and executes the pack tool against TypeScript and Python without checkout output", async () => {
		expect(astGrepAvailable(worktree, verifiedAstGrepPath), "the pinned ast-grep test binary must activate the pack tool").toBe(true);
		expect(registered, "the activated market pack must register ast_grep").toBeTruthy();

		const typescript = await registered!.execute("ast-ts", {
			paths: ["src/app.ts"],
			pattern: "console.log($$$ARGS)",
			language: "TypeScript",
			strictness: "ast",
		}, new AbortController().signal);
		expect(typescript.isError).not.toBe(true);
		expect(typescript.details).toMatchObject({ languages: ["typescript"], matchCount: 1 });
		expect(typescript.details.matches).toEqual(expect.arrayContaining([
			expect.objectContaining({ file: "src/app.ts", line: 1, text: 'console.log("typescript")' }),
		]));

		const python = await registered!.execute("ast-python", {
			paths: ["src/tool.py"],
			pattern: "print($$$ARGS)",
			language: "python",
			strictness: "smart",
		}, new AbortController().signal);
		expect(python.isError).not.toBe(true);
		expect(python.details).toMatchObject({ languages: ["python"], matchCount: 1 });
		expect(python.details.matches).toEqual(expect.arrayContaining([
			expect.objectContaining({ file: "src/tool.py", line: 1 }),
		]));
		expect((await git(["status", "--porcelain", "--untracked-files=all"], worktree)).trim()).toBe("");
	});
});
