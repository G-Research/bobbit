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
	getPromptSections,
	cleanupSessionPrompt,
	initPromptDirs,
} = await import("../src/server/agent/system-prompt.ts");

// Initialize prompt dirs with the test stateDir (required after parameterization)
initPromptDirs(stateDir);

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

	it("resolves inline @references mid-line", () => {
		fs.writeFileSync(path.join(cwdDir, "file.md"), "expanded content", "utf-8");
		const result = resolveMarkdownRefs("see @file.md for details", cwdDir);
		assert.ok(result.includes("expanded content"), "inline @ref should be expanded");
		assert.ok(result.includes("see "), "surrounding text preserved");
		assert.ok(result.includes(" for details"), "surrounding text preserved");
	});

	it("resolves inline @ref in list items like Claude Code", () => {
		fs.mkdirSync(path.join(cwdDir, "docs"), { recursive: true });
		fs.writeFileSync(path.join(cwdDir, "docs/rules.md"), "Rule content", "utf-8");
		const result = resolveMarkdownRefs("- git workflow @docs/rules.md", cwdDir);
		assert.ok(result.includes("Rule content"), "inline @ref in list should expand");
		assert.ok(result.includes("- git workflow"), "list prefix preserved");
	});

	it("does not expand email addresses as @refs", () => {
		const result = resolveMarkdownRefs("contact user@example.com for help", cwdDir);
		assert.equal(result, "contact user@example.com for help");
	});

	it("respects max depth of 5 hops", () => {
		// Create a chain of 7 files
		for (let i = 0; i < 7; i++) {
			const next = i < 6 ? `@depth${i + 1}.md` : "leaf";
			fs.writeFileSync(path.join(cwdDir, `depth${i}.md`), `level-${i}\n${next}`, "utf-8");
		}
		const result = resolveMarkdownRefs("@depth0.md", cwdDir);
		assert.ok(result.includes("level-0"));
		assert.ok(result.includes("level-4"));
		assert.ok(result.includes("max import depth reached"));
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

	it("returns working-directory-only prompt when all other parts are empty", () => {
		const result = assembleSystemPrompt("test-session", { cwd: cwdDir });
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Working Directory"));
		assert.ok(content.includes(cwdDir));
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

	it("resolves @refs in global system prompt", () => {
		const docsDir = path.join(path.dirname(globalPromptPath), "docs");
		fs.mkdirSync(docsDir, { recursive: true });
		fs.writeFileSync(path.join(docsDir, "rules.md"), "Rule 1: Be concise.", "utf-8");
		fs.writeFileSync(globalPromptPath, "You are helpful.\n@docs/rules.md\nEnd.", "utf-8");
		const result = assembleSystemPrompt("test-session-refs", {
			cwd: cwdDir,
			baseSystemPromptPath: globalPromptPath,
		});
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("You are helpful."));
		assert.ok(content.includes("Rule 1: Be concise."));
		assert.ok(content.includes("End."));
		assert.ok(!content.includes("@docs/rules.md"), "raw @ref should be expanded");
	});

	it("includes AGENTS.md from cwd", () => {
		fs.writeFileSync(path.join(cwdDir, "AGENTS.md"), "# Project Guide\nUse TypeScript.", "utf-8");
		const result = assembleSystemPrompt("test-session-2", { cwd: cwdDir });
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Project AGENTS.md"));
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
		// Whitespace-only goalSpec should be treated as empty, but CWD still produces a prompt
		assert.ok(result);
		const content = fs.readFileSync(result, "utf-8");
		assert.ok(content.includes("# Working Directory"));
		assert.ok(!content.includes("Goal"));
	});
});

describe("getPromptSections", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("resolves @refs in global system prompt sections", () => {
		const docsDir = path.join(path.dirname(globalPromptPath), "docs");
		fs.mkdirSync(docsDir, { recursive: true });
		fs.writeFileSync(path.join(docsDir, "extra.md"), "Expanded content here.", "utf-8");
		fs.writeFileSync(globalPromptPath, "Base prompt.\n@docs/extra.md", "utf-8");
		const sections = getPromptSections({
			cwd: cwdDir,
			baseSystemPromptPath: globalPromptPath,
		});
		const sysSection = sections.find(s => s.label === "System Prompt");
		assert.ok(sysSection, "should have a System Prompt section");
		assert.ok(sysSection!.content.includes("Base prompt."));
		assert.ok(sysSection!.content.includes("Expanded content here."));
		assert.ok(!sysSection!.content.includes("@docs/extra.md"), "raw @ref should be expanded");
	});
});

/**
 * Canonical LSP-before-text-search rule lives in `defaults/system-prompt.md`
 * (the base system prompt). It supersedes the legacy per-role injection of
 * `## Tool selection — symbol queries`. These tests assert the canonical
 * section reaches every role — including docs-writer / qa-tester / empty —
 * and is never duplicated.
 *
 * The broader role matrix lives in `tests/lsp-canonical-base-prompt.test.ts`.
 */
