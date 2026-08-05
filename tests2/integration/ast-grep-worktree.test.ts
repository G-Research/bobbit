import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getSgResolution } from "../../src/server/binaries.ts";
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
let verifiedAstGrepPath: string | undefined;
let availabilitySkip = "";

async function git(args: string[], cwd: string): Promise<string> {
	return (await runFixtureCommand("git", args, { cwd })).stdout;
}

beforeAll(async () => {
	const resolution = getSgResolution();
	if (resolution.source !== "bundled" || !resolution.path) {
		availabilitySkip = `requires a resolver-verified bundled ast-grep; got ${resolution.source} (${resolution.path ?? "none"})`;
		console.warn(`[ast-grep-worktree] skipped: ${availabilitySkip}`);
		return;
	}
	verifiedAstGrepPath = resolution.path;
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
	it("registers and executes the pack tool against TypeScript and Python without checkout output", async (context) => {
		if (!verifiedAstGrepPath) return context.skip(availabilitySkip);
		expect(astGrepAvailable(worktree, verifiedAstGrepPath), "the resolver-verified ast-grep binary must activate the pack tool").toBe(true);
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
