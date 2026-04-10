/**
 * Unit tests for getToolDocsForPrompt() — verifies the collapsed single-section
 * layout with per-group footer links for both built-in and MCP tool groups.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Create a temp config dir with a tools subdirectory structure
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-docs-prompt-"));
const toolsDir = path.join(tmpConfigDir, "tools");
const shellDir = path.join(toolsDir, "shell");
fs.mkdirSync(shellDir, { recursive: true });

// Write a sample YAML tool file
fs.writeFileSync(
	path.join(shellDir, "bash.yaml"),
	`name: bash
description: Execute shell commands and return stdout/stderr.
summary: Execute shell commands.
group: Shell
docs: |
  Output truncated to last 2000 lines / 50KB. Use -- before patterns starting with --.
`,
	"utf-8",
);

fs.writeFileSync(
	path.join(shellDir, "bash_bg.yaml"),
	`name: bash_bg
description: Manage background shell processes.
summary: Start, monitor, and kill background processes.
group: Shell
`,
	"utf-8",
);

// Write a second group
const fsDir = path.join(toolsDir, "filesystem");
fs.mkdirSync(fsDir, { recursive: true });
fs.writeFileSync(
	path.join(fsDir, "read.yaml"),
	`name: read
description: Read the contents of a file.
summary: Read file contents.
group: File System
docs: |
  Offset is 1-indexed. Supports images as visual attachments.
`,
	"utf-8",
);

const { ToolManager } = await import("../src/server/agent/tool-manager.ts");

after(() => {
	try {
		fs.rmSync(tmpConfigDir, { recursive: true, force: true });
	} catch { /* ignore */ }
});

describe("getToolDocsForPrompt — collapsed layout", () => {
	it("produces exactly one # Tools heading", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		const headingCount = (output.match(/^# Tools$/gm) || []).length;
		assert.equal(headingCount, 1, "Expected exactly one '# Tools' heading");
	});

	it("does NOT contain a separate # Tool Documentation heading", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(
			!output.includes("# Tool Documentation"),
			"Should not contain '# Tool Documentation' heading",
		);
	});

	it("contains built-in group footer linking to defaults/tools/<groupDir>/", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(
			output.includes("_For detailed Shell tool docs"),
			"Should contain Shell group footer",
		);
		assert.ok(
			output.includes("defaults/tools/shell/"),
			"Footer should reference defaults/tools/shell/",
		);
		assert.ok(
			output.includes("detail_docs"),
			"Footer should mention detail_docs field",
		);
	});

	it("contains summary lines for built-in tools", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(output.includes("- **bash**: Execute shell commands."), "Should have bash summary");
		assert.ok(output.includes("- **bash_bg**: Start, monitor, and kill background processes."), "Should have bash_bg summary");
		assert.ok(output.includes("- **read**: Read file contents."), "Should have read summary");
	});

	it("contains doc sections under ### headings", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(output.includes("### bash\n"), "Should have ### bash heading");
		assert.ok(output.includes("### read\n"), "Should have ### read heading");
		// bash_bg has no docs, so no ### heading for it
		assert.ok(!output.includes("### bash_bg\n"), "bash_bg has no docs, should not have ### heading");
	});

	it("has docs content between summary lines and footer", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		// bash docs should appear after the summary lines and before the footer
		const bashSummaryIdx = output.indexOf("- **bash**: ");
		const bashDocsIdx = output.indexOf("Output truncated to last 2000 lines");
		const shellFooterIdx = output.indexOf("_For detailed Shell tool docs");
		assert.ok(bashSummaryIdx < bashDocsIdx, "bash docs should come after summary");
		assert.ok(bashDocsIdx < shellFooterIdx, "bash docs should come before Shell footer");
	});

	it("groups are separate sections with ## headings", () => {
		const tm = new ToolManager(tmpConfigDir);
		const output = tm.getToolDocsForPrompt();
		assert.ok(output.includes("## Shell"), "Should have ## Shell heading");
		assert.ok(output.includes("## File System"), "Should have ## File System heading");
	});
});

