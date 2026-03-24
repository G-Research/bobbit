/**
 * Unit tests for system-prompt.ts — prompt assembly and markdown reference resolution.
 * Uses a temp directory via BOBBIT_DIR to isolate from real state.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set up temp BOBBIT_DIR before importing the module
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "system-prompt-test-"));
const stateDir = path.join(tmpRoot, "state");
const promptsDir = path.join(stateDir, "session-prompts");
fs.mkdirSync(promptsDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const {
	resolveMarkdownRefs,
	readAgentsMd,
	assembleSystemPrompt,
	cleanupSessionPrompt,
} = await import("../src/server/agent/system-prompt.ts");

// Helpers
let cwdDir: string;
let globalPromptPath: string;

function setup() {
	cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-cwd-"));
	globalPromptPath = path.join(cwdDir, "system-prompt.md");
}

function cleanup() {
	try {
		fs.rmSync(cwdDir, { recursive: true, force: true });
	} catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveMarkdownRefs", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("returns content unchanged when no @references exist", () => {
		const result = resolveMarkdownRefs("Hello world\nNo refs here", cwdDir);
		assert.equal(result, "Hello world\nNo refs here");
	});

	it("resolves a single @reference", () => {
		fs.writeFileSync(path.join(cwdDir, "included.md"), "Included content", "utf-8");
		const result = resolveMarkdownRefs("Before\n@included.md\nAfter", cwdDir);
		assert.ok(result.includes("Included content"));
		assert.ok(result.includes("Before"));
		assert.ok(result.includes("After"));
	});

	it("resolves nested @references recursively", () => {
		fs.writeFileSync(path.join(cwdDir, "a.md"), "Content A\n@b.md", "utf-8");
		fs.writeFileSync(path.join(cwdDir, "b.md"), "Content B", "utf-8");
		const result = resolveMarkdownRefs("@a.md", cwdDir);
		assert.ok(result.includes("Content A"));
		assert.ok(result.includes("Content B"));
	});

	it("handles circular references without infinite loop", () => {
		fs.writeFileSync(path.join(cwdDir, "a.md"), "@b.md", "utf-8");
		fs.writeFileSync(path.join(cwdDir, "b.md"), "@a.md", "utf-8");
		const result = resolveMarkdownRefs("@a.md", cwdDir);
		assert.ok(result.includes("circular reference"));
	});

	it("handles missing file references gracefully", () => {
		const result = resolveMarkdownRefs("@nonexistent.md", cwdDir);
		assert.ok(result.includes("file not found: nonexistent.md"));
	});

	it("preserves indentation for included content", () => {
		fs.writeFileSync(path.join(cwdDir, "indented.md"), "line1\nline2", "utf-8");
		const result = resolveMarkdownRefs("  @indented.md", cwdDir);
		assert.ok(result.includes("  line1"));
		assert.ok(result.includes("  line2"));
	});

	it("does not match @references mid-line", () => {
		const result = resolveMarkdownRefs("see @file.md for details", cwdDir);
		// The regex requires the @ref to be at the start of a line (with optional whitespace)
		// "see @file.md for details" has "see " before @, so it should NOT be treated as a ref
		assert.equal(result, "see @file.md for details");
	});

	it("handles empty included file", () => {
		fs.writeFileSync(path.join(cwdDir, "empty.md"), "", "utf-8");
		const result = resolveMarkdownRefs("Before\n@empty.md\nAfter", cwdDir);
		assert.ok(result.includes("Before"));
		assert.ok(result.includes("After"));
	});
});

describe("readAgentsMd", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("returns empty string when no AGENTS.md exists", () => {
		const result = readAgentsMd(cwdDir);
		assert.equal(result, "");
	});

	it("reads AGENTS.md content", () => {
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "# Agent Guide\nSome instructions", "utf-8");
		const result = readAgentsMd(cwdDir);
		assert.ok(result.includes("# Agent Guide"));
		assert.ok(result.includes("Some instructions"));
	});

	it("resolves @references within AGENTS.md", () => {
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "# Guide\n@extra.md", "utf-8");
		fs.writeFileSync(path.join(cwdDir, "extra.md"), "Extra content", "utf-8");
		const result = readAgentsMd(cwdDir);
		assert.ok(result.includes("Extra content"));
	});
});

describe("assembleSystemPrompt", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("returns undefined when all parts are empty", () => {
		const result = assembleSystemPrompt("test-session", { cwd: cwdDir });
		assert.equal(result, undefined);
	});

	it("includes global system prompt", () => {
		fs.writeFileSync(globalPromptPath, "You are a helpful assistant.", "utf-8");
		const result = assembleSystemPrompt("test-session-1", {
			cwd: cwdDir,
			baseSystemPromptPath: globalPromptPath,
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("You are a helpful assistant."));
	});

	it("includes AGENTS.md from cwd", () => {
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "# Project Guide\nUse TypeScript.", "utf-8");
		const result = assembleSystemPrompt("test-session-2", { cwd: cwdDir });
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Project Context"));
		assert.ok(content.includes("Use TypeScript."));
	});

	it("includes goal spec with title and state", () => {
		const result = assembleSystemPrompt("test-session-3", {
			cwd: cwdDir,
			goalTitle: "Fix the bug",
			goalState: "in-progress",
			goalSpec: "Investigate the null pointer issue in parser.ts",
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Goal"));
		assert.ok(content.includes("**Fix the bug**"));
		assert.ok(content.includes("in-progress"));
		assert.ok(content.includes("null pointer issue"));
	});

	it("includes goal spec without title", () => {
		const result = assembleSystemPrompt("test-session-4", {
			cwd: cwdDir,
			goalSpec: "Some spec",
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Goal"));
		assert.ok(content.includes("Some spec"));
	});

	it("includes personality fragments", () => {
		const result = assembleSystemPrompt("test-session-5", {
			cwd: cwdDir,
			goalSpec: "Do something",
			personalities: [
				{ label: "Friendly", promptFragment: "Be warm and approachable." },
				{ label: "Concise", promptFragment: "Keep answers short." },
			],
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("## Personality"));
		assert.ok(content.includes("**Friendly**"));
		assert.ok(content.includes("Be warm and approachable."));
		assert.ok(content.includes("**Concise**"));
	});

	it("includes tool documentation", () => {
		const result = assembleSystemPrompt("test-session-6", {
			cwd: cwdDir,
			goalSpec: "Build something",
			toolDocs: "# Tools\n\n## bash\nRun commands.",
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Tools"));
		assert.ok(content.includes("## bash"));
	});

	it("includes task context", () => {
		const result = assembleSystemPrompt("test-session-7", {
			cwd: cwdDir,
			goalSpec: "Goal spec",
			taskTitle: "Implement login",
			taskType: "implementation",
			taskSpec: "Add OAuth2 login flow",
			taskDependsOn: ["Setup auth module", "Create user model"],
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Current Task"));
		assert.ok(content.includes("**Type**: implementation"));
		assert.ok(content.includes("**Title**: Implement login"));
		assert.ok(content.includes("Add OAuth2 login flow"));
		assert.ok(content.includes("## Dependencies"));
		assert.ok(content.includes("Setup auth module"));
		assert.ok(content.includes("Create user model"));
	});

	it("includes workflow context", () => {
		const result = assembleSystemPrompt("test-session-8", {
			cwd: cwdDir,
			goalSpec: "Goal",
			workflowContext: "# Upstream Gates\n\nDesign doc content here.",
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Upstream Gates"));
		assert.ok(content.includes("Design doc content here."));
	});

	it("assembles all parts with separators", () => {
		fs.writeFileSync(globalPromptPath, "Global prompt.", "utf-8");
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "Agent guide.", "utf-8");
		const result = assembleSystemPrompt("test-session-9", {
			cwd: cwdDir,
			baseSystemPromptPath: globalPromptPath,
			goalTitle: "My Goal",
			goalState: "in-progress",
			goalSpec: "Goal spec content.",
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		// All sections present
		assert.ok(content.includes("Global prompt."));
		assert.ok(content.includes("Agent guide."));
		assert.ok(content.includes("Goal spec content."));
		// Sections separated by ---
		assert.ok(content.includes("---"));
	});

	it("writes prompt file to session-prompts directory", () => {
		const result = assembleSystemPrompt("file-check-session", {
			cwd: cwdDir,
			goalSpec: "Something",
		});
		assert.ok(result);
		assert.ok(result.endsWith("file-check-session.md"));
		assert.ok(fs.existsSync(result));
	});

	it("skips missing global prompt file gracefully", () => {
		const result = assembleSystemPrompt("test-session-10", {
			cwd: cwdDir,
			baseSystemPromptPath: "/nonexistent/system-prompt.md",
			goalSpec: "Has spec",
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("Has spec"));
		assert.ok(!content.includes("nonexistent"));
	});

	it("handles empty goal spec (whitespace only)", () => {
		const result = assembleSystemPrompt("test-session-11", {
			cwd: cwdDir,
			goalSpec: "   \n\n  ",
		});
		// Whitespace-only goalSpec should be treated as empty
		assert.equal(result, undefined);
	});
});

describe("cleanupSessionPrompt", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("removes the session prompt file", () => {
		const promptPath = assembleSystemPrompt("cleanup-test", {
			cwd: cwdDir,
			goalSpec: "Temp content",
		});
		assert.ok(promptPath);
		assert.ok(fs.existsSync(promptPath));

		cleanupSessionPrompt("cleanup-test");
		assert.ok(!fs.existsSync(promptPath));
	});

	it("does not throw when prompt file does not exist", () => {
		cleanupSessionPrompt("nonexistent-session");
		// Should not throw
	});

	it("also removes preview HTML file", () => {
		const previewPath = path.join(stateDir, "preview-cleanup-preview.html");
		fs.writeFileSync(previewPath, "<html>preview</html>", "utf-8");
		assert.ok(fs.existsSync(previewPath));

		cleanupSessionPrompt("cleanup-preview");
		assert.ok(!fs.existsSync(previewPath));
	});
});
