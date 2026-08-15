import { describe, expect, it } from "vitest";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import defaultLspExtension, {
	createLspExtension,
} from "../../market-packs/code-intelligence/tools/lsp/extension.ts";

type RegisteredTool = {
	name: string;
	promptSnippet?: string;
	parameters?: any;
	execute: (toolCallId: string, params: unknown) => Promise<any>;
};

function registeredBy(extension: (pi: any) => void): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	extension({ registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) });
	return tools;
}

const adapterOptions = (componentRoot = "/linked-worktree/services/api") => ({
	context: {
		projectId: "project-42",
		component: { name: "api", repo: ".", relativePath: "services/api" },
		componentRoot,
	},
});

describe("LSP extension registration", () => {
	it("keeps the default extension inert without platform-injected adapter context", () => {
		expect(registeredBy(defaultLspExtension).size).toBe(0);
		const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "market-packs", "code-intelligence", "tools", "lsp", "extension.ts"), "utf8");
		expect(source).not.toMatch(/\bBOBBIT_/);
	});

	it("registers six bounded read-only tools with an exact linked-worktree context", async () => {
		const componentRoot = mkdtempSync(path.join(tmpdir(), "bobbit-lsp-extension-"));
		try {
			const tools = registeredBy(createLspExtension({ adapterOptions: () => adapterOptions(componentRoot) }));
			expect([...tools.keys()]).toEqual([
				"lsp_definition", "lsp_references", "lsp_hover", "lsp_symbols", "lsp_diagnostics", "lsp_status",
			]);

			for (const tool of tools.values()) {
				expect(tool.promptSnippet).toContain("never edits files, starts, or installs");
			}
			const symbols = tools.get("lsp_symbols")!;
			expect(symbols.parameters.anyOf.map((branch: any) => branch.properties.scope.const)).toEqual(["document", "workspace"]);

			const result = await tools.get("lsp_status")!.execute("call-1", { language: "typescript" });
			expect(result.details).toMatchObject({
				capability: "lsp",
				action: "status",
				component: "api",
				languageId: "typescript",
				status: "unavailable",
				reasonCode: "service-unavailable",
			});
			expect(JSON.parse(result.content[0].text)).toEqual(result.details);
		} finally {
			rmSync(componentRoot, { recursive: true, force: true });
		}
	});

	it("returns a generic unavailable result when injected adapter options throw", async () => {
		const tools = registeredBy(createLspExtension({
			adapterOptions: () => {
				throw new Error("failed at /private/worktree/secret.env token=top-secret");
			},
		}));
		const result = await tools.get("lsp_definition")!.execute("call-2", {
			language: "typescript", path: "src/server.ts", position: { line: 0, character: 0 },
		});
		const text = JSON.stringify(result.details);

		expect(result.details).toMatchObject({
			capability: "lsp",
			action: "definition",
			component: "unavailable",
			languageId: "typescript",
			status: "unavailable",
			reasonCode: "service-unavailable",
		});
		expect(text).not.toContain("/private/worktree");
		expect(text).not.toContain("top-secret");
	});
});