describe("getToolDocsForPrompt — MCP tools", () => {
	it("contains MCP group footer linking to .bobbit/state/mcp-tool-docs/", () => {
		const tm = new ToolManager(tmpConfigDir);
		tm.registerExternalTools([
			{
				name: "mcp__test_server__do_thing",
				description: "Does a thing via MCP.",
				summary: "Does a thing.",
				group: "MCP: test-server",
				docs: "Parameters: arg1",
				provider: { type: "mcp", server: "test-server", mcpTool: "do_thing" },
			},
		]);
		const output = tm.getToolDocsForPrompt();

		assert.ok(
			output.includes("_For detailed test-server tool docs"),
			"Should contain MCP group footer",
		);
		assert.ok(
			output.includes(".bobbit/state/mcp-tool-docs/test-server.md"),
			"Footer should reference mcp-tool-docs/test-server.md",
		);
	});

	it("has MCP tool summary line", () => {
		const tm = new ToolManager(tmpConfigDir);
		tm.registerExternalTools([
			{
				name: "mcp__test_server__do_thing",
				description: "Does a thing via MCP.",
				summary: "Does a thing.",
				group: "MCP: test-server",
				provider: { type: "mcp", server: "test-server", mcpTool: "do_thing" },
			},
		]);
		const output = tm.getToolDocsForPrompt();
		assert.ok(
			output.includes("- **mcp__test_server__do_thing**: Does a thing."),
			"Should have MCP tool summary line",
		);
	});

	it("inlines MCP param docs in summary line, no ### heading", () => {
		const tm = new ToolManager(tmpConfigDir);
		tm.registerExternalTools([
			{
				name: "mcp__test_server__do_thing",
				description: "Does a thing via MCP.",
				summary: "Does a thing.",
				group: "MCP: test-server",
				docs: "Parameters: arg1, arg2",
				provider: { type: "mcp", server: "test-server", mcpTool: "do_thing" },
			},
		]);
		const output = tm.getToolDocsForPrompt();
		assert.ok(!output.includes("### mcp__test_server__do_thing"), "MCP tools should NOT have ### heading");
		assert.ok(
			output.includes("- **mcp__test_server__do_thing**: Does a thing.. Parameters: arg1, arg2"),
			"Param docs should be inlined in summary line",
		);
	});

	it("still has only one # Tools heading with mixed built-in and MCP tools", () => {
		const tm = new ToolManager(tmpConfigDir);
		tm.registerExternalTools([
			{
				name: "mcp__myserver__tool1",
				description: "Tool one.",
				summary: "Tool one.",
				group: "MCP: myserver",
				provider: { type: "mcp", server: "myserver", mcpTool: "tool1" },
			},
		]);
		const output = tm.getToolDocsForPrompt();
		const headingCount = (output.match(/^# Tools$/gm) || []).length;
		assert.equal(headingCount, 1, "Should still have exactly one # Tools heading");
		// Both built-in and MCP groups present
		assert.ok(output.includes("## Shell"), "Built-in group present");
		assert.ok(output.includes("## MCP: myserver"), "MCP group present");
	});

	it("returns empty string when no tools exist", () => {
		const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-docs-empty-"));
		fs.mkdirSync(path.join(emptyDir, "tools"), { recursive: true });
		const tm = new ToolManager(emptyDir);
		const output = tm.getToolDocsForPrompt();
		assert.equal(output, "", "Should return empty string with no tools");
		fs.rmSync(emptyDir, { recursive: true, force: true });
	});

	it("respects toolNames filter", () => {
		const tm = new ToolManager(tmpConfigDir);
		tm.registerExternalTools([
			{
				name: "mcp__srv__tool_a",
				description: "Tool A.",
				summary: "Tool A.",
				group: "MCP: srv",
				provider: { type: "mcp", server: "srv", mcpTool: "tool_a" },
			},
		]);
		const output = tm.getToolDocsForPrompt(["bash", "mcp__srv__tool_a"]);
		assert.ok(output.includes("- **bash**:"), "Should include bash");
		assert.ok(output.includes("- **mcp__srv__tool_a**:"), "Should include MCP tool");
		assert.ok(!output.includes("- **read**:"), "Should not include read (not in filter)");
	});
});
