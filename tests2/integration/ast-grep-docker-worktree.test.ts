import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectSandbox } from "../../src/server/agent/project-sandbox.ts";
import { ensureImageAgentVersion } from "../../src/server/agent/sandbox-status.ts";
import { isDockerSandboxAvailable } from "../../tests/e2e/test-utils/docker.ts";
import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.ts";
import { createRunChild, removeOwnedRunChild } from "../harness/run-isolation.ts";
import { runFixtureCommand } from "../harness/spawn-with-retry.ts";

let root = "";
let source = "";
let sandbox: ProjectSandbox | undefined;

async function git(args: string[], cwd: string): Promise<string> {
	return (await runFixtureCommand("git", args, { cwd })).stdout;
}

beforeAll(async () => {
	if (!isDockerSandboxAvailable()) return;
	// Exercise the existing image-freshness path. A present but stale image can
	// contain an unrelated `sg` executable, so availability alone is insufficient.
	expect(await ensureImageAgentVersion("bobbit-agent"), "the sandbox image must rebuild to the pinned ast-grep version").toBe(true);
	await prepareGitTemplate();
	root = createRunChild("ast-grep-docker-worktree");
	source = copyGitTemplate(path.join(root, "source"));
	mkdirSync(path.join(source, "src"), { recursive: true });
	writeFileSync(path.join(source, "src", "app.ts"), 'console.log("inside-container");\n');
	await git(["add", "--", "src/app.ts"], source);
	await git(["commit", "--quiet", "-m", "Add container structural-search fixture"], source);
}, 300_000);

afterAll(async () => {
	try {
		await sandbox?.destroy();
	} finally {
		if (root) removeOwnedRunChild(root);
	}
});

describe("code-intelligence ast_grep in a real Docker linked worktree", () => {
	it("uses the image-local binary from the sandbox worktree and leaves both checkouts clean", async () => {
		if (!isDockerSandboxAvailable()) return;
		const projectId = `ast-grep-${randomUUID()}`;
		sandbox = new ProjectSandbox({
			projectId,
			projectDir: root,
			repoUrl: "file:///workspace-src",
			cloneSource: {
				kind: "mounted",
				hostPath: source,
				mountPath: "/workspace-src",
				cloneUrl: "file:///workspace-src",
			},
			image: "bobbit-agent",
		});
		await sandbox.init();
		const worktree = await sandbox.createWorktree("ast-grep", "test/ast-grep-docker", "master");

		const binary = (await sandbox.exec(["sh", "-c", "command -v sg"], { cwd: worktree })).trim();
		expect(binary, "sg must resolve from the sandbox image, never a host mount").toBe("/usr/local/bin/sg");
		expect((await sandbox.exec(["pwd"], { cwd: worktree })).trim()).toBe(worktree);

		const output = await sandbox.exec([
			"sg", "run", "--pattern", "console.log($$$ARGS)", "--lang", "TypeScript",
			"--strictness", "ast", "--json=stream", "--color", "never", "--heading", "never", "src/app.ts",
		], { cwd: worktree });
		const matches = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
		expect(matches).toHaveLength(1);
		expect(matches[0]).toMatchObject({ file: "src/app.ts", text: 'console.log("inside-container")' });
		expect(matches[0].file).not.toContain("/workspace");
		expect((await sandbox.exec(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: worktree })).trim()).toBe("");
		expect((await git(["status", "--porcelain", "--untracked-files=all"], source)).trim()).toBe("");
	}, 180_000);
});