describe("Canonical LSP-before-text-search rule (base system prompt)", () => {
	beforeEach(setup);
	afterEach(cleanup);

	const CANONICAL_HEADER = "## Tool selection — LSP before text search";
	// Resolve the shipped defaults/system-prompt.md relative to this test file
	// so we pin against the canonical source rather than any developer overlay.
	const defaultsSystemPrompt = path.resolve(
		path.dirname(new URL(import.meta.url).pathname),
		"../defaults/system-prompt.md",
	);

	function assembleForRole(
		sessionId: string,
		roleName: string | undefined,
		rolePrompt?: string,
	): string {
		const promptPath = assembleSystemPrompt(sessionId, {
			cwd: cwdDir,
			baseSystemPromptPath: defaultsSystemPrompt,
			roleName,
			rolePrompt,
		});
		assert.ok(promptPath, "assembleSystemPrompt must return a path");
		return fs.readFileSync(promptPath!, "utf-8");
	}

	function count(haystack: string, needle: string): number {
		let n = 0;
		let from = 0;
		while (true) {
			const i = haystack.indexOf(needle, from);
			if (i < 0) return n;
			n++;
			from = i + needle.length;
		}
	}

	// Every role — code-investigation AND docs/qa/empty — must receive the
	// canonical rule via the base prompt. The whole point of moving it out of
	// role yamls is that role/project overrides cannot suppress it.
	const ALL_ROLES = [
		"team-lead",
		"coder",
		"reviewer",
		"code-reviewer",
		"security-reviewer",
		"architect",
		"spec-auditor",
		"docs-writer",
		"qa-tester",
		"",
	];

	for (const role of ALL_ROLES) {
		it(`role '${role || "(empty)"}' gets exactly one canonical section`, () => {
			const content = assembleForRole(
				`canonical-${role || "empty"}`,
				role,
				role ? `You are a ${role}. Do good work.` : undefined,
			);
			assert.strictEqual(
				count(content, CANONICAL_HEADER),
				1,
				`Expected exactly one '${CANONICAL_HEADER}' in prompt for role '${role}'`,
			);
		});
	}

	it("canonical section mentions rg, ripgrep, git grep, ag, ack, and bash", () => {
		const content = assembleForRole("canonical-tokens", "coder", "You are a coder.");
		for (const token of ["rg", "ripgrep", "git grep", "ag", "ack", "bash"]) {
			assert.ok(
				content.includes(token),
				`Canonical section must mention text-search tool "${token}"`,
			);
		}
	});

	it("canonical section includes lsp_definition({ symbolName: \"X\" }) example", () => {
		const content = assembleForRole("canonical-symbolname", "coder", "You are a coder.");
		assert.ok(
			content.includes(`lsp_definition({ symbolName: "X" })`),
			'Canonical section must include the literal `lsp_definition({ symbolName: "X" })` example',
		);
	});

	it("canonical section appears before generic read/grep/bash guidance", () => {
		const content = assembleForRole("canonical-order", "coder", "You are a coder.");
		const lsp = content.indexOf(CANONICAL_HEADER);
		const readGuidance = content.indexOf("# How to read files and gather information");
		assert.ok(lsp >= 0, "canonical section must exist");
		assert.ok(readGuidance >= 0, "read/search guidance must exist");
		assert.ok(
			lsp < readGuidance,
			"Canonical LSP section must appear before generic read/grep/bash guidance",
		);
	});

	it("role override that does not mention LSP still inherits exactly one canonical section", () => {
		// Simulate a project `.bobbit/config/roles/coder.yaml` replacing the
		// default coder prompt entirely with text that omits LSP guidance.
		const overriddenCoderPrompt =
			"You are a **Coder** agent.\n\n## Your Role\nImplement features. Use grep to find things.\n";
		const content = assembleForRole("canonical-override", "coder", overriddenCoderPrompt);
		assert.strictEqual(
			count(content, CANONICAL_HEADER),
			1,
			"LSP-free coder override must still inherit the canonical rule from the base prompt",
		);
		assert.ok(content.includes("lsp_definition"));
	});

	it("role prompt containing the canonical header does not produce a duplicate", () => {
		// Defensive duplication guard: even if a role yaml happens to embed the
		// canonical header, the final assembled prompt must still contain it at
		// most twice (once from base, once from role) — and ideally exactly once.
		// The base prompt is the source of truth, so we accept one occurrence in
		// the role text + one in the base prompt = 2 only as an upper bound, but
		// the role yamls shipped today do NOT embed the canonical header, so we
		// enforce exactly one here when role text is LSP-free.
		const content = assembleForRole("canonical-role-clean", "coder", "You are a coder.");
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
	});

	it("canonical section reaches team-lead prompts", () => {
		const content = assembleForRole("canonical-team-lead", "team-lead", "You are the team lead.");
		assert.strictEqual(count(content, CANONICAL_HEADER), 1);
		assert.ok(content.includes("lsp_workspace_symbol"));
	});

	it("legacy `## Tool selection — symbol queries` header is no longer injected by assembly", () => {
		// The role-yaml injection path was removed; assembly must not emit the
		// legacy header for code-investigation roles that lack it in their role
		// prompt.
		const content = assembleForRole(
			"legacy-header-absent",
			"coder",
			"You are a coder. No LSP guidance here.",
		);
		assert.ok(
			!content.includes("## Tool selection — symbol queries"),
			"Legacy `## Tool selection — symbol queries` header must not be auto-injected; canonical section supersedes it.",
		);
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

});
