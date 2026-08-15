import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { preflightConfigExtensionFile } from "../../src/server/agent/tool-extension-preflight.ts";
import { createAstGrepExtension, resolveAstGrepBinary } from "../../market-packs/code-intelligence/tools/ast/extension.ts";

type Registered = { name: string; description: string; promptSnippet: string; promptGuidelines: string[]; parameters: unknown; execute: Function };
const priorCwd = process.env.BOBBIT_CWD;
const priorAstGrepPath = process.env.BOBBIT_AST_GREP_PATH;

afterEach(() => {
	if (priorCwd === undefined) delete process.env.BOBBIT_CWD;
	else process.env.BOBBIT_CWD = priorCwd;
	if (priorAstGrepPath === undefined) delete process.env.BOBBIT_AST_GREP_PATH;
	else process.env.BOBBIT_AST_GREP_PATH = priorAstGrepPath;
});

function load(available: boolean, languages: string[]): Registered[] {
	const tools: Registered[] = [];
	createAstGrepExtension(() => available, () => languages)({ registerTool(tool: Registered) { tools.push(tool); } } as any);
	return tools;
}

describe("ast-grep tool activation", () => {
	it("registers exactly one read-only tool for a supported worktree and binary", () => {
		process.env.BOBBIT_CWD = "/worktree";
		const tools = load(true, ["typescript", "python"]);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: "ast_grep" });
		expect(tools[0].description).toContain("structural search");
		expect(tools[0].description).toContain("read cited source and callers");
		expect(tools[0].promptSnippet).toContain("structural leads");
		expect(tools[0].promptSnippet.length).toBeLessThanOrEqual(160);
		expect(tools[0].promptGuidelines.join("\n")).toContain("Before a finding or approval, use read on every cited source and caller");
		const schema = tools[0].parameters as any;
		expect(Object.keys(schema.properties)).toEqual(["paths", "pattern", "language", "strictness"]);
	});

	it("stays inert without a runnable binary or supported source", () => {
		expect(load(false, ["typescript"])).toEqual([]);
		expect(load(true, [])).toEqual([]);
	});

	it("executes with the resolver-provided host binary rather than a bare PATH command", async () => {
		const tools: Registered[] = [];
		const run = async (_input: unknown, options: { cwd: string; binary?: string }) => {
			expect(options).toEqual({ cwd: "/worktree", binary: "/verified/ast-grep" });
			return { matches: [], matchCount: 0, truncated: false, languages: ["typescript"], diagnostics: [] };
		};
		process.env.BOBBIT_CWD = "/worktree";
		createAstGrepExtension(() => true, () => ["typescript"], () => "/verified/ast-grep", run as any)({ registerTool(tool: Registered) { tools.push(tool); } } as any);
		await tools[0].execute("call", { pattern: "console.log($$$ARGS)" }, new AbortController().signal);
	});

	it("uses image-local sg when no host resolver path was supplied", () => {
		delete process.env.BOBBIT_AST_GREP_PATH;
		expect(resolveAstGrepBinary()).toBe("sg");
		process.env.BOBBIT_AST_GREP_PATH = "/verified/ast-grep";
		expect(resolveAstGrepBinary()).toBe("/verified/ast-grep");
	});

	it("loads its complete extension graph from the pack", () => {
		const diagnostic = preflightConfigExtensionFile({
			toolName: "ast_grep",
			baseDir: path.resolve("market-packs/code-intelligence/tools"),
			groupDir: "ast",
			extension: "extension.ts",
		});
		expect(diagnostic).toBeUndefined();
	});
});
