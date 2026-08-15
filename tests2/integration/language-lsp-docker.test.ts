import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODE_INTELLIGENCE_LANGUAGE_MATRIX } from "../../market-packs/code-intelligence/lib/language-matrix.ts";
import { detectComponentLanguages } from "../../market-packs/code-intelligence/src/language-detection.ts";
import { serializeLspRequest } from "../../market-packs/code-intelligence/src/lsp-request-adapter.ts";
import { deriveSandboxRequirements } from "../../market-packs/code-intelligence/src/sandbox-requirements.ts";
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
	// Keep the ordinary sandbox image freshness path in the test. It must not
	// add an LSP-specific layer or otherwise configure this project.
	expect(await ensureImageAgentVersion("bobbit-agent")).toBe(true);
	await prepareGitTemplate();
	root = createRunChild("language-lsp-docker");
	source = copyGitTemplate(path.join(root, "source"));
	mkdirSync(path.join(source, "internal"), { recursive: true });
	writeFileSync(path.join(source, "go.mod"), "module example.com/lsp-fixture\n\ngo 1.22\n");
	writeFileSync(path.join(source, "internal", "server.go"), "package internal\n\nfunc Answer() int { return 42 }\n");
	await git(["add", "--", "go.mod", "internal/server.go"], source);
	await git(["commit", "--quiet", "-m", "Add Go LSP degradation fixture"], source);
}, 330_000);

afterAll(async () => {
	try {
		await sandbox?.destroy();
	} finally {
		if (root) removeOwnedRunChild(root);
	}
});

describe("language LSP Go degradation in a real Docker linked worktree", () => {
	it("retains structural search while naming missing Go and gopls sandbox requirements without LSP state", async () => {
		if (!isDockerSandboxAvailable()) return;

		const detected = detectComponentLanguages({ component: "go-api", root: source });
		const go = detected.find(language => language.languageId === "go");
		expect(go).toMatchObject({
			component: "go-api",
			languageId: "go",
			structuralSearch: "available",
			lsp: "disabled",
			evidence: { fileCount: 1, rootMarkers: ["go.mod"] },
		});

		const requirements = deriveSandboxRequirements(detected, ["go"]);
		expect(requirements).toEqual(expect.arrayContaining([
			expect.objectContaining({ layerId: "go-1.22", label: "Go toolchain", languageIds: ["go"] }),
			expect.objectContaining({ layerId: "gopls", label: "gopls", languageIds: ["go"] }),
		]));

		const language = CODE_INTELLIGENCE_LANGUAGE_MATRIX.find(entry => entry.id === "go");
		expect(language?.lsp).toBeTruthy();
		const prepared = serializeLspRequest({
			action: "definition",
			component: "go-api",
			language: "go",
			path: "internal/server.go",
			position: { line: 2, character: 5 },
		}, {
			context: {
				projectId: "docker-go-lsp-fixture",
				component: { name: "go-api", repo: "." },
				componentRoot: source,
			},
			languages: [language!],
			runtime: { enabled: true, toolchain: "missing" },
		});
		expect(prepared).toMatchObject({
			result: {
				capability: "lsp",
				component: "go-api",
				languageId: "go",
				status: "requires-toolchain",
				reasonCode: "requires-toolchain",
			},
			request: { key: { languageId: "go" } },
		});
		expect(prepared.result.reason).toContain("Go toolchain");

		const projectId = `language-lsp-go-${randomUUID()}`;
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
		const worktree = await sandbox.createWorktree("go-lsp", "test/go-lsp-docker", "master");
		expect(worktree).toBe("/workspace-wt/go-lsp");
		expect((await sandbox.exec(["pwd"], { cwd: worktree })).trim()).toBe(worktree);
		expect((await sandbox.exec(["sh", "-c", "command -v go || true; command -v gopls || true"], { cwd: worktree })).trim()).toBe("");
		expect((await sandbox.exec([
			"sh", "-c",
			"for file in /proc/[0-9]*/comm; do name=$(cat \"$file\" 2>/dev/null || true); test \"$name\" = gopls && exit 1; done; test ! -e .bobbit/lsp; test ! -e .bobbit/language-server",
		], { cwd: worktree })).trim()).toBe("");
		expect((await sandbox.exec(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: worktree })).trim()).toBe("");
		expect((await git(["status", "--porcelain", "--untracked-files=all"], source)).trim()).toBe("");

		await sandbox.removeWorktree("go-lsp");
		expect((await sandbox.exec(["sh", "-c", `test ! -e ${worktree}`])).trim()).toBe("");
	}, 180_000);
});
