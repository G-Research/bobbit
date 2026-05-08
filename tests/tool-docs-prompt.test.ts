/**
 * Unit tests for getToolDocsForPrompt() — verifies the compact one-bullet-per-tool
 * layout introduced by the "Compact tool docs in prompt" goal.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Create a temp config dir with a tools subdirectory structure
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-docs-prompt-"));
const toolsDir = path.join(tmpConfigDir, "tools");
const shellDir = path.join(toolsDir, "shell");
fs.mkdirSync(shellDir, { recursive: true });

// bash: has params (one optional)
fs.writeFileSync(
	path.join(shellDir, "bash.yaml"),
	`name: bash
description: "Execute shell commands"
summary: "Execute shell commands; returns stdout/stderr"
params: [command, timeout?]
group: Shell
docs: |-
  Output truncated. Use -- before patterns starting with --.
detail_docs: |-
  Full reference.
`,
	"utf-8",
);

// bash_bg: NO params field — must render bare
fs.writeFileSync(
	path.join(shellDir, "bash_bg.yaml"),
	`name: bash_bg
description: "Manage background shell processes"
summary: "Background shell processes"
group: Shell
`,
	"utf-8",
);

// File System group — only optional params
const fsDir = path.join(toolsDir, "filesystem");
fs.mkdirSync(fsDir, { recursive: true });
fs.writeFileSync(
	path.join(fsDir, "read.yaml"),
	`name: read
description: "Read file contents"
summary: "Read file contents"
params: [path, offset?, limit?]
group: File System
docs: |-
  Offset is 1-indexed.
detail_docs: |-
  Read reference body.
`,
	"utf-8",
);

const { ToolManager } = await import("../src/server/agent/tool-manager.ts");

after(() => {
	try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("getToolDocsForPrompt — compact layout", () => {
	it("produces exactly one # Tools heading", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		const headingCount = (output.match(/^# Tools$/gm) || []).length;
		assert.equal(headingCount, 1);
	});

	it("group header is '## <Group> — see <path>' on a single line", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-docs-state-"));
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt(undefined, stateDir);
		const expectedShellPath = path.join(stateDir, "tool-docs", "shell.md");
		const expectedFsPath = path.join(stateDir, "tool-docs", "filesystem.md");
		assert.ok(
			output.includes(`## Shell — see ${expectedShellPath}`),
			`Expected single-line Shell header with path; got:\n${output}`,
		);
		assert.ok(
			output.includes(`## File System — see ${expectedFsPath}`),
			"Expected single-line File System header with path",
		);
		// No separate footer paragraph.
		assert.ok(!output.includes("_For detailed"), "Should not emit old `_For detailed…_` footer paragraph");
		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("falls back to .bobbit/state/tool-docs/<group>.md when stateDir undefined", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(output.includes(".bobbit/state/tool-docs/shell.md"));
		assert.ok(output.includes(".bobbit/state/tool-docs/filesystem.md"));
	});

	it("renders builtin tools as `- name(params) — summary` bullets, NOT ### blocks", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(!/^### bash$/m.test(output), "Must not emit ### bash heading");
		assert.ok(!/^### read$/m.test(output), "Must not emit ### read heading");
		assert.ok(
			output.includes("- bash(command, timeout?) — Execute shell commands; returns stdout/stderr"),
			`Expected bash bullet with params; got:\n${output}`,
		);
	});

	it("renders optional params with trailing `?`", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(output.includes("- read(path, offset?, limit?) — Read file contents"));
		assert.ok(output.includes("timeout?"));
	});

	it("renders tools with no params as bare `- name — summary` (no parens)", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(
			output.includes("- bash_bg — Background shell processes"),
			`Expected bare bullet for bash_bg; got:\n${output}`,
		);
		assert.ok(!output.includes("bash_bg("), "bash_bg should not have parens");
	});

	it("does NOT inline `docs` paragraphs into the prompt", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(!output.includes("Output truncated"), "docs body must not appear in prompt");
		assert.ok(!output.includes("Offset is 1-indexed"), "docs body must not appear in prompt");
	});
});

describe("getToolDocsForPrompt — MCP tools", () => {
	it("renders MCP tools as `- name — summary` with no inlined Parameters prose", () => {
		const tm = new ToolManager(tmpConfigDir);
		tm.registerExternalTools([
			{
				name: "mcp__test_server__do_thing",
				description: "Does a thing via MCP.",
				summary: "Does a thing",
				group: "MCP: test-server",
				docs: "Parameters: arg1, arg2",
				provider: { type: "mcp", server: "test-server", mcpTool: "do_thing" },
			},
		]);
		const output = tm.getToolDocsForPrompt();
		assert.ok(output.includes("- mcp__test_server__do_thing — Does a thing"), `bullet missing in:\n${output}`);
		assert.ok(!output.includes("Parameters: arg1"), "Inlined Parameters: prose must not appear");
		assert.ok(!output.includes("### mcp__"), "MCP tools must not have ### heading");
		assert.ok(!output.includes("- **mcp__"), "Must not use old bold-bullet style");
	});

	it("MCP group header points at .bobbit/state/mcp-tool-docs/<server>.md", () => {
		const tm = new ToolManager(tmpConfigDir);
		tm.registerExternalTools([
			{
				name: "mcp__myserver__tool1",
				description: "Tool one.",
				summary: "Tool one",
				group: "MCP: myserver",
				provider: { type: "mcp", server: "myserver", mcpTool: "tool1" },
			},
		]);
		const output = tm.getToolDocsForPrompt();
		assert.ok(
			output.includes("## MCP: myserver — see .bobbit/state/mcp-tool-docs/myserver.md"),
			`Expected single-line MCP header; got:\n${output}`,
		);
	});

	it("returns empty string when no tools exist", () => {
		const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-docs-empty-"));
		fs.mkdirSync(path.join(emptyDir, "tools"), { recursive: true });
		const tm = new ToolManager(emptyDir);
		const output = tm.getToolDocsForPrompt();
		assert.equal(output, "");
		fs.rmSync(emptyDir, { recursive: true, force: true });
	});

	it("respects toolNames filter", () => {
		const tm = new ToolManager(tmpConfigDir);
		tm.registerExternalTools([
			{
				name: "mcp__srv__tool_a",
				description: "Tool A.",
				summary: "Tool A",
				group: "MCP: srv",
				provider: { type: "mcp", server: "srv", mcpTool: "tool_a" },
			},
		]);
		const output = tm.getToolDocsForPrompt(["bash", "mcp__srv__tool_a"]);
		assert.ok(output.includes("- bash("), "Should include bash bullet");
		assert.ok(output.includes("- mcp__srv__tool_a — Tool A"), "Should include MCP tool bullet");
		assert.ok(!output.includes("- read"), "Should NOT include read (filtered out)");
	});
});

describe("generateDetailDocs", () => {
	it("writes tool-docs/<group>.md containing both docs and detail_docs for each tool", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-docs-gen-"));
		const tm = new ToolManager(tmpConfigDir);
		tm.generateDetailDocs(stateDir);

		const shellMd = fs.readFileSync(path.join(stateDir, "tool-docs", "shell.md"), "utf-8");
		assert.ok(shellMd.includes("## bash"), "shell.md should have ## bash heading");
		assert.ok(shellMd.includes("Output truncated"), "should include bash docs paragraph");
		assert.ok(shellMd.includes("Full reference."), "should include bash detail_docs body");
		// docs comes before detail_docs
		const docsIdx = shellMd.indexOf("Output truncated");
		const detailIdx = shellMd.indexOf("Full reference.");
		assert.ok(docsIdx < detailIdx, "docs paragraph should appear before detail_docs");

		const fsMd = fs.readFileSync(path.join(stateDir, "tool-docs", "filesystem.md"), "utf-8");
		assert.ok(fsMd.includes("Offset is 1-indexed"), "should include read docs paragraph");
		assert.ok(fsMd.includes("Read reference body."), "should include read detail_docs body");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});
});

describe("getToolDocsForPrompt — byte budget (real builtins)", () => {
	it("renders the full default builtin set under 8 KB", () => {
		// Point ToolManager at the real defaults/tools directory, not tmpConfigDir.
		const builtinsDir = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "defaults", "tools");
		const fakeConfig = fs.mkdtempSync(path.join(os.tmpdir(), "tool-docs-budget-"));
		fs.mkdirSync(path.join(fakeConfig, "tools"), { recursive: true });
		const tm = new ToolManager(fakeConfig, builtinsDir);
		const output = tm.getToolDocsForPrompt();
		const bytes = Buffer.byteLength(output, "utf-8");
		assert.ok(
			bytes <= 8192,
			`Tool docs prompt section is ${bytes} bytes; must be <= 8192. First 400 chars:\n${output.slice(0, 400)}`,
		);
		assert.ok(bytes > 0, "Should produce non-empty output");
		fs.rmSync(fakeConfig, { recursive: true, force: true });
	});
});
