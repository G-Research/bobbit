import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { preflightConfigExtensionFile } from "../../src/server/agent/tool-extension-preflight.ts";
import { createAstGrepExtension } from "../../market-packs/code-intelligence/tools/ast/extension.ts";

type Registered = { name: string; description: string; parameters: unknown; execute: Function };
const priorCwd = process.env.BOBBIT_CWD;

afterEach(() => {
	if (priorCwd === undefined) delete process.env.BOBBIT_CWD;
	else process.env.BOBBIT_CWD = priorCwd;
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
		expect(tools[0].description).toContain("grep");
		expect(tools[0].description).toContain("read");
		const schema = tools[0].parameters as any;
		expect(Object.keys(schema.properties)).toEqual(["paths", "pattern", "language", "strictness"]);
	});

	it("stays inert without a runnable binary or supported source", () => {
		expect(load(false, ["typescript"])).toEqual([]);
		expect(load(true, [])).toEqual([]);
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
