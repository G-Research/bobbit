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
	stripPromptStanzas,
	REVIEWER_EXCLUDED_STANZAS,
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

// ---------------------------------------------------------------------------
// F2/F22 — prompt-slimming profiles (RECONCILIATION-2026-07-05.md NEXT QUEUE
// items 4/5). Uses the REAL shipped `defaults/system-prompt.md` (not a test
// fixture) so the excluded-stanza list and the reported token savings track
// the actual base prompt, not a synthetic stand-in that could drift from it.
// ---------------------------------------------------------------------------
const REAL_BASE_PROMPT_PATH = path.join(process.cwd(), "defaults", "system-prompt.md");
/** Mirrors system-prompt.ts's internal estimateTokens() (~4 chars/token). */
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

describe("prompt profiles (F2 reviewer / F22 narrow-worker)", () => {
	beforeEach(setup);
	afterEach(cleanup);

	it("stripPromptStanzas removes a named H1 section (heading through the next H1)", () => {
		const text = "# A\n\nbody A\n\n# B\n\nbody B\n\n# C\n\nbody C";
		const out = stripPromptStanzas(text, ["B"]);
		assert.ok(!out.includes("# B"));
		assert.ok(!out.includes("body B"));
		assert.ok(out.includes("# A") && out.includes("body A"));
		assert.ok(out.includes("# C") && out.includes("body C"));
	});

	it("stripPromptStanzas is a no-op when no listed heading is present", () => {
		const text = "# A\n\nbody A\n\n# C\n\nbody C";
		assert.equal(stripPromptStanzas(text, ["B"]), text);
	});

	it("default (no promptProfile) system prompt is BYTE-IDENTICAL to pre-profile output", () => {
		// Hand-rolled expectation using the SAME primitives production code used
		// before this change (raw file + resolveMarkdownRefs + the pre-existing
		// hardcoded Working Directory copy) — this is the explicit byte-identity
		// pin for the unmodified (coder) path required by the PR brief.
		const raw = fs.readFileSync(REAL_BASE_PROMPT_PATH, "utf-8").trim();
		const base = resolveMarkdownRefs(raw, path.dirname(REAL_BASE_PROMPT_PATH));
		const expectedWorkingDir = "# Working Directory\n\n" +
			`Your working directory is: \`${cwdDir}\`\n\n` +
			`Stay in this directory for all file operations and git commands. ` +
			`Do not \`cd\` into other directories unless explicitly required by the task.\n\n` +
			`**Why this is a hard constraint:** Other agents, the dev server, and the user may all be working in the primary worktree simultaneously. ` +
			`If you \`cd\` there and make changes, you risk merge conflicts during rebase, corrupting other agents' in-progress work, or breaking the running dev server. ` +
			`Even for infrastructure files (Dockerfiles, configs), the correct flow is: edit here → commit → push to origin → pull from primary. ` +
			`One \`cd\` violation cascades — all subsequent commands (edit, git add, commit) will operate on shared state.`;
		const expected = [base, expectedWorkingDir].join("\n\n---\n\n") + "\n";

		const promptPath = assembleSystemPrompt("byte-identical-coder", {
			cwd: cwdDir,
			baseSystemPromptPath: REAL_BASE_PROMPT_PATH,
		});
		assert.ok(promptPath);
		const actual = fs.readFileSync(promptPath, "utf-8");
		assert.equal(actual, expected, "unprofiled (default) prompt must be byte-identical to pre-profile output");
		// Sanity: the coder/default path still carries Git conventions in full.
		assert.ok(actual.includes("# Git conventions"));
		assert.ok(actual.includes("Parallel tool calls that mutate the same target"));
	});

	it("reviewer profile excludes the Git-conventions marker; coder profile still includes it", () => {
		const coderPath = assembleSystemPrompt("profile-coder", { cwd: cwdDir, baseSystemPromptPath: REAL_BASE_PROMPT_PATH });
		const reviewerPath = assembleSystemPrompt("profile-reviewer", { cwd: cwdDir, baseSystemPromptPath: REAL_BASE_PROMPT_PATH, promptProfile: "reviewer" });
		assert.ok(coderPath && reviewerPath);
		const coder = fs.readFileSync(coderPath, "utf-8");
		const reviewer = fs.readFileSync(reviewerPath, "utf-8");

		assert.ok(coder.includes("# Git conventions"), "coder profile keeps Git conventions");
		assert.ok(coder.includes("Parallel tool calls that mutate the same target"), "coder profile keeps the mutate-same-target stanza");
		assert.ok(!reviewer.includes("# Git conventions"), "reviewer profile excludes Git conventions");
		assert.ok(!reviewer.includes("Parallel tool calls that mutate the same target"), "reviewer profile excludes the mutate-same-target stanza");
		// Everything else in the base prompt is preserved for the reviewer too.
		assert.ok(reviewer.includes("# Scoping searches"));
		assert.ok(reviewer.includes("# Ownership mindset"));
	});

	it("reviewer profile measurably shrinks the base system prompt (token-count delta)", () => {
		const coderSections = getPromptSections({ cwd: cwdDir, baseSystemPromptPath: REAL_BASE_PROMPT_PATH });
		const reviewerSections = getPromptSections({ cwd: cwdDir, baseSystemPromptPath: REAL_BASE_PROMPT_PATH, promptProfile: "reviewer" });
		const coderSys = coderSections.find(s => s.label === "System Prompt")!;
		const reviewerSys = reviewerSections.find(s => s.label === "System Prompt")!;
		assert.ok(coderSys && reviewerSys);
		const saved = coderSys.tokens - reviewerSys.tokens;
		// Measured on the real shipped prompt: ~935 tokens (~19%) as of this PR.
		// Assert a conservative floor so future edits to system-prompt.md can't
		// silently regress the savings to near-zero without failing this test.
		assert.ok(saved > 500, `expected the reviewer profile to save >500 tokens on the base prompt, saved ${saved}`);
		console.log(`[F2] reviewer profile base-prompt savings: ${saved} tokens (coder=${coderSys.tokens}, reviewer=${reviewerSys.tokens})`);
	});

	it("SWARM-W4 verifier/reviewer-class spawns request the reviewer profile and drop Git conventions", () => {
		const harnessSrc = fs.readFileSync(path.join(process.cwd(), "src/server/agent/verification-harness.ts"), "utf-8");
		const explicitReviewerProfileSites = harnessSrc.match(/promptProfile:\s*"reviewer"/g) ?? [];
		assert.ok(explicitReviewerProfileSites.length >= 2, "llm-review and agent-qa verifier spawns should request promptProfile:\"reviewer\"");

		const swarmVerifierSrc = fs.readFileSync(path.join(process.cwd(), "src/server/agent/swarm-verifier.ts"), "utf-8");
		assert.doesNotMatch(swarmVerifierSrc, /createSession|PromptParts|assembleSystemPrompt/, "swarm-verifier.ts is deterministic shell verification; it has no reviewer-class session prompt to profile");

		const coderPath = assembleSystemPrompt("swarm-verifier-coder-baseline", { cwd: cwdDir, baseSystemPromptPath: REAL_BASE_PROMPT_PATH });
		const reviewerPath = assembleSystemPrompt("swarm-verifier-reviewer-profile", { cwd: cwdDir, baseSystemPromptPath: REAL_BASE_PROMPT_PATH, promptProfile: "reviewer" });
		assert.ok(coderPath && reviewerPath);
		const coder = fs.readFileSync(coderPath, "utf-8");
		const reviewer = fs.readFileSync(reviewerPath, "utf-8");
		assert.ok(coder.includes("# Git conventions"), "baseline keeps Git conventions");
		assert.ok(!reviewer.includes("# Git conventions"), "reviewer-profile verifier prompt excludes Git conventions");
		assert.ok(!reviewer.includes("Parallel tool calls that mutate the same target"), "reviewer-profile verifier prompt excludes mutate-same-target guidance");

		const savedBytes = Buffer.byteLength(coder, "utf-8") - Buffer.byteLength(reviewer, "utf-8");
		assert.ok(savedBytes > 2000, `expected reviewer verifier profile to save >2000 bytes, saved ${savedBytes}`);
		console.log(`[SWARM-W4] verifier reviewer-profile byte savings: ${savedBytes} bytes`);
	});

	it("SWARM-W4 best-of-N candidate builders stay byte-identical default when narrowness cannot be proven", () => {
		const bestOfNSrc = fs.readFileSync(path.join(process.cwd(), "src/server/agent/swarm-best-of-n.ts"), "utf-8");
		const siblingSpecStart = bestOfNSrc.indexOf("export interface BestOfNSiblingSpec");
		const siblingSpecEnd = bestOfNSrc.indexOf("export interface BestOfNSwarmOptions");
		assert.ok(siblingSpecStart >= 0 && siblingSpecEnd > siblingSpecStart, "BestOfNSiblingSpec source window not found");
		const siblingSpec = bestOfNSrc.slice(siblingSpecStart, siblingSpecEnd);
		assert.doesNotMatch(siblingSpec, /allowedTools/, "best-of-N siblings do not carry an explicit allowedTools proof, so narrow-worker must not be inferred");
		assert.doesNotMatch(bestOfNSrc, /promptProfile:\s*"narrow-worker"|promptProfile:\s*narrow/, "best-of-N candidate builders must remain unprofiled until allowedTools proves narrowness");

		const raw = fs.readFileSync(REAL_BASE_PROMPT_PATH, "utf-8").trim();
		const base = resolveMarkdownRefs(raw, path.dirname(REAL_BASE_PROMPT_PATH));
		const expectedWorkingDir = "# Working Directory\n\n" +
			`Your working directory is: \`${cwdDir}\`\n\n` +
			`Stay in this directory for all file operations and git commands. ` +
			`Do not \`cd\` into other directories unless explicitly required by the task.\n\n` +
			`**Why this is a hard constraint:** Other agents, the dev server, and the user may all be working in the primary worktree simultaneously. ` +
			`If you \`cd\` there and make changes, you risk merge conflicts during rebase, corrupting other agents' in-progress work, or breaking the running dev server. ` +
			`Even for infrastructure files (Dockerfiles, configs), the correct flow is: edit here → commit → push to origin → pull from primary. ` +
			`One \`cd\` violation cascades — all subsequent commands (edit, git add, commit) will operate on shared state.`;
		const expectedGoal = "# Goal\n\n**Best-of-N candidate** (Status: active)\n\nBuild the shared candidate implementation.";
		const expectedRole = "Team lead candidate builder role prompt.";
		const expected = [base, expectedWorkingDir, expectedGoal, expectedRole].join("\n\n---\n\n") + "\n";

		const promptPath = assembleSystemPrompt("swarm-best-of-n-unprofiled-builder", {
			cwd: cwdDir,
			baseSystemPromptPath: REAL_BASE_PROMPT_PATH,
			goalTitle: "Best-of-N candidate",
			goalState: "active",
			goalSpec: "Build the shared candidate implementation.",
			rolePrompt: "Team lead candidate builder role prompt.",
		});
		assert.ok(promptPath);
		const actual = fs.readFileSync(promptPath, "utf-8");
		assert.equal(actual, expected, "unprofiled best-of-N builder prompt must stay byte-identical to the default prompt shape");
		assert.ok(actual.includes("# Git conventions"));
		assert.ok(actual.includes("Why this is a hard constraint"));
	});

	it("narrow-worker profile drops the branch-discipline rationale from Working Directory; default profile keeps it", () => {
		const fullSections = getPromptSections({ cwd: cwdDir });
		const narrowSections = getPromptSections({ cwd: cwdDir, promptProfile: "narrow-worker" });
		const fullWd = fullSections.find(s => s.label === "Working Directory")!;
		const narrowWd = narrowSections.find(s => s.label === "Working Directory")!;
		assert.ok(fullWd.content.includes("Why this is a hard constraint"));
		assert.ok(!narrowWd.content.includes("Why this is a hard constraint"));
		// Both keep the load-bearing "stay in this directory" instruction and path.
		assert.ok(fullWd.content.includes(cwdDir) && narrowWd.content.includes(cwdDir));
		assert.ok(fullWd.content.includes("Stay in this directory") && narrowWd.content.includes("Stay in this directory"));

		const saved = fullWd.tokens - narrowWd.tokens;
		assert.ok(saved > 0, `expected narrow-worker profile to shrink the Working Directory section, saved ${saved}`);
		console.log(`[F22] narrow-worker Working-Directory savings: ${saved} tokens (full=${fullWd.tokens}, narrow=${narrowWd.tokens})`);
	});

	it("reviewer/narrow-worker excluded stanza list matches the current base prompt's headings exactly (drift guard)", () => {
		const raw = fs.readFileSync(REAL_BASE_PROMPT_PATH, "utf-8");
		for (const heading of REVIEWER_EXCLUDED_STANZAS) {
			assert.ok(raw.includes(`# ${heading}\n`), `defaults/system-prompt.md must still contain "# ${heading}" — if this heading was renamed, update REVIEWER_EXCLUDED_STANZAS in system-prompt.ts`);
		}
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

	// F22 — the "Tools" section records the active BOBBIT_TOOLS_MD mode so the
	// persisted <sessionId>-prompt.json breakdown can A/B measure the flag.
	it("Tools section reports toolsMdMode 'full' by default", () => {
		delete process.env.BOBBIT_TOOLS_MD;
		const sections = getPromptSections({
			cwd: cwdDir,
			toolDocs: "# Tools\n\n## Shell\n- bash(command) — Execute a shell command",
		});
		const toolsSection = sections.find(s => s.label === "Tools");
		assert.ok(toolsSection, "should have a Tools section");
		assert.equal(toolsSection!.toolsMdMode, "full");
	});

	it("Tools section reports toolsMdMode 'index' when BOBBIT_TOOLS_MD=index", () => {
		process.env.BOBBIT_TOOLS_MD = "index";
		try {
			const sections = getPromptSections({
				cwd: cwdDir,
				toolDocs: "# Tools\n\n## Shell\n- bash — Execute a shell command",
			});
			const toolsSection = sections.find(s => s.label === "Tools");
			assert.ok(toolsSection);
			assert.equal(toolsSection!.toolsMdMode, "index");
		} finally {
			delete process.env.BOBBIT_TOOLS_MD;
		}
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
