import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODE_INTELLIGENCE_LANGUAGE_MATRIX } from "../../market-packs/code-intelligence/lib/language-matrix.ts";
import { detectComponentLanguages } from "../../market-packs/code-intelligence/src/language-detection.ts";
import {
	serializeLspRequest,
	type LspLanguageDeclaration,
} from "../../market-packs/code-intelligence/src/lsp-request-adapter.ts";
import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.ts";
import { createRunChild, removeOwnedRunChild } from "../harness/run-isolation.ts";
import { runFixtureCommand } from "../harness/spawn-with-retry.ts";

let root = "";
let primary = "";
let worktree = "";
let componentRoot = "";
let primaryOnlyFile = "";

async function git(args: string[], cwd: string): Promise<string> {
	return (await runFixtureCommand("git", args, { cwd })).stdout;
}

function typescriptLanguage(): LspLanguageDeclaration {
	const language = CODE_INTELLIGENCE_LANGUAGE_MATRIX.find(entry => entry.id === "typescript");
	expect(language, "the matrix must declare TypeScript for linked-worktree LSP requests").toBeTruthy();
	expect(language!.lsp, "TypeScript must independently declare an LSP capability").toBeTruthy();
	return language as unknown as LspLanguageDeclaration;
}

beforeAll(async () => {
	await prepareGitTemplate();
	root = createRunChild("language-lsp-worktree");
	primary = copyGitTemplate(path.join(root, "primary"));
	componentRoot = path.join(primary, "packages", "api");
	mkdirSync(path.join(componentRoot, "src"), { recursive: true });
	writeFileSync(path.join(componentRoot, "src", "linked.ts"), "export const linkedWorktreeOnly = true;\n");
	writeFileSync(path.join(componentRoot, "package.json"), '{"name":"api"}\n');
	await git(["add", "--", "packages/api"], primary);
	await git(["commit", "--quiet", "-m", "Add linked component fixture"], primary);

	worktree = path.join(root, "linked-worktree");
	await git(["worktree", "add", "--quiet", "-b", "test/language-lsp", worktree, "master"], primary);
	componentRoot = path.join(worktree, "packages", "api");

	primaryOnlyFile = path.join(primary, "packages", "api", "src", "primary-only.py");
	writeFileSync(primaryOnlyFile, "primary_only = True\n");
	await git(["add", "--", "packages/api/src/primary-only.py"], primary);
	await git(["commit", "--quiet", "-m", "Keep primary-only source outside linked worktree"], primary);
}, 60_000);

afterAll(async () => {
	try {
		if (primary && worktree) await git(["worktree", "remove", "--force", worktree], primary);
		if (worktree) expect(existsSync(worktree), "linked-worktree cleanup must remove the checkout without an LSP-owned process or state directory").toBe(false);
	} finally {
		if (root) removeOwnedRunChild(root);
	}
});

describe("language LSP adapter in a real linked worktree component", () => {
	it("detects source in the linked component and serializes its exact root, never the primary checkout", () => {
		expect(existsSync(path.join(componentRoot, "src", "linked.ts"))).toBe(true);
		expect(existsSync(primaryOnlyFile)).toBe(true);
		expect(existsSync(path.join(componentRoot, "src", "primary-only.py"))).toBe(false);
		const detected = detectComponentLanguages({ component: "api", root: componentRoot });
		expect(detected).toEqual(expect.arrayContaining([
			expect.objectContaining({ component: "api", languageId: "typescript", structuralSearch: "available", lsp: "disabled" }),
		]));
		expect(detected.find(language => language.languageId === "typescript")?.evidence.fileCount).toBe(1);
		expect(detected.find(language => language.languageId === "python"), "primary-only Python must not be detected through the primary checkout").toBeUndefined();

		const prepared = serializeLspRequest({
			action: "definition",
			component: "api",
			language: "typescript",
			path: "src/linked.ts",
			position: { line: 0, character: 0 },
		}, {
			context: {
				projectId: "linked-worktree-project",
				component: { name: "api", repo: ".", relativePath: "packages/api" },
				componentRoot,
			},
			languages: [typescriptLanguage()],
		});

		expect(prepared.result).toMatchObject({
			capability: "lsp",
			action: "definition",
			component: "api",
			languageId: "typescript",
			status: "unavailable",
			reasonCode: "service-unavailable",
		});
		expect(prepared.request).toBeTruthy();
		expect(prepared.request!.key.worktreePath).toBe(realpathSync(componentRoot));
		expect(prepared.request!.key.worktreePath).not.toBe(realpathSync(path.join(primary, "packages", "api")));
		expect(fileURLToPath(prepared.request!.uri!)).toBe(path.join(realpathSync(componentRoot), "src", "linked.ts"));
		expect(prepared.result.reason).toMatch(/No language server was started/i);
	});

	it("rejects a primary-worktree escape and degrades a named missing runtime without starting one", () => {
		const options = {
			context: {
				component: { name: "api", repo: ".", relativePath: "packages/api" },
				componentRoot,
			},
			languages: [typescriptLanguage()],
		};
		const escaped = serializeLspRequest({
			action: "hover",
			language: "typescript",
			path: "../../primary/packages/api/src/primary-only.py",
			position: { line: 0, character: 0 },
		}, options);
		expect(escaped).toMatchObject({
			result: { status: "unavailable", reasonCode: "invalid-path" },
		});
		expect(escaped.request).toBeUndefined();

		const missingRuntime = serializeLspRequest({
			action: "hover",
			language: "typescript",
			path: "src/linked.ts",
			position: { line: 0, character: 0 },
		}, { ...options, runtime: { enabled: true, toolchain: "missing" } });
		const requirement = typescriptLanguage().lsp!.host[0] ?? typescriptLanguage().lsp!.sandbox[0];
		expect(requirement, "the declared TypeScript LSP must name a toolchain requirement").toBeTruthy();
		expect(missingRuntime).toMatchObject({
			result: {
				capability: "lsp",
				status: "requires-toolchain",
				reasonCode: "requires-toolchain",
			},
			request: {
				key: { worktreePath: realpathSync(componentRoot), languageId: "typescript" },
			},
		});
		expect(missingRuntime.result.reason).toContain(requirement!.label);
		expect(missingRuntime.result.reason).toMatch(/required/i);
	});
});
